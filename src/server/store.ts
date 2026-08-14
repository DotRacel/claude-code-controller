/**
 * store.ts — server state. Multi-tenant: every environment and session is owned by a
 * credential ("凭证A"); the web side lists/controls only its own.
 *
 * Single-instance design, so the split is:
 *   - PG (db.ts) is the source of truth for environments / sessions / events.
 *   - `envs` / `sessions` are an in-memory READ CACHE, loaded by load() on boot and written
 *     through on every mutation. Read paths therefore stay SYNCHRONOUS and never touch the
 *     database — `owns()` in web-channel.ts runs on every websocket frame.
 *   - Only mutations are async. Runtime state (sse handles, seq, connection liveness, the work
 *     queue) is memory-only by nature and never persisted.
 *   - Events are not cached (a multi-user server can't hold every transcript); history is a
 *     query. Without a pool they fall back to an in-memory ring, which is what the unit tests
 *     and the local `src/cli.ts` driver use.
 *
 * `new Store()` = pure memory (no persistence). `new Store({ pool })` = write-through to PG.
 */
import crypto from 'node:crypto';
import os from 'node:os';
import type { ServerResponse } from 'node:http';
import {
  type Pool, upsertEnv, upsertSession, insertEvents, selectHistory, flushActivity, loadRecent,
} from './db.ts';

/** Token-level deltas: high write volume, no replay value (the full `assistant` message
 * carries the final text), so they are relayed live but never stored. */
const UNSTORED_EVENT_TYPES = new Set(['stream_event']);
const HISTORY_LIMIT = 3000;
const ACTIVITY_FLUSH_MS = 30000;

export interface WorkItem {
  id: string;
  secret: string; // base64url(JSON {version:1, session_ingress_token, api_base_url})
  data: { type: 'session' | 'healthcheck'; id: string };
}

export interface EnvRecord {
  id: string;
  credential: string; // owner (凭证A)
  machineName?: string;
  dir?: string;
  branch?: string;
  gitRepoUrl?: string;
  createdAt: number;
  online: boolean; // false once the injector deregisters / bridge drops
  queue: WorkItem[]; // work not yet delivered
  inflight: Map<string, WorkItem>; // delivered, awaiting ack/stop
}

export interface SessionRecord {
  id: string; // sessionId (used in the code-sessions path)
  credential: string;
  envId: string;
  ingressToken: string; // the child authenticates the data-plane with this
  workId: string;
  // metadata (inherited from the environment) for the session list
  machineName?: string;
  dir?: string;
  branch?: string;
  gitRepoUrl?: string;
  createdAt: number;
  lastActivity: number;
  wsConnected: boolean; // child's SSE data-plane is open
  sseRes: ServerResponse | null; // server → child channel
  seq: number; // client_event sequence_num / id
}

/** Public shape sent to the web (no tokens / internals). */
export interface SessionView {
  id: string;
  machine?: string;
  dir?: string;
  branch?: string;
  gitRepoUrl?: string;
  status: 'active' | 'offline';
  createdAt: number;
  lastActivity: number;
}

/** Encode a bridge work secret exactly as AVl() in the target expects to decode it. */
export function encodeWorkSecret(sessionIngressToken: string, apiBaseUrl: string): string {
  const payload = { version: 1, session_ingress_token: sessionIngressToken, api_base_url: apiBaseUrl };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

export class Store {
  envs = new Map<string, EnvRecord>();
  sessions = new Map<string, SessionRecord>(); // by sessionId
  private byIngressToken = new Map<string, string>(); // ingressToken → sessionId
  private memHistory = new Map<string, unknown[]>(); // no-pool fallback: capped ring
  private pool?: Pool;
  private dirtyActivity = new Set<string>(); // sessionIds whose last_activity needs flushing
  private flushTimer?: NodeJS.Timeout;

  constructor(opts: { pool?: Pool } = {}) {
    this.pool = opts.pool;
    if (this.pool) {
      // touch() fires on every inbound event; batch the bumps instead of one UPDATE each.
      this.flushTimer = setInterval(() => void this.flushActivity(), ACTIVITY_FLUSH_MS);
      this.flushTimer.unref?.();
    }
  }

  /** Hydrate the read cache from PG. No-op without a pool. */
  async load(windowDays = Number(process.env.CCC_LOAD_WINDOW_DAYS || 30)): Promise<{ envs: number; sessions: number }> {
    if (!this.pool) return { envs: 0, sessions: 0 };
    const { envs, sessions } = await loadRecent(this.pool, windowDays);
    for (const e of envs) {
      this.envs.set(e.id, { ...e, online: false, queue: [], inflight: new Map() });
    }
    for (const s of sessions) {
      this.sessions.set(s.id, { ...s, wsConnected: false, sseRes: null, seq: 0 });
      this.byIngressToken.set(s.ingressToken, s.id);
    }
    return { envs: envs.length, sessions: sessions.length };
  }

  /** Flush pending last_activity bumps and stop the timer. */
  async close(): Promise<void> {
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.flushTimer = undefined;
    await this.flushActivity();
  }

  async createEnv(meta: { credential: string; machineName?: string; dir?: string; branch?: string; gitRepoUrl?: string; reuseId?: string }): Promise<EnvRecord> {
    const id = meta.reuseId && this.envs.has(meta.reuseId) ? meta.reuseId : meta.reuseId || 'env-' + crypto.randomUUID();
    const rec: EnvRecord = {
      id, credential: meta.credential, machineName: meta.machineName, dir: meta.dir,
      branch: meta.branch, gitRepoUrl: meta.gitRepoUrl, createdAt: Date.now(), online: true,
      queue: [], inflight: new Map(),
    };
    this.envs.set(id, rec);
    if (this.pool) await upsertEnv(this.pool, rec);
    return rec;
  }

  /** Queue a session work item for an environment; the session inherits the env's owner + metadata. */
  async pushSessionWork(envId: string, apiBaseUrl: string): Promise<{ work: WorkItem; session: SessionRecord } | null> {
    const env = this.envs.get(envId);
    if (!env) return null;
    const sessionId = 'ses-' + crypto.randomUUID();
    const ingressToken = 'sit_' + crypto.randomBytes(18).toString('hex');
    const work: WorkItem = {
      id: 'work-' + crypto.randomUUID(),
      secret: encodeWorkSecret(ingressToken, apiBaseUrl),
      data: { type: 'session', id: sessionId },
    };
    const now = Date.now();
    const session: SessionRecord = {
      id: sessionId, credential: env.credential, envId, ingressToken, workId: work.id,
      machineName: env.machineName, dir: env.dir, branch: env.branch, gitRepoUrl: env.gitRepoUrl,
      createdAt: now, lastActivity: now, wsConnected: false, sseRes: null, seq: 0,
    };
    this.sessions.set(sessionId, session);
    this.byIngressToken.set(ingressToken, sessionId);
    env.queue.push(work); // in-flight lease: memory only, invalid after a restart anyway
    if (this.pool) await upsertSession(this.pool, session);
    return { work, session };
  }

  /**
   * Create a session for the interactive REPL bridge (`/rc`): no environment/work item — the
   * interactive claude creates a code-session directly and then fetches worker creds. The
   * session id is the `cse_…` we return; `ingressToken` doubles as the `worker_jwt`.
   */
  async createReplSession(credential: string, meta: { dir?: string; title?: string; machineName?: string }, id?: string): Promise<SessionRecord> {
    const sid = id && id.startsWith('cse_') ? id : 'cse_' + crypto.randomBytes(8).toString('hex');
    const existing = this.sessions.get(sid);
    if (existing && existing.credential === credential) {
      this.patchSession(existing, meta);
      if (this.pool) await upsertSession(this.pool, existing);
      return existing;
    }
    const ingressToken = 'sit_' + crypto.randomBytes(18).toString('hex');
    const now = Date.now();
    const session: SessionRecord = {
      id: sid, credential, envId: '', ingressToken, workId: '',
      machineName: meta.machineName ?? meta.title ?? os.hostname(),
      dir: meta.dir,
      createdAt: now, lastActivity: now, wsConnected: false, sseRes: null, seq: 0,
    };
    this.sessions.set(sid, session);
    this.byIngressToken.set(ingressToken, sid);
    if (this.pool) await upsertSession(this.pool, session);
    return session;
  }

  /** Fill machine/dir when a later event (create body, system:init) knows more. */
  async updateSessionMeta(sessionId: string, meta: { dir?: string; title?: string; machineName?: string; branch?: string; gitRepoUrl?: string }): Promise<boolean> {
    const s = this.sessions.get(sessionId);
    if (!s) return false;
    const changed = this.patchSession(s, meta);
    if (changed && this.pool) await upsertSession(this.pool, s);
    return changed;
  }

  /** Pull cwd (and anything else useful) out of a data-plane payload. */
  async applyEventMeta(sessionId: string, payload: any): Promise<boolean> {
    if (!payload || payload.type !== 'system' || payload.subtype !== 'init') return false;
    const dir = typeof payload.cwd === 'string' && payload.cwd ? payload.cwd : undefined;
    return this.updateSessionMeta(sessionId, { dir });
  }

  // ── work queue (memory only: a lease is meaningless across a restart) ──
  nextWork(envId: string): WorkItem | null {
    const env = this.envs.get(envId);
    if (!env || env.queue.length === 0) return null;
    const w = env.queue.shift()!;
    env.inflight.set(w.id, w);
    return w;
  }

  ackWork(envId: string, workId: string): void {
    this.envs.get(envId)?.inflight.delete(workId);
  }

  // ── synchronous reads (served from the cache) ──
  getSession(sessionId: string): SessionRecord | undefined {
    return this.sessions.get(sessionId);
  }
  getEnv(envId: string): EnvRecord | undefined {
    return this.envs.get(envId);
  }
  sessionByIngressToken(token: string): SessionRecord | undefined {
    const id = this.byIngressToken.get(token);
    return id ? this.sessions.get(id) : undefined;
  }
  sessionsForCredential(credential: string): SessionRecord[] {
    return [...this.sessions.values()].filter((s) => s.credential === credential).sort((a, b) => b.lastActivity - a.lastActivity);
  }
  view(s: SessionRecord): SessionView {
    return { id: s.id, machine: s.machineName, dir: s.dir, branch: s.branch, gitRepoUrl: s.gitRepoUrl, status: s.wsConnected ? 'active' : 'offline', createdAt: s.createdAt, lastActivity: s.lastActivity };
  }

  touch(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    s.lastActivity = Date.now();
    if (this.pool) this.dirtyActivity.add(sessionId); // batched by the flush timer
  }

  private async flushActivity(): Promise<void> {
    if (!this.pool || this.dirtyActivity.size === 0) return;
    const ids = [...this.dirtyActivity];
    this.dirtyActivity.clear();
    const rows = ids.map((id) => this.sessions.get(id)).filter(Boolean).map((s) => ({ id: s!.id, lastActivity: s!.lastActivity }));
    try {
      await flushActivity(this.pool, rows);
    } catch (e: any) {
      for (const id of ids) this.dirtyActivity.add(id); // retry on the next tick
      console.error(`[store] last_activity flush failed: ${e.message}`);
    }
  }

  /**
   * Record child event payloads so a web client that subscribes later gets the transcript.
   * The REPL bridge replays the whole pre-/rc conversation on connect, so this captures it.
   * Batched: one multi-row INSERT per /worker/events POST.
   */
  async appendEvents(sessionId: string, payloads: unknown[]): Promise<void> {
    const storable = payloads.filter((p) => !UNSTORED_EVENT_TYPES.has((p as any)?.type));
    if (!storable.length) return;
    if (!this.pool) {
      let h = this.memHistory.get(sessionId);
      if (!h) { h = []; this.memHistory.set(sessionId, h); }
      h.push(...storable);
      if (h.length > HISTORY_LIMIT) h.splice(0, h.length - HISTORY_LIMIT);
      return;
    }
    await insertEvents(this.pool, sessionId, storable.map((p) => ({ type: (p as any)?.type, payload: p })));
  }

  async historyFor(sessionId: string): Promise<unknown[]> {
    if (!this.pool) return this.memHistory.get(sessionId) ?? [];
    return selectHistory(this.pool, sessionId, HISTORY_LIMIT);
  }

  // ── runtime connection state (memory only) ──
  markWsConnected(sessionId: string, connected: boolean): void {
    const s = this.sessions.get(sessionId);
    if (s) { s.wsConnected = connected; this.touch(sessionId); }
  }

  /** Mark an environment (and its sessions) offline — injector gone / deregistered. */
  markEnvOffline(envId: string): void {
    const env = this.envs.get(envId);
    if (env) env.online = false;
    for (const s of this.sessions.values()) if (s.envId === envId) s.wsConnected = false;
  }

  attachSse(sessionId: string, res: ServerResponse): void {
    const s = this.sessions.get(sessionId);
    if (s) s.sseRes = res;
  }

  detachSse(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (s) s.sseRes = null;
  }

  private patchSession(s: SessionRecord, meta: { dir?: string; title?: string; machineName?: string; branch?: string; gitRepoUrl?: string }): boolean {
    let changed = false;
    const machine = meta.machineName ?? meta.title;
    if (machine && s.machineName !== machine) { s.machineName = machine; changed = true; }
    if (meta.dir && s.dir !== meta.dir) { s.dir = meta.dir; changed = true; }
    if (meta.branch && s.branch !== meta.branch) { s.branch = meta.branch; changed = true; }
    if (meta.gitRepoUrl && s.gitRepoUrl !== meta.gitRepoUrl) { s.gitRepoUrl = meta.gitRepoUrl; changed = true; }
    if (changed) s.lastActivity = Date.now();
    return changed;
  }

  /** Push one stream-json payload to the child over SSE. False if no open stream. */
  sendToChild(sessionId: string, payload: unknown): boolean {
    const s = this.sessions.get(sessionId);
    if (!s || !s.sseRes) return false;
    const seq = ++s.seq;
    const data = JSON.stringify({ sequence_num: seq, event_id: `srv-${seq}`, event_type: 'relay', payload });
    try {
      s.sseRes.write(`event: client_event\ndata: ${data}\nid: ${seq}\n\n`);
      this.touch(sessionId);
      return true;
    } catch {
      return false;
    }
  }
}
