/**
 * auth.test.ts — account registration, login, and the strictness that makes them worth having.
 *
 * The point of this layer is that a credential (凭证A) can no longer be conjured: before,
 * `Authorization: Bearer <anything>` opened a private namespace on the server. So the negative
 * cases here matter as much as the happy path — an unregistered token must be refused by every
 * control-plane door, including the websocket.
 *
 * INVITE_CODE is process-wide state, so it is set and restored around each case rather than
 * once at the top; the endpoint reads it per request precisely so this works.
 *
 * Run: node --test test/auth.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createControllerServer, type ControllerServer } from '../src/server/index.ts';
import { attachWebChannel } from '../src/server/web-channel.ts';

const CODE = 'let-me-in-1234';
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

/** `code: null` means "INVITE_CODE unset" — not `undefined`, which a default parameter eats. */
async function withServer(fn: (s: ControllerServer) => Promise<void>, code: string | null = CODE) {
  const prev = process.env.INVITE_CODE;
  if (code === null) delete process.env.INVITE_CODE;
  else process.env.INVITE_CODE = code;
  const server = await createControllerServer({});
  try { await fn(server); } finally {
    server.close();
    if (prev === undefined) delete process.env.INVITE_CODE;
    else process.env.INVITE_CODE = prev;
  }
}

const post = (s: ControllerServer, path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${s.baseUrl}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
    .then(async (r) => ({ status: r.status, body: (await r.json().catch(() => ({}))) as any }));

const REGISTER = { username: 'racel', password: 'hunter2-but-longer', invite_code: CODE };

test('register issues a token, and login returns the same one forever', async () => {
  await withServer(async (s) => {
    const reg = await post(s, '/v1/auth/register', REGISTER);
    assert.equal(reg.status, 200);
    assert.match(reg.body.token, /^ccc_/);
    assert.equal(reg.body.username, 'racel');

    // The token is fixed at registration — this is what lets a user paste it into a second
    // device and keep the same session namespace.
    const first = await post(s, '/v1/auth/login', { username: 'racel', password: REGISTER.password });
    const second = await post(s, '/v1/auth/login', { username: 'racel', password: REGISTER.password });
    assert.equal(first.status, 200);
    assert.equal(first.body.token, reg.body.token);
    assert.equal(second.body.token, reg.body.token);

    const me = await fetch(`${s.baseUrl}/v1/auth/me`, { headers: auth(reg.body.token) }).then(async (r) => ({ status: r.status, body: await r.json() }));
    assert.equal(me.status, 200);
    assert.equal(me.body.username, 'racel');
  });
});

test('the invite code is required, checked, and closes registration when unset', async () => {
  await withServer(async (s) => {
    const wrong = await post(s, '/v1/auth/register', { ...REGISTER, invite_code: 'nope' });
    assert.equal(wrong.status, 403);
    assert.equal(wrong.body.error.type, 'bad_invite_code');
    const missing = await post(s, '/v1/auth/register', { username: 'racel', password: REGISTER.password });
    assert.equal(missing.status, 403);
    assert.equal(s.store.userCount, 0);
  });

  // No INVITE_CODE at all must mean CLOSED, never "open to everyone" — a default-open gate
  // would be indistinguishable from having no gate.
  await withServer(async (s) => {
    const r = await post(s, '/v1/auth/register', REGISTER);
    assert.equal(r.status, 403);
    assert.equal(r.body.error.type, 'registration_closed');
    assert.equal(s.store.userCount, 0);
  }, null);
});

test('usernames and passwords are validated, and names are unique', async () => {
  await withServer(async (s) => {
    for (const username of ['ab', 'has space', 'no@symbols', 'x'.repeat(33)]) {
      const r = await post(s, '/v1/auth/register', { ...REGISTER, username });
      assert.equal(r.status, 400, `expected ${username} to be rejected`);
      assert.equal(r.body.error.type, 'bad_username');
    }
    const weak = await post(s, '/v1/auth/register', { ...REGISTER, password: 'short' });
    assert.equal(weak.status, 400);
    assert.equal(weak.body.error.type, 'weak_password');

    assert.equal((await post(s, '/v1/auth/register', REGISTER)).status, 200);
    const dupe = await post(s, '/v1/auth/register', { ...REGISTER, password: 'a-different-password' });
    assert.equal(dupe.status, 409);
    assert.equal(dupe.body.error.type, 'username_taken');
    assert.equal(s.store.userCount, 1);
  });
});

test('a wrong password is refused, and repeated attempts lock the account out', async () => {
  await withServer(async (s) => {
    await post(s, '/v1/auth/register', REGISTER);
    for (let i = 0; i < 5; i++) {
      const r = await post(s, '/v1/auth/login', { username: 'racel', password: 'wrong-password' });
      assert.equal(r.status, 401, `attempt ${i + 1}`);
      assert.equal(r.body.error.type, 'bad_credentials');
    }
    // Locked out — and the correct password does not get a free pass while it holds.
    const locked = await post(s, '/v1/auth/login', { username: 'racel', password: REGISTER.password });
    assert.equal(locked.status, 429);
    assert.equal(locked.body.error.type, 'too_many_attempts');

    // An unknown user is refused the same way, without revealing that it does not exist.
    const unknown = await post(s, '/v1/auth/login', { username: 'nobody', password: 'whatever-123' });
    assert.equal(unknown.status, 401);
    assert.equal(unknown.body.error.type, 'bad_credentials');
  });
});

test('a token belonging to no account opens no door', async () => {
  await withServer(async (s) => {
    const web = attachWebChannel(s.server, s, s.store);
    assert.ok(web);
    const bogus = 'ccc_totally-made-up';

    assert.equal((await fetch(`${s.baseUrl}/v1/auth/me`, { headers: auth(bogus) })).status, 401);
    assert.equal((await post(s, '/v1/environments/bridge', { machine_name: 'x' }, auth(bogus))).status, 401);
    assert.equal((await post(s, '/v1/code/sessions', { config: { cwd: '/x' } }, auth(bogus))).status, 401);
    // Resurrecting a cse_* id is the one path that CREATES a session from an unknown id, so an
    // unregistered token reaching it would be a namespace conjured out of nothing.
    assert.equal((await post(s, '/v1/code/sessions/cse_deadbeef/bridge', {}, auth(bogus))).status, 401);
    assert.equal(s.store.sessions.size, 0);
    assert.equal(s.store.envs.size, 0);

    // …and the websocket refuses the upgrade rather than handing over a session list.
    const ws = new WebSocket(`ws://127.0.0.1:${s.port}/ws/client?credential=${encodeURIComponent(bogus)}`);
    const outcome = await new Promise<string>((resolve) => {
      ws.onopen = () => resolve('open');
      ws.onerror = () => resolve('refused');
      ws.onclose = () => resolve('refused');
    });
    assert.equal(outcome, 'refused');
  });
});

test('malformed json does not hang the request', async () => {
  await withServer(async (s) => {
    const r = await fetch(`${s.baseUrl}/v1/auth/login`, { method: 'POST', body: '{not json' });
    assert.equal(r.status, 401); // treated as empty credentials, not a crash
    await r.text();
  });
});
