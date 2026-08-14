import { useState, useEffect, useRef, type ReactNode } from 'react';
import { ControlSocket, getCredential, setCredential, clearCredential, type SessionView, type Connection } from './ws';
import { showPushNotification, pushNotificationFrom } from './notify';
import { checkToken } from './auth.ts';
import { SessionList } from './components/SessionList.tsx';
import { ChatView } from './components/ChatView.tsx';
import { AuthGate } from './components/AuthGate.tsx';

export function App() {
  const [credential, setCred] = useState<string | null>(getCredential());
  // Until the stored token has been checked, showing either screen would be a guess: the login
  // form flashes for a user who is signed in, the session list hangs for one who is not.
  const [checked, setChecked] = useState(!credential);

  useEffect(() => {
    if (checked || !credential) return;
    let live = true;
    void checkToken(credential).then((r) => {
      if (!live) return;
      // Only an outright rejection logs the user out. If the server is merely unreachable the
      // token is still presumed good — the socket's own reconnect loop handles the outage.
      if (r.status === 'rejected') { clearCredential(); setCred(null); }
      setChecked(true);
    });
    return () => { live = false; };
  }, []);

  return (
    <PhoneStage>
      {!checked
        ? <div className="center-screen" />
        : !credential
          ? <AuthGate onAuthed={({ token }) => { setCredential(token); setCred(token); }} />
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
