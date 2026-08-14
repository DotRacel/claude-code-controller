/**
 * Sheets.tsx — the three modal surfaces: permission (1d), raw tool output (1e), session ⋯ (1h).
 */
import { useState } from 'react';
import { Sheet } from './Sheet.tsx';
import type { PermissionRequest, ToolCall } from '../model.ts';
import type { PermissionAnswer } from '../ws.ts';
import { toolDisplayName, toolArg, durationLabel } from '../tools.ts';
import { haptic } from '../haptics.ts';
import { Lock, Copy, Info, Gear, Pencil, Download, Archive } from '../icons.tsx';

/** The worker's own suggestion, phrased as a button. Only ever what it offered — the phone
 * never invents a rule, and it cannot reach the machine's settings.json. */
function suggestionLabel(s: any): string | null {
  if (!s || typeof s !== 'object') return null;
  if (s.type === 'addRules') {
    const r = Array.isArray(s.rules) ? s.rules[0] : undefined;
    if (!r) return null;
    return r.ruleContent ? `${r.toolName}(${r.ruleContent})` : String(r.toolName ?? '');
  }
  if (s.type === 'setMode') return s.mode === 'acceptEdits' ? '自动接受编辑' : String(s.mode ?? '');
  if (s.type === 'addDirectories') return (Array.isArray(s.directories) ? s.directories[0] : '') || '该目录';
  return null;
}

export function PermissionSheet({ req, cwd, onAnswer, onDismiss }: {
  req: PermissionRequest;
  cwd?: string;
  onAnswer: (a: PermissionAnswer) => void;
  onDismiss: () => void;
}) {
  const name = req.displayName || toolDisplayName(req.toolName);
  const arg = toolArg(req.toolName, req.input);
  const suggestion = req.suggestions.map((s) => ({ s, label: suggestionLabel(s) })).find((x) => x.label);

  return (
    <Sheet onDismiss={onDismiss}>
      <div className="sheet-pad">
        <div className="perm-head">
          <span className="perm-icon"><Lock size={19} stroke="#e5895f" /></span>
          <div>
            <div className="t1">{name} 想要执行：</div>
            {cwd && <div className="t2">在 {cwd}</div>}
          </div>
        </div>
        <div className="perm-cmd">{arg || JSON.stringify(req.input, null, 2)}</div>
        {req.reason && <div className="perm-why"><Info size={13} />{req.reason}</div>}
        <div className="perm-actions">
          <button className="btn primary tall" onClick={() => { haptic('light'); onAnswer({ behavior: 'allow' }); }}>允许一次</button>
          {suggestion && (
            <button className="btn tall" onClick={() => { haptic('light'); onAnswer({ behavior: 'allow', updatedPermissions: [suggestion.s] }); }}>
              总是允许<span className="rule">{suggestion.label}</span>
            </button>
          )}
          <button className="btn tall danger" onClick={() => { haptic('medium'); onAnswer({ behavior: 'deny' }); }}>拒绝</button>
        </div>
      </div>
    </Sheet>
  );
}

export function OutputSheet({ call, onDismiss }: { call: ToolCall; onDismiss: () => void }) {
  const [copied, setCopied] = useState(false);
  const dur = durationLabel(call.endedAt && call.startedAt ? call.endedAt - call.startedAt : undefined);
  const body = call.result ?? '';
  const copy = async () => {
    try { await navigator.clipboard.writeText(body); setCopied(true); haptic('light'); setTimeout(() => setCopied(false), 1500); } catch { /* denied */ }
  };
  return (
    <Sheet onDismiss={onDismiss} height="78%">
      <div className="out-head">
        <div>
          <div className="t1">{toolDisplayName(call.name)}</div>
          <div className="t2">{toolArg(call.name, call.input)}</div>
        </div>
        <div className="out-meta">
          {call.status === 'error' ? <span style={{ color: 'var(--danger)' }}>失败</span> : '完成'}
          {dur && <><br />{dur}</>}
        </div>
      </div>
      <div className="sheet-scroll">
        <div className={`out-body${call.status === 'error' ? ' fail' : ''}`}>{body || '（没有输出）'}</div>
      </div>
      <div className="out-actions">
        <button className="btn" style={{ flex: 1 }} onClick={copy}><Copy size={15} />{copied ? '已复制' : '复制'}</button>
      </div>
    </Sheet>
  );
}

const MODES: Array<{ id: string; label: string }> = [
  { id: 'default', label: '每次询问' },
  { id: 'acceptEdits', label: '自动接受编辑' },
  { id: 'plan', label: '计划模式' },
  { id: 'bypassPermissions', label: '不再询问' },
];

export function MenuSheet({ meta, mode, onMode, onExport, onEnd, onDismiss }: {
  meta: string;
  mode?: string;
  onMode: (m: string) => void;
  onExport: () => void;
  onEnd: () => void;
  onDismiss: () => void;
}) {
  const [modes, setModes] = useState(false);
  return (
    <Sheet onDismiss={onDismiss}>
      <div className="menu-meta">{meta}</div>
      {modes ? (
        <>
          <div className="menu-label">权限模式</div>
          <div className="menu-group">
            {MODES.map((m) => (
              <button key={m.id} className="menu-row" onClick={() => { haptic('light'); onMode(m.id); onDismiss(); }}>
                <Gear size={18} />{m.label}
                {mode === m.id && <span className="val">当前</span>}
              </button>
            ))}
          </div>
        </>
      ) : (
        <div className="menu-group">
          <button className="menu-row" onClick={() => setModes(true)}>
            <Gear size={18} />权限模式<span className="val">{MODES.find((m) => m.id === mode)?.label ?? mode ?? '—'}</span>
          </button>
          <button className="menu-row" onClick={() => { onExport(); onDismiss(); }}><Download size={18} />复制转录（Markdown）</button>
          {/* Rename and archive need columns the sessions table does not have yet. */}
          <button className="menu-row" disabled style={{ opacity: .4 }}><Pencil size={18} />重命名会话<span className="val">下一版</span></button>
          <button className="menu-row" disabled style={{ opacity: .4 }}><Archive size={18} />归档<span className="val">下一版</span></button>
          <button className="menu-row danger" onClick={() => { haptic('medium'); onEnd(); onDismiss(); }}>
            <span style={{ width: 15, height: 15, borderRadius: 3, background: 'var(--danger)', display: 'block' }} />停止当前回合
          </button>
        </div>
      )}
    </Sheet>
  );
}
