/**
 * Transcript.tsx — one component per item kind the reducer produces (web/src/model.ts).
 *
 * Rendering rules taken from the design doc:
 *  - assistant prose is serif, with no avatar and no bubble; the user's turn is the only bubble
 *  - adjacent tool calls are one bordered group, each row a single line + a result line
 *  - a tool's raw output is NOT inline: the row opens the output sheet (1e)
 *  - only the newest item animates in; earlier ones never re-animate on re-render (0c)
 *  - a tool card is one element to a screen reader ("Bash, npm test, failed, double-tap …")
 */
import { memo, useRef, useState } from 'react';
import type { Item, ToolCall, TodoTask, Question } from '../model.ts';
import { toolDisplayName, toolArg, splitPath, argIsPath, resultLine, durationLabel } from '../tools.ts';
import { renderMarkdown } from '../md.ts';
import { haptic } from '../haptics.ts';
import { Check, Alert, Brain, ClaudeMark } from '../icons.tsx';

const LONG_PRESS_MS = 400;

export interface TranscriptHandlers {
  onOpenOutput: (call: ToolCall) => void;
  onAnswerQuestion: (item: Extract<Item, { kind: 'question' }>, answers: Record<string, string>, freeform?: string) => void;
}

export const ItemView = memo(function ItemView({ it, isLast, h }: { it: Item; isLast: boolean; h: TranscriptHandlers }) {
  const cls = isLast ? 'enter' : undefined;
  switch (it.kind) {
    case 'user':
      return (
        <div className={`bubble-user${it.state === 'queued' ? ' queued' : ''} ${cls ?? ''}`}>
          {it.text}
          {it.state === 'queued' && <span className="queued-tag">排队中 · Claude 正忙</span>}
        </div>
      );
    case 'prose':
      return (
        <div className={`prose md ${cls ?? ''}`}>
          {renderMarkdown(it.text)}
          {it.streaming && <span className="caret" />}
        </div>
      );
    case 'thinking':
      return <ThinkingView it={it} cls={cls} />;
    case 'tools':
      return <ToolGroup calls={it.calls} cls={cls} onOpen={h.onOpenOutput} />;
    case 'todo':
      return <TodoCard tasks={it.tasks} cls={cls} />;
    case 'question':
      return <QuestionCard it={it} cls={cls} onAnswer={h.onAnswerQuestion} />;
    case 'bgtask':
      return (
        <div className={`bgtask${it.status === 'failed' ? ' failed' : ''} ${cls ?? ''}`}>
          <span className={`dot ${it.status === 'running' ? 'run' : it.status === 'failed' ? 'off' : 'on'}`} />
          <div className="bgtask-text">
            <div className="t1">{it.description}</div>
            <div className="t2">后台任务 · {it.status === 'running' ? 'running…' : it.status === 'failed' ? '失败' : '完成'}</div>
          </div>
        </div>
      );
    case 'status':
      return <div className={`status-line ${cls ?? ''}`}>{it.text}</div>;
    case 'error':
      return (
        <div className={`error-card ${cls ?? ''}`}>
          <div className="t1"><Alert size={14} /> {it.title}</div>
          {it.detail && <div className="t2">{it.detail}</div>}
        </div>
      );
  }
});

/**
 * The data plane relays `thinking: ""` — the signature only, never the reasoning text (verified
 * across every thinking block in a real session). So this is a marker, not a disclosure; it
 * expands only in the hypothetical case where text does arrive.
 */
function ThinkingView({ it, cls }: { it: Extract<Item, { kind: 'thinking' }>; cls?: string }) {
  const [open, setOpen] = useState(false);
  const hasText = !!it.text.trim();
  return (
    <div className={`thinking ${cls ?? ''}`}>
      <button className="thinking-head" onClick={() => hasText && setOpen(!open)} disabled={!hasText}>
        <Brain size={14} />
        思考{it.tokens ? ` · ${it.tokens} tokens` : ''}{hasText ? (open ? ' · 收起' : ' · 展开') : ''}
      </button>
      {open && hasText && <div className="thinking-body">{it.text}</div>}
    </div>
  );
}

function ToolGroup({ calls, cls, onOpen }: { calls: ToolCall[]; cls?: string; onOpen: (c: ToolCall) => void }) {
  const bad = calls.some((c) => c.status === 'error');
  const waiting = calls.some((c) => c.status === 'awaiting');
  return (
    <div className={`tool-group${bad ? ' err' : ''}${waiting ? ' await' : ''} ${cls ?? ''}`}>
      {calls.map((c) => <ToolRow key={c.toolUseId} call={c} onOpen={onOpen} />)}
    </div>
  );
}

function ToolRow({ call, onOpen }: { call: ToolCall; onOpen: (c: ToolCall) => void }) {
  const [pressed, setPressed] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const fired = useRef(false);
  const touched = useRef(false); // a touch also emits synthetic mouse events; ignore those
  const label = toolDisplayName(call.name);
  const arg = toolArg(call.name, call.input);
  const res = resultLine(call);
  const dur = durationLabel(call.endedAt && call.startedAt ? call.endedAt - call.startedAt : undefined);
  const openable = !!call.result;

  const begin = () => {
    if (!openable) return;
    fired.current = false;
    setPressed(true);
    // Long-press is the design's gesture (0c: 400ms, card scales to .98); a plain tap opens it
    // too, because on a phone nobody discovers a long-press on their own.
    timer.current = window.setTimeout(() => {
      timer.current = undefined;
      fired.current = true;
      haptic('selection');
      setPressed(false);
      onOpen(call);
    }, LONG_PRESS_MS);
  };
  const end = (fire: boolean) => {
    window.clearTimeout(timer.current);
    timer.current = undefined;
    setPressed(false);
    if (fire && !fired.current && openable) onOpen(call);
  };

  return (
    <button
      className={`tool-row${pressed ? ' press' : ''}`}
      onTouchStart={() => { touched.current = true; begin(); }}
      onTouchEnd={() => end(true)}
      onTouchCancel={() => end(false)}
      onMouseDown={() => { if (!touched.current) begin(); }}
      onMouseUp={() => { if (!touched.current) end(true); }}
      onMouseLeave={() => { if (!touched.current) end(false); }}
      disabled={!openable}
      aria-label={`${label}${arg ? `, ${arg}` : ''}, ${res?.text ?? ''}${openable ? '，双击查看输出' : ''}`}
    >
      <div className="tool-head">
        {label} {arg && <span className="arg">{argIsPath(call.name) ? <PathArg p={arg} /> : arg}</span>}
      </div>
      {res && (
        <div className={`tool-result-line${res.isError ? ' err' : ''}`}>
          {dur && <span className="tool-badge">{dur}</span>}
          {res.text}
          {res.tapHint && <span className="hint"> — 点按查看输出</span>}
        </div>
      )}
    </button>
  );
}

/** `src/routes/checkout/` dim + `handler.ts` bright — the filename is what you scan for. */
function PathArg({ p }: { p: string }) {
  const { dir, base } = splitPath(p);
  return <>{dir && <span className="dim">{dir}</span>}{base}</>;
}

function TodoCard({ tasks, cls }: { tasks: TodoTask[]; cls?: string }) {
  return (
    <div className={`tool-group ${cls ?? ''}`}>
      <div className="tool-head">任务清单</div>
      <div className="todo-list">
        {tasks.map((t) => (
          <div key={t.key} className={`todo-item ${t.status === 'completed' ? 'done' : t.status === 'in_progress' ? 'active' : ''}`}>
            <span className="todo-box">{t.status === 'completed' && <Check size={11} stroke="#1f1e1c" />}</span>
            <span>{t.subject}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * AskUserQuestion. It arrives as a can_use_tool permission request, but a 2–4 question form
 * does not fit a modal, so it renders inline and the transcript stays scrollable behind it.
 * Answering replies allow + updatedInput.answers (question text → chosen label).
 */
function QuestionCard({ it, cls, onAnswer }: {
  it: Extract<Item, { kind: 'question' }>;
  cls?: string;
  onAnswer: TranscriptHandlers['onAnswerQuestion'];
}) {
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [freeform, setFreeform] = useState('');
  const answered = it.answered !== undefined;

  const toggle = (q: Question, label: string) => {
    haptic('selection');
    setPicked((prev) => {
      const cur = prev[q.question] ?? [];
      if (q.multiSelect) {
        return { ...prev, [q.question]: cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label] };
      }
      return { ...prev, [q.question]: cur[0] === label ? [] : [label] };
    });
  };

  const submit = (skip: boolean) => {
    const answers: Record<string, string> = {};
    if (!skip) for (const q of it.questions) {
      const cur = picked[q.question];
      if (cur?.length) answers[q.question] = cur.join(', '); // multi-select is comma-joined (worker's own format)
    }
    onAnswer(it, answers, skip ? undefined : freeform.trim() || undefined);
  };

  const complete = it.questions.every((q) => picked[q.question]?.length) || !!freeform.trim();

  return (
    <div className={`qcard${answered ? ' answered' : ''} ${cls ?? ''}`}>
      <div className="qcard-head"><ClaudeMark size={15} fill="#d97757" /><span className="t1">Claude 想问你</span></div>
      {it.questions.map((q, qi) => (
        <div className="qblock" key={qi}>
          {q.header && <span className="qchip">{q.header}</span>}
          <div className="qtext">{q.question}</div>
          {!answered && (
            <div className="qopts">
              {q.options.map((o, oi) => {
                const on = (picked[q.question] ?? []).includes(o.label);
                return (
                  <button key={oi} className={`qopt${on ? ' on' : ''}`} onClick={() => toggle(q, o.label)}>
                    <div className="l">{o.label}</div>
                    {o.description && <div className="d">{o.description}</div>}
                    {o.preview && <div className="p">{o.preview}</div>}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      ))}
      {answered
        ? <div className="qanswer">{it.answered!.trim() || '已回答'}</div>
        : (
          <>
            <div className="qblock" style={{ paddingTop: 0 }}>
              <input
                className="qother" placeholder="或者直接写点别的…" value={freeform}
                onChange={(e) => setFreeform(e.target.value)}
              />
            </div>
            <div className="qactions">
              <button className="btn" onClick={() => { haptic('medium'); submit(true); }}>跳过</button>
              <button className="btn primary" style={{ flex: 1 }} disabled={!complete} onClick={() => { haptic('light'); submit(false); }}>提交</button>
            </div>
          </>
        )}
    </div>
  );
}
