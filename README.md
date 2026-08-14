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
  attach.ts           spawn + free-port + wait-for-port + connect + killTree (worker reaping)
  anchors.ts          ★ version-fragile: gate specs, locators, rebinds
  gate-rebind.ts      the injector core: parent + child gate rebinding
  extract-anchors.ts  offline tool: locate gates/aliases in the running bundle
src/server/
  store.ts            state: in-memory read cache + write-through to PG; runtime conn registry
  db.ts               PostgreSQL layer (pool, schema, queries) — no ORM
  schema.sql          environments / sessions / events DDL, applied idempotently on boot
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
`test/fixtures/`; refresh them with `npm run capture-events` (uses BYOK inference). Set
`DATABASE_URL` to also run the persistence tests (otherwise they skip — see below).

## Hosted web (third version) — DONE

Phones control sessions through a central server, scoped by a **credential** (凭证A). Same
credential ⇒ the injector and the web see each other; it's a namespace key, stored in a
cookie (lost = re-issue).

Run it:
0. `npm install && npm run db:up` — start PostgreSQL (docker compose) and export
   `DATABASE_URL=postgres://ccc:ccc@127.0.0.1:5432/ccc` (see `.env.example`).
1. `npm run server` — central server on `:8787` (bridge control-plane + CCR v2 data-plane +
   `/ws/client` web channel + serves `web/dist`). Without `DATABASE_URL` it still runs, in
   memory, and says so — nothing survives a restart.
2. `cd web && npm install && npm run build` — build the mobile SPA once.
3. `node src/control-cli.ts --credential <A> --server http://127.0.0.1:8787` (or an https
   tunnel URL) — launches an injected claude whose bridge points at the server, owned by `<A>`.
   Generates/prints/saves a credential if none is given. Interactive by default (see below);
   `--headless` gives the phone-only `claude remote-control` process instead.
4. On your phone (LAN IP or a tunnel), open the server URL, paste the credential → your
   session appears → chat, with tool-use permission prompts. On a desktop the same UI renders
   inside a 390×844 phone frame, so the real thing is reviewable without a device.

- Data-plane is authenticated by the per-session ingress token; `/ws/client` is scoped to the
  credential (a socket only touches its own sessions).
- `node test/e2e-web.ts` runs the whole hosted loop in one process (real inference):
  session list → message → streamed reply → `can_use_tool` permission → tool executes.

Files: `src/server/main.ts` (process entry), `src/server/web-channel.ts` (browser WS),
`src/control-cli.ts` (`control-claude-code`), `web/` (Vite + React SPA).

## Mobile UI (sixth version) — DONE, verified

The phone UI is built to the Anthropic Remote Control design spec: warm-dark surface (`#262624`),
Source Serif 4 for assistant prose, JetBrains Mono for commands and output, 4pt grid, tool cards
that merge into bordered groups, a permission sheet whose drag-dismiss is a *deny*, and an output
sheet instead of inline dumps. Fonts are self-hosted (`web/public/fonts`, latin + latin-ext, both
variable ⇒ 4 files / 140 KB) and precached by the service worker.

**The transcript is a pure reducer.** `web/src/model.ts` folds data-plane payloads into render
items (`user · prose · thinking · tools · todo · question · bgtask · status · error`) plus a
`live` block (busy, running tool, thinking tokens, model, permission mode, slash commands). The
same function eats the history backfill and the live stream, so a reopened session renders
identically — and it is testable without a browser (`test/model.test.ts`, `npm run render-history`
replays a real session out of PostgreSQL).

Four things the design doc could not have known, found by reading real captured traffic:

- **`thinking` blocks arrive with `thinking: ""`** — the data plane relays the signature only,
  never the reasoning text (verified across every block of a real session). So a thinking block is
  a marker ("思考 · N tokens", token count from `system:thinking_tokens`), not a collapsible
  transcript. It expands only if a future version starts sending text.
- **`AskUserQuestion` is not a tool card.** It always arrives as `control_request:can_use_tool`
  (its `checkPermissions` returns `ask` unconditionally), and is answered with
  `{behavior:'allow', updatedInput:{questions, answers}}` — answers keyed by question text,
  multi-select comma-joined. It renders as an inline question card with options, descriptions,
  previews, a free-text box and Skip. `npm run e2e-question` proves the round trip on a real
  wire: the phone's answer reaches the tool, the tool_result echoes it, the model acts on it.
- **`Update Todos` does not exist in 2.1.232** — the todo card is built from `TaskCreate` /
  `TaskUpdate`, and falls back to a plain tool row when the input cannot be parsed.
- **The `/rc` bridge does not relay `stream_event`.** The CCR client uploads partial messages as
  ephemeral events, but a completed interactive turn delivered `user → assistant → result` and
  nothing else. So prose appears per message, not per token; the reducer handles both (the
  streamed draft is replaced in place, never appended twice) and the busy state is carried by the
  activity line instead of a caret.

`permission_response` over `/ws/client` now carries the worker's own contract —
`{behavior, updatedInput?, updatedPermissions?, message?}` — which is what makes "Always allow"
work: the phone echoes back a `permission_suggestions` entry rather than inventing a rule (it
cannot reach the machine's `settings.json`). The browser is untrusted, so `web-channel.ts` filters
to those four keys and drops permission updates with an unknown `type` — one malformed entry would
make the worker silently discard the whole array and turn an "always" into a "once".

The session list is backed by a server-derived digest (`store.foldDigest`: last prompt, running
tool, tool count, needs-approval, model), persisted in a `digest jsonb` column that rides the same
batched UPDATE as `last_activity`. An in-flight approval is deliberately not restored on boot — the
request died with the process, so the badge must not come back stuck on.

Deliberately not built, because the architecture has no channel for it: starting a session from the
phone (only your terminal can launch `control-claude-code`), reading/writing the machine's
permission allowlist, the `@`-file picker, "open in editor", voice, and image upload. Web Push
lock-screen approval is deferred — notifications today are local and need the page alive.

Verified by: `npm test` (76 tests, ~4s — reducer invariants against real captured shapes in
`test/fixtures/transcript-shapes.jsonl`, permission pass-through and digest derivation over a real
socket, digest persistence across a restart), `npm run e2e-interactive`, `npm run e2e-question`,
and `cd web && npm run build` (typechecks first).

### Reviewing the phone UI without a phone

```bash
npm run ui-preview                       # :8791 — the real SPA against fake-but-real-shaped sessions
npm run ui-shot                          # both device profiles → artifacts/ui/<device>/*.png + numbers
npm run ui-shot -- --device pro-max-pwa  # just the installed-web-app profile
```

Two profiles, because the bugs differ: `phone` is a 390×844 browser tab, and `pro-max-pwa` is the
installed web app on an iPhone 15 Pro Max — 430×932 **with real safe-area insets** (59pt of Dynamic
Island, 34pt of home indicator, via `Emulation.setSafeAreaInsetsOverride`) and genuinely
`display-mode: standalone`. That last part needs chromium launched with `--app=<url>`:
`Emulation.setEmulatedMedia` accepts a `display-mode` feature and then silently ignores it
(measured — the page still reports `browser`), so a standalone run gets its own browser process.

`test/ui-preview.ts` replays `test/fixtures/transcript-shapes.jsonl` **through the actual
data-plane** (`POST …/worker/events`) into three seeded sessions — one live transcript, one waiting
on approval, one offline — so what the browser renders came out of the same reducer path as a real
session, with no claude, no inference and no database. `test/ui-shot.ts` drives chromium over CDP
(no puppeteer), sets a *real* mobile viewport with `Emulation.setDeviceMetricsOverride`
(`mobile: true`, DPR 3 — a bare `--window-size` leaves `mobile:false`, so `dvh`, safe-area insets
and touch queries behave like a desktop), and captures nine states: list, transcript top/bottom,
composing, permission sheet, question card, output sheet, menu, credential gate.

It prints numbers as well as pixels — every box's geometry, each transcript item's height,
`scrollTop/scrollMax`, and any element painting outside the viewport (ignoring code blocks, the one
place horizontal scroll is allowed). That is what found the three real bugs, none of which any unit
test could see:

- **The app shell was not one viewport tall.** `.phone-frame` inherited only `min-height: 100%`
  from `.desktop-stage` on the mobile branch, and a percentage height resolves to `auto` against an
  auto-height parent — so the frame grew with the transcript (2732px on an 844px screen), the page
  itself became the scroller and the composer scrolled off the bottom of the phone.
- **Every clipped card collapsed to a 2px sliver** once that was fixed. A column flex item's
  automatic minimum size is its content — *except* with `overflow: hidden`, where it is 0. Tool
  groups and question cards round their corners, so the moment the transcript overflowed they were
  shrunk to their borders. `.chat > *, .session-list > * { flex: none }`. (The two bugs masked each
  other: with no definite height nothing overflowed, so nothing shrank.)
- **Long unbroken tokens escaped the tool card** — a DSN or URL in a command ran past the right
  edge and was clipped, because `.tool-head` only broke at spaces.

Two smaller fixes came out of the same pass: the transcript now re-pins when the *composer* grows
(a `ResizeObserver`, since no new item arrives — typing a three-line message used to hide the
message you were writing about), and the code-block copy button moved out of the code into its own
row (floating at the top-right, it covered whatever sat at the right edge of the first line
whenever the block scrolled sideways).

Note when reading screenshots on a fresh box: with no CJK font installed every Chinese glyph
renders as tofu. `fc-list :lang=zh` first.

### Installed on iOS: safe areas, viewport units, and the scroll-off tap

Three more things only the real installed app showed (reported on an iPhone 15 Pro Max, iOS 26):

- **Safe areas now use `max(inset, gap)`, never `inset + gap`.** Adding a gap on top of an inset
  stacks padding on space the Dynamic Island already took; and when iOS installs via the manifest
  instead of the `apple-*` meta tags the inset is `0`, where `max()` still leaves the plain gap.
  Same at the bottom, which is where the wasted space was most visible (44px → 34px).
- **The height chain is `%`, with `dvh` only in a browser tab.** iOS 26.0 mis-measures `dvh` for
  viewport-sized containers, leaving a dead scrollable band at the bottom of a standalone PWA
  (Apple fixed it in Safari 26.1). An installed app has no collapsing chrome, so `%` is both
  correct and immune; `@media (display-mode: browser)` keeps `dvh` where the URL bar does move.
  `html, body { overflow: hidden }` backs this up — if the document can never scroll, the browser
  stops collapsing its chrome at all.
- **A tool card no longer opens when you scroll off it.** `ToolRow` rolls its own
  touchstart/touchend (it shares the code path with the long-press), and iOS does *not* reliably
  send `touchcancel` when a drag inside a scroll container becomes a scroll — the same touch just
  ends normally, which read as a tap. It now cancels past 10px of travel, which also kills the
  pending long-press so a slow scroll cannot fire it either.

Two follow-ups came out of measuring the installed app instead of reasoning about it, and both
reversed an earlier decision:

- **The height unit is `dvh`, and `%` is only the no-dvh fallback.** On the device: `innerHeight`
  932, `100dvh` 932, but `height: 100%` → **873 = 932 − 59**, exactly the top inset. Under
  `viewport-fit=cover` with a translucent status bar WebKit resolves the initial containing block
  *without* that inset, so a `%` chain is short by the height of the Dynamic Island and leaves it
  as a dead band at the bottom. Chromium does not reproduce this even with
  `Emulation.setSafeAreaInsetsOverride` — its ICB stays the full viewport — so the numbers are
  written into the CSS comment, because only a device can catch a regression here.
- **The composer bar reaches the screen edge**; the pill clears ~12px, not the full 34pt inset.
  That inset is clearance for the home indicator's *gesture* area, not a margin a bottom bar must
  float above; sitting 34pt up left a band of bare page background that read as a hole. The sheets
  keep the full inset, since their buttons are the primary action.

**The header floats and frosts.** `.header` (top bar + connection banner) is absolutely positioned
over the transcript, which now starts at `y=0` and scrolls *under* it — so the 59pt behind the
status bar and Dynamic Island is used rather than reserved, and content passing up there is blurred
instead of colliding with the clock. This is
[muffinman.io/blog/pwa-ios-status-bar-blur](https://muffinman.io/blog/pwa-ios-status-bar-blur)
adapted rather than copied: that demo has no `viewport-fit=cover`, so its layout origin sits *below*
the status bar and it can hide a blur strip at negative `y`; under `cover` `y=0` is the physical top
(measured: ICB offset 0), so the strip simply lives at the top edge. Three details are load-bearing:
the blurring `::before` needs `z-index: -1` (an absolutely positioned box paints in a later step
than its in-flow siblings, so without it the frost covers the header's own title), it needs
`pointer-events: none` (its fade tail hangs over the transcript), and the tail is a fixed 22px that
the transcript's top padding clears — a percentage tail dimmed the first card at rest. `--header-h`
is measured with a `ResizeObserver` in `ChatView`, because the banner changes the height at runtime.

What is still **not** fixable from CSS: iOS 26 paints a Liquid Glass "scroll edge effect" behind the
status bar, and there is no web-facing opt-out (`theme-color` is ignored in Safari 26; the native
`scrollEdgeEffectStyle` is not exposed). All a page can do is control what gets sampled — which the
frosted header now does deliberately.

Because an installed PWA can sit on a stale service-worker cache indefinitely, the session menu
prints `build <vite content hash> · 外壳 top→bottom / innerHeight`: one screenshot says which build
a phone is actually running and whether its shell fills the viewport. Without it every layout
report is ambiguous — `diag.html` can measure the browser, but not the app around it.

`web/public/diag.html` (served at `/diag.html`, deliberately excluded from the service worker
cache) is the device-side counterpart: open it from the home-screen icon and it reports
`display-mode`, `innerHeight` vs `100vh` vs `100dvh` vs `100%`, all four insets and the UA, plus
three coloured bars down the left edge so a lying viewport unit is visible without reading a
number.

### Icons: the official Claude symbol

`web/public/icons/claude-symbol.svg` is Anthropic's own symbol (via Wikimedia Commons,
CC0 1.0, sourced from anthropic.com), and it is the single source of truth for the mark —
`web/scripts/gen-icons.mjs` (`cd web && npm run icons`) parses the `<path>` out of it and renders
the PWA PNGs with chromium, rather than a hand-rolled rasteriser. Proportions are measured, not
invented: `claude.ai/apple-touch-icon.png` is a #d97757 ground with a #fefcfb mark spanning
**74.4%** of the square, so that is what 192 / 512 / 180 / 32 use; the maskable 512 drops to 56% to
survive Android's circular crop. The same path is a `ClaudeMark` component (`web/src/icons.tsx`)
used for the launch screen's app icon and the question card, replacing a `✳` glyph on a coral
rounded square. The service worker cache is bumped (`ccc-web-v4`) so installed copies do not keep
serving the old ones. It is Anthropic's trademark, used here because this app is a client for
their product.

## Interactive `/rc` (fourth version) — DONE, verified

The main entry point, and the **default** mode: a user is vibing in a normal `claude` TUI and,
mid-session, wants it on their phone. `control-claude-code` launches the interactive TUI with the
`/rc` gates rebound; the user types `/rc` (optionally `/rc <name>`) and the session appears on
their phone — same web, same credential.

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

Run: `node src/control-cli.ts --credential <A> --server http://127.0.0.1:8787`, then type `/rc`
in the TUI.

### CLI contract

```bash
control-claude-code                            # interactive claude + /rc injection (default)
control-claude-code --resume                   # ← any unknown arg is forwarded to claude
control-claude-code -c --model opus "fix this"
control-claude-code -- --help                  # everything after -- is claude's, verbatim
control-claude-code --headless                 # old mode: injected `claude remote-control`
```

Controller-owned flags — `--server`, `--credential`, `--cwd`, `--claude-bin`, `--log-dir`,
`--headless`, `-i/--interactive` (compat no-op), `-h/--help`. Every other token, in order, is
claude's argv; `--` forces the rest through even if it collides with a controller flag name. A
value flag with a missing/flag-looking value is a hard error rather than silently eating a claude
argument. `test/control-cli.test.ts` pins this contract.

Logs go to a directory, not the terminal (the TUI owns it): `~/.config/claude-code-controller/logs/`
by default, `--log-dir` / `CCC_LOG_DIR` to move it. Each run writes `ccc-<stamp>-<pid>.log`
(controller + injector) and `ccc-<stamp>-<pid>.claude.log` (claude's stderr — always captured, an
unread stderr pipe would eventually stall claude), with `latest.log` / `latest.claude.log`
symlinked for `tail -f`; the newest 20 runs are kept. If claude exits nonzero its stderr tail is
echoed to the terminal so a bad forwarded argument stays visible. `CCC_CLAUDE_DEBUG=1` adds
claude's own `--debug` (also to `~/.claude/debug/<uuid>.txt`).

**Window titles under tmux / screen.** The host renames itself to `claude` (`process.title`) so
an automatic-rename terminal titles the window the way a direct `claude` run does. tmux takes the
window name from the *foreground process group leader's* `argv[0]` (`/proc/<pgid>/cmdline`), and
claude — our child — inherits our process group, so without the rename `#W` reads `node`
(measured) while claude's own OSC title only reaches tmux's `pane_title` (`#T`), which the common
`set-titles-string "#S / #W"` never renders. Putting the child in its own foreground group is not
an option: that needs `setpgid` + `tcsetpgrp` (no Node API), and `detached: true` calls `setsid()`,
which would cost claude its controlling terminal — no `SIGWINCH`, so the TUI would stop reflowing
on resize. `CCC_NO_PROCESS_TITLE=1` keeps the real argv when you'd rather see the controller in
`ps`.

## Persistence — PostgreSQL (fifth version) — DONE, verified

The server is meant to serve many users, so state lives in PostgreSQL. Three tables
(`src/server/schema.sql`): `environments`, `sessions`, `events`. `credential` deliberately has no
registry table yet — it is still a pure namespace key.

```bash
npm install && npm run db:up          # postgres:17 via docker compose (loopback-only :5432)
export DATABASE_URL=postgres://ccc:ccc@127.0.0.1:5432/ccc
npm run server                        # schema is applied idempotently on boot
npm run db:psql                       # a shell in the database
```

**Design: in-memory read cache + write-through.** Since the server is single-instance, PG never
has to coordinate between processes, so it only has to be the source of truth:

| | |
|---|---|
| boot | `store.load()` pulls the last 30 days into `envs` / `sessions` maps |
| reads | served from the maps — **synchronous** (`owns()` runs on every websocket frame) |
| writes | memory + PG in the same call — the only methods that became `async` |
| events | never cached; `historyFor()` is a query, `appendEvents()` a batched INSERT |

That is why the migration touched ~8 call sites instead of ~73: `sessionsForCredential`,
`sendToChild`, `sessionByIngressToken`, `view`, `nextWork` and friends never changed signature.

**Deliberately not persisted**, because storing it would be wrong rather than merely wasteful:
SSE response handles, `wsConnected` / `online` (a restart must report offline), the SSE `seq`, and
the work queue (an in-flight lease is void after a restart — the injector re-registers). Plus
`stream_event`: token-level deltas are relayed live but never stored, since the full `assistant`
message already carries the text and storing them would multiply writes for no replay value.

Two more consequences worth knowing:

- **`last_activity` is batched.** `touch()` fires on every inbound event, so it only marks the
  session dirty; a 30s timer (and `store.close()` on SIGINT/SIGTERM) does one `UPDATE … from
  unnest(...)` for everything that accumulated.
- **A live session reconnects itself across a restart.** `ingress_token` is persisted, so a
  running claude's data-plane re-authenticates against the new process and the session goes back
  to `active` on its own — no second `/rc`. (`e2e-persist` shows exactly this; kill the TUI too
  and it correctly reports `offline` instead.)
- **A cold session is recoverable, not lost.** Sessions older than the load window aren't in the
  cache, but `POST /v1/code/sessions/{id}/bridge` recreates an unknown `cse_*` id under the
  calling credential, so a returning TUI just re-signs its worker token.

Without `DATABASE_URL` the server still runs, in memory, and says so — `new Store()` is the same
single implementation with persistence switched off, which is what the unit tests and
`src/cli.ts` use.

Verified by:
- `npm test` — with `DATABASE_URL`, `test/db.test.ts` runs write-through, restart-reload,
  transcript ordering, the `stream_event` exclusion and the `last_activity` batching against the
  real database. Without it those 6 tests skip and the suite stays zero-dependency (~4s).
  Those tests TRUNCATE, so they get their own tables via `createPool(url, { schema: 'ccc_test' })`
  (a per-connection `search_path`) — the same database as the server, never its `public` tables.
  **Any new test that writes must use that schema**; pointed at `public` it would delete live
  sessions.
- `npm run e2e-persist` — the whole thing: inject → `/rc` → web message → real reply → stop the
  server → **start a new process** → the transcript comes back from PG with claude gone.

## Worker reaping (headless only)

`claude remote-control` forks a **worker claude** (`--print --sdk-url …`) as a *grandchild*, so
killing the process we spawned leaves the worker behind (PPID→1). Whether it then exits depends on
something outside our control: with the server still up it notices and quits within ~12s, but if
the server died first it retries the dead `--sdk-url` **forever**, holding ~370 MB at 0.4% CPU.
Ten of those (7–18 hours old, 3.5 GB total) accumulated in one day of testing before this was
found.

`killTree()` in `attach.ts` fixes it: snapshot the process tree from `/proc` **before** anything
dies (once an intermediate exits, its children re-parent to init and become unreachable), then
signal deepest-first. Verified at 0.5s after SIGTERM/SIGINT, versus the old behaviour reproducing
the orphan in the same window.

Two things it deliberately does *not* do:
- **No process groups.** The worker inherits the group it was spawned in — the *caller's* — so
  `kill(-pid)` would take out the user's own shell or tmux window. `detached: true` would give the
  child its own group, but it also moves the child out of the caller's group, which makes the
  SIGKILL-the-host case (where no cleanup code runs at all) leak *more* reliably. Walking `/proc`
  costs one scan and has neither problem.
- **Interactive `/rc` is untouched.** That path must stay in the foreground process group to own
  the terminal, and it spawns no worker, so it has no grandchild to leak.

## Next

A real-phone LAN test (only tmux-automated so far), https cloud deploy, the compose `app`
service, and a `credentials` table (registry + revocation + quota + account/password recovery),
which is the natural next step now that there is a database.
