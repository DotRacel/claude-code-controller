/**
 * SessionList.tsx — home (design 1a). Live sessions surface the running tool; a pending
 * permission is the only badge that ever gets accent colour.
 *
 * The row content comes from the server-derived digest (src/server/store.ts foldDigest), so the
 * list is accurate without subscribing to every transcript.
 *
 * The design's "New session" button is deliberately not here: a phone cannot start claude on
 * your machine — `control-claude-code` is launched from your terminal — so the ? button explains
 * how instead of offering a button that could not work.
 */
import { useEffect, useState } from 'react';
import type { SessionView } from '../ws.ts';
import { toolDisplayName } from '../tools.ts';
import { Lock, Check, Help, SignOut } from '../icons.tsx';
import { HelpSheet, ConfirmSheet } from './Sheets.tsx';
import { notifyPermission, requestNotifyPermission } from '../notify.ts';

type Filter = 'active' | 'all';

function relTime(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 45) return '刚刚';
  if (s < 3600) return `${Math.round(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.round(s / 3600)} 小时前`;
  return `${Math.round(s / 86400)} 天前`;
}

function elapsed(since: number): string {
  const s = Math.max(0, Math.round((Date.now() - since) / 1000));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

export function SessionList({ sessions, connection, onOpen, onLogout }: {
  sessions: SessionView[];
  connection: string;
  onOpen: (s: SessionView) => void;
  onLogout: () => void;
}) {
  const [filter, setFilter] = useState<Filter>('active');
  const [perm, setPerm] = useState(notifyPermission());
  const [help, setHelp] = useState(false);
  const [confirmLogout, setConfirmLogout] = useState(false);
  const [, tick] = useState(0);

  // Keep "2m 14s" honest while a tool runs.
  useEffect(() => {
    const running = sessions.some((s) => s.digest?.toolStatus === 'running');
    if (!running) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [sessions]);

  const shown = sessions.filter((s) => (filter === 'active' ? s.status === 'active' : filter === 'all'));

  return (
    <div className="screen">
      <div className="topbar-lg">
        <h1>会话</h1>
        <div style={{ display: 'flex', gap: 10 }}>
          <button className="icon-btn" aria-label="帮助" onClick={() => setHelp(true)}><Help size={17} /></button>
          <button className="icon-btn" aria-label="退出登录" onClick={() => setConfirmLogout(true)}><SignOut size={17} /></button>
        </div>
      </div>
      <div className="chips">
        {(['active', 'all'] as Filter[]).map((f) => (
          <button key={f} className={`chip${filter === f ? ' on' : ''}`} onClick={() => setFilter(f)}>
            {f === 'active' ? '活跃' : '全部'}
          </button>
        ))}
      </div>
      {perm === 'default' && (
        <button className="notify-banner" onClick={async () => { await requestNotifyPermission(); setPerm(notifyPermission()); }}>
          需要审批时通知我
        </button>
      )}
      <div className="scroll">
        <div className="session-list">
          {shown.length === 0 && (
            <div className="empty">
              {connection === 'online' ? '还没有会话。点右上角的 ? 看怎么开一个。' : '正在连接…'}
            </div>
          )}
          {shown.map((s) => <SessionCard key={s.id} s={s} onOpen={onOpen} />)}
        </div>
      </div>
      {help && <HelpSheet onDismiss={() => setHelp(false)} />}
      {confirmLogout && (
        <ConfirmSheet
          title="退出登录？"
          body="这台设备会忘掉密钥，下次要重新登录。电脑上的会话不受影响，继续跑。"
          confirmLabel="退出登录"
          onConfirm={onLogout}
          onDismiss={() => setConfirmLogout(false)}
        />
      )}
    </div>
  );
}

function SessionCard({ s, onOpen }: { s: SessionView; onOpen: (s: SessionView) => void }) {
  const d = s.digest ?? ({ toolCalls: 0, pendingApproval: false, turnActive: false } as SessionView['digest']);
  const running = d.toolStatus === 'running' && s.status === 'active';
  const attention = d.pendingApproval;

  return (
    <button
      className={`session-card${attention ? ' attention' : ''}${!d.turnActive && s.status !== 'active' ? ' done' : ''}`}
      onClick={() => onOpen(s)}
    >
      <div className="session-top">
        <span className="session-name ellipsis">{s.machine || '未知设备'}</span>
        {attention
          ? <span className="badge-approval"><Lock size={11} stroke="#e5895f" />需要审批</span>
          : <span className="session-when">{relTime(s.lastActivity)}</span>}
      </div>
      {d.prompt && <div className="session-prompt">{d.prompt}</div>}
      <div className="session-meta">
        {running ? (
          <>
            <span className="dot run" />
            {toolDisplayName(d.tool!)}{d.toolArg ? ` · ${d.toolArg.split('\n')[0].slice(0, 40)}` : ''}
            {d.toolStartedAt ? ` · ${elapsed(d.toolStartedAt)}` : ''}
          </>
        ) : d.toolCalls > 0 ? (
          <><Check size={12} stroke="#8a8781" />完成 · {d.toolCalls} 次工具调用</>
        ) : (
          <><span className={`dot ${s.status === 'active' ? 'on' : 'off'}`} />{s.status === 'active' ? '在线' : '离线'}{s.dir ? ` · ${s.dir}` : ''}</>
        )}
      </div>
    </button>
  );
}
