/**
 * index.ts — the controller server: bridge control-plane REST + CCR v2 SSE data-plane.
 *
 * Multi-tenant: every environment/session is owned by a credential ("凭证A") read from the
 * bridge `Authorization: Bearer`. The data-plane authenticates by the session_ingress_token.
 * Re-hosts the Remote Control control-plane so an injected `claude remote-control` talks to
 * us; the web side (web-channel.ts) attaches to the returned `server` and relays per-credential.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Store } from './store.ts';
import type { Pool } from './db.ts';

export type ServerEvent =
  | { type: 'env.register'; envId: string; credential: string; body: any }
  | { type: 'env.deregister'; envId: string; credential?: string }
  | { type: 'session.create'; sessionId: string; credential: string }
  | { type: 'session.update'; sessionId: string; credential: string }
  | { type: 'ws.connect'; sessionId: string; credential: string }
  | { type: 'ws.close'; sessionId: string; credential: string }
  | { type: 'claude.event'; sessionId: string; credential: string; payload: any }
  | { type: 'work.poll'; envId: string; delivered?: string }
  | { type: 'http'; method: string; path: string };

/**
 * What a bridge client is allowed to answer a `can_use_tool` request with. This is exactly the
 * schema the 2.1.232 worker validates a bridge permission response against (an empty
 * `updatedInput` is treated as absent, malformed `updatedPermissions` is dropped with a warn):
 *
 *   - `updatedInput`       — edited tool input. AskUserQuestion rides this: the phone puts the
 *                            chosen answers in `{questions, answers, response?, annotations?}`.
 *   - `updatedPermissions` — the `permission_suggestions` the worker itself offered, echoed back
 *                            to make an allow persistent ("Always allow").
 *   - `message`            — reason shown to the model on a deny.
 */
export interface PermissionDecision {
  behavior: 'allow' | 'deny';
  updatedInput?: Record<string, unknown>;
  updatedPermissions?: unknown[];
  message?: string;
}

export interface ControllerServer {
  server: http.Server;
  port: number;
  baseUrl: string;
  store: Store;
  pushSessionWork: (envId: string, apiBaseUrl?: string) => ReturnType<Store['pushSessionWork']>; // async: writes through to PG
  sendUserMessage: (sessionId: string, text: string) => boolean;
  sendControlResponse: (sessionId: string, requestId: string, decision: 'allow' | 'deny' | PermissionDecision) => boolean;
  sendControl: (sessionId: string, subtype: string, extra?: Record<string, unknown>) => boolean;
  close: () => void;
}

const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
const NO_CACHE = new Set(['sw.js', 'manifest.webmanifest']);

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => resolve(b));
    req.on('error', () => resolve(b));
  });
}
const bearer = (req: http.IncomingMessage): string | undefined => {
  const h = req.headers.authorization;
  return h && h.startsWith('Bearer ') ? h.slice(7) : undefined;
};
/** The origin the child should use to reach us, derived from the injector's own request. */
const originOf = (req: http.IncomingMessage): string => {
  const proto = (req.headers['x-forwarded-proto'] as string) || 'http';
  return `${proto}://${req.headers.host}`;
};

export interface CreateOpts {
  onEvent?: (e: ServerEvent) => void;
  port?: number;
  host?: string;
  staticDir?: string; // serve SPA build for non-API paths
  pool?: Pool; // PG persistence; omitted = pure in-memory (tests, local drivers)
}

export async function createControllerServer(opts: CreateOpts = {}): Promise<ControllerServer> {
  const onEvent = opts.onEvent || (() => {});
  const store = new Store({ pool: opts.pool });
  await store.load(); // hydrate the read cache before we accept any request

  const server = http.createServer(async (req, res) => {
    const method = req.method || 'GET';
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const p = url.pathname;
    onEvent({ type: 'http', method, path: p });
    const json = (code: number, obj?: any) => {
      res.statusCode = code;
      res.setHeader('content-type', 'application/json');
      res.end(obj === undefined ? '' : JSON.stringify(obj));
    };

    let m: RegExpExecArray | null;

    // ── bridge control-plane ──
    // POST /v1/environments/bridge — register (owner = 凭证A) + auto-create one session
    if (method === 'POST' && p === '/v1/environments/bridge') {
      const credential = bearer(req);
      if (!credential) return json(401, { error: { type: 'no_credential' } });
      const body = JSON.parse((await readBody(req)) || '{}');
      const env = await store.createEnv({ credential, machineName: body.machine_name, dir: body.directory, branch: body.branch, gitRepoUrl: body.git_repo_url, reuseId: body.environment_id });
      onEvent({ type: 'env.register', envId: env.id, credential, body });
      const pushed = await store.pushSessionWork(env.id, originOf(req)); // one owner-controllable session
      if (pushed) onEvent({ type: 'session.create', sessionId: pushed.session.id, credential });
      return json(200, { environment_id: env.id, non_exclusive_heartbeat_interval_ms: 20000, multisession_poll_interval_ms_at_capacity: 5000, multisession_poll_interval_ms_partial_capacity: 3000, multisession_poll_interval_ms_not_at_capacity: 2000 });
    }
    if (method === 'GET' && (m = /^\/v1\/environments\/([^/]+)\/work\/poll$/.exec(p))) {
      const work = store.nextWork(m[1]);
      onEvent({ type: 'work.poll', envId: m[1], delivered: work?.id });
      return work ? json(200, work) : json(200, undefined);
    }
    if (method === 'POST' && (m = /^\/v1\/environments\/([^/]+)\/work\/([^/]+)\/ack$/.exec(p))) { store.ackWork(m[1], m[2]); return json(200, {}); }
    if (method === 'POST' && /^\/v1\/environments\/[^/]+\/work\/[^/]+\/heartbeat$/.test(p)) return json(200, { lease_extended: true, state: 'active' });
    if (method === 'POST' && /^\/v1\/environments\/[^/]+\/work\/[^/]+\/stop$/.test(p)) return json(200, {});
    if (method === 'POST' && /^\/v1\/environments\/[^/]+\/bridge\/reconnect$/.test(p)) return json(200, {});
    if (method === 'DELETE' && (m = /^\/v1\/environments\/bridge\/([^/]+)$/.exec(p))) {
      const env = store.getEnv(m[1]);
      store.markEnvOffline(m[1]);
      onEvent({ type: 'env.deregister', envId: m[1], credential: env?.credential });
      return json(200, {});
    }

    // GET /v1/code/sessions/{id} is control-plane (OAuth / 凭证A), not the data-plane.
    // A 401 here is shown as "Session expired. Please run /login" — missing session must be 404.
    if (method === 'GET' && (m = /^\/v1\/code\/sessions\/([^/]+)$/.exec(p))) {
      const token = bearer(req);
      const session = store.getSession(m[1]) || (token ? store.sessionByIngressToken(token) : undefined);
      if (!session) return json(404, { error: { type: 'not_found' } });
      if (token && token !== session.credential && token !== session.ingressToken) return json(401, { error: { type: 'bad_session' } });
      return json(200, { session: { id: session.id } });
    }

    // ── CCR v2 code-sessions data-plane (authenticated by session_ingress_token) ──
    const dp = /^\/v1\/code\/sessions\/([^/]+)\/(worker(?:\/.*)?|events)$/.exec(p);
    if (dp) {
      const token = bearer(req);
      const session = token ? store.sessionByIngressToken(token) : undefined;
      if (!session) return json(401, { error: { type: 'bad_session_token' } });
      const sid = session.id;
      const sub = p.slice(`/v1/code/sessions/${dp[1]}`.length); // '' | '/worker' | '/worker/events' | '/worker/events/stream' | '/worker/internal-events' | '/worker/register' | '/events'

      if (method === 'POST' && sub === '/worker/register') return json(200, { worker_epoch: 1 });
      if (method === 'GET' && sub === '/worker/events/stream') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        res.write(': connected\n\n');
        store.markWsConnected(sid, true);
        store.attachSse(sid, res);
        onEvent({ type: 'ws.connect', sessionId: sid, credential: session.credential });
        const ka = setInterval(() => { try { res.write(': ka\n\n'); } catch {} }, 15000);
        ka.unref?.();
        req.on('close', () => { clearInterval(ka); store.detachSse(sid); store.markWsConnected(sid, false); onEvent({ type: 'ws.close', sessionId: sid, credential: session.credential }); });
        return;
      }
      if (sub === '/worker' && (method === 'GET' || method === 'PUT')) {
        return method === 'GET' ? json(200, { worker: { external_metadata: null, internal_metadata: null }, worker_epoch: 1 }) : json(200, { worker_epoch: 1, status: 'ready' });
      }
      if (method === 'GET' && sub === '/worker/internal-events') {
        const key = url.searchParams.get('subagents') === 'true' ? 'subagent_events' : 'internal_events';
        return json(200, { [key]: [] });
      }
      if (method === 'POST' && (sub === '/worker/events' || sub === '/events')) {
        const body = JSON.parse((await readBody(req)) || '{}');
        const payloads = (Array.isArray(body.events) ? body.events : []).filter((ev: any) => ev?.payload).map((ev: any) => ev.payload);
        // Relay first — a phone is watching a live stream; persistence comes after.
        for (const payload of payloads) onEvent({ type: 'claude.event', sessionId: sid, credential: session.credential, payload });
        store.touch(sid);
        for (const payload of payloads) {
          if (await store.applyEventMeta(sid, payload)) onEvent({ type: 'session.update', sessionId: sid, credential: session.credential });
        }
        // One multi-row INSERT for the whole batch. A write failure must not make the child
        // retry the batch (it would duplicate the relay), so log and still answer 200.
        await store.appendEvents(sid, payloads).catch((e) => console.error(`[server] event persist failed ses=${sid}: ${e.message}`));
        return json(200, {});
      }
      if (method === 'POST' && sub.startsWith('/worker/')) return json(200, {}); // heartbeat / delivery
      return json(200, {});
    }

    // ── interactive REPL bridge (/rc) control-plane ──
    // POST /v1/code/sessions — createCodeSession: owned by 凭证A, creates a session record.
    if (method === 'POST' && p === '/v1/code/sessions') {
      const credential = bearer(req);
      if (!credential) return json(401, { error: { type: 'no_credential' } });
      const body = JSON.parse((await readBody(req)) || '{}');
      const s = await store.createReplSession(credential, sessionMetaFrom(body));
      onEvent({ type: 'session.create', sessionId: s.id, credential });
      return json(200, { session: { id: s.id } });
    }
    // POST /v1/code/sessions/{id}/bridge — fetchRemoteCredentials → worker_jwt (= ingress token).
    if (method === 'POST' && (m = /^\/v1\/code\/sessions\/([^/]+)\/bridge$/.exec(p))) {
      const credential = bearer(req);
      const body = JSON.parse((await readBody(req)) || '{}');
      let session = store.getSession(m[1]);
      // Not in the read cache (never seen, or older than the load window) while the TUI still
      // holds the cse_* id. Recreate it under this credential so fetchRemoteCredentials can
      // finish without a /login — this is why a cold session is recoverable, not lost.
      if (!session && credential && m[1].startsWith('cse_')) {
        session = await store.createReplSession(credential, sessionMetaFrom(body), m[1]);
        onEvent({ type: 'session.create', sessionId: session.id, credential });
      } else if (session && (await store.updateSessionMeta(session.id, sessionMetaFrom(body)))) {
        onEvent({ type: 'session.update', sessionId: session.id, credential: session.credential });
      }
      if (!session || (credential && session.credential !== credential)) return json(session ? 401 : 404, { error: { type: 'bad_session' } });
      return json(200, { worker_jwt: session.ingressToken, api_base_url: originOf(req), worker_epoch: 1, expires_in: 3600 });
    }
    // /v1/sessions — bridge session metadata (createBridgeSession)
    if (method === 'POST' && p === '/v1/sessions') return json(200, { id: 'cses-' + crypto.randomBytes(5).toString('hex') });
    if (/^\/v1\/sessions\/[^/]+(\/archive)?$/.test(p)) return json(200, {});

    // ── static SPA (non-API) ──
    if (opts.staticDir && (method === 'GET' || method === 'HEAD')) return serveStatic(opts.staticDir, p, res);
    return json(404, { error: { type: 'not_found', message: p } });
  });

  const api = {
    pushSessionWork: (envId: string, apiBaseUrl?: string) => store.pushSessionWork(envId, apiBaseUrl || `http://127.0.0.1:${(server.address() as any)?.port ?? 0}`),
    sendUserMessage: (sessionId: string, text: string) =>
      store.sendToChild(sessionId, { type: 'user', message: { role: 'user', content: text }, client_platform: 'web_claude_ai' }),
    sendControlResponse: (sessionId: string, requestId: string, decision: 'allow' | 'deny' | PermissionDecision) => {
      const d: PermissionDecision = typeof decision === 'string' ? { behavior: decision } : decision;
      // Only the four keys the worker's schema knows; anything else it would ignore anyway.
      const response: Record<string, unknown> = { behavior: d.behavior === 'deny' ? 'deny' : 'allow' };
      if (d.updatedInput && Object.keys(d.updatedInput).length) response.updatedInput = d.updatedInput;
      if (d.updatedPermissions?.length) response.updatedPermissions = d.updatedPermissions;
      if (d.message) response.message = d.message;
      store.clearPendingApproval(sessionId); // the list badge must drop as soon as we answer
      return store.sendToChild(sessionId, { type: 'control_response', response: { subtype: 'success', request_id: requestId, response } });
    },
    sendControl: (sessionId: string, subtype: string, extra: Record<string, unknown> = {}) =>
      store.sendToChild(sessionId, { type: 'control_request', request_id: crypto.randomUUID(), request: { subtype, ...extra } }),
  };

  return new Promise((resolve) => {
    server.listen(opts.port ?? 0, opts.host ?? '127.0.0.1', () => {
      const port = (server.address() as any).port;
      resolve({ server, port, baseUrl: `http://127.0.0.1:${port}`, store, ...api, close: () => { server.close(); void store.close(); } });
    });
  });
}

function sessionMetaFrom(body: any): { dir?: string; title?: string; machineName?: string } {
  const dir = body?.config?.cwd || body?.cwd || body?.directory || body?.config?.directory;
  const title = body?.title || body?.name || body?.session_name;
  const machineName = body?.machine_name || body?.hostname;
  return { dir: typeof dir === 'string' && dir ? dir : undefined, title: typeof title === 'string' && title ? title : undefined, machineName: typeof machineName === 'string' && machineName ? machineName : undefined };
}

function serveStatic(root: string, urlPath: string, res: http.ServerResponse): void {
  let rel = decodeURIComponent(urlPath.split('?')[0]);
  if (rel.endsWith('/')) rel += 'index.html';
  let file = path.join(root, rel);
  if (!file.startsWith(path.resolve(root))) { res.statusCode = 403; res.end('forbidden'); return; }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(root, 'index.html'); // SPA fallback
  fs.readFile(file, (err, buf) => {
    if (err) { res.statusCode = 404; res.end('not found'); return; }
    res.setHeader('content-type', MIME[path.extname(file)] || 'application/octet-stream');
    if (NO_CACHE.has(path.basename(file))) res.setHeader('cache-control', 'no-cache');
    res.end(buf);
  });
}
