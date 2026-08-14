/**
 * db.test.ts — the PostgreSQL persistence layer against a REAL database.
 * Needs DATABASE_URL; without it every test here is skipped (so `npm test` still runs
 * zero-dependency for anyone who hasn't started the container).
 *
 * These tests TRUNCATE between cases, so they run in their own `ccc_test` schema — the same
 * database as the server, but never its tables. Pointing them at `public` would delete real
 * sessions.
 *
 * Run: docker compose up -d db
 *      DATABASE_URL=postgres://ccc:ccc@127.0.0.1:5432/ccc node --test test/db.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/server/store.ts';
import { createPool, ensureSchema, selectHistory, type Pool } from '../src/server/db.ts';
import { createControllerServer } from '../src/server/index.ts';

const URL = process.env.DATABASE_URL;
const skip = URL ? false : 'DATABASE_URL not set (docker compose up -d db)';
const CRED = 'test-cred-DB';
const TEST_SCHEMA = 'ccc_test'; // isolated from the server's `public` tables

let pool: Pool | undefined;
async function db(): Promise<Pool> {
  if (!pool) {
    pool = createPool(URL!, { schema: TEST_SCHEMA });
    await ensureSchema(pool, TEST_SCHEMA);
  }
  // Every test starts from a clean slate; events go with the sessions (ON DELETE CASCADE).
  // Schema-qualified so a stray search_path can never point this at production tables.
  await pool.query(`truncate ${TEST_SCHEMA}.sessions, ${TEST_SCHEMA}.environments cascade`);
  return pool;
}
test.after(async () => { await pool?.end(); });

test('write-through: env + session survive a fresh Store (restart)', { skip }, async () => {
  const pool = await db();
  const a = new Store({ pool });
  const env = await a.createEnv({ credential: CRED, machineName: 'box', dir: '/proj', branch: 'main' });
  const pushed = (await a.pushSessionWork(env.id, 'http://127.0.0.1:1'))!;
  await a.close();

  const b = new Store({ pool }); // simulates a process restart
  const loaded = await b.load();
  assert.equal(loaded.sessions, 1);
  assert.equal(loaded.envs, 1);
  const s = b.getSession(pushed.session.id)!;
  assert.ok(s, 'session came back');
  assert.equal(s.credential, CRED);
  assert.equal(s.machineName, 'box');
  assert.equal(s.dir, '/proj');
  assert.equal(s.branch, 'main');
  assert.equal(s.ingressToken, pushed.session.ingressToken, 'ingress token is stable across restart');
  assert.equal(b.sessionByIngressToken(pushed.session.ingressToken)?.id, s.id, 'token index rebuilt');
  // Runtime state must NOT come back as connected.
  assert.equal(s.wsConnected, false);
  assert.equal(s.sseRes, null);
  assert.equal(b.view(s).status, 'offline');
  // A restart invalidates in-flight leases: the work queue is memory-only by design.
  assert.equal(b.getEnv(env.id)!.queue.length, 0);
  await b.close();
});

test('meta updates and /rc sessions write through', { skip }, async () => {
  const pool = await db();
  const a = new Store({ pool });
  const s = await a.createReplSession(CRED, { title: 'box', dir: '/proj' }, 'cse_dbtest1');
  assert.equal(await a.applyEventMeta(s.id, { type: 'system', subtype: 'init', cwd: '/home/racel/app' }), true);
  await a.close();

  const b = new Store({ pool });
  await b.load();
  const loaded = b.getSession('cse_dbtest1')!;
  assert.equal(loaded.machineName, 'box');
  assert.equal(loaded.dir, '/home/racel/app', 'system:init cwd was persisted');
  assert.equal(loaded.credential, CRED);
  await b.close();
});

test('transcript persists and replays oldest-first', { skip }, async () => {
  const pool = await db();
  const a = new Store({ pool });
  const s = await a.createReplSession(CRED, { dir: '/x' });
  await a.appendEvents(s.id, [
    { type: 'user', message: { role: 'user', content: 'one' } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'two' }] } },
  ]);
  await a.appendEvents(s.id, [{ type: 'result', subtype: 'success' }]);
  await a.close();

  const b = new Store({ pool });
  await b.load();
  const h = (await b.historyFor(s.id)) as any[];
  assert.deepEqual(h.map((e) => e.type), ['user', 'assistant', 'result'], 'chronological');
  assert.equal(h[0].message.content, 'one', 'jsonb round-trips the payload');
  await b.close();
});

test('stream_event is relayed but never stored', { skip }, async () => {
  const pool = await db();
  const a = new Store({ pool });
  const s = await a.createReplSession(CRED, { dir: '/x' });
  await a.appendEvents(s.id, [
    { type: 'stream_event', event: { delta: { text: 'to' } } },
    { type: 'stream_event', event: { delta: { text: 'ken' } } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'token' }] } },
  ]);
  const rows = await pool.query('select type from events where session_id = $1', [s.id]);
  assert.deepEqual(rows.rows.map((r) => r.type), ['assistant'], 'only the semantic event landed');
  // A batch of nothing but stream_events must not issue an INSERT at all.
  await a.appendEvents(s.id, [{ type: 'stream_event' }]);
  assert.equal((await pool.query('select count(*)::int c from events where session_id = $1', [s.id])).rows[0].c, 1);
  await a.close();
});

test('last_activity is batched by close(), not written per event', { skip }, async () => {
  const pool = await db();
  const a = new Store({ pool });
  const s = await a.createReplSession(CRED, { dir: '/x' });
  const created = (await pool.query('select last_activity from sessions where id = $1', [s.id])).rows[0].last_activity;

  await new Promise((r) => setTimeout(r, 15));
  a.touch(s.id); // memory only — the flush timer is 30s away
  const midway = (await pool.query('select last_activity from sessions where id = $1', [s.id])).rows[0].last_activity;
  assert.equal(midway.getTime(), created.getTime(), 'touch() did not hit the database');

  await a.close(); // flushes what accumulated
  const after = (await pool.query('select last_activity from sessions where id = $1', [s.id])).rows[0].last_activity;
  assert.ok(after.getTime() > created.getTime(), 'flush persisted the bump');
});

test('server end-to-end: /rc session + events survive a restart', { skip }, async () => {
  const pool = await db();
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  const s1 = await createControllerServer({ pool });
  const cs = await fetch(`${s1.baseUrl}/v1/code/sessions`, {
    method: 'POST', headers: auth(CRED), body: JSON.stringify({ config: { cwd: '/proj' } }),
  }).then((r) => r.json());
  const creds = await fetch(`${s1.baseUrl}/v1/code/sessions/${cs.session.id}/bridge`, {
    method: 'POST', headers: auth(CRED), body: '{}',
  }).then((r) => r.json());
  await fetch(`${s1.baseUrl}/v1/code/sessions/${cs.session.id}/worker/events`, {
    method: 'POST', headers: { ...auth(creds.worker_jwt), 'content-type': 'application/json' },
    body: JSON.stringify({ events: [
      { payload: { type: 'user', message: { role: 'user', content: 'hi' } } },
      { payload: { type: 'stream_event', event: { delta: { text: 'x' } } } },
      { payload: { type: 'assistant', message: { content: [{ type: 'text', text: 'yo' }] } } },
    ] }),
  });
  s1.close();
  await s1.store.close();

  const s2 = await createControllerServer({ pool }); // restart
  try {
    const list = s2.store.sessionsForCredential(CRED);
    assert.equal(list.length, 1, 'session list restored');
    assert.equal(list[0].id, cs.session.id);
    const h = (await s2.store.historyFor(cs.session.id)) as any[];
    assert.deepEqual(h.map((e) => e.type), ['user', 'assistant'], 'transcript restored, no stream_event');
    assert.equal((await selectHistory(pool, cs.session.id, 1)).length, 1, 'history limit honoured');
  } finally {
    s2.close();
    await s2.store.close();
  }
});
