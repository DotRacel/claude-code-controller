/**
 * cli.ts — test driver for claude-code-controller.
 *
 *   handshake (v1): start server → launch injected `claude remote-control` → gates rebound
 *   → environment registered → session work → child spawned → child gate rebound → child
 *   connects the CCR v2 SSE data-plane.
 *   conversation (v2): once connected, relay a user message over the SSE data-plane and
 *   print the child's streamed reply; auto-answer can_use_tool permission requests.
 *
 * Run:
 *   node src/cli.ts                     # one scripted turn (CCC_PROMPT overrides the text)
 *   node src/cli.ts --interactive       # multi-turn REPL (type /quit to exit)
 *   node src/cli.ts --deny              # deny tool-use permission requests
 */
import readline from 'node:readline';
import { createControllerServer, type ServerEvent } from './server/index.ts';
import { launchWithGatesRebound } from './injector/gate-rebind.ts';

const OBSERVE_MS = Number(process.env.CCC_OBSERVE_MS || 30000);
const TURN_TIMEOUT_MS = Number(process.env.CCC_TURN_TIMEOUT_MS || 90000);
const INTERACTIVE = process.argv.includes('--interactive') || process.argv.includes('-i');
const AUTO_DENY = process.argv.includes('--deny');
const STREAM = process.argv.includes('--stream');
const PROMPT = process.env.CCC_PROMPT || 'Reply with exactly: hello from remote-control';

const ts = () => new Date().toISOString().slice(11, 23);

function extractText(msg: any): string {
  const c = msg?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.filter((b) => b?.type === 'text').map((b) => b.text).join('');
  return '';
}

async function main() {
  const claudeBin = process.env.CLAUDE_BIN || 'claude';
  const cwd = process.env.CCC_CWD || process.cwd();
  const bridgeToken = 'ccc_' + Math.random().toString(36).slice(2, 12);

  let sessionId: string | null = null;
  let wsConnected = false;
  let resolveWs: (() => void) | null = null;
  const wsPromise = new Promise<void>((r) => (resolveWs = r));
  let pushedForEnv: string | null = null;
  let onResult: (() => void) | null = null; // resolves the in-flight turn on a `result`

  function handleClaudeEvent(sid: string, payload: any) {
    const t = payload?.type;
    if (t === 'assistant') {
      const text = extractText(payload.message);
      if (text) console.log(`\n🤖 ${text}`);
    } else if (t === 'stream_event') {
      if (STREAM) {
        const d = payload.event?.delta?.text ?? payload.event?.delta?.partial_json;
        if (d) process.stdout.write(d);
      }
    } else if (t === 'result') {
      const r = typeof payload.result === 'string' ? payload.result : JSON.stringify(payload.result ?? '');
      console.log(`\n${ts()} [result] ${payload.subtype ?? ''}${payload.is_error ? ' (error)' : ''} ${String(r).slice(0, 300)}`);
      onResult?.();
    } else if (t === 'control_request' && payload.request?.subtype === 'can_use_tool') {
      const tool = payload.request.tool_name;
      const behavior = AUTO_DENY ? 'deny' : 'allow';
      console.log(`\n${ts()} [permission] can_use_tool ${tool} ${JSON.stringify(payload.request.input ?? {}).slice(0, 120)} → ${behavior}`);
      server.sendControlResponse(sid, payload.request_id, behavior);
    } else if (t === 'system') {
      if (payload.subtype) console.log(`${ts()} [system] ${payload.subtype}`);
    }
  }

  const server = await createControllerServer({
    onEvent: (e: ServerEvent) => {
      if (e.type === 'http') return;
      if (e.type === 'claude.event') { handleClaudeEvent(e.sessionId, e.payload); return; }
      if (e.type === 'ws.message') return; // legacy WS path, unused on 2.1.231
      console.log(`${ts()} [server] ${e.type}${'envId' in e && e.envId ? ' env=' + e.envId : ''}${'sessionId' in e && (e as any).sessionId ? ' ses=' + (e as any).sessionId : ''}${'delivered' in e && e.delivered ? ' →' + e.delivered : ''}`);

      if (e.type === 'env.register' && pushedForEnv !== e.envId) {
        pushedForEnv = e.envId;
        setTimeout(() => {
          const r = server.pushSessionWork(e.envId);
          console.log(`${ts()} [cli] pushed session work → session=${r?.session.id}`);
        }, 400);
      }
      if (e.type === 'ws.connect') { sessionId = e.sessionId; wsConnected = true; resolveWs?.(); }
    },
  });

  console.log(`${ts()} [cli] controller server @ ${server.baseUrl}`);
  console.log(`${ts()} [cli] launching ${claudeBin} remote-control (cwd=${cwd})`);

  const h = await launchWithGatesRebound({
    claudeBin,
    cwd,
    bridgeBaseUrl: server.baseUrl,
    bridgeToken,
    extraArgs: [
      ...(process.env.CCC_VERBOSE ? ['--verbose'] : []),
      ...(process.env.CCC_DEBUG_FILE ? ['--debug-file', process.env.CCC_DEBUG_FILE] : []),
    ],
    log: (m) => console.log(`${ts()} ${m}`),
    onStderr: (s) => process.stderr.write(`\x1b[2m[claude] ${s}\x1b[0m`),
  });

  console.log(`${ts()} [cli] gates: ` + h.reports.map((r) => `${r.id}=${r.located && r.reboundOk ? 'ok' : r.located ? 'located' : 'MISS'}`).join(' '));

  await Promise.race([wsPromise, new Promise((r) => setTimeout(r, OBSERVE_MS))]);

  const cleanup = (code: number) => { h.kill(); server.close(); process.exit(code); };

  if (!wsConnected || !sessionId) {
    console.log('\n⚠️  handshake did not reach the data plane — see logs above');
    cleanup(1);
    return;
  }
  console.log(`\n✅ handshake reached the data plane (session ${sessionId}) — starting conversation\n`);

  // Give the child a moment to finish worker init before the first message.
  await new Promise((r) => setTimeout(r, 1500));

  async function sendAndWait(text: string): Promise<void> {
    console.log(`\n👤 ${text}`);
    const done = new Promise<void>((r) => (onResult = r));
    if (!server.sendUserMessage(sessionId!, text)) console.log(`${ts()} [cli] WARN: no SSE stream to send on`);
    await Promise.race([done, new Promise((r) => setTimeout(r, TURN_TIMEOUT_MS))]);
    onResult = null;
  }

  if (INTERACTIVE) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ask = () => rl.question('\n👤 > ', async (line) => {
      const s = line.trim();
      if (s === '/quit' || s === '/exit') { rl.close(); cleanup(0); return; }
      if (s) await sendAndWait(s);
      ask();
    });
    ask();
  } else {
    await sendAndWait(PROMPT);
    console.log('\n✅ conversation round complete');
    cleanup(0);
  }
}

main().catch((e) => { console.error('[cli] fatal:', e); process.exit(1); });
