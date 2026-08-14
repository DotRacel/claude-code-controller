/**
 * web-channel.test.ts — what the phone is allowed to send back, and what the session list is
 * told without subscribing.
 *
 * The permission shape matters more than it looks: the 2.1.232 worker validates a bridge
 * permission response against `{behavior, updatedInput?, updatedPermissions?, message?}` and
 * silently DROPS the whole updatedPermissions array if one entry is malformed — which would
 * turn a user's "Always allow" into a one-off allow with no error anywhere. So the server
 * filters entries itself instead of trusting the browser.
 *
 * Run: node --test test/web-channel.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createControllerServer, type ControllerServer } from '../src/server/index.ts';
import { attachWebChannel } from '../src/server/web-channel.ts';

const CRED = 'test-cred-WEB';
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A server with the web channel attached, a session, and a fake child on the SSE data-plane. */
async function withLoop(fn: (ctx: {
  server: ControllerServer;
  sid: string;
  ws: WebSocket;
  frames: () => any[];
  post: (payloads: unknown[]) => Promise<void>;
  sessionsFrame: () => any[];
}) => Promise<void>) {
  const server = await createControllerServer({ onEvent: (e) => web.handleEvent(e) });
  const web = attachWebChannel(server.server, server, server.store);
  try {
    const s = await server.store.createReplSession(CRED, { dir: '/proj', title: 'box' });
    const ac = new AbortController();
    const sse = await fetch(`${server.baseUrl}/v1/code/sessions/${s.id}/worker/events/stream`, { headers: auth(s.ingressToken), signal: ac.signal });
    const chunks: string[] = [];
    const reader = sse.body!.getReader();
    const dec = new TextDecoder();
    void (async () => { for (;;) { const { done, value } = await reader.read(); if (done) break; chunks.push(dec.decode(value)); } })().catch(() => {});

    let sessions: any[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws/client?credential=${CRED}`);
    ws.onmessage = (e) => { const m = JSON.parse(String(e.data)); if (m.type === 'sessions') sessions = m.sessions; };
    await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error('ws')); });
    await sleep(50);

    await fn({
      server, sid: s.id, ws,
      frames: () => chunks.join('').split('\n').filter((l) => l.startsWith('data: '))
        .map((l) => { try { return JSON.parse(l.slice(6)).payload; } catch { return null; } }).filter(Boolean),
      post: async (payloads) => {
        await fetch(`${server.baseUrl}/v1/code/sessions/${s.id}/worker/events`, {
          method: 'POST', headers: auth(s.ingressToken),
          body: JSON.stringify({ worker_epoch: 1, events: payloads.map((p) => ({ payload: p })) }),
        });
        await sleep(40);
      },
      sessionsFrame: () => sessions,
    });
    ac.abort();
    ws.close();
  } finally { server.close(); }
}

test('an allow carries updatedInput and updatedPermissions through to the child', async () => {
  await withLoop(async ({ sid, ws, frames }) => {
    const suggestion = { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }], behavior: 'allow', destination: 'session' };
    ws.send(JSON.stringify({
      type: 'permission_response', sessionId: sid, requestId: 'rq1', behavior: 'allow',
      updatedInput: { questions: [{ question: '继续吗' }], answers: { 继续吗: '是' } },
      updatedPermissions: [suggestion],
    }));
    await sleep(60);
    const cr = frames().find((p: any) => p.type === 'control_response');
    assert.ok(cr, 'no control_response reached the child');
    assert.equal(cr.response.request_id, 'rq1');
    assert.deepEqual(cr.response.response, {
      behavior: 'allow',
      updatedInput: { questions: [{ question: '继续吗' }], answers: { 继续吗: '是' } },
      updatedPermissions: [suggestion],
    });
  });
});

test('a browser cannot smuggle extra keys, and a malformed rule is dropped, not forwarded', async () => {
  await withLoop(async ({ sid, ws, frames }) => {
    ws.send(JSON.stringify({
      type: 'permission_response', sessionId: sid, requestId: 'rq2', behavior: 'deny',
      message: '不要跑这个',
      updatedInput: 'not-an-object',           // wrong type → dropped
      updatedPermissions: [{ type: 'nonsense' }, 'nope'], // unknown type → whole array dropped
      toolName: 'Bash', evil: { rm: '-rf' },   // not part of the contract → never forwarded
    }));
    await sleep(60);
    const cr = frames().find((p: any) => p.type === 'control_response');
    assert.ok(cr);
    assert.deepEqual(cr.response.response, { behavior: 'deny', message: '不要跑这个' });
  });
});

test('an empty updatedInput is omitted (the worker treats {} as absent anyway)', async () => {
  await withLoop(async ({ sid, ws, frames }) => {
    ws.send(JSON.stringify({ type: 'permission_response', sessionId: sid, requestId: 'rq3', behavior: 'allow', updatedInput: {} }));
    await sleep(60);
    const cr = frames().find((p: any) => p.type === 'control_response');
    assert.deepEqual(cr.response.response, { behavior: 'allow' });
  });
});

test('the session list gets a digest without subscribing to the transcript', async () => {
  await withLoop(async ({ sid, post, sessionsFrame, server }) => {
    await post([
      { type: 'system', subtype: 'init', model: 'claude-opus-5', permissionMode: 'default', cwd: '/proj' },
      { type: 'user', timestamp: '2026-08-14T10:00:00.000Z', message: { role: 'user', content: '修一下登录' } },
      { type: 'assistant', timestamp: '2026-08-14T10:00:01.000Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'npm test' } }] } },
    ]);
    let d = server.store.view(server.store.getSession(sid)!).digest;
    assert.equal(d.prompt, '修一下登录');
    assert.equal(d.tool, 'Bash');            // raw wire name; the web maps it for display
    assert.equal(d.toolArg, 'npm test');
    assert.equal(d.toolStatus, 'running');
    assert.equal(d.toolCalls, 1);
    assert.equal(d.model, 'claude-opus-5');
    assert.equal(d.turnActive, true);
    assert.ok(d.toolStartedAt! > 0);

    await post([{ type: 'control_request', request_id: 'rq', request: { subtype: 'can_use_tool', tool_name: 'Bash', tool_use_id: 'tu1' } }]);
    assert.equal(server.store.view(server.store.getSession(sid)!).digest.pendingApproval, true);

    // Answering clears the badge immediately, without waiting for the tool to finish.
    server.sendControlResponse(sid, 'rq', 'allow');
    assert.equal(server.store.view(server.store.getSession(sid)!).digest.pendingApproval, false);

    await post([
      { type: 'user', timestamp: '2026-08-14T10:00:09.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'ok' }] } },
      { type: 'result', subtype: 'success', is_error: false },
    ]);
    d = server.store.view(server.store.getSession(sid)!).digest;
    assert.equal(d.toolStatus, 'ok');
    assert.equal(d.turnActive, false);

    // …and the phone sees it: the list frame is pushed on session changes.
    await sleep(30);
    assert.ok(sessionsFrame().some((s: any) => s.id === sid && s.digest));
  });
});

test('synthetic user messages never become the list preview', async () => {
  await withLoop(async ({ sid, post, server }) => {
    await post([{ type: 'user', message: { role: 'user', content: '真实提示' } }]);
    await post([
      { type: 'user', isSynthetic: true, message: { role: 'user', content: '<local-command-caveat>ignore me</local-command-caveat>' } },
      { type: 'user', message: { role: 'user', content: '<command-name>/clear</command-name>' } },
    ]);
    assert.equal(server.store.view(server.store.getSession(sid)!).digest.prompt, '真实提示');
  });
});
