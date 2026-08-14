/**
 * e2e-web.ts — full hosted-web loop in one process (uses real BYOK inference):
 *   central server + web-channel  ←bridge─  injected `claude remote-control` (control-cli path)
 *                                 ←/ws/client (Node WebSocket, standing in for the phone)
 * Asserts: session appears in the credential's list → send a message → streamed reply →
 * a tool prompt → permission round-trip → tool runs.
 *
 * Run: node test/e2e-web.ts
 */
import { createControllerServer, type ServerEvent } from '../src/server/index.ts';
import { attachWebChannel } from '../src/server/web-channel.ts';
import { launchWithGatesRebound } from '../src/injector/gate-rebind.ts';
import { existsSync, rmSync } from 'node:fs';

const CRED = 'dev-e2e-AAA';
const ts = () => new Date().toISOString().slice(11, 23);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, ms: number, label: string) {
  const dl = Date.now() + ms;
  while (Date.now() < dl) { if (cond()) return; await sleep(200); }
  throw new Error(`timeout waiting for ${label}`);
}

async function main() {
  let web: ReturnType<typeof attachWebChannel> | null = null;
  const server = await createControllerServer({ port: 0, host: '127.0.0.1', onEvent: (e: ServerEvent) => { web?.handleEvent(e); } });
  web = attachWebChannel(server.server, server, server.store);
  const base = `http://127.0.0.1:${server.port}`;
  console.log(`${ts()} server @ ${base}; launching injected claude (cred=${CRED})…`);

  const h = await launchWithGatesRebound({ bridgeBaseUrl: base, bridgeToken: CRED, cwd: process.cwd(), log: () => {}, onStderr: () => {} });

  await waitFor(() => [...server.store.sessions.values()].some((s) => s.wsConnected), 45000, 'child SSE connect');
  console.log(`${ts()} session online. connecting web socket…`);

  // ── stand in for the phone ──
  const events: any[] = [];
  let sessions: any[] = [];
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws/client?credential=${CRED}`);
  ws.onmessage = (e) => { const m = JSON.parse(e.data as string); if (m.type === 'sessions') sessions = m.sessions; else if (m.type === 'event') events.push(m.payload); };
  await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error('ws error')); });
  await sleep(400);

  if (!sessions.length) throw new Error('web received no sessions');
  const s0 = sessions[0];
  console.log(`${ts()} session list: machine=${s0.machine} dir=${s0.dir} status=${s0.status}`);
  const sid = s0.id;
  ws.send(JSON.stringify({ type: 'subscribe', sessionId: sid }));
  await sleep(200);

  // turn 1: plain reply
  console.log(`${ts()} 👤 (web) Reply with exactly: web-ok`);
  ws.send(JSON.stringify({ type: 'user_message', sessionId: sid, text: 'Reply with exactly: web-ok' }));
  await waitFor(() => events.some((p) => p.type === 'result'), 60000, 'turn-1 result');
  const asst = events.find((p) => p.type === 'assistant');
  const asstText = asst?.message?.content?.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('') ?? '';
  console.log(`${ts()} 🤖 ${asstText.trim()}`);

  // turn 2: tool → permission round-trip
  rmSync('/tmp/web-cap.txt', { force: true });
  console.log(`${ts()} 👤 (web) Use the Write tool to create /tmp/web-cap.txt with: WEB_PERM`);
  const before = events.length;
  ws.send(JSON.stringify({ type: 'user_message', sessionId: sid, text: 'Use the Write tool to create the file /tmp/web-cap.txt with exactly the content: WEB_PERM' }));
  await waitFor(() => events.slice(before).some((p) => p.type === 'control_request' && p.request?.subtype === 'can_use_tool'), 60000, 'can_use_tool');
  const cr = events.slice(before).find((p) => p.type === 'control_request');
  console.log(`${ts()} 🔐 (web) permission: ${cr.request.tool_name} → allow`);
  ws.send(JSON.stringify({ type: 'permission_response', sessionId: sid, requestId: cr.request_id, behavior: 'allow' }));
  await waitFor(() => events.slice(before).some((p) => p.type === 'result'), 60000, 'turn-2 result');

  await sleep(300);
  const wrote = existsSync('/tmp/web-cap.txt');
  console.log('\n===== WEB E2E RESULT =====');
  console.log(`session in list:       ✅ ${s0.machine}`);
  console.log(`reply received:        ${asstText.includes('web-ok') ? '✅' : '⚠️'} "${asstText.trim().slice(0, 40)}"`);
  console.log(`permission round-trip: ${cr ? '✅' : '❌'}`);
  console.log(`tool executed (file):  ${wrote ? '✅' : '❌'}`);
  const ok = sessions.length > 0 && !!cr && wrote;
  console.log(`\n${ok ? '✅ PASS — hosted web loop works end to end' : '⚠️ PARTIAL — see above'}`);

  rmSync('/tmp/web-cap.txt', { force: true });
  ws.close();
  h.kill();
  server.close();
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error('[e2e-web] fatal:', e); process.exit(1); });
