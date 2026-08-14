/**
 * tools.ts — how a tool call is summarised on a card. Names and headline arguments come from
 * the shared src/tool-summary.ts (the server's session-list digest uses the same source), this
 * file adds the one-line result summary the collapsed card shows.
 *
 * Note on exit codes: the design's `exit 1` line is not reproducible — the data plane gives us
 * `is_error` and the output text, never a numeric status. So a failed call shows the first line
 * of its actual error instead of an invented exit code.
 */
import { toolDisplayName, toolArg, splitPath, argIsPath, HIDDEN_TOOLS, QUESTION_TOOL } from '../../src/tool-summary.ts';
import type { ToolCall } from './model.ts';

export { toolDisplayName, toolArg, splitPath, argIsPath, HIDDEN_TOOLS, QUESTION_TOOL };

const firstLine = (s: string, max = 120): string => {
  const line = (s.split('\n').find((l) => l.trim()) ?? '').trim();
  return line.length > max ? line.slice(0, max) + '…' : line;
};
const countLines = (s: string): number => (s ? s.split('\n').filter((l) => l.length).length : 0);

/** `+6 −2` for an Edit, computed from the strings it was given. Returned as numbers because the
 * card colours the two halves separately (green added / red removed). */
function editDelta(input: any): { add: number; del: number } | null {
  if (typeof input?.new_string !== 'string' || typeof input?.old_string !== 'string') return null;
  const add = input.new_string ? input.new_string.split('\n').length : 0;
  const del = input.old_string ? input.old_string.split('\n').length : 0;
  return { add, del };
}

export function durationLabel(ms: number | undefined): string | null {
  if (!ms || ms < 0) return null;
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${String(Math.round(s % 60)).padStart(2, '0')}s`;
}

/** `text` is always the plain reading of the line (it is also the card's accessible name); `delta`
 * is set alongside it when the two counts should render as coloured spans instead. */
export interface ResultLine { text: string; isError?: boolean; delta?: { add: number; del: number } }

/** The single line a collapsed tool card shows. Status is present tense, lowercase after the
 * first word (design copy rule): "Running…", not "RUNNING". */
export function resultLine(call: ToolCall): ResultLine | null {
  if (call.status === 'running') return { text: 'Running…' };
  if (call.status === 'awaiting') return { text: '等待你允许…' };

  const out = call.result ?? '';
  if (call.status === 'error') {
    return { text: firstLine(out) || '失败', isError: true };
  }
  switch (call.name) {
    case 'Read': {
      const n = countLines(out);
      return { text: n ? `读了 ${n} 行` : '完成' };
    }
    case 'Edit':
    case 'NotebookEdit': {
      const d = editDelta(call.input);
      return d ? { text: `+${d.add} −${d.del}`, delta: d } : { text: '已修改' };
    }
    case 'Write': {
      const n = typeof call.input?.content === 'string' ? call.input.content.split('\n').length : 0;
      return { text: n ? `写入 ${n} 行` : '已写入' };
    }
    case 'Grep':
    case 'Glob': {
      const n = countLines(out);
      return { text: n ? `${n} 处结果` : '无匹配' };
    }
    default: {
      const l = firstLine(out);
      return { text: l || '完成' };
    }
  }
}
