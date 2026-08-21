/**
 * ChatView.tsx — one session: header, connection banner, transcript, activity line, composer,
 * and the three sheets.
 *
 * Rules from the design doc that are easy to break and so are called out here:
 *  - a connection change NEVER destroys the transcript; losing the socket degrades the composer
 *    to read-only and shows a banner under the header (1g)
 *  - autoscroll stays pinned within 120px of the bottom; scrolling up unpins and reveals the
 *    scroll-to-bottom button (0c)
 *  - dismissing the permission sheet by drag is a DENY, never an allow (0c)
 *  - haptics fire once per event and never during streaming (0c)
 */
import { useEffect, useRef, useState } from 'react';
import type { ControlSocket, SessionView, Connection, PermissionAnswer } from '../ws.ts';
import { useSession, useTranscriptScroll } from '../session.ts';
import { ItemView } from './Transcript.tsx';
import { phoneRenderers } from '../render/phone.tsx';
import { Composer } from './Composer.tsx';
import { PermissionSheet, OutputSheet, MenuSheet } from './Sheets.tsx';
import { toolDisplayName, blobUrl } from '../tools.ts';
import { Back, Dots, WifiOff, Alert } from '../icons.tsx';
import { haptic } from '../haptics.ts';
import { showPushNotification } from '../notify.ts';

export function ChatView({ session, sock, connection, onBack, registerEvent, registerHistory }: {
  session: SessionView;
  sock: ControlSocket;
  connection: Connection;
  onBack: () => void;
  registerEvent: (cb: (sid: string, p: any) => void) => void;
  registerHistory: (cb: (sid: string, events: any[]) => void) => void;
}) {
  const {
    state, busy, offline, actions, send, stop, answerPermission, output, setOutput, permissionId, announce, meta,
  } = useSession({ session, sock, connection, registerEvent, registerHistory });
  const { scrollRef, pinned, onScroll, toBottom } = useTranscriptScroll([state.items, state.live.busy]);
  const [menu, setMenu] = useState(false);
  const screenRef = useRef<HTMLDivElement | null>(null);
  const headerRef = useRef<HTMLDivElement | null>(null);

  // The header floats over the transcript (so the transcript can use the full screen, status-bar
  // strip included), which means the transcript's top padding has to equal the header's height —
  // and the connection banner makes that height change at runtime. Measured, not hard-coded.
  // Phone-only: no other layout puts the header on top of the scroller.
  useEffect(() => {
    const head = headerRef.current;
    const screen = screenRef.current;
    if (!head || !screen) return;
    const apply = () => screen.style.setProperty('--header-h', `${head.offsetHeight}px`);
    apply();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(apply);
    ro.observe(head);
    return () => ro.disconnect();
  }, []);

  // The one haptic worth firing unprompted (0c: notification haptic). A desktop has nothing to
  // fire, which is why this lives here and not in the hook.
  useEffect(() => { if (permissionId) haptic('warning'); }, [permissionId]);

  return (
    <div className="screen" ref={screenRef}>
      {/* Two layers, deliberately siblings: .header-frost blurs whatever scrolls beneath (so the
          strip behind the status bar / Dynamic Island is used instead of reserved) and .header
          sits above it with an explicit z-index, so the title can never be caught by the blur. */}
      <div className="header-frost" aria-hidden />
      <div className="header" ref={headerRef}>
        <div className="topbar">
          <button className="icon-btn" aria-label="返回" onClick={onBack}><Back size={18} /></button>
          <div className="topbar-title">
            <div className="t1 ellipsis">Remote Control 会话</div>
            <div className="t2 ellipsis">{session.machine || state.live.cwd || session.dir || '会话'}</div>
          </div>
          <button className="icon-btn" aria-label="更多" onClick={() => setMenu(true)}><Dots size={18} /></button>
        </div>

        <Banner connection={connection} sessionOffline={session.status !== 'active'} machine={session.machine} onRetry={() => sock.reconnect()} />
      </div>

      <div
        className="scroll chat"
        ref={scrollRef}
        onScroll={onScroll}
      >
        {state.items.map((it, i) => (
          <ItemView key={it.id} it={it} isLast={i === state.items.length - 1} h={actions} renderers={phoneRenderers} />
        ))}
        {/* Offline, nothing is running here to report — a spinner would just keep promising work
            that no connected claude is doing. */}
        {busy && !offline && (
          <ActivityLine running={state.live.running} thinking={state.live.thinking} tokens={state.live.thinkingTokens} />
        )}
      </div>

      <p className="sr-only" role="status" aria-live="polite">{announce}</p>

      <Composer
        busy={busy}
        offline={offline}
        slashCommands={state.live.slashCommands}
        skills={state.live.skills}
        onSend={send}
        onStop={stop}
        showToBottom={!pinned}
        onToBottom={toBottom}
      />

      {state.live.permission && (
        <PermissionSheet
          req={state.live.permission}
          cwd={state.live.cwd || session.dir}
          onAnswer={answerPermission}
          // Drag-to-dismiss is a deny-later, never an allow (0c).
          onDismiss={() => answerPermission({ behavior: 'deny', message: 'The user dismissed the request on their phone.' })}
        />
      )}
      {output && <OutputSheet call={output} onDismiss={() => setOutput(null)} />}
      {menu && (
        <MenuSheet
          meta={meta || '会话'}
          mode={state.live.permissionMode}
          onMode={(m) => sock.control(session.id, 'set_permission_mode', { mode: m })}
          onEnd={stop}
          onDismiss={() => setMenu(false)}
        />
      )}
    </div>
  );
}

/**
 * One line under the transcript for as long as the agent holds the turn. The leading glyph is
 * chosen by what the agent is *actually* doing, not merely by `busy`: the thinking star is the
 * CLI's reasoning animation and would be a lie while a tool runs or prose streams in.
 */
function ActivityLine({ running, thinking, tokens }: {
  running?: { name: string; arg: string; since: number };
  thinking?: boolean;
  tokens?: number;
}) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [running?.since]);

  if (running) {
    const s = Math.max(0, Math.round((Date.now() - running.since) / 1000));
    const dur = s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
    const arg = running.arg ? ` · ${running.arg.split('\n')[0].slice(0, 40)}` : '';
    return (
      <div className="activity">
        <span className="dot run pulse" aria-hidden="true" />
        {`${toolDisplayName(running.name)}${arg} · ${dur}`}
      </div>
    );
  }
  if (thinking) {
    return (
      <div className="activity">
        <ThinkingSpinner />
        {tokens ? `思考中 · ${tokens} tokens` : '思考中'}
      </div>
    );
  }
  // Working, but neither reasoning nor inside a tool — streaming prose, or between steps. A quiet
  // pulse says "still going" without claiming which.
  return <div className="activity"><span className="dot run pulse" aria-hidden="true" />运行中</div>;
}

/** The CLI's own thinking glyph: it grows to a full star and shrinks back, one frame at a time. */
const FRAMES = ['·', '✢', '✳', '✶', '✻', '✽'];
const SPINNER_MS = 120;

function ThinkingSpinner() {
  const [i, setI] = useState(0);
  const dir = useRef(1);

  useEffect(() => {
    // 0c: reduce-motion freezes every animation, and this one is driven by JS, so the media query
    // in the stylesheet cannot reach it.
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const t = setInterval(() => {
      setI((prev) => {
        if (prev === FRAMES.length - 1) dir.current = -1;
        if (prev === 0) dir.current = 1;
        return prev + dir.current;
      });
    }, SPINNER_MS);
    return () => clearInterval(t);
  }, []);

  return <span className="spin" aria-hidden="true">{FRAMES[i]}</span>;
}

function Banner({ connection, sessionOffline, machine, onRetry }: {
  connection: Connection; sessionOffline: boolean; machine?: string; onRetry: () => void;
}) {
  if (connection === 'connecting') {
    return (
      <div className="banner warning">
        <span className="spinner" />
        <div className="banner-text">
          <div className="t1">重新连接中…</div>
          <div className="t2">会话仍在 {machine || '你的机器'} 上继续运行</div>
        </div>
      </div>
    );
  }
  if (connection === 'offline') {
    return (
      <div className="banner danger">
        <WifiOff size={15} stroke="#e07a5f" />
        <div className="banner-text">
          <div className="t1">已离线</div>
          <div className="t2">恢复连接后会自动继续</div>
        </div>
        <button className="link" style={{ color: 'var(--text)' }} onClick={onRetry}>重试</button>
      </div>
    );
  }
  if (sessionOffline) {
    return (
      <div className="banner neutral">
        <Alert size={15} stroke="#8a8781" />
        <div className="banner-text">
          <div className="t1">{machine || '这台机器'} 上的 claude 没有连着</div>
          <div className="t2">转录仍在，回到终端继续会话即可恢复</div>
        </div>
      </div>
    );
  }
  return null;
}
