/**
 * webclient.ts — drive the first session of a credential over /ws/client: send a message,
 * print the assistant reply, and flag owner-vs-peer. Used by e2e-interactive.sh after `/rc`
 * connects an interactive session, to confirm the full web loop + that a relayed message is
 * treated as owner keyboard input (not a cross-session peer).
 * Run: node test/webclient.ts <credential> <port> [text]
 */
const CRED = process.argv[2] || 'smoke-cred';
const PORT = process.argv[3] || '8790';
const TEXT = process.argv[4] || 'Reply with exactly: RC-OWNER-OK';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, ms: number) { const dl = Date.now() + ms; while (Date.now() < dl) { if (cond()) return true; await sleep(200); } return false; }

const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/client?credential=${CRED}`);
let sessions: any[] = [];
const events: any[] = [];
let history: any[] = [];
ws.onmessage = (e) => { const m = JSON.parse(e.data as string); if (m.type === 'sessions') sessions = m.sessions; else if (m.type === 'event') events.push(m.payload); else if (m.type === 'history') history = m.events || []; };
await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error('ws error')); });
await sleep(600);

console.log('sessions:', JSON.stringify(sessions.map((s: any) => ({ id: s.id, m: s.machine, status: s.status }))));
if (!sessions.length) { console.log('❌ NO SESSIONS'); process.exit(1); }
const sid = sessions[0].id;
ws.send(JSON.stringify({ type: 'subscribe', sessionId: sid }));
await sleep(600);
const htext = history
  .filter((p) => p.type === 'user' || p.type === 'assistant')
  .map((p) => { const c = p.message?.content; if (typeof c === 'string') return `[u]${c}`; return (Array.isArray(c) ? c : []).map((b: any) => (b.type === 'text' ? `[${p.type[0]}]${b.text}` : `[${b.type}]`)).join(''); })
  .join(' | ');
console.log(`history backfill: ${history.length} events; text = ${htext.slice(0, 200)}`);
console.log(`👤 (web) ${TEXT}`);
ws.send(JSON.stringify({ type: 'user_message', sessionId: sid, text: TEXT }));

// Wait for the REPLY, not merely for a `result`: a turn that was already in flight when we
// subscribed can land its own result first and end the wait before Claude has said anything.
const got = await waitFor(() => events.some((p) => p.type === 'assistant' && p.message?.content?.some?.((b: any) => b.type === 'text')), 90000);
const asst = events.filter((p) => p.type === 'assistant').pop();
const txt = asst?.message?.content?.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('') ?? '';
const peer = events.some((p) => { const s = JSON.stringify(p); return s.includes('"peer"') || s.includes('Another Claude'); });
console.log(`🤖 ${txt.trim().slice(0, 80)}`);
console.log(`result: ${got ? '✅' : '❌ timeout'}   owner(no-peer): ${peer ? '❌ PEER' : '✅ owner'}`);
// Which event types the interactive (/rc) data-plane actually delivers. `stream_event` here or
// not decides whether the phone can render token-by-token or only whole messages.
const hist: Record<string, number> = {};
for (const p of events) {
  const k = p.type === 'system' ? `system:${p.subtype}` : p.type === 'stream_event' ? `stream_event:${p.event?.type ?? '?'}` : p.type;
  hist[k] = (hist[k] || 0) + 1;
}
console.log('event types:', JSON.stringify(hist));
process.exit(got && !peer ? 0 : 1);
