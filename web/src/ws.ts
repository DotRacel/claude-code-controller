/** Client for the controller's /ws/client channel (see src/server/web-channel.ts). */
import type { SessionDigest } from '../../src/server/store.ts';

export type { SessionDigest };

export interface SessionView {
  id: string;
  machine?: string;
  dir?: string;
  branch?: string;
  gitRepoUrl?: string;
  status: 'active' | 'offline';
  createdAt: number;
  lastActivity: number;
  /** Server-derived summary for the list row (prompt preview, running tool, tool count). */
  digest: SessionDigest;
}

export type Connection = 'connecting' | 'online' | 'offline';

/**
 * What we answer a `can_use_tool` request with. Mirrors the worker's own bridge-permission
 * schema — `updatedInput` carries AskUserQuestion answers, `updatedPermissions` carries the
 * worker's own `permission_suggestions` back to make an allow stick ("Always allow").
 */
export interface PermissionAnswer {
  behavior: 'allow' | 'deny';
  updatedInput?: Record<string, unknown>;
  updatedPermissions?: unknown[];
  message?: string;
}

export interface Handlers {
  onSessions: (s: SessionView[]) => void;
  onEvent: (sessionId: string, payload: any) => void;
  onHistory?: (sessionId: string, events: any[]) => void;
  onNotify?: (sessionId: string, message: string, ready?: boolean) => void;
  onStatus?: (c: Connection) => void;
}

/** Build hash + the numbers that decide whether the shell is laid out correctly. */
function clientInfo(): string {
  try {
    const src = document.querySelector<HTMLScriptElement>('script[src*="assets/index-"]')?.src ?? '';
    const build = /index-([A-Za-z0-9_-]+)\./.exec(src)?.[1] ?? 'dev';
    const root = document.getElementById('root');
    const r = root?.getBoundingClientRect();
    const mode = ['standalone', 'fullscreen', 'minimal-ui', 'browser'].find((x) => matchMedia(`(display-mode: ${x})`).matches) ?? '?';
    const probe = document.createElement('div');
    probe.style.cssText = 'position:absolute;top:0;left:0;width:0;height:100%';
    document.body.appendChild(probe);
    const icb = Math.round(probe.getBoundingClientRect().height);
    probe.remove();
    // Insets distinguish the two ways iOS can install a web app: honouring the apple-* meta tags
    // gives a translucent status bar (full-height window, non-zero top inset), while the manifest
    // path gives an opaque one (shorter window, zero top inset) and the status-bar strip is then
    // outside the web view entirely.
    const inset = (side: string) => {
      const d = document.createElement('div');
      d.style.cssText = `position:fixed;top:0;left:0;width:0;height:0;padding-${side}:env(safe-area-inset-${side},0px)`;
      document.body.appendChild(d);
      const v = getComputedStyle(d).getPropertyValue(`padding-${side}`);
      d.remove();
      return parseFloat(v) || 0;
    };
    // Which viewport unit tells the truth is the entire question on iOS 26, so report all four
    // next to the physical screen height.
    const unit = (u: string) => {
      const d = document.createElement('div');
      d.style.cssText = `position:fixed;top:0;left:0;width:0;height:100${u}`;
      document.body.appendChild(d);
      const h = Math.round(d.getBoundingClientRect().height);
      d.remove();
      return h;
    };
    // The whole percentage chain from the shell down to the composer. When a band appears at the
    // bottom, exactly one of these boxes is where the height gets lost — and reading it off the
    // device beats deducing it from a screenshot.
    const chain = ['.desktop-stage', '.phone-frame', '.screen', '.scroll', '.composer-wrap', '.composer']
      .map((sel) => {
        const b = document.querySelector(sel)?.getBoundingClientRect();
        return b ? `${sel.slice(1)}:${Math.round(b.top)}→${Math.round(b.bottom)}` : `${sel.slice(1)}:-`;
      })
      .join(' ');
    const comp = document.querySelector('.composer')?.getBoundingClientRect();
    return `build=${build} mode=${mode} win=${innerWidth}x${innerHeight} screen=${screen.width}x${screen.height}`
      + ` shell=${r ? `${Math.round(r.top)}→${Math.round(r.bottom)}` : '?'} icb=${icb}`
      + ` vh/dvh/svh/lvh=${unit('vh')}/${unit('dvh')}/${unit('svh')}/${unit('lvh')}`
      + ` insets=${inset('top')}/${inset('bottom')}`
      + (comp ? ` gap=${Math.round(screen.height - comp.bottom)}` : '')
      + ` | ${chain}`;
  } catch {
    return 'info-failed';
  }
}

export class ControlSocket {
  private ws: WebSocket | null = null;
  private closed = false;
  private retry = 0;

  constructor(private credential: string, private h: Handlers) {}

  connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    this.h.onStatus?.('connecting');
    const ws = new WebSocket(`${proto}://${location.host}/ws/client?credential=${encodeURIComponent(this.credential)}`);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.h.onStatus?.('online');
      // Report what this copy is actually running. On an installed iOS app the service worker can
      // keep serving an old bundle with no network request at all, so the server otherwise has no
      // way to know which build a phone is on — and neither do we.
      this.send({ type: 'hello', info: clientInfo() });
    };
    ws.onmessage = (e) => {
      let m: any;
      try { m = JSON.parse(e.data); } catch { return; }
      if (m.type === 'sessions') this.h.onSessions(m.sessions);
      else if (m.type === 'event') this.h.onEvent(m.sessionId, m.payload);
      else if (m.type === 'history') this.h.onHistory?.(m.sessionId, m.events || []);
      else if (m.type === 'notify' && typeof m.message === 'string') this.h.onNotify?.(m.sessionId, m.message, !!m.ready);
    };
    ws.onclose = () => {
      if (this.closed) return;
      this.h.onStatus?.('offline');
      // Back off a little, but stay responsive: a phone waking from sleep should reconnect fast.
      const wait = Math.min(1000 * 2 ** this.retry++, 15000);
      setTimeout(() => this.connect(), wait);
    };
    ws.onerror = () => ws.close();
  }

  /** Force an immediate reconnect (the offline banner's Retry). */
  reconnect() {
    this.retry = 0;
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) this.ws.close();
    else this.connect();
  }

  private send(o: unknown) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(o));
  }

  get online(): boolean { return this.ws?.readyState === WebSocket.OPEN; }

  subscribe(sessionId: string) { this.send({ type: 'subscribe', sessionId }); }
  sendMessage(sessionId: string, text: string) { this.send({ type: 'user_message', sessionId, text }); }
  respondPermission(sessionId: string, requestId: string, answer: PermissionAnswer) {
    this.send({ type: 'permission_response', sessionId, requestId, ...answer });
  }
  control(sessionId: string, subtype: string, extra?: Record<string, unknown>) { this.send({ type: 'control', sessionId, subtype, extra }); }

  close() { this.closed = true; this.ws?.close(); }
}

// ── credential cookie ──
export function getCredential(): string | null {
  const m = document.cookie.match(/(?:^|;\s*)ccc_credential=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}
export function setCredential(cred: string) {
  const secure = location.protocol === 'https:' ? '; Secure' : '';
  // 10-year cookie; SameSite=Lax. Not httpOnly by design (the SPA reads it to open the WS).
  document.cookie = `ccc_credential=${encodeURIComponent(cred)}; Max-Age=${10 * 365 * 24 * 3600}; Path=/; SameSite=Lax${secure}`;
}
export function clearCredential() {
  document.cookie = 'ccc_credential=; Max-Age=0; Path=/';
}
