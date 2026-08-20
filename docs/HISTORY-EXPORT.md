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
node test/history-audit.ts artifacts/history/events.jsonl --promote   # → the fixture corpus
```

The audit feeds every payload through the real `web/src/model.ts` reducer and cross-checks two
independent signals:

| signal | where it comes from |
|---|---|
| **declared** | `verdictOf` in `src/wire-shape.ts` — `handled`, `ignored` (with a reason), or `unknown` = nobody decided yet |
| **measured** (`no-effect` column) | the payload is really reduced and the before/after state compared by reference |

Neither alone is enough, which is why both are printed. Measurement cannot tell a heartbeat we drop
on purpose from a subtype we have never seen — and that is the only distinction that matters when
deciding what to adapt next. A declaration, meanwhile, can be wrong or go stale. Together they
catch drift in both directions, and the report says so out loud:

- **`⚠ N shape(s) to adapt`** — present in this history, no rule in `src/wire-shape.ts`. This is
  the backlog. The same list, for a live deployment, is `npm run shape-report`.
- **`⚠ declared handled but never changed anything`** — a dead branch, or a rule that is lying.
  This is how `assistant:[redacted_thinking]` was found: the payload rule says handled, and the
  block type inside it is what nobody handles.
- **`⚠ declared ignored but DID change the transcript`** — the reverse.

Two more passes over the folded transcript follow:

- **Non-text `tool_result` content** — a `tool_result` whose `content` is an array of blocks
  rather than a string. Unknown block types render as a named placeholder (`[document]`), never as
  their JSON, and are counted under `block:` keys in `state.unhandled`.
- **Base64 blobs stringified into the transcript** — the same failure at its worst, with the total
  size, because that text is also what the history backfill pushes to the phone.

`--promote` appends one payload per undecided shape to `test/fixtures/transcript-shapes.jsonl`,
which makes `npm test` fail until each is handled or declared ignored. That is the point: the
corpus is what stops a shape from being quietly un-learned by a later refactor, so discovery and
regression coverage are one step. Image bytes are stripped and every string capped at 120 chars
(nothing about matching a shape needs the text) — but **read the diff before committing**, because
those lines came out of a real conversation and this audit has itself found an access token echoed
by a `Bash` call.

Re-run it after touching the reducer, and after a `claude` upgrade: a new CLI version emitting a
new `system` subtype shows up as a backlog entry instead of as a rendering bug.

## The backlog without an export

An export is a heavy way to ask a light question. `events.shape` — written by `insertEvents` with
the same `shapeOf()` the audit uses — makes "what has this deployment seen, and have we decided
about each?" one aggregate query:

```bash
DATABASE_URL=… npm run shape-report                  # just what needs a decision
DATABASE_URL=… npm run shape-report -- --backfill    # once per deployment, see below
DATABASE_URL=… npm run shape-report -- --all         # every shape, with verdicts and dates
PG_SCHEMA=ccc_test  npm run shape-report             # against the tests' own tables
```

Prefer this to an export whenever the question is about shapes: the report carries **no
conversation content** — shape names, counts, first/last dates, and an event id to look at if you
want one. The export is for when you need the payloads themselves.

The column needs no migration step (`ensureSchema` adds it on the next server boot), but rows
stored before it existed are `NULL` until `--backfill` stamps them. Run it once per deployment —
batched, keyed off `shape is null`, safe to interrupt and re-run — otherwise the report only sees
traffic since the upgrade, and the whole point is that the backlog is complete from day one.

The verdict is deliberately **not** stored. It is code: adapting a shape changes it, so a stored
copy would start lying the moment someone did the work.
