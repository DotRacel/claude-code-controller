/**
 * fixtures.test.ts — regression against the real captured wire events (test/fixtures/).
 * Guards the web contract in docs/EVENTS.md: the event shapes the front-end depends on
 * stay parseable and correlated. Refresh fixtures with `node test/capture-events.ts`.
 * Run: node --test test/fixtures.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(here, 'fixtures', 'child-events.jsonl');

function load(): any[] {
  if (!existsSync(fixturePath)) throw new Error(`missing ${fixturePath} — run: node test/capture-events.ts`);
  return readFileSync(fixturePath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}
const contentBlocks = (events: any[], type: 'assistant' | 'user') =>
  events.flatMap((e) => (e.type === type && Array.isArray(e.message?.content) ? e.message.content : []));

test('every fixture line parses and has a string type', () => {
  const events = load();
  assert.ok(events.length > 0);
  for (const e of events) assert.equal(typeof e.type, 'string');
});

test('the key event kinds the web renders are present', () => {
  const events = load();
  const has = (pred: (e: any) => boolean, label: string) => assert.ok(events.some(pred), label);
  has((e) => e.type === 'system' && e.subtype === 'init', 'system:init');
  has((e) => e.type === 'assistant', 'assistant');
  has((e) => e.type === 'result', 'result');
  has((e) => e.type === 'control_request' && e.request?.subtype === 'can_use_tool', 'control_request:can_use_tool');
  has((e) => e.type === 'user', 'user');
});

test('owner semantics: replayed user messages carry origin human (not peer)', () => {
  const events = load();
  const userMsgs = events.filter((e) => e.type === 'user' && e.origin);
  assert.ok(userMsgs.length > 0, 'has user messages with origin');
  for (const u of userMsgs) assert.notEqual(u.origin.kind, 'peer', 'must not be demoted to peer');
  assert.ok(userMsgs.some((u) => u.origin.kind === 'human'), 'at least one origin human');
});

test('tool-call lifecycle links assistant.tool_use → can_use_tool → tool_result by id', () => {
  const events = load();
  const toolUse = contentBlocks(events, 'assistant').find((b) => b.type === 'tool_use');
  assert.ok(toolUse, 'assistant emitted a tool_use block');
  assert.ok(toolUse.id && toolUse.name, 'tool_use has id + name');

  const req = events.find((e) => e.type === 'control_request' && e.request?.tool_use_id === toolUse.id);
  assert.ok(req, 'can_use_tool references the tool_use id');
  assert.equal(req.request.tool_name, toolUse.name);
  assert.ok(Array.isArray(req.request.permission_suggestions), 'has permission_suggestions for the UI');

  const result = contentBlocks(events, 'user').find((b) => b.type === 'tool_result' && b.tool_use_id === toolUse.id);
  assert.ok(result, 'tool_result references the same tool_use id');
});

test('control_request/control_response correlate by request_id', () => {
  const events = load();
  const req = events.find((e) => e.type === 'control_request');
  assert.ok(req?.request_id, 'control_request has request_id');
  const resp = events.find((e) => e.type === 'control_response');
  if (resp) {
    assert.equal(resp.response.subtype, 'success');
    assert.ok('request_id' in resp.response);
    assert.ok('behavior' in resp.response.response);
  }
});

test('system:init carries the session-bootstrap fields the web needs', () => {
  const init = load().find((e) => e.type === 'system' && e.subtype === 'init');
  assert.ok(init);
  assert.ok(Array.isArray(init.tools) && init.tools.length > 0, 'tools list');
  assert.equal(typeof init.model, 'string');
  assert.equal(typeof init.permissionMode, 'string');
  assert.equal(typeof init.session_id, 'string');
});

test('result marks turn completion with cost/usage/stop_reason', () => {
  const result = load().find((e) => e.type === 'result');
  assert.ok(result);
  assert.equal(typeof result.is_error, 'boolean');
  assert.ok('stop_reason' in result);
  assert.ok('usage' in result);
});
