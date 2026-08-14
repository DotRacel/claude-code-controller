/**
 * question-client.ts — prove the AskUserQuestion round trip on a real wire.
 *
 * The tool always asks permission (its checkPermissions returns `behavior:"ask"`), so the phone
 * receives a `control_request:can_use_tool` and must answer with
 * `{behavior:'allow', updatedInput:{questions, answers}}` — the answers keyed by question text.
 * This drives that end to end and asserts the model actually received the chosen option.
 *
 * Run: node test/question-client.ts <credential> <port>
 */
const CRED = process.argv[2] || 'smoke-cred';
const PORT = process.argv[3] || '8790';
const PROMPT = process.argv[4]
  || 'Call the AskUserQuestion tool exactly once, with one question: "选哪个颜色?" and two options labelled "红色" and "蓝色". After I answer, reply with exactly: PICKED=<the label I chose>';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, ms: number) { const dl = Date.now() + ms; while (Date.now() < dl) { if (cond()) return true; await sleep(200); } return false; }

const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/client?credential=${CRED}`);
let sessions: any[] = [];
const events: any[] = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data as string);
  if (m.type === 'sessions') sessions = m.sessions;
  else if (m.type === 'event') events.push(m.payload);
};
await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error('ws error')); });
await sleep(600);
if (!sessions.length) { console.log('❌ NO SESSIONS'); process.exit(1); }
const sid = sessions[0].id;
ws.send(JSON.stringify({ type: 'subscribe', sessionId: sid }));
await sleep(600);

console.log(`👤 ${PROMPT.slice(0, 60)}…`);
ws.send(JSON.stringify({ type: 'user_message', sessionId: sid, text: PROMPT }));

// 1. the permission request carrying the questions
const asked = await waitFor(() => events.some((p) => p.type === 'control_request' && p.request?.tool_name === 'AskUserQuestion'), 120000);
if (!asked) { console.log('❌ AskUserQuestion never arrived'); process.exit(1); }
const req = events.find((p) => p.type === 'control_request' && p.request?.tool_name === 'AskUserQuestion');
const questions = req.request.input?.questions ?? [];
console.log(`❓ ${questions.length} question(s): ${questions.map((q: any) => `${q.header ?? ''}｜${q.question} [${(q.options ?? []).map((o: any) => o.label).join(' / ')}]`).join(' ; ')}`);
if (!questions.length || !questions[0].options?.length) { console.log('❌ no options to answer with'); process.exit(1); }

// 2. answer it the way the phone does
const q0 = questions[0];
const choice = q0.options[0].label;
const answers: Record<string, string> = { [q0.question]: choice };
for (const q of questions.slice(1)) answers[q.question] = q.options?.[0]?.label ?? '';
console.log(`✅ answering: ${JSON.stringify(answers)}`);
ws.send(JSON.stringify({
  type: 'permission_response', sessionId: sid, requestId: req.request_id,
  behavior: 'allow', updatedInput: { questions, answers },
}));

// 3. the tool_result must echo our choice back to the model, and the model must see it
const ok = await waitFor(() => events.some((p) => p.type === 'result'), 120000);
const toolResult = events
  .filter((p) => p.type === 'user' && Array.isArray(p.message?.content))
  .flatMap((p) => p.message.content)
  .find((b: any) => b?.type === 'tool_result' && typeof b.content === 'string' && b.content.includes(choice));
const finalText = events.filter((p) => p.type === 'assistant')
  .flatMap((p) => p.message?.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join(' ');

console.log(`🔁 tool_result echoes our answer: ${toolResult ? '✅' : '❌'} ${toolResult ? JSON.stringify(String(toolResult.content).slice(0, 120)) : ''}`);
console.log(`🤖 ${finalText.trim().slice(0, 160)}`);
const modelSaw = finalText.includes(choice);
console.log(`model received the answer: ${modelSaw ? '✅' : '❌'}   turn finished: ${ok ? '✅' : '❌'}`);
process.exit(toolResult && modelSaw ? 0 : 1);
