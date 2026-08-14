import { useState, useEffect, useRef, type ReactNode } from 'react';
import { ControlSocket, getCredential, setCredential, clearCredential, type SessionView, type Connection } from './ws';
import { showPushNotification, pushNotificationFrom } from './notify';
import { SessionList } from './components/SessionList.tsx';
import { ChatView } from './components/ChatView.tsx';
import { ClaudeMark } from './icons.tsx';

export function App() {
  const [credential, setCred] = useState<string | null>(getCredential());
  return (
    <PhoneStage>
      {!credential
        ? <CredentialGate onSet={(c) => { setCredential(c); setCred(c); }} />
        : <Home credential={credential} onLogout={() => { clearCredential(); setCred(null); }} />}
    </PhoneStage>
  );
}

/**
 * On a phone this is just the screen. On a desktop it is a 390×844 frame — the product is
 * mobile-only by design, but a hard block made the real UI impossible to review on a laptop.
 */
function PhoneStage({ children }: { children: ReactNode }) {
  return (
    <div className="desktop-stage">
      <div className="desktop-note">
        <h2>手机专用</h2>
        <p>Claude Remote 是为手机做的。用手机浏览器打开 <code>{location.host}</code>，或把这个窗口调窄到手机尺寸。</p>
        <p>右边是等比的手机画面，功能完全一致。</p>
      </div>
      <div className="phone-frame">{children}</div>
    </div>
  );
}

function CredentialGate({ onSet }: { onSet: (c: string) => void }) {
  const [val, setVal] = useState('');
  return (
    <div className="center-screen">
      <div className="panel">
        <div className="logo-mark"><ClaudeMark size={34} fill="#fefcfb" /></div>
        <h1>Claude Remote</h1>
        <p>粘贴你的凭证以连接自己的会话。凭证由 <span className="mono">control-claude-code</span> 启动时生成并打印。</p>
        <input
          className="cred-input" placeholder="ccc_…" value={val}
          onChange={(e) => setVal(e.target.value)}
          autoCapitalize="off" autoCorrect="off" spellCheck={false}
        />
        <button className="btn primary block" disabled={!val.trim()} onClick={() => onSet(val.trim())}>连接</button>
        <p>凭证保存在本机 cookie；丢失后需要重新获取。</p>
      </div>
    </div>
  );
}

function Home({ credential, onLogout }: { credential: string; onLogout: () => void }) {
  const [sessions, setSessions] = useState<SessionView[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [connection, setConnection] = useState<Connection>('connecting');
  const sockRef = useRef<ControlSocket | null>(null);
  const eventCb = useRef<(sid: string, payload: any) => void>(() => {});
  const historyCb = useRef<(sid: string, events: any[]) => void>(() => {});

  useEffect(() => {
    const sock = new ControlSocket(credential, {
      onSessions: setSessions,
      onEvent: (sid, p) => {
        const note = pushNotificationFrom(p);
        if (note) showPushNotification(note.message, { force: note.ready || document.visibilityState !== 'visible' });
        eventCb.current(sid, p);
      },
      onHistory: (sid, evs) => historyCb.current(sid, evs),
      onNotify: (_sid, message, ready) => showPushNotification(message, { force: !!ready || document.visibilityState !== 'visible' }),
      onStatus: setConnection,
    });
    sock.connect();
    sockRef.current = sock;
    return () => sock.close();
  }, [credential]);

  // Re-subscribe after a reconnect so the transcript backfills instead of going quiet.
  useEffect(() => {
    if (connection === 'online' && activeId) sockRef.current?.subscribe(activeId);
  }, [connection]);

  const active = activeId ? sessions.find((s) => s.id === activeId) ?? null : null;

  if (active && sockRef.current) {
    return (
      <ChatView
        key={active.id}
        session={active}
        sock={sockRef.current}
        connection={connection}
        onBack={() => setActiveId(null)}
        registerEvent={(cb) => (eventCb.current = cb)}
        registerHistory={(cb) => (historyCb.current = cb)}
      />
    );
  }
  return <SessionList sessions={sessions} connection={connection} onOpen={(s) => setActiveId(s.id)} onLogout={onLogout} />;
}
