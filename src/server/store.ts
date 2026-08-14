/**
 * store.ts — in-memory state for the controller server. Multi-tenant: every environment
 * and session is owned by a credential ("凭证A"); the web side lists/controls only its own.
 * Single-process, no persistence (yet).
 */
import crypto from 'node:crypto';
import type { ServerResponse } from 'node:http';

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
  private history = new Map<string, unknown[]>(); // sessionId → event payloads (capped ring), for late web subscribers

  createEnv(meta: { credential: string; machineName?: string; dir?: string; branch?: string; gitRepoUrl?: string; reuseId?: string }): EnvRecord {
    const id = meta.reuseId && this.envs.has(meta.reuseId) ? meta.reuseId : meta.reuseId || 'env-' + crypto.randomUUID();
    const rec: EnvRecord = {
      id, credential: meta.credential, machineName: meta.machineName, dir: meta.dir,
      branch: meta.branch, gitRepoUrl: meta.gitRepoUrl, createdAt: Date.now(), online: true,
      queue: [], inflight: new Map(),
    };
    this.envs.set(id, rec);
    return rec;
  }

  /** Queue a session work item for an environment; the session inherits the env's owner + metadata. */
  pushSessionWork(envId: string, apiBaseUrl: string): { work: WorkItem; session: SessionRecord } | null {
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
    env.queue.push(work);
    return { work, session };
  }

  /**
   * Create a session for the interactive REPL bridge (`/rc`): no environment/work item — the
   * interactive claude creates a code-session directly and then fetches worker creds. The
   * session id is the `cse_…` we return; `ingressToken` doubles as the `worker_jwt`.
   */
  createReplSession(credential: string, meta: { dir?: string; title?: string; machineName?: string }): SessionRecord {
    const id = 'cse_' + crypto.randomBytes(8).toString('hex');
    const ingressToken = 'sit_' + crypto.randomBytes(18).toString('hex');
    const now = Date.now();
    const session: SessionRecord = {
      id, credential, envId: '', ingressToken, workId: '',
      machineName: meta.machineName ?? meta.title, dir: meta.dir, // title = the /rc session name (hostname by default)
      createdAt: now, lastActivity: now, wsConnected: false, sseRes: null, seq: 0,
    };
    this.sessions.set(id, session);
    this.byIngressToken.set(ingressToken, id);
    return session;
  }

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

  // ── multi-tenant lookups ──
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
    if (s) s.lastActivity = Date.now();
  }

  /** Record a child event payload so a web client that subscribes later gets the transcript.
   * The REPL bridge replays the whole pre-/rc conversation on connect, so this captures it. */
  appendEvent(sessionId: string, payload: unknown): void {
    let h = this.history.get(sessionId);
    if (!h) { h = []; this.history.set(sessionId, h); }
    h.push(payload);
    if (h.length > 3000) h.splice(0, h.length - 3000); // cap
  }
  historyFor(sessionId: string): unknown[] {
    return this.history.get(sessionId) ?? [];
  }

  markWsConnected(sessionId: string, connected: boolean): void {
    const s = this.sessions.get(sessionId);
    if (s) { s.wsConnected = connected; s.lastActivity = Date.now(); }
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

  /**
   * Push one stream-json `payload` to the child over its SSE stream as a `client_event`
   * frame (the exact shape sse-bridge-transport's handleSSEFrame expects). Returns false
   * if there is no open stream for the session.
   */
  sendToChild(sessionId: string, payload: unknown): boolean {
    const s = this.sessions.get(sessionId);
    if (!s || !s.sseRes) return false;
    const seq = ++s.seq;
    const data = JSON.stringify({ sequence_num: seq, event_id: `srv-${seq}`, event_type: 'relay', payload });
    try {
      s.sseRes.write(`event: client_event\ndata: ${data}\nid: ${seq}\n\n`);
      s.lastActivity = Date.now();
      return true;
    } catch {
      return false;
    }
  }
}
