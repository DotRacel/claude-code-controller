import { useState, useEffect, useRef } from 'react';
import { ControlSocket, getCredential, setCredential, clearCredential, type SessionView } from './ws';
import { takeVisibleUserTexts } from './transcript';
import { isPushNotificationToolUse } from '../../src/push-event.ts';
import { notifyPermission, requestNotifyPermission, showPushNotification, pushNotificationFrom } from './notify';

// ── transcript item model (derived from docs/EVENTS.md payloads) ──
type Item =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool_use'; id: string; name: string; input: any }
  | { kind: 'tool_result'; toolUseId: string; content: string; isError?: boolean }
  | { kind: 'result'; subtype?: string; text: string }
  | { kind: 'status'; text: string };

interface Permission { requestId: string; toolName: string; input: any; reason?: string; suggestions?: any[] }

function useIsMobile(): boolean {
  const check = () => /Android|iPhone|iPad|iPod|Mobile|Silk/i.test(navigator.userAgent) || window.innerWidth <= 820;
  const [mobile, setMobile] = useState(check);
  useEffect(() => {
    const on = () => setMobile(check());
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  return mobile;
}

export function App() {
  const isMobile = useIsMobile();
  const [credential, setCred] = useState<string | null>(getCredential());
  if (!isMobile) return <DesktopGuard />;
  if (!credential) return <CredentialGate onSet={(c) => { setCredential(c); setCred(c); }} />;
  return <Home credential={credential} onLogout={() => { clearCredential(); setCred(null); }} />;
}

function DesktopGuard() {
  return (
    <div className="center-screen">
      <div className="panel">
        <div className="logo-dot" />
        <h1>手机专用</h1>
        <p className="muted">Claude Remote 目前只适配移动端。请用手机浏览器打开本页面。</p>
        <p className="mono small">{location.origin}</p>
        <p className="muted small">（如果你确实想在桌面试用，把浏览器窗口调窄到手机尺寸即可继续。）</p>
      </div>
    </div>
  );
}

function CredentialGate({ onSet }: { onSet: (c: string) => void }) {
  const [val, setVal] = useState('');
  return (
    <div className="center-screen">
      <div className="panel">
        <div className="logo-dot" />
        <h1>Claude Remote</h1>
        <p className="muted">粘贴你的凭证以连接自己的会话。凭证由 <span className="mono">control-claude-code</span> 启动时生成/打印。</p>
        <input className="cred-input" placeholder="ccc_…" value={val} onChange={(e) => setVal(e.target.value)} autoCapitalize="off" autoCorrect="off" spellCheck={false} />
        <button className="btn primary" disabled={!val.trim()} onClick={() => onSet(val.trim())}>连接</button>
        <p className="muted small">凭证保存在本机 cookie；丢失后需重新获取。</p>
      </div>
    </div>
  );
}

function Home({ credential, onLogout }: { credential: string; onLogout: () => void }) {
  const [sessions, setSessions] = useState<SessionView[]>([]);
  const [active, setActive] = useState<SessionView | null>(null);
  const [connected, setConnected] = useState(false);
  const sockRef = useRef<ControlSocket | null>(null);
  const eventCb = useRef<(sid: string, payload: any) => void>(() => {});
  const historyCb = useRef<(sid: string, events: any[]) => void>(() => {});

  useEffect(() => {
    const sock = new ControlSocket(credential, {
      onSessions: (s) => setSessions(s),
      onEvent: (sid, p) => {
        const note = pushNotificationFrom(p);
        if (note) showPushNotification(note.message, { force: note.ready || document.visibilityState !== 'visible' });
        eventCb.current(sid, p);
      },
      onHistory: (sid, evs) => historyCb.current(sid, evs),
      onNotify: (_sid, message, ready) => { showPushNotification(message, { force: !!ready || document.visibilityState !== 'visible' }); },
      onStatus: setConnected,
    });
    sock.connect();
    sockRef.current = sock;
    return () => sock.close();
  }, [credential]);

  // keep the active session view fresh as the list updates
  useEffect(() => {
    if (active) { const u = sessions.find((s) => s.id === active.id); if (u) setActive(u); }
  }, [sessions]);

  if (active && sockRef.current) {
    return <ChatView session={active} sock={sockRef.current} onBack={() => setActive(null)} registerEvent={(cb) => (eventCb.current = cb)} registerHistory={(cb) => (historyCb.current = cb)} />;
  }
  return <SessionList sessions={sessions} connected={connected} onOpen={setActive} onLogout={onLogout} />;
}

function relTime(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s 前`;
  if (s < 3600) return `${Math.round(s / 60)}m 前`;
  if (s < 86400) return `${Math.round(s / 3600)}h 前`;
  return `${Math.round(s / 86400)}d 前`;
}

function SessionList({ sessions, connected, onOpen, onLogout }: { sessions: SessionView[]; connected: boolean; onOpen: (s: SessionView) => void; onLogout: () => void }) {
  const [perm, setPerm] = useState(notifyPermission());
  const askNotify = async () => { await requestNotifyPermission(); setPerm(notifyPermission()); };
  return (
    <div className="screen">
      <header className="topbar">
        <span className={`dot ${connected ? 'on' : 'off'}`} />
        <span className="title">会话</span>
        <button className="link" onClick={onLogout}>退出</button>
      </header>
      {perm === 'default' && (
        <button className="notify-banner" onClick={askNotify}>会话就绪时通知我</button>
      )}
      <div className="scroll">
        {sessions.length === 0 && (
          <div className="empty">
            <p className="muted">还没有会话。</p>
            <p className="muted small">在电脑上用 <span className="mono">control-claude-code</span> 启动，会话会出现在这里。</p>
          </div>
        )}
        {sessions.map((s) => (
          <button key={s.id} className="session-card" onClick={() => onOpen(s)}>
            <div className="row">
              <span className={`dot ${s.status === 'active' ? 'on' : 'off'}`} />
              <span className="session-machine">{s.machine || '未知设备'}</span>
              <span className="muted small right">{relTime(s.lastActivity)}</span>
            </div>
            <div className="session-dir mono small">{s.dir || '~'}{s.branch ? ` · ${s.branch}` : ''}</div>
          </button>
        ))}
      </div>
    </div>
  );
}

function ChatView({ session, sock, onBack, registerEvent, registerHistory }: { session: SessionView; sock: ControlSocket; onBack: () => void; registerEvent: (cb: (sid: string, p: any) => void) => void; registerHistory: (cb: (sid: string, events: any[]) => void) => void }) {
  const [items, setItems] = useState<Item[]>([]);
  const [input, setInput] = useState('');
  const [perm, setPerm] = useState<Permission | null>(null);
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pendingWeb = useRef<string[]>([]);

  useEffect(() => {
    sock.subscribe(session.id);
    pendingWeb.current = [];
    const push = (it: Item) => setItems((x) => [...x, it]);
    // isHistory=true = transcript backfill: render past turns, do not reopen a stale
    // permission modal or flip the busy flag. Live `user` echoes include both web-sent
    // (already on screen) and terminal-typed turns (must be shown).
    const apply = (payload: any, isHistory: boolean) => {
      if (!payload) return;
      const t = payload.type;
      if (t === 'assistant') {
        for (const b of payload.message?.content || []) {
          if (b.type === 'text' && b.text) push({ kind: 'assistant', text: b.text });
          else if (b.type === 'thinking' && b.thinking) push({ kind: 'thinking', text: b.thinking });
          else if (b.type === 'tool_use' && !isPushNotificationToolUse(b)) push({ kind: 'tool_use', id: b.id, name: b.name, input: b.input });
        }
      } else if (t === 'user') {
        const taken = takeVisibleUserTexts(payload, pendingWeb.current, isHistory);
        pendingWeb.current = taken.pendingWeb;
        for (const txt of taken.texts) {
          push({ kind: 'user', text: txt });
          if (!isHistory) setBusy(true);
        }
        const content = payload.message?.content;
        if (Array.isArray(content)) {
          for (const b of content) {
            if (b.type === 'tool_result') push({ kind: 'tool_result', toolUseId: b.tool_use_id, content: typeof b.content === 'string' ? b.content : JSON.stringify(b.content), isError: b.is_error });
          }
        }
      } else if (t === 'result') {
        if (!isHistory) setBusy(false);
        // A normal turn end (success) needs no marker — only surface errors.
        if (payload.subtype && payload.subtype !== 'success') push({ kind: 'result', subtype: payload.subtype, text: typeof payload.result === 'string' ? payload.result : '' });
      } else if (t === 'control_request' && payload.request?.subtype === 'can_use_tool') {
        if (!isHistory) setPerm({ requestId: payload.request_id, toolName: payload.request.tool_name, input: payload.request.input, reason: payload.request.decision_reason, suggestions: payload.request.permission_suggestions });
      } else if (t === 'system' && payload.subtype === 'post_turn_summary' && payload.status_detail) {
        push({ kind: 'status', text: payload.status_detail });
      }
    };
    registerHistory((sid, evs) => { if (sid !== session.id) return; setItems([]); for (const e of evs) apply(e, true); });
    registerEvent((sid, payload) => { if (sid === session.id) apply(payload, false); });
    return () => { registerEvent(() => {}); registerHistory(() => {}); };
  }, [session.id]);

  useEffect(() => { const el = scrollRef.current; if (el) el.scrollTop = el.scrollHeight; }, [items, perm]);

  const submit = () => {
    const text = input.trim();
    if (!text) return;
    pendingWeb.current.push(text);
    setItems((x) => [...x, { kind: 'user', text }]);
    sock.sendMessage(session.id, text);
    setInput('');
    setBusy(true);
  };
  const answer = (behavior: 'allow' | 'deny') => { if (perm) { sock.respondPermission(session.id, perm.requestId, behavior); setPerm(null); } };
  const interrupt = () => { sock.control(session.id, 'interrupt'); setBusy(false); };

  return (
    <div className="screen">
      <header className="topbar">
        <button className="link" onClick={onBack}>‹ 返回</button>
        <span className="title ellipsis">{session.machine || '会话'}</span>
        <span className={`dot ${session.status === 'active' ? 'on' : 'off'}`} />
      </header>
      <div className="scroll chat" ref={scrollRef}>
        {items.map((it, i) => <ItemView key={i} it={it} />)}
        {busy && <div className="typing">Claude 正在思考…<button className="link" onClick={interrupt}>停止</button></div>}
      </div>
      <div className="composer">
        <textarea
          className="composer-input" placeholder="给 Claude 发消息…" rows={1} value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } }}
        />
        <button className="btn send" disabled={!input.trim()} onClick={submit}>↑</button>
      </div>
      {perm && <PermissionModal perm={perm} onAllow={() => answer('allow')} onDeny={() => answer('deny')} />}
    </div>
  );
}

function ItemView({ it }: { it: Item }) {
  switch (it.kind) {
    case 'user': return <div className="bubble user">{it.text}</div>;
    case 'assistant': return <div className="bubble assistant">{it.text}</div>;
    case 'thinking': return <div className="thinking">{it.text}</div>;
    case 'tool_use': return (
      <div className="tool-card">
        <div className="tool-head"><span className="tool-name">{it.name}</span></div>
        <pre className="tool-input mono">{summarizeInput(it.input)}</pre>
      </div>
    );
    case 'tool_result': return <pre className={`tool-result mono ${it.isError ? 'err' : ''}`}>{clip(it.content, 1200)}</pre>;
    case 'result': return <div className="turn-end"><span className="muted small">⚠ {it.subtype || '结束'}{it.text ? ` · ${clip(it.text, 80)}` : ''}</span></div>;
    case 'status': return <div className="status-line">{it.text}</div>;
  }
}

function PermissionModal({ perm, onAllow, onDeny }: { perm: Permission; onAllow: () => void; onDeny: () => void }) {
  return (
    <div className="modal-backdrop">
      <div className="modal">
        <h3>允许使用工具？</h3>
        <div className="perm-tool"><span className="tool-name">{perm.toolName}</span></div>
        <pre className="tool-input mono">{summarizeInput(perm.input)}</pre>
        {perm.reason && <p className="muted small">{perm.reason}</p>}
        <div className="modal-actions">
          <button className="btn" onClick={onDeny}>拒绝</button>
          <button className="btn primary" onClick={onAllow}>允许</button>
        </div>
      </div>
    </div>
  );
}

function summarizeInput(input: any): string {
  if (input == null) return '';
  try {
    const s = JSON.stringify(input, null, 2);
    return clip(s, 800);
  } catch { return String(input); }
}
function clip(s: string, n: number): string { return s.length > n ? s.slice(0, n) + '\n…' : s; }
