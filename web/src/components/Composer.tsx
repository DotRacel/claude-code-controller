/**
 * Composer.tsx — the one control the whole product runs through (design 1i).
 *
 * States: idle · typing (send turns accent) · agent running (send becomes a Stop square) ·
 * offline (read-only, the transcript is never cleared — 1g's rule) · slash picker.
 * The input's font-size matches .bubble-user exactly so sending never reflows the text.
 */
import { useEffect, useRef, useState } from 'react';
import { Plus, ArrowUp, ArrowDown } from '../icons.tsx';
import { haptic } from '../haptics.ts';

export function Composer({ busy, offline, slashCommands, skills, onSend, onStop, showToBottom, onToBottom }: {
  busy: boolean;
  offline: boolean;
  slashCommands: string[];
  skills: string[];
  onSend: (text: string) => void;
  onStop: () => void;
  showToBottom: boolean;
  onToBottom: () => void;
}) {
  const [text, setText] = useState('');
  const [focus, setFocus] = useState(false);
  const ref = useRef<HTMLTextAreaElement | null>(null);

  // Grow to five lines, then scroll internally (0c, Dynamic Type up to XXL).
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 7.5 * 16)}px`;
  }, [text]);

  const submit = () => {
    const t = text.trim();
    if (!t || offline) return;
    haptic('light');
    onSend(t);
    setText('');
  };

  const slashQuery = /^\/([\w:-]*)$/.exec(text);
  const matches = slashQuery
    ? [...new Set([...slashCommands, ...skills])].filter((c) => c.startsWith(slashQuery[1])).slice(0, 6)
    : [];

  return (
    <>
      {matches.length > 0 && (
        <div className="picker">
          {matches.map((c, i) => (
            <button key={c} className={`picker-row${i === 0 ? ' on' : ''}`} onClick={() => { setText(`/${c} `); ref.current?.focus(); }}>
              <span className="cmd">/{c}</span>
              <span className="desc">{skills.includes(c) ? '技能' : '斜杠命令'}</span>
            </button>
          ))}
        </div>
      )}
      <div className="composer-wrap">
        {showToBottom && (
          <button className="to-bottom" onClick={onToBottom} aria-label="回到底部"><ArrowDown size={20} /></button>
        )}
        <div className={`composer${focus ? ' focus' : ''}${offline ? ' readonly' : ''}`}>
          <textarea
            ref={ref}
            className="composer-input"
            rows={1}
            placeholder={offline ? '离线 — 重连后可继续' : busy ? '补充说明…（会排队）' : '给 Claude 发消息…'}
            value={text}
            disabled={offline}
            onFocus={() => setFocus(true)}
            onBlur={() => setFocus(false)}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !('ontouchstart' in window)) { e.preventDefault(); submit(); } }}
          />
          <div className="composer-row">
            <div className="composer-mode">
              <span className="sig">&lt;/&gt;</span>
              <span className="lbl">Code</span>
            </div>
            <div className="composer-actions">
              <button aria-label="更多" onClick={() => setText((t) => (t ? t : '/'))}><Plus size={22} /></button>
              {busy && !text.trim() ? (
                <button className="send" aria-label="停止" onClick={() => { haptic('medium'); onStop(); }}>
                  <span className="send-square" />
                </button>
              ) : (
                <button className={`send${text.trim() ? ' ready' : ''}`} aria-label="发送" disabled={!text.trim() || offline} onClick={submit}>
                  <ArrowUp size={20} stroke="#fff" />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
