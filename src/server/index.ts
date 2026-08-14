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

export type ServerEvent =
  | { type: 'env.register'; envId: string; credential: string; body: any }
  | { type: 'env.deregister'; envId: string; credential?: string }
  | { type: 'session.create'; sessionId: string; credential: string }
  | { type: 'ws.connect'; sessionId: string; credential: string }
  | { type: 'ws.close'; sessionId: string; credential: string }
  | { type: 'claude.event'; sessionId: string; credential: string; payload: any }
  | { type: 'work.poll'; envId: string; delivered?: string }
  | { type: 'http'; method: string; path: string };

export interface ControllerServer {
  server: http.Server;
  port: number;
  baseUrl: string;
  store: Store;
  pushSessionWork: (envId: string, apiBaseUrl?: string) => ReturnType<Store['pushSessionWork']>;
  sendUserMessage: (sessionId: string, text: string) => boolean;
  sendControlResponse: (sessionId: string, requestId: string, behavior: 'allow' | 'deny') => boolean;
  sendControl: (sessionId: string, subtype: string, extra?: Record<string, unknown>) => boolean;
  close: () => void;
}

const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };

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
}

export function createControllerServer(opts: CreateOpts = {}): Promise<ControllerServer> {
  const onEvent = opts.onEvent || (() => {});
  const store = new Store();

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
      const env = store.createEnv({ credential, machineName: body.machine_name, dir: body.directory, branch: body.branch, gitRepoUrl: body.git_repo_url, reuseId: body.environment_id });
      onEvent({ type: 'env.register', envId: env.id, credential, body });
      const pushed = store.pushSessionWork(env.id, originOf(req)); // one owner-controllable session
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
      const env = store.envs.get(m[1]);
      store.markEnvOffline(m[1]);
      onEvent({ type: 'env.deregister', envId: m[1], credential: env?.credential });
      return json(200, {});
    }

    // ── CCR v2 code-sessions data-plane (authenticated by session_ingress_token) ──
    const dp = /^\/v1\/code\/sessions\/([^/]+)\/(worker(?:\/.*)?|events)$/.exec(p) || /^\/v1\/code\/sessions\/([^/]+)$/.exec(p);
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
        for (const ev of Array.isArray(body.events) ? body.events : []) if (ev && ev.payload) { store.appendEvent(sid, ev.payload); onEvent({ type: 'claude.event', sessionId: sid, credential: session.credential, payload: ev.payload }); }
        store.touch(sid);
        return json(200, {});
      }
      if (method === 'POST' && sub.startsWith('/worker/')) return json(200, {}); // heartbeat / delivery
      return json(200, {}); // GET /v1/code/sessions/{id}
    }

    // ── interactive REPL bridge (/rc) control-plane ──
    // POST /v1/code/sessions — createCodeSession: owned by 凭证A, creates a session record.
    if (method === 'POST' && p === '/v1/code/sessions') {
      const credential = bearer(req);
      if (!credential) return json(401, { error: { type: 'no_credential' } });
      const body = JSON.parse((await readBody(req)) || '{}');
      const s = store.createReplSession(credential, { dir: body.config?.cwd, title: body.title });
      onEvent({ type: 'session.create', sessionId: s.id, credential });
      return json(200, { session: { id: s.id } });
    }
    // POST /v1/code/sessions/{id}/bridge — fetchRemoteCredentials → worker_jwt (= ingress token).
    if (method === 'POST' && (m = /^\/v1\/code\/sessions\/([^/]+)\/bridge$/.exec(p))) {
      const credential = bearer(req);
      const session = store.sessions.get(m[1]);
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
    sendControlResponse: (sessionId: string, requestId: string, behavior: 'allow' | 'deny') =>
      store.sendToChild(sessionId, { type: 'control_response', response: { subtype: 'success', request_id: requestId, response: { behavior } } }),
    sendControl: (sessionId: string, subtype: string, extra: Record<string, unknown> = {}) =>
      store.sendToChild(sessionId, { type: 'control_request', request_id: crypto.randomUUID(), request: { subtype, ...extra } }),
  };

  return new Promise((resolve) => {
    server.listen(opts.port ?? 0, opts.host ?? '127.0.0.1', () => {
      const port = (server.address() as any).port;
      resolve({ server, port, baseUrl: `http://127.0.0.1:${port}`, store, ...api, close: () => server.close() });
    });
  });
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
    res.end(buf);
  });
}
