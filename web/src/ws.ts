/** Client for the controller's /ws/client channel (see src/server/web-channel.ts). */

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

export interface Handlers {
  onSessions: (s: SessionView[]) => void;
  onEvent: (sessionId: string, payload: any) => void;
  onHistory?: (sessionId: string, events: any[]) => void;
  onNotify?: (sessionId: string, message: string, ready?: boolean) => void;
  onStatus?: (connected: boolean) => void;
}

export class ControlSocket {
  private ws: WebSocket | null = null;
  private closed = false;

  constructor(private credential: string, private h: Handlers) {}

  connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws/client?credential=${encodeURIComponent(this.credential)}`);
    this.ws = ws;
    ws.onopen = () => this.h.onStatus?.(true);
    ws.onmessage = (e) => {
      let m: any;
      try { m = JSON.parse(e.data); } catch { return; }
      if (m.type === 'sessions') this.h.onSessions(m.sessions);
      else if (m.type === 'event') this.h.onEvent(m.sessionId, m.payload);
      else if (m.type === 'history') this.h.onHistory?.(m.sessionId, m.events || []);
      else if (m.type === 'notify' && typeof m.message === 'string') this.h.onNotify?.(m.sessionId, m.message, !!m.ready);
    };
    ws.onclose = () => {
      this.h.onStatus?.(false);
      if (!this.closed) setTimeout(() => this.connect(), 2000);
    };
    ws.onerror = () => ws.close();
  }

  private send(o: unknown) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(o));
  }

  subscribe(sessionId: string) { this.send({ type: 'subscribe', sessionId }); }
  sendMessage(sessionId: string, text: string) { this.send({ type: 'user_message', sessionId, text }); }
  respondPermission(sessionId: string, requestId: string, behavior: 'allow' | 'deny') { this.send({ type: 'permission_response', sessionId, requestId, behavior }); }
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
