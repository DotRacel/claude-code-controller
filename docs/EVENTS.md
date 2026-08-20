# CCR v2 Data-Plane Event Catalog

The wire contract between our controller server and the child `claude` worker, and therefore
the contract the web front-end builds on. Every message is a **stream-json SDK message** carried
as a `payload`:

- **server → child** — SSE frame on `GET .../worker/events/stream`:
  `event: client_event\ndata: {"sequence_num":N,"event_id":"…","event_type":"relay","payload":{…}}\nid: N\n\n`
- **child → server** — `POST .../worker/events` body `{"worker_epoch":N,"events":[{"payload":{…}}]}`

The server exposes this as `sendUserMessage` / `sendControlResponse` (send) and the
`claude.event` callback (receive). Fixtures of every real event live in
`test/fixtures/` (`child-events.jsonl`, `event-samples.json`), captured by `test/capture-events.ts`.

Legend: ✓ = observed on the wire at runtime · ○ = defined in `sdk-control-protocol-schemas.js`
but not seen in the capture run (rarer paths).

## Correlation IDs

- `uuid` — unique per message.
- `request_id` — pairs a `control_request` with its `control_response`.
- `tool_use_id` (aka `toolu_…`) — the thread that ties **`assistant` tool_use** →
  **`control_request` can_use_tool** → **`user` tool_result** together.

---

## server → child (what the web SENDS)

### `user` — a user turn ✓
```json
{ "type": "user",
  "message": { "role": "user", "content": "…text… or content blocks" },
  "client_platform": "web_claude_ai" }
```
**`client_platform` is mandatory** (`ios`/`android`/`web_claude_ai`/`desktop_app`). Without it the
worker demotes the message to a cross-session *peer* ("Another Claude session sent a message",
tools self-approved). With it, the message is owner keyboard input (`origin:{kind:"human"}`) and
the normal permission flow runs. Payload `origin` is IGNORED by the worker — only `client_platform`
decides ownership.

### `control_response` — answer a permission (or other) request ✓
```json
{ "type": "control_response",
  "response": { "subtype": "success", "request_id": "<from the control_request>",
    "response": { "behavior": "allow" } } }
```
`behavior`: `"allow"` | `"deny"`. Allow may also carry `updated_input` (edited tool input) and
`permission_updates`. Error form: `response:{ "subtype":"error", "request_id", "error":"…" }`.

### `control_request` (host→child) — drive the session ○
`{ "type":"control_request", "request_id":"…", "request":{ "subtype":<X>, … } }` where subtype:
- `interrupt` — cancel the in-flight turn.
- `set_permission_mode` — `{subtype:"set_permission_mode", mode:"default"|"acceptEdits"|"plan"|"bypassPermissions", …}`.
- `set_model` — switch model. · `set_max_thinking_tokens`. · `initialize` — handshake. ·
  `apply_flag_settings`, `mcp_message`, `hook_callback`.

---

## child → server (what the web RENDERS)

### `system` (subtype-tagged) — session + progress signals
- `init` ✓ — session metadata. Fields: `cwd`, `session_id`, `tools:[…]`, `model`,
  `permissionMode`, `slash_commands:[…]`, `agents`, `skills`, `mcp_servers`, `output_style`,
  `capabilities`. **Use this to seed the web UI** (available tools, current model/mode).
- `post_turn_summary` ✓ — `{summarizes_uuid, status_category, status_detail, needs_action}`; a
  short human status of the turn ("replied with hi as requested").
- `task_started` ✓ (`{task_id, task_type:"local_bash"|"local_agent", description, prompt,
  tool_use_id, workflow_name}`) · `task_progress` ✓ (`{task_id, description, summary,
  usage:{tool_uses,duration_ms,total_tokens}, last_tool_name,
  workflow_progress:[{type:"workflow_phase",index,title}]}`) · `task_updated` ✓
  (`{task_id, patch:{status,end_time}}`) · `task_notification` ✓ (`{task_id, status, summary,
  output_file, usage}`) · `task_summary` ○ — background-task lifecycle.
  Two things a client has to get right: between `task_started` and the notification, a long
  workflow reports **only** through `task_progress` (a card with no progress is a spinner for
  minutes), and `task_updated` can be the **only** event that says a task finished.
- `thinking` ○ · `thinking_tokens` ✓ (`{estimated_tokens, estimated_tokens_delta}`) — reasoning progress.
- `notification` ○ · `os_notification` ○ · `informational` ○ · `status` ○ — surfaced notices.
- `api_error` ○ · `api_retry` ○ · `permission_denied` ○ · `permission_retry` ○ — error/retry.
- `vcs_state_changed` ✓ — `{kind:"commit"|"push", branch, cwd}`; emitted after the agent commits
  or pushes. The one side effect a reader cannot undo by reading further, so it is worth a line.
- `worker_shutting_down` ✓ — `{reason:"host_exit"}`; the terminal-side claude is going away. No
  `result` is coming, so anything still claiming to be in flight has to be wound down.
- `compact_boundary` ○ · `compact_start`/`compact_progress`/`compact_end` ○ — context compaction.
- `memory_recall` ○ · `memory_saved` ○ — memory ops.
- `hook_started`/`hook_progress`/`hook_response`/`stop_hook_summary` ○ — hooks.
- `model_fallback` ○ · `model_refusal_fallback`/`model_refusal_no_fallback` ○ ·
  `model_consent_fallback` ○ — model routing.
- `commands_changed` ○ · `session_state_changed` ○ · `plugin_install` ○ ·
  `elicitation_complete` ○ · `local_command_output` ○ · `away_summary` ○ ·
  `file_snapshot`/`files_persisted` ○ · `scheduled_task_fire` ○ · `mirror_error` ○.

### `assistant` — a model message ✓
```json
{ "type": "assistant",
  "message": { "model": "claude-opus-5", "id": "msg_…", "role": "assistant",
    "content": [ {"type":"text","text":"…"} | {"type":"tool_use","id":"toolu_…","name":"Write","input":{…},"caller":{"type":"direct"}} | {"type":"thinking",…} ],
    "stop_reason": null, "usage": { … } } }
```
Iterate `message.content`: `text` blocks are prose; `tool_use` blocks (with `id`) are pending tool
calls; `thinking` blocks are reasoning.

### `user` (replay) — echo of a user turn / tool results ✓
```json
{ "type": "user", "isReplay": true, "origin": { "kind": "human" },
  "message": { "role": "user",
    "content": "…" | [ {"type":"tool_result","tool_use_id":"toolu_…","content":"…"} ] },
  "session_id": "…", "parent_tool_use_id": null, "uuid": "…", "timestamp": "…" }
```
`isReplay:true` messages are the worker echoing turns into the transcript (including our own sends
and tool results). Match `tool_result.tool_use_id` back to the `assistant` tool_use.

**`tool_result.content` is not always a string.** A `Read` of an image returns
`[{"type":"image","source":{"type":"base64","media_type":"image/png","data":"…"}}]` — one
screenshot is 300–600 KB of base64. Stringifying that block puts megabytes of noise in a chat
bubble, so text and images have to be pulled apart (`src/image-blob.ts`).

**Every `tool_result` payload also carries `tool_use_result`** — Claude's own record of the call,
outside `message` and not part of this wire contract: `{interrupted, isImage, stdout, stderr}` for
Bash, `{filePath, oldString, newString, originalFile, structuredPatch}` for Edit, `{type, file:
{type, base64|content}}` for Read. Nothing in this project reads it, and it is **half the bytes**:
across a real 6298-event history it was 20.2 MB of 40.5 MB, including a second full copy of every
screenshot. The server strips the duplicated image on the way to a browser.

### `result` — end of a turn ✓
```json
{ "type": "result", "subtype": "success", "is_error": false, "stop_reason": "end_turn",
  "num_turns": 1, "duration_ms": …, "duration_api_ms": …, "total_cost_usd": …,
  "usage": {…}, "modelUsage": {…}, "permission_denials": [], "result": "…final text…" }
```
`subtype`: `success` | `error` (and specific errors like `tool_deferred*`). Signals the turn is
done; `result` is the final assistant text.

### `control_request` (child→host) — the worker asks us ✓
```json
{ "type": "control_request", "request_id": "…",
  "request": { "subtype": "can_use_tool", "tool_name": "Write", "display_name": "Write",
    "input": {…}, "description": "…", "tool_use_id": "toolu_…",
    "permission_suggestions": [ {"type":"setMode","mode":"acceptEdits","destination":"session"},
                                {"type":"addDirectories","directories":["/tmp"],"destination":"session"} ],
    "decision_reason": "Path is outside allowed working directories",
    "decision_reason_type": "workingDir" } }
```
`can_use_tool` is the permission ask — the web renders a prompt (tool_name + input + why), then we
reply with a `control_response`. Other child→host subtypes (○): `mcp_message`, `hook_callback`.

### `control_cancel_request` ✓ — a request is withdrawn
```json
{ "type": "control_cancel_request", "request_id": "<the control_request's id>", "uuid": "…" }
```
The child is taking back a request we may still be showing — in practice the same permission being
answered in the terminal. It carries **only** `request_id`, so a client has to match on that: the
sheet must close (and the list badge clear), or the phone keeps offering an answer the worker
would reject.

### `conversation_reset` ✓ — /clear or a compaction
```json
{ "type": "conversation_reset", "new_conversation_id": "…", "session_id": "…", "uuid": "…" }
```
The same session continues under a new conversation. The turns above it are history, not context:
render a break, drop the task list, and treat the turn as over.

### `keep_alive` ○ — idle heartbeat from the worker; ignore.

---

## Tool-call lifecycle (the sequence the web threads together)

```
1. assistant   → content[].tool_use  { id: toolu_X, name, input }        (model wants a tool)
2. control_request { subtype:can_use_tool, tool_use_id: toolu_X, … }      (worker asks permission)
3. [web/us]    control_response { request_id, response:{behavior:allow} } (we answer)
4. user(replay)→ content[].tool_result { tool_use_id: toolu_X, content }  (tool ran)
5. assistant   → text …                                                   (model continues)
6. result      { subtype:success, … }                                     (turn done)
```
An auto-approved tool (safe, in-workdir) skips steps 2–3. A `deny` short-circuits to a
`tool_result` error and often a `system:permission_denied`.

## Web rendering guide

- **Transcript**: `assistant` text/thinking, `tool_use` (as a tool card), `user` `tool_result`
  (tool output), `result` (final text + cost).
- **Permission UI**: `control_request:can_use_tool` → modal with `tool_name`, `input`, the reason,
  and `permission_suggestions` as one-tap options; reply `control_response`. The reason arrives in
  **`description`** — `decision_reason` is the control-schema's name for it and was never seen on
  the wire, so reading only that leaves the modal with no explanation. Handle
  `control_cancel_request` too, or the modal outlives the request.
- **Status chips**: `system:post_turn_summary`, `system:task_*`, `system:thinking_tokens`,
  `system:api_error`/`permission_denied`.
- **Session bootstrap**: `system:init` → tool list, model, permission mode.
- **Ignore**: `keep_alive`, our own `control_response` echoed back, unknown `system:*` (log, don't
  break) — treat unrecognized subtypes as forward-compatible no-ops. `test/history-audit.ts`
  reports which shapes a client is silently dropping (docs/HISTORY-EXPORT.md).
- **Controls the web can send**: `user` (with `client_platform`), `control_response`,
  and host `control_request` (`interrupt`, `set_permission_mode`, `set_model`).
