/**
 * capture-events.ts — drive a rich conversation and record every wire event that flows on
 * the CCR v2 SSE data-plane, so we know the exact shape of what the web front-end must
 * render (child→server) and send (server→child).
 *
 * Output:
 *   test/fixtures/child-events.jsonl   every child→server payload, one per line
 *   test/fixtures/event-samples.json   one representative sample per (type[:subtype])
 *   + a printed catalog of event kinds seen
 *
 * Run: node test/capture-events.ts   (uses the user's BYOK creds for real inference)
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createControllerServer, type ServerEvent } from '../src/server/index.ts';
import { launchWithGatesRebound } from '../src/injector/gate-rebind.ts';

const PROMPTS = [
  'Reply with exactly: hi',
  'Use the Write tool to create the file /tmp/ccc-cap.txt with the content: capture-sample',
  'Use the Read tool to read /tmp/ccc-cap.txt and report its content',
  'What is 2+2? Answer with just the number.',
];
const TURN_TIMEOUT_MS = 90000;

const ts = () => new Date().toISOString().slice(11, 23);

/** Stable key for de-duping into representative samples. */
function keyOf(p: any): string {
  if (!p || typeof p !== 'object') return String(p);
  if (p.type === 'system') return `system:${p.subtype ?? '?'}`;
  if (p.type === 'control_request') return `control_request:${p.request?.subtype ?? '?'}`;
  if (p.type === 'control_response') return `control_response:${p.response?.subtype ?? '?'}`;
  if (p.type === 'stream_event') return `stream_event:${p.event?.type ?? '?'}`;
  return String(p.type ?? '?');
}

async function main() {
  const claudeBin = process.env.CLAUDE_BIN || 'claude';
  const cwd = process.env.CCC_CWD || process.cwd();

  const allEvents: any[] = [];
  const samples = new Map<string, any>();
  const counts = new Map<string, number>();
  let sessionId: string | null = null;
  let wsConnected = false;
  let resolveWs: (() => void) | null = null;
  const wsPromise = new Promise<void>((r) => (resolveWs = r));
  let pushedForEnv: string | null = null;
  let onResult: (() => void) | null = null;

  const record = (payload: any) => {
    allEvents.push(payload);
    const k = keyOf(payload);
    counts.set(k, (counts.get(k) ?? 0) + 1);
    if (!samples.has(k)) samples.set(k, payload);
  };

  const server = await createControllerServer({
    onEvent: (e: ServerEvent) => {
      if (e.type === 'claude.event') {
        record(e.payload);
        const p = e.payload;
        if (p?.type === 'control_request' && p.request?.subtype === 'can_use_tool') {
          console.log(`${ts()} [permission] ${p.request.tool_name} → allow`);
          server.sendControlResponse(e.sessionId, p.request_id, 'allow');
        } else if (p?.type === 'result') {
          onResult?.();
        }
        return;
      }
      if (e.type === 'env.register' && pushedForEnv !== e.envId) {
        pushedForEnv = e.envId;
        setTimeout(() => void server.pushSessionWork(e.envId), 400);
      }
      if (e.type === 'ws.connect') { sessionId = e.sessionId; wsConnected = true; resolveWs?.(); }
    },
  });

  console.log(`${ts()} [capture] server @ ${server.baseUrl}; launching claude…`);
  const h = await launchWithGatesRebound({
    claudeBin, cwd,
    bridgeBaseUrl: server.baseUrl,
    bridgeToken: 'ccc_' + Math.random().toString(36).slice(2, 10),
    log: () => {},
    onStderr: () => {},
  });
  await Promise.race([wsPromise, new Promise((r) => setTimeout(r, 30000))]);
  if (!wsConnected || !sessionId) { console.error('handshake failed'); h.kill(); server.close(); process.exit(1); }
  console.log(`${ts()} [capture] connected (session ${sessionId}); running ${PROMPTS.length} turns\n`);
  await new Promise((r) => setTimeout(r, 1500));

  for (const prompt of PROMPTS) {
    console.log(`${ts()} 👤 ${prompt}`);
    const done = new Promise<void>((r) => (onResult = r));
    server.sendUserMessage(sessionId, prompt);
    await Promise.race([done, new Promise((r) => setTimeout(r, TURN_TIMEOUT_MS))]);
    onResult = null;
    await new Promise((r) => setTimeout(r, 500));
  }

  // Write fixtures
  const here = path.dirname(fileURLToPath(import.meta.url));
  const outDir = path.resolve(here, 'fixtures');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, 'child-events.jsonl'), allEvents.map((e) => JSON.stringify(e)).join('\n') + '\n');
  writeFileSync(path.join(outDir, 'event-samples.json'), JSON.stringify(Object.fromEntries(samples), null, 2));

  console.log(`\n===== EVENT CATALOG (${allEvents.length} total) =====`);
  for (const [k, n] of [...counts.entries()].sort()) console.log(`  ${k.padEnd(40)} ×${n}`);
  console.log(`\nwrote ${outDir}/child-events.jsonl + event-samples.json`);

  h.kill();
  server.close();
  process.exit(0);
}

main().catch((e) => { console.error('[capture] fatal:', e); process.exit(1); });
