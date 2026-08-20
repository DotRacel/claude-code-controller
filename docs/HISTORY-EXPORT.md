# Exporting and auditing transcript history

The server keeps every data-plane payload it ever relayed in PostgreSQL (`events.payload`, one
stream-json SDK message per row, ordered by the globally monotonic `events.id`). That table is the
ground truth for what the phone UI has to render — so when a message shows up wrong on a phone,
the answer is in there, not in a screenshot.

## Export

```bash
npm run export-history                 # → artifacts/history/{sessions.json,events.jsonl}
```

The script reads the db container with `docker exec` (default `ccc-pg`, override `PG_CONTAINER`),
so a `docker compose` deployment needs no client tooling. Options:

```bash
scripts/export-history.sh /tmp/dump              # somewhere else
scripts/export-history.sh --session cse_1a2b3c   # one session
scripts/export-history.sh --full                 # keep base64 image data
DATABASE_URL=postgres://ccc:ccc@host:5432/ccc scripts/export-history.sh   # needs psql
```

For a remote deployment, run it on the host and copy the directory back — or open an SSH tunnel to
the database and use the `DATABASE_URL` form.

**Base64 image blobs are stripped by default.** One screenshot read is ~600 KB of base64 — and it
is stored *twice*, once as an image content block and once in `tool_use_result.file.base64`, so the
blobs dominated the first real export at 29.4 MB of 40.5 MB. Nothing about message *shape* needs
the bytes. `--full` keeps them for anything that has to re-render the real image.

`events.jsonl` holds one `{sid, eid, p}` envelope per line — `p` is the payload, in replay order.
`test/history-audit.ts` also accepts bare payloads per line, so a hand-made fixture works.

> The dump is raw conversation history: prompts, file contents, command output, and any credential
> a tool ever echoed. Treat it like a log archive, and prefer sharing the audit report over the
> dump itself.

## Audit

```bash
npm run history-audit artifacts/history/events.jsonl
node test/history-audit.ts artifacts/history/events.jsonl --samples   # + one payload per shape
```

The audit feeds every payload through the real `web/src/model.ts` reducer and reports what the
front-end does *not* turn into anything on screen. Detection is dynamic rather than a hand-kept
list of supported types — `reduce` returns the same state object for a type it does not know, so:

| column | meaning |
|---|---|
| `ignored` | the reducer returned the state unchanged — the type is unknown to it |
| `inert` | consumed, but nothing visible changed (a `live` flag, a duplicate suppressed) |
| `← never rendered` / `← no visible effect` | *every* payload of that shape produced nothing |

A shape that is entirely `ignored`/`inert` is either deliberate (`control_response` echoes are
noise) or a gap. The report ends with two more passes over the folded transcript:

- **Non-text `tool_result` content** — a `tool_result` whose `content` is an array of blocks
  rather than a string. `textOf` stringifies those, so they reach the screen as raw JSON.
- **Base64 blobs stringified into the transcript** — the same failure at its worst, with the total
  size, because that text is also what the history backfill pushes to the phone.

Re-run it after touching the reducer, and after a `claude` upgrade: a new CLI version emitting a
new `system` subtype shows up as a number instead of as a rendering bug.
