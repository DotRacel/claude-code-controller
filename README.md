# claude-code-controller

Revive **Claude Code Remote Control for BYOK users**. Anthropic gates Remote Control to
OAuth (claude.ai subscription) logins; BYOK users (`ANTHROPIC_API_KEY` / relay endpoints)
are hard-refused. This tool injects the Bun-compiled `claude` binary via its built-in
inspector, neutralizes the OAuth-only gates, and re-hosts the `/remote-control`
**control-plane** on a self-run server — without touching the user's model/inference path.

> First version: handshake-layer only. A test CLI stands in for the (future) web UI. It
> proves the whole loop end-to-end; it does not yet relay a full conversation.

## Status — first version DONE (verified end-to-end on claude 2.1.231)

`node src/cli.ts` reproducibly reaches:

```
6/6 OAuth-only gates rebound (parent) → environment registered → work poll →
session work delivered → child claude spawned → child gate rebound → child connects
the CCR v2 SSE data-plane  ⇒  ✅ PASS
```

## How it works

**Injection (inspector).** `claude` is a Bun standalone ELF with the JSC/WebKit inspector
compiled in. We launch it with `BUN_INSPECT=ws://127.0.0.1:<port>?wait=1` (pauses before
user code), attach, and — key discovery — **release with `Inspector.initialized`** (JSC has
no `Runtime.runIfWaitingForDebugger`; cc-injector believed wait was unreleasable). While
paused we read the bundle in-process via `Bun.file('/$bunfs/root/cli').text()` to locate
each gate (string/structural anchors → current minified aliases), set pending breakpoints,
release, and on each hit **rebind the local alias** with `evaluateOnCallFrame` (JSC has no
`setReturnValue`; source hot-swap is impossible — the bundle is one 62,951-line script).

**Gates rebound (parent `claude remote-control`):** `hasStoredOAuthToken`,
`getBridgeDisabledReason`, `checkBridgeMinVersion`, `isPolicyAllowed`,
`getTrustedDeviceUnenrolledReason`, `getBridgeAccessToken`→our token,
`getBridgeBaseUrl`→our URL.

**Multi-process.** bridgeMain spawns a child `claude --print --sdk-url …` that has its OWN
gate: `dHs()` rejects a non-Anthropic `--sdk-url` host. At the spawn site we inject
`BUN_INSPECT` into the child env, attach the child, and rebind `dHs`→`{status:'ok'}`.

**Control-plane vs inference-plane.** We only take over `getBridgeBaseUrl` (the REST +
data-plane root). The child inherits the user's `ANTHROPIC_API_KEY`/`ANTHROPIC_BASE_URL`
and does inference through their own relay, untouched.

## Version note (2.1.231)

Diverged from the 2.1.193 reconstructed source we planned against: `session_ingress/ws` is
gone; the data-plane is now **CCR v2 code-sessions over SSE** — `GET .../worker/events/stream`
(SSE) + `POST .../worker/events`, plus `GET/PUT .../worker` and `POST .../worker/register`.
All version-fragile facts live in `src/injector/anchors.ts`; re-run `extract-anchors` on a
new version to refresh them.

## Layout

```
src/injector/
  ws-client.ts        WebKit inspector JSON-RPC over RFC6455 (ported from cc-injector)
  attach.ts           spawn + free-port + wait-for-port + connect helpers
  anchors.ts          ★ version-fragile: gate specs, locators, rebinds
  gate-rebind.ts      the injector core: parent + child gate rebinding
  extract-anchors.ts  offline tool: locate gates/aliases in the running bundle
src/server/
  store.ts            in-memory environments / work / sessions
  ws-ingress.ts       WS session_ingress server (legacy ≤2.1.193; unused on 2.1.231)
  index.ts            REST (environments/work/sessions) + CCR v2 SSE data-plane
src/cli.ts            test driver: server + injector + observe the whole handshake
test/test-gates.ts    injector-only check (gates crossed + base-url redirected)
```

## Run

```bash
node src/cli.ts                       # full handshake loop, prints every step
CCC_DEBUG_FILE=/tmp/b.log node src/cli.ts   # + capture the bridge's debug log
node test/test-gates.ts               # injector-only assertion
node src/injector/extract-anchors.ts  # refresh anchors against the installed claude
```
Requires Node ≥22 (uses native TS type-stripping). Set `CLAUDE_BIN` to override the
`claude` path.

## Conversation (second version) — DONE

`node src/cli.ts` now drives a real remote turn end-to-end: it relays a user message over the
SSE data-plane, the child does inference with the user's BYOK creds, and the streamed reply
comes back. `--interactive` gives a multi-turn REPL; `--deny` refuses tool-use.

- **Data-plane**: server→child SSE `client_event` frames, child→server `POST .../worker/events`;
  worker lifecycle (`GET/PUT .../worker`, `GET .../worker/internal-events`).
- **Owner semantics (subtle!)**: a relayed message must carry `client_platform`
  (`web_claude_ai` etc.) or the headless worker demotes it to a cross-session *peer* ("Another
  Claude session sent a message", tools self-approved). Payload `origin` is ignored — the worker
  classifies by `client_platform`. With it, the message is owner keyboard input.
- **Permission round-trip**: `control_request{can_use_tool}` → we answer
  `control_response{allow|deny}` → the tool runs.

## Event catalog & tests (web foundation)

`docs/EVENTS.md` is the full wire contract the front-end builds on — every event type and
shape on the CCR v2 data-plane, both directions, with real examples, the tool-call lifecycle
(`tool_use` → `can_use_tool` → `control_response` → `tool_result`), and a rendering guide.

`npm test` runs the suite (no claude needed, ~4s): frame/secret encoding, server relay +
worker-lifecycle endpoints, and fixture regression that pins the event shapes the web depends
on (incl. the owner-vs-peer `client_platform` invariant). Real-wire fixtures live in
`test/fixtures/`; refresh them with `npm run capture-events` (uses BYOK inference).

## Hosted web (third version) — DONE

Phones control sessions through a central server, scoped by a **credential** (凭证A). Same
credential ⇒ the injector and the web see each other; it's a namespace key, stored in a
cookie (lost = re-issue).

Run it:
1. `npm run server` — central server on `:8787` (bridge control-plane + CCR v2 data-plane +
   `/ws/client` web channel + serves `web/dist`).
2. `cd web && npm install && npm run build` — build the mobile SPA once.
3. `node src/control-cli.ts --credential <A> --server http://127.0.0.1:8787` (or an https
   tunnel URL) — launches an injected `claude remote-control` whose bridge points at the
   server, owned by `<A>`. Generates/prints/saves a credential if none is given.
4. On your phone (LAN IP or a tunnel), open the server URL, paste the credential → your
   session appears → chat, with tool-use permission prompts. Desktop browsers get a
   "use your phone" guard.

- Data-plane is authenticated by the per-session ingress token; `/ws/client` is scoped to the
  credential (a socket only touches its own sessions).
- `node test/e2e-web.ts` runs the whole hosted loop in one process (real inference):
  session list → message → streamed reply → `can_use_tool` permission → tool executes.

Files: `src/server/main.ts` (process entry), `src/server/web-channel.ts` (browser WS),
`src/control-cli.ts` (`control-claude-code`), `web/` (Vite + React SPA).

## Interactive `/rc` (fourth version) — DONE, verified

The other entry point: a user is vibing in a normal `claude` TUI and, mid-session, wants it on
their phone. `control-claude-code -i` launches the interactive TUI with the `/rc` gates rebound;
the user types `/rc` (optionally `/rc <name>`) and the session appears on their phone — same web,
same credential.

Unlike headless, the REPL bridge spawns **no child**: the interactive process creates a
code-session and connects the SSE data-plane itself. Two extra server endpoints back it:
`POST /v1/code/sessions` (createCodeSession, owned by 凭证A) and
`POST /v1/code/sessions/{id}/bridge` (fetchRemoteCredentials → `worker_jwt` = the session's
ingress token). Injection rebinds **six** gates (each breakpoint removed after the first hit —
hot TUI paths): enable the command (`isBridgeEnabled` kill-switch → true); redirect the
base-url/token overrides → our URL / 凭证A; clear the command preflight (disabled-reason +
trusted-device); inject a synthetic **org UUID** (a BYOK account has none — this was the real
blocker); and satisfy the transport init's OAuth check. A relayed web message is treated as
**owner** (bridgeOrigin), not a peer — no `client_platform` hack needed here.

- `node test/probe-interactive.ts` — asserts all six gates locate against the installed claude.
- `bash test/e2e-interactive.sh` — the full loop through tmux: inject → `/rc` → session on the
  server → web message → reply, checking owner semantics.
- `npm test` — the interactive control-plane (createCodeSession ownership + fetchRemoteCredentials
  + data-plane auth).

Run: `node src/control-cli.ts -i --credential <A> --server http://127.0.0.1:8787`, then type
`/rc` in the TUI. Injector logs go to `$TMPDIR/ccc-interactive.log`; `CCC_CLAUDE_DEBUG=1` also
captures claude's own `--debug` output (to `~/.claude/debug/<uuid>.txt`).

## Next

A real-phone LAN test (only tmux-automated so far), https cloud deploy, and account+password
credential recovery.
