/**
 * DesktopShell.tsx — the two-pane layout: session rail on the left, one session on the right.
 *
 * The socket, the session list and which session is open all live a level up in App.tsx, shared
 * with the phone layout — so dragging the window across the breakpoint keeps the session you were
 * reading instead of dropping you back at a list.
 */
import type { ControlSocket, SessionView, Connection } from '../../ws.ts';
import { Sidebar } from './Sidebar.tsx';
import { DesktopChat } from './DesktopChat.tsx';
import { ClaudeMark } from '../../icons.tsx';

export function DesktopShell({ sessions, activeId, connection, sock, onOpen, onLogout, registerEvent, registerHistory }: {
  sessions: SessionView[];
  activeId: string | null;
  connection: Connection;
  sock: ControlSocket;
  onOpen: (s: SessionView) => void;
  onLogout: () => void;
  registerEvent: (cb: (sid: string, p: any) => void) => void;
  registerHistory: (cb: (sid: string, events: any[]) => void) => void;
}) {
  const active = activeId ? sessions.find((s) => s.id === activeId) ?? null : null;

  return (
    <div className="dshell">
      <Sidebar
        sessions={sessions}
        activeId={activeId}
        connection={connection}
        onOpen={onOpen}
        onLogout={onLogout}
      />
      <main className="dmain">
        {active ? (
          <DesktopChat
            key={active.id}
            session={active}
            sock={sock}
            connection={connection}
            registerEvent={registerEvent}
            registerHistory={registerHistory}
          />
        ) : (
          <div className="dempty">
            <ClaudeMark size={34} fill="#3a3936" />
            <p>{sessions.length ? '从左边选一个会话' : '还没有会话。左上角的 ? 说明怎么开一个。'}</p>
          </div>
        )}
      </main>
    </div>
  );
}
