/**
 * model.test.ts — the transcript reducer against REAL captured events.
 *
 * `test/fixtures/transcript-shapes.jsonl` is one instance of every payload shape a real
 * vibe-coding session produced (plus two shapes that session never hit — post_turn_summary and
 * stream_event — transcribed from docs/EVENTS.md). The assertions are invariants, not golden
 * output: what must never happen for the phone to read like Claude Code.
 *
 * Run: node --test test/model.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { reduce, reduceAll, initialState, localSend, turnActiveIn, type Item, type TranscriptState } from '../web/src/model.ts';
import { resultLine } from '../web/src/tools.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const EVENTS: any[] = fs.readFileSync(path.join(here, 'fixtures/transcript-shapes.jsonl'), 'utf8')
  .split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));

const history = () => reduceAll(EVENTS, { isHistory: true });
const kinds = (s: TranscriptState) => s.items.map((i) => i.kind);
const only = <K extends Item['kind']>(s: TranscriptState, k: K) => s.items.filter((i) => i.kind === k) as Extract<Item, { kind: K }>[];

test('the fixture still covers every shape the reducer branches on', () => {
  const seen = new Set(EVENTS.map((e) => (e.type === 'system' ? `system:${e.subtype}` : e.type === 'control_request' ? `control_request:${e.request?.subtype}` : e.type)));
  for (const want of ['user', 'assistant', 'result', 'stream_event', 'control_request:can_use_tool',
    'system:init', 'system:thinking_tokens', 'system:task_started', 'system:task_notification',
    'system:background_tasks_changed', 'system:post_turn_summary']) {
    assert.ok(seen.has(want), `fixture lost coverage of ${want}`);
  }
});

test('no raw JSON ever reaches a rendered item', () => {
  const s = history();
  for (const it of s.items) {
    const texts: string[] = [];
    if (it.kind === 'user' || it.kind === 'prose' || it.kind === 'thinking') texts.push(it.text);
    if (it.kind === 'status') texts.push(it.text);
    if (it.kind === 'error') texts.push(it.title, it.detail ?? '');
    if (it.kind === 'bgtask') texts.push(it.description);
    for (const t of texts) {
      // `{"` or `[{` / `["` — not a bare bracket, since Claude's own copy contains lines like
      // "[Request interrupted by user]".
      assert.ok(!/^\s*[{[]\s*["{]/.test(t), `raw JSON rendered in a ${it.kind}: ${t.slice(0, 60)}`);
    }
  }
});

test('synthetic user messages never become a bubble', () => {
  const s = history();
  // The fixture contains a <local-command-caveat> and a <command-name>/clear payload.
  assert.ok(EVENTS.some((e) => typeof e.message?.content === 'string' && e.message.content.startsWith('<local-command-caveat')));
  assert.ok(EVENTS.some((e) => typeof e.message?.content === 'string' && e.message.content.startsWith('<command-name>')));
  for (const u of only(s, 'user')) {
    assert.ok(!/^</.test(u.text), `synthetic user text rendered: ${u.text.slice(0, 40)}`);
  }
});

test('every tool call is threaded to its result', () => {
  const s = history();
  const calls = only(s, 'tools').flatMap((t) => t.calls);
  assert.ok(calls.length >= 3, 'fixture should contain several tool calls');
  const settled = calls.filter((c) => c.status === 'ok' || c.status === 'error');
  assert.ok(settled.length >= 2, 'tool_results did not reach their cards');
  for (const c of settled) assert.equal(typeof c.result, 'string');
  // One of the fixture's results is an error; it must be marked, not silently rendered as ok.
  assert.ok(calls.some((c) => c.status === 'error'), 'the is_error tool_result lost its error state');
});

test('AskUserQuestion is a question card, never a tool row', () => {
  const s = history();
  const qs = only(s, 'question');
  assert.equal(qs.length, 1);
  assert.ok(qs[0].questions.length >= 1);
  assert.ok(qs[0].questions[0].options.length >= 2, 'options must survive for the card to be answerable');
  const calls = only(s, 'tools').flatMap((t) => t.calls);
  assert.ok(!calls.some((c) => c.name === 'AskUserQuestion'), 'AskUserQuestion leaked into a tool group');
});

test('a question with a tool_result is settled; one without stays answerable', () => {
  const answered = reduceAll(EVENTS, { isHistory: true });
  // Drop the tool_result that answers it and the card must stay open — a replayed transcript
  // can legitimately carry a request the CLI is still blocked on.
  const withoutResult = EVENTS.filter((e) => !(e.type === 'user' && Array.isArray(e.message?.content)
    && e.message.content.some((b: any) => b.type === 'tool_result' && b.tool_use_id === answered.items.find((i) => i.kind === 'question')?.toolUseId)));
  const open = reduceAll(withoutResult, { isHistory: true });
  assert.equal(open.items.filter((i) => i.kind === 'question')[0]?.answered, undefined);
});

test('thinking blocks arrive textless and still produce a marker', () => {
  const block = EVENTS.find((e) => e.type === 'assistant' && e.message?.content?.some?.((b: any) => b.type === 'thinking'));
  assert.ok(block, 'fixture lost its thinking block');
  assert.equal(block.message.content.find((b: any) => b.type === 'thinking').thinking, '',
    'the data plane relays the signature only — if this ever carries text, expand the marker into prose');
  const s = history();
  assert.ok(only(s, 'thinking').length >= 1, 'a textless thinking block produced nothing at all');
});

test('adjacent tool calls merge into one group; prose splits them', () => {
  const call = (id: string) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'ls' } }] } });
  let s = initialState();
  for (const p of [call('a'), call('b')]) s = reduce(s, p, { isHistory: true });
  assert.deepEqual(kinds(s), ['tools']);
  assert.equal(only(s, 'tools')[0].calls.length, 2);

  s = reduce(s, { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '中间说了句话' }] } }, { isHistory: true });
  s = reduce(s, call('c'), { isHistory: true });
  assert.deepEqual(kinds(s), ['tools', 'prose', 'tools']);
});

test('streamed prose is replaced by the final message, not duplicated', () => {
  const s = history();
  const proses = only(s, 'prose').map((p) => p.text);
  assert.equal(proses.filter((t) => t === '流式第一段').length, 1, 'the streamed draft and the final message both rendered');
  assert.ok(!only(s, 'prose').some((p) => p.streaming), 'a prose item is still flagged streaming after message_stop');
});

test('history backfill never flips busy or opens a permission sheet', () => {
  const s = history();
  assert.equal(s.live.busy, false);
  // The fixture's can_use_tool is AskUserQuestion (a card), and its turn ended with a result.
  assert.equal(s.live.permission, undefined);
});

test('an unfinished turn is still recognisable in the backfill', () => {
  // The reducer keeps busy=false for history, so the view asks separately (ChatView re-derives
  // `busy` after each backfill) — otherwise reopening a running session shows no Stop button.
  // The fixture's last turn never got its `result`, which is exactly that case.
  assert.equal(EVENTS[EVENTS.length - 1].type, 'assistant');
  assert.equal(turnActiveIn(EVENTS), true, 'a turn with no result is still in flight');
  assert.equal(turnActiveIn([...EVENTS, { type: 'result', subtype: 'success' }]), false);
  // Events that are not part of a turn must neither end one nor resurrect one.
  const finished = [...EVENTS, { type: 'result', subtype: 'success' }, { type: 'system', subtype: 'thinking_tokens', estimated_tokens: 12 }];
  assert.equal(turnActiveIn(finished), false);
  assert.equal(turnActiveIn([{ type: 'system', subtype: 'init' }, { type: 'keep_alive' }]), false);
  assert.equal(turnActiveIn([]), false);
});

test('a live can_use_tool opens the sheet and marks the call awaiting', () => {
  let s = initialState();
  s = reduce(s, { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'npm test' } }] } }, { isHistory: false });
  s = reduce(s, {
    type: 'control_request', request_id: 'req1',
    request: { subtype: 'can_use_tool', tool_name: 'Bash', tool_use_id: 'tu1', input: { command: 'npm test' }, permission_suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }], behavior: 'allow', destination: 'session' }] },
  }, { isHistory: false });
  assert.equal(s.live.permission?.requestId, 'req1');
  assert.equal(s.live.permission?.suggestions.length, 1);
  assert.equal(only(s, 'tools')[0].calls[0].status, 'awaiting');

  s = reduce(s, { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'ok' }] } }, { isHistory: false });
  assert.equal(s.live.permission, undefined, 'the sheet must close once the tool actually ran');
  assert.equal(only(s, 'tools')[0].calls[0].status, 'ok');
});

test('background tasks resolve; a task that drops off the list is done', () => {
  const s = history();
  const bg = only(s, 'bgtask');
  assert.ok(bg.length >= 1);
  assert.ok(!bg.some((b) => b.status === 'running'), 'a background task is still shown as running after the session ended');
});

test('an interrupted turn leaves nothing claiming to run', () => {
  let s = initialState();
  s = reduce(s, { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'x', name: 'Bash', input: { command: 'sleep 100' } }] } }, { isHistory: false });
  assert.equal(only(s, 'tools')[0].calls[0].status, 'running');
  s = reduce(s, { type: 'result', subtype: 'error_during_execution', is_error: true }, { isHistory: false });
  assert.equal(only(s, 'tools')[0].calls[0].status, 'error');
  assert.equal(s.live.busy, false);
  assert.ok(only(s, 'error').length === 1, 'a failed turn should surface, a successful one should not');
});

test('a successful turn leaves no marker at all', () => {
  let s = initialState();
  s = reduce(s, { type: 'result', subtype: 'success', is_error: false }, { isHistory: false });
  assert.deepEqual(kinds(s), []);
});

test('an optimistic web send is not rendered twice when the echo arrives', () => {
  let s = localSend(initialState(), '你好', false);
  assert.deepEqual(only(s, 'user').map((u) => u.text), ['你好']);
  s = reduce(s, { type: 'user', isReplay: true, message: { role: 'user', content: '你好' } }, { isHistory: false });
  assert.deepEqual(only(s, 'user').map((u) => u.text), ['你好']);
  // A turn typed in the terminal, by contrast, must show up.
  s = reduce(s, { type: 'user', isReplay: true, message: { role: 'user', content: '终端里敲的' } }, { isHistory: false });
  assert.deepEqual(only(s, 'user').map((u) => u.text), ['你好', '终端里敲的']);
});

test('a queued follow-up is marked queued while the agent holds the turn', () => {
  let s = initialState();
  s = reduce(s, { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '在做了' }] } }, { isHistory: false });
  assert.equal(s.live.busy, true);
  s = localSend(s, '再补一句', s.live.busy);
  assert.equal(only(s, 'user')[0].state, 'queued');
});

test('result lines summarise instead of dumping output', () => {
  const call = (name: string, input: any, result: string) => ({ toolUseId: 't', name, input, status: 'ok' as const, result });
  assert.equal(resultLine(call('Read', { file_path: '/a/b.ts' }, '1\tone\n2\ttwo\n3\tthree'))!.text, '读了 3 行');
  assert.equal(resultLine(call('Edit', { old_string: 'a\nb', new_string: 'a\nb\nc\nd' }, ''))!.text, '+4 −2');
  assert.equal(resultLine(call('Write', { content: 'x\ny' }, ''))!.text, '写入 2 行');
  assert.equal(resultLine({ toolUseId: 't', name: 'Bash', input: {}, status: 'running' })!.text, 'Running…');
  const long = resultLine(call('Bash', { command: 'ls' }, 'a'.repeat(500)))!;
  assert.ok(long.text.length < 130, 'a result line must never carry the whole output');
});

test('unknown event types and subtypes are inert', () => {
  const before = history();
  let s = before;
  for (const p of [{ type: 'keep_alive' }, { type: 'system', subtype: 'a_brand_new_subtype', anything: 1 }, { type: 'who_knows' }, null, 'nope']) {
    s = reduce(s, p, { isHistory: true });
  }
  assert.deepEqual(kinds(s), kinds(before));
});
