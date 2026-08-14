/**
 * push-event.test.ts — official RC-ready PushNotification shape + fan-out to
 * a phone that is not subscribed to the session transcript.
 * Run: node --test test/push-event.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createControllerServer, type ServerEvent } from '../src/server/index.ts';
import { attachWebChannel } from '../src/server/web-channel.ts';
import { pushNotificationFrom, RC_READY_PUSH, isPushNotificationToolUse } from '../src/push-event.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fju(message: string) {
  return {
    type: 'assistant',
    is_meta: true,
    message: {
      role: 'assistant',
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 'toolu_x', name: 'PushNotification', input: { message, status: 'proactive' } }],
    },
  };
}

test('detects the official /rc connected PushNotification injection', () => {
  const n = pushNotificationFrom(fju(RC_READY_PUSH));
  assert.ok(n);
  assert.equal(n.message, RC_READY_PUSH);
  assert.equal(n.status, 'proactive');
  assert.equal(n.ready, true);
  assert.equal(isPushNotificationToolUse(fju(RC_READY_PUSH).message.content[0]), true);
});

test('detects os_notification {notificationType:push_notification}', () => {
  const n = pushNotificationFrom({ type: 'os_notification', message: 'long task done', notificationType: 'push_notification' });
  assert.ok(n);
  assert.equal(n.message, 'long task done');
  assert.equal(n.ready, false);
});

test('ignores ordinary assistant / user turns', () => {
  assert.equal(pushNotificationFrom({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } }), null);
  assert.equal(pushNotificationFrom({ type: 'user', message: { content: 'hello' } }), null);
  assert.equal(pushNotificationFrom({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Write', input: {} }] } }), null);
});

test('unsubscribed web socket receives notify (session-list / background phone)', async () => {
  const events: ServerEvent[] = [];
  const server = await createControllerServer({ onEvent: (e) => events.push(e) });
  const web = attachWebChannel(server.server, server, server.store);
  // The credential has to be a registered account's token for /ws/client to accept it.
  const CRED = (await server.store.createUser('pushtester', 'pw-12345678'))!.token;
  const orig = await server.store.createReplSession(CRED, { dir: '/x', title: 'box' });
  const notes: any[] = [];
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws/client?credential=${CRED}`);
  ws.onmessage = (e) => {
    const m = JSON.parse(String(e.data));
    if (m.type === 'notify') notes.push(m);
  };
  await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error('ws')); });
  await sleep(50);
  web.handleEvent({ type: 'claude.event', sessionId: orig.id, credential: CRED, payload: fju(RC_READY_PUSH) });
  const dl = Date.now() + 1000;
  while (!notes.length && Date.now() < dl) await sleep(20);
  ws.close();
  server.close();
  assert.equal(notes.length, 1);
  assert.equal(notes[0].message, RC_READY_PUSH);
  assert.equal(notes[0].ready, true);
  assert.equal(notes[0].sessionId, orig.id);
});
