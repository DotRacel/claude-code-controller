/**
 * history-check.ts — subscribe to a credential's newest session over /ws/client and assert the
 * transcript came back. Used by e2e-persist.sh against a freshly restarted server: no claude
 * needs to be running, since the history is served from PostgreSQL.
 * Run: node test/history-check.ts <credential> [port] [expected-substring]
 */
const CRED = process.argv[2];
const PORT = process.argv[3] || '8787';
const EXPECT = process.argv[4]; // optional substring the transcript must contain
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/client?credential=${CRED}`);
let sessions: any[] = [];
let history: any[] | null = null;
ws.onmessage = (e) => {
  const m = JSON.parse(e.data as string);
  if (m.type === 'sessions') sessions = m.sessions;
  else if (m.type === 'history') history = m.events || [];
};
await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error('ws connect failed')); });
await sleep(800);

console.log('sessions:', JSON.stringify(sessions.map((s: any) => ({ id: s.id, m: s.machine, dir: s.dir, status: s.status }))));
if (!sessions.length) { console.log('❌ session list empty'); process.exit(1); }

ws.send(JSON.stringify({ type: 'subscribe', sessionId: sessions[0].id }));
await sleep(1200);
if (!history) { console.log('❌ no history frame'); process.exit(1); }

const types: Record<string, number> = {};
for (const p of history) { const t = (p as any)?.type ?? '?'; types[t] = (types[t] || 0) + 1; }
const text = history
  .filter((p: any) => p.type === 'user' || p.type === 'assistant')
  .map((p: any) => {
    const c = p.message?.content;
    if (typeof c === 'string') return `[u]${c}`;
    return (Array.isArray(c) ? c : []).map((b: any) => (b.type === 'text' ? `[${p.type[0]}]${b.text}` : `[${b.type}]`)).join('');
  })
  .join(' | ');

console.log(`history: ${history.length} events`, JSON.stringify(types));
console.log('text:', text.replace(/\s+/g, ' ').slice(0, 300));

const hasStream = 'stream_event' in types; // must never be persisted
const hasExpected = !EXPECT || text.includes(EXPECT);
const ok = history.length > 0 && !hasStream && hasExpected;
console.log(ok ? '✅ transcript restored from postgres' : `❌ events=${history.length} stream_event=${hasStream} expected=${hasExpected}`);
process.exit(ok ? 0 : 1);
