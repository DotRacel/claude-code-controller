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
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ControlSocket, SessionView, Connection, PermissionAnswer } from '../ws.ts';
import { reduce, initialState, localSend, markQuestionAnswered, clearPermission, type TranscriptState, type ToolCall, type Item } from '../model.ts';
import { ItemView, type TranscriptHandlers } from './Transcript.tsx';
import { Composer } from './Composer.tsx';
import { PermissionSheet, OutputSheet, MenuSheet } from './Sheets.tsx';
import { toolDisplayName } from '../tools.ts';
import { Back, Dots, WifiOff, Alert } from '../icons.tsx';
import { haptic } from '../haptics.ts';
import { showPushNotification } from '../notify.ts';

const PIN_PX = 120;

export function ChatView({ session, sock, connection, onBack, registerEvent, registerHistory }: {
  session: SessionView;
  sock: ControlSocket;
  connection: Connection;
  onBack: () => void;
  registerEvent: (cb: (sid: string, p: any) => void) => void;
  registerHistory: (cb: (sid: string, events: any[]) => void) => void;
}) {
  const [state, setState] = useState<TranscriptState>(() => initialState());
  const [output, setOutput] = useState<ToolCall | null>(null);
  const [menu, setMenu] = useState(false);
  const [pinned, setPinned] = useState(true);
  const [announce, setAnnounce] = useState('');
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  // Seed "the agent holds the turn" from the list digest, so reopening a busy session shows
  // the Stop button immediately instead of waiting for the next event.
  useEffect(() => {
    setState(() => {
      const s = initialState();
      return session.digest?.turnActive ? { ...s, live: { ...s.live, busy: true } } : s;
    });
    sock.subscribe(session.id);
    registerHistory((sid, evs) => {
      if (sid !== session.id) return;
      let s = initialState();
      for (const e of evs) s = reduce(s, e, { isHistory: true });
      setState(s);
    });
    registerEvent((sid, payload) => {
      if (sid !== session.id) return;
      setState((prev) => reduce(prev, payload, { isHistory: false }));
    });
    return () => { registerEvent(() => {}); registerHistory(() => {}); };
  }, [session.id]);

  // Autoscroll while pinned. Items and the sheets both move the bottom.
  useEffect(() => {
    if (!pinned) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [state.items, state.live.busy, pinned]);

  // The transcript also shrinks without any new item: the composer grows line by line as you
  // type (and the slash picker opens above it). Without this the last message slides behind the
  // composer while you are writing about it.
  const pinnedRef = useRef(pinned);
  pinnedRef.current = pinned;
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => { if (pinnedRef.current) el.scrollTop = el.scrollHeight; });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // A permission arriving is the one thing worth interrupting you for (0c: notification haptic).
  const permId = state.live.permission?.requestId;
  useEffect(() => {
    if (!permId) return;
    haptic('warning');
    setAnnounce('需要审批');
    if (document.visibilityState !== 'visible') {
      showPushNotification(`${toolDisplayName(state.live.permission!.toolName)} 需要你的批准`, { force: true });
    }
  }, [permId]);

  const busy = state.live.busy;
  useEffect(() => { if (!busy) setAnnounce('回合完成'); }, [busy]);

  const offline = connection !== 'online' || session.status !== 'active';

  const handlers: TranscriptHandlers = useMemo(() => ({
    onOpenOutput: (call) => setOutput(call),
    onAnswerQuestion: (item, answers, freeform) => {
      const updatedInput: Record<string, unknown> = { questions: item.questions, answers };
      if (freeform) updatedInput.response = freeform;
      sock.respondPermission(session.id, item.requestId, { behavior: 'allow', updatedInput });
      const summary = Object.entries(answers).map(([q, a]) => `${q} → ${a}`).join('\n') || (freeform ?? '已跳过');
      setState((prev) => markQuestionAnswered(prev, item.requestId, summary));
    },
  }), [session.id, sock]);

  const answerPermission = (a: PermissionAnswer) => {
    const req = stateRef.current.live.permission;
    if (!req) return;
    sock.respondPermission(session.id, req.requestId, a);
    setState((prev) => clearPermission(prev));
  };

  const send = (text: string) => {
    sock.sendMessage(session.id, text);
    setState((prev) => localSend(prev, text, prev.live.busy));
  };

  const stop = () => {
    sock.control(session.id, 'interrupt');
    setState((prev) => ({ ...prev, live: { ...prev.live, busy: false, running: undefined } }));
  };

  const toBottom = () => {
    setPinned(true);
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  };

  const meta = [session.machine, session.branch, state.live.model, state.live.permissionMode]
    .filter(Boolean).join(' · ');

  return (
    <div className="screen">
      <div className="topbar">
        <button className="icon-btn" aria-label="返回" onClick={onBack}><Back size={18} /></button>
        <div className="topbar-title">
          <div className="t1 ellipsis">Remote Control 会话</div>
          <div className="t2 ellipsis">{session.machine || state.live.cwd || session.dir || '会话'}</div>
        </div>
        <button className="icon-btn" aria-label="更多" onClick={() => setMenu(true)}><Dots size={18} /></button>
      </div>

      <Banner connection={connection} sessionOffline={session.status !== 'active'} machine={session.machine} onRetry={() => sock.reconnect()} />

      <div
        className="scroll chat"
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          setPinned(el.scrollHeight - el.scrollTop - el.clientHeight < PIN_PX);
        }}
      >
        {state.items.map((it, i) => (
          <ItemView key={it.id} it={it} isLast={i === state.items.length - 1} h={handlers} />
        ))}
        {busy && <ActivityLine running={state.live.running} tokens={state.live.thinkingTokens} />}
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
          onExport={() => void copyTranscript(state.items)}
          onEnd={stop}
          onDismiss={() => setMenu(false)}
        />
      )}
    </div>
  );
}

function ActivityLine({ running, tokens }: { running?: { name: string; arg: string; since: number }; tokens?: number }) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [running?.since]);

  let text = 'Claude 正在处理…';
  if (running) {
    const s = Math.max(0, Math.round((Date.now() - running.since) / 1000));
    const dur = s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
    text = `${toolDisplayName(running.name)}${running.arg ? ` · ${running.arg.split('\n')[0].slice(0, 40)}` : ''} · ${dur}`;
  } else if (tokens) {
    text = `思考中 · ${tokens} tokens`;
  }
  return <div className="activity"><span className="pulse" />{text}</div>;
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

/** Markdown export (1h). Copy rather than download: a blob download is blocked or invisible in
 * several mobile browsers, while the clipboard works everywhere. */
async function copyTranscript(items: Item[]): Promise<void> {
  const out: string[] = [];
  for (const it of items) {
    if (it.kind === 'user') out.push(`\n## 你\n\n${it.text}`);
    else if (it.kind === 'prose') out.push(`\n${it.text}`);
    else if (it.kind === 'thinking') out.push(`\n_思考${it.tokens ? ` · ${it.tokens} tokens` : ''}_`);
    else if (it.kind === 'tools') for (const c of it.calls) out.push(`\n- **${toolDisplayName(c.name)}** \`${(c.input?.command ?? c.input?.file_path ?? c.input?.pattern ?? '').toString().split('\n')[0]}\` — ${c.status}`);
    else if (it.kind === 'todo') out.push(`\n${it.tasks.map((t) => `- [${t.status === 'completed' ? 'x' : ' '}] ${t.subject}`).join('\n')}`);
    else if (it.kind === 'status') out.push(`\n_${it.text}_`);
    else if (it.kind === 'error') out.push(`\n> ⚠ ${it.title}${it.detail ? ` — ${it.detail}` : ''}`);
  }
  try { await navigator.clipboard.writeText(out.join('\n').trim()); haptic('success'); } catch { /* denied */ }
}
