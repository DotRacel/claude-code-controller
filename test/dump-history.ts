/** Dump the raw history payloads of a credential's first session, to inspect user-message
 * shapes (which are synthetic/meta and should not render). Run: node test/dump-history.ts <cred> [port] */
const CRED = process.argv[2];
const PORT = process.argv[3] || '8787';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/client?credential=${CRED}`);
let sessions: any[] = [];
let history: any[] = [];
ws.onmessage = (e) => { const m = JSON.parse(e.data as string); if (m.type === 'sessions') sessions = m.sessions; else if (m.type === 'history') history = m.events || []; };
await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error('ws error')); });
await sleep(500);
if (!sessions.length) { console.log('no sessions for this credential'); process.exit(1); }
const sid = sessions[0].id;
console.log(`session ${sid} (${sessions[0].machine})`);
ws.send(JSON.stringify({ type: 'subscribe', sessionId: sid }));
await sleep(900);
console.log(`history: ${history.length} events`);
const counts: Record<string, number> = {};
for (const p of history) counts[p.type] = (counts[p.type] || 0) + 1;
console.log('types:', JSON.stringify(counts));
console.log('\n--- USER messages (raw, first 500 chars each) ---');
for (const p of history) {
  if (p.type !== 'user') continue;
  const meta = { isMeta: p.isMeta, isReplay: p.isReplay, parent: p.parent_tool_use_id, isCompact: p.isCompactSummary, isSidechain: p.isSidechain };
  console.log(`\n[user] meta=${JSON.stringify(meta)}`);
  console.log(JSON.stringify(p.message?.content).slice(0, 500));
}
process.exit(0);
