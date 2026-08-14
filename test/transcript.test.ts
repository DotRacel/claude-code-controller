/**
 * transcript.test.ts — web rendering of user turns (web-sent vs terminal-typed).
 * Run: node --test test/transcript.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanUserText, takeVisibleUserTexts, userTextsFrom } from '../web/src/transcript.ts';

const user = (content: unknown, extra: Record<string, unknown> = {}) => ({
  type: 'user',
  message: { role: 'user', content },
  isReplay: true,
  origin: { kind: 'human' },
  ...extra,
});

test('cleanUserText keeps ordinary terminal / web text', () => {
  assert.equal(cleanUserText('hello from the TUI'), 'hello from the TUI');
});

test('cleanUserText drops slash-command and system-reminder wrappers', () => {
  assert.equal(cleanUserText('<command-name>/help</command-name>'), null);
  assert.equal(cleanUserText('<system-reminder>secret</system-reminder>\nreal'), 'real');
});

test('history backfill shows the terminal-typed user turn', () => {
  const { texts } = takeVisibleUserTexts(user('Reply with exactly: hi'), [], true);
  assert.deepEqual(texts, ['Reply with exactly: hi']);
});

test('live echo of a terminal-typed turn is shown (the previous bug)', () => {
  const { texts, pendingWeb } = takeVisibleUserTexts(user('typed in the TUI'), [], false);
  assert.deepEqual(texts, ['typed in the TUI']);
  assert.deepEqual(pendingWeb, []);
});

test('live echo of a web-sent turn is consumed, not duplicated', () => {
  const { texts, pendingWeb } = takeVisibleUserTexts(user('from the phone'), ['from the phone'], false);
  assert.deepEqual(texts, []);
  assert.deepEqual(pendingWeb, []);
});

test('content-block user text is treated the same as a string body', () => {
  const { texts } = takeVisibleUserTexts(user([{ type: 'text', text: 'block form' }]), [], false);
  assert.deepEqual(texts, ['block form']);
});

test('meta / compact summaries and tool_result-only users produce no bubble', () => {
  assert.deepEqual(userTextsFrom(user('x', { isMeta: true })), []);
  assert.deepEqual(userTextsFrom(user('x', { isCompactSummary: true })), []);
  assert.deepEqual(userTextsFrom(user([{ type: 'tool_result', tool_use_id: 't', content: 'ok' }])), []);
});
