#!/usr/bin/env bash
# export-history.sh — dump a deployed server's transcript history for offline analysis.
#
# The history lives in PostgreSQL (`events.payload`, one stream-json SDK message per row), so a
# docker deployment needs nothing but psql inside the db container. Two files land in the output
# directory: sessions.json (metadata) and events.jsonl (one {sid,eid,p} envelope per line, in the
# globally monotonic `events.id` order the transcript is replayed in).
#
# Base64 image blobs are replaced with a placeholder by default: a single screenshot read is
# ~600 KB of base64, they dominate the dump, and no shape analysis needs the bytes. Pass --full
# to keep them.
#
# Usage:
#   scripts/export-history.sh [outdir] [--full] [--session <id>]
#
# Against a remote host, run it there and copy the directory back, or point it at a tunnelled
# database instead:
#   PG_CONTAINER=ccc-pg  scripts/export-history.sh              # docker deployment (default)
#   DATABASE_URL=postgres://user:pw@host:5432/ccc  scripts/export-history.sh
#
# NOTE: the dump is your raw conversation history — prompts, file contents, command output, and
# any credential that was ever echoed by a tool. Treat it like a log archive.
set -euo pipefail

OUT="artifacts/history"
FULL=0
SESSION=""
while [ $# -gt 0 ]; do
  case "$1" in
    --full) FULL=1 ;;
    --session) SESSION="${2:?--session needs an id}"; shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) OUT="$1" ;;
  esac
  shift
done

PG_CONTAINER="${PG_CONTAINER:-ccc-pg}"
PG_USER="${PG_USER:-ccc}"
PG_DB="${PG_DB:-ccc}"

# One indirection so the two transports (container exec / direct URL) share the query text.
if [ -n "${DATABASE_URL:-}" ]; then
  command -v psql >/dev/null || {
    echo "DATABASE_URL is set but psql is not installed — install postgresql-client," >&2
    echo "or unset DATABASE_URL to read the db container with docker exec instead." >&2
    exit 1
  }
  psql_q() { psql "$DATABASE_URL" -At -c "$1"; }
  echo "source: ${DATABASE_URL%%:*}://… (direct)"
else
  command -v docker >/dev/null || { echo "docker not found and DATABASE_URL unset" >&2; exit 1; }
  docker inspect "$PG_CONTAINER" >/dev/null 2>&1 || {
    echo "container '$PG_CONTAINER' not found — set PG_CONTAINER or DATABASE_URL" >&2
    echo "running postgres containers:" >&2
    docker ps --filter ancestor=postgres --format '  {{.Names}}' >&2 || true
    exit 1
  }
  psql_q() { docker exec -i "$PG_CONTAINER" psql -U "$PG_USER" -d "$PG_DB" -At -c "$1"; }
  echo "source: docker exec $PG_CONTAINER (db=$PG_DB user=$PG_USER)"
fi

mkdir -p "$OUT"

WHERE=""
[ -n "$SESSION" ] && WHERE="where session_id = '$(printf '%s' "$SESSION" | tr -d "'")'"

psql_q "select coalesce(jsonb_agg(to_jsonb(s) order by s.last_activity desc), '[]'::jsonb)::text
        from (select id, credential, env_id, work_id, machine_name, dir, branch, created_at,
                     last_activity, digest from sessions) s" > "$OUT/sessions.json"

psql_q "select jsonb_build_object('sid', session_id, 'eid', id, 'p', payload)::text
        from events $WHERE order by id" > "$OUT/events.raw.jsonl"

if [ "$FULL" = "1" ]; then
  mv "$OUT/events.raw.jsonl" "$OUT/events.jsonl"
else
  # Strip the bytes, keep the shape: an image block stays an image block, its data becomes a note.
  node -e '
    const fs = require("node:fs");
    const [src, dst] = process.argv.slice(1);
    const out = fs.createWriteStream(dst);
    let n = 0, saved = 0;
    for (const line of fs.readFileSync(src, "utf8").split("\n")) {
      if (!line.trim()) continue;
      let o; try { o = JSON.parse(line) } catch { out.write(line + "\n"); continue }
      // Any long base64 field, whichever name carries it: an image block holds it as `source.data`
      // and `tool_use_result.file.base64` holds the SAME bytes again, so keying on the block shape
      // alone left half the weight in the dump.
      const walk = (v) => {
        if (Array.isArray(v)) return v.map(walk);
        if (v && typeof v === "object") {
          const r = {};
          for (const k of Object.keys(v)) {
            const x = v[k];
            if ((k === "data" || k === "base64") && typeof x === "string" && x.length > 512) {
              n++; saved += x.length;
              r[k] = `<stripped ${x.length} base64 chars>`;
            } else r[k] = walk(x);
          }
          return r;
        }
        return v;
      };
      out.write(JSON.stringify(walk(o)) + "\n");
    }
    out.end();
    console.error(`stripped ${n} base64 blob(s), ${(saved / 1e6).toFixed(1)} MB`);
  ' "$OUT/events.raw.jsonl" "$OUT/events.jsonl"
  rm -f "$OUT/events.raw.jsonl"
fi

echo "sessions: $(node -e 'console.log(JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")).length)' "$OUT/sessions.json")"
echo "events:   $(wc -l < "$OUT/events.jsonl") ($(du -h "$OUT/events.jsonl" | cut -f1))"
echo "wrote $OUT/{sessions.json,events.jsonl}"
echo
echo "next: node test/history-audit.ts $OUT/events.jsonl"
