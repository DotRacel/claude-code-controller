/**
 * surface-parts.tsx — the contents of the five modal surfaces, with no container around them.
 *
 * A phone puts each of these in a bottom sheet with a drag handle; a desktop puts four in a
 * centred modal and one in a popover. The container is the only difference — the permission
 * buttons, the output's copy action, the mode list and the install instructions are the same
 * words either way, and having two copies would mean fixing the next wording change twice.
 *
 * The markup here is byte-for-byte what Sheets.tsx used to emit inline, so the phone's DOM (and
 * therefore its screenshots) is unchanged by the extraction.
 */
import { useState } from 'react';
import type { PermissionRequest, ToolCall } from '../model.ts';
import type { PermissionAnswer } from '../ws.ts';
import { toolDisplayName, toolArg, durationLabel } from '../tools.ts';
import { haptic } from '../haptics.ts';
import { useCopy } from '../clipboard.ts';
import { Lock, Copy, Info, Gear, Pencil } from '../icons.tsx';

/** The worker's own suggestion, phrased as a button. Only ever what it offered — the client
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

export function PermissionBody({ req, cwd, onAnswer }: {
  req: PermissionRequest;
  cwd?: string;
  onAnswer: (a: PermissionAnswer) => void;
}) {
  const name = req.displayName || toolDisplayName(req.toolName);
  const arg = toolArg(req.toolName, req.input);
  const suggestion = req.suggestions.map((s) => ({ s, label: suggestionLabel(s) })).find((x) => x.label);

  return (
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
  );
}

export function OutputBody({ call }: { call: ToolCall }) {
  const dur = durationLabel(call.endedAt && call.startedAt ? call.endedAt - call.startedAt : undefined);
  const body = call.result ?? '';
  const { label, failed, copy } = useCopy(body);
  return (
    <>
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
        <button className={`btn${failed ? ' fail' : ''}`} style={{ flex: 1 }} onClick={copy}><Copy size={15} />{label}</button>
      </div>
    </>
  );
}

const MODES: Array<{ id: string; label: string }> = [
  { id: 'default', label: '每次询问' },
  { id: 'acceptEdits', label: '自动接受编辑' },
  { id: 'plan', label: '计划模式' },
  { id: 'bypassPermissions', label: '不再询问' },
];

export function MenuBody({ meta, mode, onMode, onEnd, onDismiss }: {
  meta: string;
  mode?: string;
  onMode: (m: string) => void;
  onEnd: () => void;
  onDismiss: () => void;
}) {
  const [modes, setModes] = useState(false);
  return (
    <>
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
          {/* Rename needs a column the sessions table does not have yet. */}
          <button className="menu-row" disabled style={{ opacity: .4 }}><Pencil size={18} />重命名会话<span className="val">下一版</span></button>
          <button className="menu-row danger" onClick={() => { haptic('medium'); onEnd(); onDismiss(); }}>
            <span style={{ width: 15, height: 15, borderRadius: 3, background: 'var(--danger)', display: 'block' }} />停止当前回合
          </button>
        </div>
      )}
    </>
  );
}

/** A command block. It scrolls rather than wraps (a wrapped command gets pasted wrong), which on
 * a phone makes selecting it by hand hopeless — hence the copy button rather than a bare block. */
function Cmd({ text }: { text: string }) {
  const { label, failed, copy } = useCopy(text);
  return (
    <div className="help-cmd">
      <button className={`md-copy${failed ? ' fail' : ''}`} type="button" onClick={copy}>{label}</button>
      <pre>{text}</pre>
    </div>
  );
}

/**
 * What used to be the home screen's dashed "要开一个新会话？" card, now behind the ? button and
 * long enough to actually be instructions: a client cannot start claude on your machine, so the
 * only useful answer is how to install and run the thing that can.
 */
export function HelpBody() {
  return (
    <>
      <div className="menu-meta">把电脑上的 claude 接到手机</div>
      <div className="sheet-scroll">
        <div className="sheet-pad">
          <ol className="help-steps">
            <li>
              <b>在电脑上装好本项目</b>
              <p>需要 Node ≥ 22 和已经能用的 <code>claude</code>。</p>
              <Cmd text="npm i -g control-claude-code" />
            </li>
            <li>
              <b>用同一个账号登录</b>
              <p>第一次运行会让你选服务器（填你现在打开的这个地址），再用手机上这个账号登录。答案存在 <code>~/.config/control-claude-code/config.json</code>，之后直接启动；<code>--login</code> 可以换服务器或账号。</p>
              <Cmd text="control-claude" />
            </li>
            <li>
              <b>在 TUI 里输入 /rc</b>
              <p>会话立刻出现在这个列表里，之后的对话和工具审批都会推到手机上。</p>
              <Cmd text={'/rc\n/rc <会话名>'} />
            </li>
          </ol>
          <p className="help-note">
            手机不能替你在机器上拉起 claude —— 会话必须从终端开始。终端关掉后会话显示离线，转录仍然留着。
          </p>
        </div>
      </div>
    </>
  );
}

/** A destructive action asked twice. Dismissing (drag, backdrop, Esc) is always the "no". */
export function ConfirmBody({ title, body, confirmLabel, onConfirm, onDismiss }: {
  title: string;
  body?: string;
  confirmLabel: string;
  onConfirm: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className="sheet-pad">
      <div className="confirm-head">
        <div className="t1">{title}</div>
        {body && <div className="t2">{body}</div>}
      </div>
      <div className="perm-actions">
        <button className="btn tall danger" onClick={() => { haptic('medium'); onConfirm(); }}>{confirmLabel}</button>
        <button className="btn tall" onClick={onDismiss}>取消</button>
      </div>
    </div>
  );
}
