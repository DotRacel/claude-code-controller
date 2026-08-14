#!/usr/bin/env bash
# Full interactive /rc loop: server + injected interactive claude (tmux) + /rc, then drive the
# connected session from a web client and confirm reply + owner semantics.
set -u
cd /home/racel/claude-code-controller
rm -rf /tmp/ccc-logs; rm -f /tmp/ccc-smoke-server.log
tmux kill-session -t ccint 2>/dev/null; sleep 0.5
tmux new-session -d -s ccint -n cli -x 200 -y 50
tmux new-window -t ccint -n srv "cd /home/racel/claude-code-controller; exec node test/smoke-server.ts >/tmp/srv-stdout.log 2>&1"
sleep 3
tmux send-keys -t ccint:cli "exec node src/control-cli.ts --log-dir /tmp/ccc-logs --server http://127.0.0.1:8790 --credential smoke-cred" Enter
sleep 18
tmux send-keys -t ccint:cli "/rc" Enter
sleep 8
echo "=== injection HITs ==="; grep "HIT" /tmp/ccc-logs/latest.log
echo; echo "=== driving from web client ==="
node test/webclient.ts smoke-cred 8790
RC=$?
echo; echo "=== TUI ==="; tmux capture-pane -t ccint:cli -p | grep -v "^$" | tail -8
tmux kill-session -t ccint 2>/dev/null
echo "e2e exit=$RC"
