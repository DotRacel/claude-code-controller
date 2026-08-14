/**
 * server.test.ts — multi-tenant controller server over real HTTP, NO claude. Drives both
 * sides (a fake child + the remote API) and asserts credential-scoped relay.
 * Run: node --test test/server.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createControllerServer, type ControllerServer, type ServerEvent } from '../src/server/index.ts';
import { Store } from '../src/server/store.ts';

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A credential is now an account's issued token, so every control-plane test needs a real
 * account. Created straight through the store rather than over /v1/auth/register — that
 * endpoint has its own test file, and this keeps the invite code out of these tests.
 */
async function account(server: ControllerServer, username = 'tester'): Promise<string> {
  const u = await server.store.createUser(username, 'pw-12345678');
  if (!u) throw new Error(`duplicate test account: ${username}`);
  return u.token;
}

/** `cred` is a freshly registered account's token — the 凭证A these tests act as. */
async function withServer(fn: (s: ControllerServer, events: ServerEvent[], cred: string) => Promise<void>) {
  const events: ServerEvent[] = [];
  const server = await createControllerServer({ onEvent: (e) => events.push(e) });
  try { await fn(server, events, await account(server)); } finally { server.close(); }
}
async function register(server: ControllerServer, cred: string, body: any = { machine_name: 't', directory: '/x', branch: 'main' }) {
  const reg = await fetch(`${server.baseUrl}/v1/environments/bridge`, { method: 'POST', headers: auth(cred), body: JSON.stringify(body) }).then((r) => r.json());
  return reg.environment_id as string;
}

test('register (with credential) auto-creates a session; poll delivers it', async () => {
  await withServer(async (server, _events, CRED) => {
    const envId = await register(server, CRED);
    assert.match(envId, /^env-/);
    const sessions = server.store.sessionsForCredential(CRED);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].machineName, 't');
    assert.equal(sessions[0].dir, '/x');
    const work = await fetch(`${server.baseUrl}/v1/environments/${envId}/work/poll`).then((r) => r.json());
    assert.equal(work.data.type, 'session');
    assert.equal(work.data.id, sessions[0].id);
  });
});

test('register without a credential is 401, and so is one belonging to no account', async () => {
  await withServer(async (server) => {
    const r = await fetch(`${server.baseUrl}/v1/environments/bridge`, { method: 'POST', body: '{}' });
    assert.equal(r.status, 401);
    // A token nobody registered is exactly as good as no token — this is what stops anyone
    // from conjuring a namespace by picking a string.
    const bogus = await fetch(`${server.baseUrl}/v1/environments/bridge`, { method: 'POST', headers: auth('ccc_not_a_real_token'), body: '{}' });
    assert.equal(bogus.status, 401);
    assert.equal((await bogus.json()).error.type, 'bad_credential');
    assert.equal(server.store.envs.size, 0);
  });
});

test('sessions are isolated per credential', async () => {
  await withServer(async (server) => {
    const a = await account(server, 'alice');
    const b = await account(server, 'bob');
    await register(server, a);
    await register(server, b);
    assert.equal(server.store.sessionsForCredential(a).length, 1);
    assert.equal(server.store.sessionsForCredential(b).length, 1);
    assert.notEqual(server.store.sessionsForCredential(a)[0].id, server.store.sessionsForCredential(b)[0].id);
  });
});

test('data-plane requires a valid session_ingress_token', async () => {
  await withServer(async (server, _events, CRED) => {
    await register(server, CRED);
    const s = server.store.sessionsForCredential(CRED)[0];
    // no token → 401
    assert.equal((await fetch(`${server.baseUrl}/v1/code/sessions/${s.id}/worker`)).status, 401);
    // valid token → worker lifecycle answers
    const w = await fetch(`${server.baseUrl}/v1/code/sessions/${s.id}/worker`, { headers: auth(s.ingressToken) }).then((r) => r.json());
    assert.ok('worker' in w);
    const ie = await fetch(`${server.baseUrl}/v1/code/sessions/${s.id}/worker/internal-events?limit=1000`, { headers: auth(s.ingressToken) }).then((r) => r.json());
    assert.deepEqual(ie.internal_events, []);
    const reg = await fetch(`${server.baseUrl}/v1/code/sessions/${s.id}/worker/register`, { method: 'POST', headers: auth(s.ingressToken), body: '{}' }).then((r) => r.json());
    assert.equal(reg.worker_epoch, 1);
  });
});

test('full relay: child SSE + POST events ⇄ sendUserMessage / control round-trip (credential-scoped)', async () => {
  await withServer(async (server, events, CRED) => {
    await register(server, CRED);
    const s = server.store.sessionsForCredential(CRED)[0];
    const tok = s.ingressToken;
    const sid = s.id;

    const ac = new AbortController();
    const sse = await fetch(`${server.baseUrl}/v1/code/sessions/${sid}/worker/events/stream`, { headers: auth(tok), signal: ac.signal });
    assert.equal(sse.status, 200);
    const frames: string[] = [];
    const reader = sse.body!.getReader();
    const dec = new TextDecoder();
    (async () => { for (;;) { const { done, value } = await reader.read(); if (done) break; frames.push(dec.decode(value)); } })().catch(() => {});
    await sleep(50);
    assert.ok(events.some((e) => e.type === 'ws.connect' && (e as any).sessionId === sid));

    await fetch(`${server.baseUrl}/v1/code/sessions/${sid}/worker/events`, {
      method: 'POST', headers: auth(tok),
      body: JSON.stringify({ worker_epoch: 1, events: [
        { payload: { type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } } },
        { payload: { type: 'control_request', request_id: 'rq1', request: { subtype: 'can_use_tool', tool_name: 'Bash', tool_use_id: 'toolu_1' } } },
      ] }),
    });
    await sleep(30);
    const ce = events.filter((e) => e.type === 'claude.event') as any[];
    assert.ok(ce.some((e) => e.payload.type === 'assistant'));
    assert.ok(ce.some((e) => e.payload.type === 'control_request' && e.payload.request.subtype === 'can_use_tool'));
    assert.ok(ce.every((e) => e.credential === CRED), 'claude.event carries the owning credential');

    server.sendUserMessage(sid, 'hello');
    server.sendControlResponse(sid, 'rq1', 'allow');
    await sleep(30);
    const payloads = frames.join('').split('\n').filter((l) => l.startsWith('data: ')).map((l) => { try { return JSON.parse(l.slice(6)).payload; } catch { return null; } }).filter(Boolean);
    const um = payloads.find((pp: any) => pp.type === 'user');
    assert.ok(um && um.client_platform === 'web_claude_ai', 'user frame with client_platform');
    const cr = payloads.find((pp: any) => pp.type === 'control_response');
    assert.ok(cr && cr.response.request_id === 'rq1' && cr.response.response.behavior === 'allow');

    ac.abort();
    await sleep(10);
    assert.ok(events.some((e) => e.type === 'ws.close' && (e as any).sessionId === sid));
  });
});

test('interactive REPL bridge: createCodeSession (owned) → fetchRemoteCredentials → data-plane', async () => {
  await withServer(async (server, _events, CRED) => {
    // createCodeSession — owned by 凭证A, metadata from config.cwd
    const cs = await fetch(`${server.baseUrl}/v1/code/sessions`, {
      method: 'POST', headers: auth(CRED),
      body: JSON.stringify({ title: 'vibe', bridge: {}, config: { cwd: '/proj' } }),
    }).then((r) => r.json());
    assert.match(cs.session.id, /^cse_/);
    const sessions = server.store.sessionsForCredential(CRED);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].id, cs.session.id);
    assert.equal(sessions[0].dir, '/proj');

    // fetchRemoteCredentials — worker_jwt (= ingress token) + api_base_url
    const creds = await fetch(`${server.baseUrl}/v1/code/sessions/${cs.session.id}/bridge`, {
      method: 'POST', headers: auth(CRED), body: '{}',
    }).then((r) => r.json());
    assert.equal(typeof creds.worker_jwt, 'string');
    assert.match(creds.api_base_url, /^http:\/\//);
    assert.equal(creds.worker_epoch, 1);
    assert.ok(creds.expires_in > 0);
    assert.equal(server.store.sessionByIngressToken(creds.worker_jwt)?.id, cs.session.id);

    // the worker_jwt authenticates the data-plane as this session
    const w = await fetch(`${server.baseUrl}/v1/code/sessions/${cs.session.id}/worker`, { headers: auth(creds.worker_jwt) }).then((r) => r.json());
    assert.ok('worker' in w);
  });
});

test('interactive createCodeSession without a credential is 401; GET missing session is 404 not 401', async () => {
  await withServer(async (server, _events, CRED) => {
    assert.equal((await fetch(`${server.baseUrl}/v1/code/sessions`, { method: 'POST', body: '{}' })).status, 401);
    // 401 here would surface in the TUI as "Session expired. Please run /login".
    const missing = await fetch(`${server.baseUrl}/v1/code/sessions/cse_gone`, { headers: auth(CRED) });
    assert.equal(missing.status, 404);
  });
});

test('GET /v1/code/sessions/{id} accepts the owning credential (not just the worker jwt)', async () => {
  await withServer(async (server, _events, CRED) => {
    const cs = await fetch(`${server.baseUrl}/v1/code/sessions`, {
      method: 'POST', headers: auth(CRED), body: JSON.stringify({ config: { cwd: '/p' } }),
    }).then((r) => r.json());
    const got = await fetch(`${server.baseUrl}/v1/code/sessions/${cs.session.id}`, { headers: auth(CRED) }).then(async (r) => ({ status: r.status, body: await r.json() }));
    assert.equal(got.status, 200);
    assert.equal(got.body.session.id, cs.session.id);
    // Another real account is still the wrong account.
    const other = await account(server, 'mallory');
    assert.equal((await fetch(`${server.baseUrl}/v1/code/sessions/${cs.session.id}`, { headers: auth(other) })).status, 401);
  });
});

// Reload-across-restart now lives in db.test.ts (it needs a real database).
test('system:init fills session dir', async () => {
  const a = new Store();
  // No HTTP here, so the credential is just the partition key — no account needed.
  const s = await a.createReplSession('cred-standin', { title: 'box', dir: '/proj' }, 'cse_persist1');
  assert.equal(s.machineName, 'box');
  assert.equal(s.dir, '/proj');
  assert.equal(await a.applyEventMeta(s.id, { type: 'system', subtype: 'init', cwd: '/home/racel/app' }), true);
  assert.equal(a.getSession(s.id)?.dir, '/home/racel/app');
});

test('POST /bridge resurrects a cse_* id after a server restart (same credential)', async () => {
  await withServer(async (server, _events, CRED) => {
    const creds = await fetch(`${server.baseUrl}/v1/code/sessions/cse_deadbeef/bridge`, {
      method: 'POST', headers: auth(CRED), body: '{}',
    }).then(async (r) => ({ status: r.status, body: await r.json() }));
    assert.equal(creds.status, 200);
    assert.equal(server.store.sessions.get('cse_deadbeef')?.credential, CRED);
    assert.equal(typeof creds.body.worker_jwt, 'string');
    assert.equal(server.store.sessionByIngressToken(creds.body.worker_jwt)?.id, 'cse_deadbeef');
  });
});
