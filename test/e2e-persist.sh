#!/usr/bin/env bash
# Persistence loop: real claude + real inference + real PostgreSQL, across a server restart.
#   inject → /rc → web message → reply → stop server → start a NEW server → transcript is back.
# This is the thing the JSON/in-memory store could not do.
#
# Needs: docker compose up -d db, a working `claude` (BYOK creds), tmux.
# Run: bash test/e2e-persist.sh
set -u
cd "$(dirname "$0")/.."
export DATABASE_URL="${DATABASE_URL:-postgres://ccc:ccc@127.0.0.1:5432/ccc}"
CRED=e2e-persist-cred
PORT=8787
EXPECT=PERSIST-OK

# Server processes are tracked by PID. Do NOT pkill -f on the command string: this script's own
# text contains it, so the pattern matches the script's shell and kills the run.
SRV=
start_server() { # $1 = logfile
  node src/server/main.ts >"$1" 2>&1 &
  SRV=$!
  for _ in $(seq 1 30); do ss -ltn 2>/dev/null | grep -q ":$PORT" && return 0; sleep 0.3; done
  echo "❌ server never listened on $PORT — see $1"; return 1
}
stop_server() { [ -n "$SRV" ] && kill -TERM "$SRV" 2>/dev/null; wait "$SRV" 2>/dev/null; SRV=; }
cleanup() { stop_server; tmux kill-session -t ccpersist 2>/dev/null; }
trap cleanup EXIT

rm -rf /tmp/ccc-logs; rm -f /tmp/ccc-persist-srv1.log /tmp/ccc-persist-srv2.log
# Clean slate for this credential only (events cascade with their sessions).
docker compose exec -T db psql -U ccc -d ccc -q \
  -c "delete from sessions where credential='$CRED'" \
  -c "delete from environments where credential='$CRED'" >/dev/null 2>&1

echo "=== server #1 (postgres) ==="
start_server /tmp/ccc-persist-srv1.log || exit 1
grep -E "postgres|loaded|listening" /tmp/ccc-persist-srv1.log

tmux kill-session -t ccpersist 2>/dev/null; sleep 0.5
tmux new-session -d -s ccpersist -n cli -x 200 -y 50
tmux send-keys -t ccpersist:cli "exec node src/control-cli.ts --log-dir /tmp/ccc-logs --server http://127.0.0.1:$PORT --credential $CRED" Enter
sleep 20
tmux send-keys -t ccpersist:cli "/rc" Enter
sleep 10
echo; echo "=== injection HITs ==="; grep -c HIT /tmp/ccc-logs/latest.log

echo; echo "=== round 1: drive it from the web (real inference) ==="
node test/webclient.ts "$CRED" "$PORT" "Reply with exactly: $EXPECT"; RC1=$?

echo; echo "=== what landed in postgres ==="
docker compose exec -T db psql -U ccc -d ccc -t \
  -c "select e.type, count(*) from events e join sessions s on s.id=e.session_id
        where s.credential='$CRED' group by e.type order by 2 desc"

echo "=== stop server #1 (graceful: flush + pool.end) ==="
stop_server
grep -q "shutting down" /tmp/ccc-persist-srv1.log && echo "graceful shutdown ✓" || echo "⚠️ no shutdown log"

echo; echo "=== server #2: a brand new process, same database ==="
start_server /tmp/ccc-persist-srv2.log || exit 1
grep -E "postgres|loaded|listening" /tmp/ccc-persist-srv2.log

echo; echo "=== round 2: transcript must come back (claude is gone) ==="
node test/history-check.ts "$CRED" "$PORT" "$EXPECT"; RC2=$?

echo; echo "=== TUI ==="; tmux capture-pane -t ccpersist:cli -p 2>/dev/null | grep -v "^$" | tail -6
echo "e2e-persist: round1=$RC1 restart=$RC2"
[ "$RC1" -eq 0 ] && [ "$RC2" -eq 0 ]
