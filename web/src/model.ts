/**
 * model.ts — the data-plane event stream folded into a renderable transcript.
 *
 * This is a pure function of (state, payload): the same reducer eats the history backfill and
 * the live stream, so what you see after reopening a session is byte-identical to what you saw
 * while it happened. Keeping it out of the components is what makes it testable against real
 * captured events (test/model.test.ts).
 *
 * Two things learned from real transcripts drive the shape here:
 *
 *  - The REPL bridge replays the WHOLE conversation on connect, so "history" is not
 *    necessarily stale: a permission request or a question that never got a tool_result is
 *    genuinely still waiting for you. So open-ness is decided by whether the matching
 *    tool_result arrived, never by whether the event came from the backfill.
 *  - `assistant` text also arrives token-by-token as `stream_event` beforehand. The final
 *    message replaces the streamed draft in place rather than appending a duplicate.
 *
 * Event shapes: docs/EVENTS.md. Unknown types are no-ops by design — a new `system` subtype
 * must never break the transcript.
 */
import { takeVisibleUserTexts } from './transcript.ts';
import { toolArg, HIDDEN_TOOLS, QUESTION_TOOL } from '../../src/tool-summary.ts';
import { isPushNotificationToolUse } from '../../src/push-event.ts';

/** Task tools that mutate the list render as a checklist card, not as a tool row. */
export const TODO_TOOLS = new Set(['TaskCreate', 'TaskUpdate']);

export type ToolStatus = 'running' | 'awaiting' | 'ok' | 'error';

export interface ToolCall {
  toolUseId: string;
  name: string;
  input: any;
  status: ToolStatus;
  result?: string;
  startedAt?: number;
  endedAt?: number;
}

export interface QuestionOption { label: string; description?: string; preview?: string }
export interface Question { question: string; header?: string; multiSelect?: boolean; options: QuestionOption[] }

export interface TodoTask { key: string; subject: string; status: 'pending' | 'in_progress' | 'completed' | 'deleted' }

export interface PermissionRequest {
  requestId: string;
  toolUseId?: string;
  toolName: string;
  displayName?: string;
  input: any;
  reason?: string;
  suggestions: any[];
}

export type Item =
  | { kind: 'user'; id: number; text: string; state: 'sent' | 'queued' }
  // `fromStream` outlives `streaming`: message_stop stops the caret, but the authoritative
  // `assistant` message arrives *after* it and must replace this item, not append a copy.
  | { kind: 'prose'; id: number; text: string; streaming?: boolean; fromStream?: boolean }
  | { kind: 'thinking'; id: number; text: string; tokens?: number; streaming?: boolean; fromStream?: boolean }
  | { kind: 'tools'; id: number; calls: ToolCall[] }
  | { kind: 'todo'; id: number; tasks: TodoTask[] }
  | { kind: 'question'; id: number; requestId: string; toolUseId?: string; questions: Question[]; answered?: string }
  | { kind: 'bgtask'; id: number; taskId: string; description: string; status: 'running' | 'completed' | 'failed' }
  | { kind: 'status'; id: number; text: string }
  | { kind: 'error'; id: number; title: string; detail?: string };

export interface Live {
  busy: boolean;
  /**
   * Is the model reasoning *right now*? `busy` spans the whole turn — tool runs and prose
   * included — so the activity line needs this narrower signal to decide whether the thinking
   * glyph is honest. Set by thinking deltas and `system:thinking_tokens`, cleared the moment
   * text or a tool call takes over.
   */
  thinking?: boolean;
  thinkingTokens?: number;
  /** The tool currently held open, for the activity line under the transcript. */
  running?: { name: string; arg: string; since: number };
  permission?: PermissionRequest;
  model?: string;
  permissionMode?: string;
  cwd?: string;
  slashCommands: string[];
  skills: string[];
}

export interface TranscriptState {
  items: Item[];
  live: Live;
  seq: number;
  /** toolUseId → position of the call, so a tool_result can find its card. */
  index: Record<string, { i: number; j: number }>;
  /** Web-sent texts awaiting their worker echo (which must not render twice). */
  pendingWeb: string[];
  /** Task* state accumulated across the session; snapshotted into each todo card. */
  todos: TodoTask[];
}

export const initialState = (): TranscriptState => ({
  items: [],
  live: { busy: false, slashCommands: [], skills: [] },
  seq: 0,
  index: {},
  pendingWeb: [],
  todos: [],
});

const timeOf = (p: any): number | undefined => {
  const t = p?.timestamp;
  if (typeof t !== 'string') return undefined;
  const ms = Date.parse(t);
  return Number.isFinite(ms) ? ms : undefined;
};
const textOf = (c: unknown): string => (typeof c === 'string' ? c : c == null ? '' : JSON.stringify(c));

/** Working copy: items/live are replaced, individual items cloned only when touched. */
interface Draft extends TranscriptState { items: Item[]; live: Live }
/** Plain `Omit` on a union collapses to the shared keys; distribute it instead. */
type NewItem = Item extends infer T ? (T extends Item ? Omit<T, 'id'> : never) : never;
const draftOf = (s: TranscriptState): Draft => ({ ...s, items: s.items.slice(), live: { ...s.live }, index: { ...s.index } });
const push = (d: Draft, item: NewItem): Item => {
  const withId = { ...item, id: d.seq++ } as Item;
  d.items.push(withId);
  return withId;
};

/** Replace the streamed draft at the tail (settled or not), or push a fresh item. */
function settleStreamed(d: Draft, kind: 'prose' | 'thinking', text: string, tokens?: number): void {
  const last = d.items[d.items.length - 1];
  if (last && last.kind === kind && (last.streaming || last.fromStream)) {
    d.items[d.items.length - 1] = { ...last, text, streaming: false, fromStream: false, ...(kind === 'thinking' ? { tokens } : {}) } as Item;
    return;
  }
  push(d, kind === 'prose' ? { kind, text } : { kind, text, tokens });
}

function appendStreamed(d: Draft, kind: 'prose' | 'thinking', chunk: string): void {
  const last = d.items[d.items.length - 1];
  if (last && last.kind === kind && last.streaming) {
    d.items[d.items.length - 1] = { ...last, text: last.text + chunk } as Item;
    return;
  }
  push(d, kind === 'prose'
    ? { kind: 'prose', text: chunk, streaming: true, fromStream: true }
    : { kind: 'thinking', text: chunk, streaming: true, fromStream: true });
}

/**
 * A textless thinking marker. Consecutive blocks coalesce (a turn emits several), so one
 * stretch of reasoning is one line, carrying the newest token estimate.
 */
function markThinking(d: Draft, tokens: number | undefined): void {
  const lastIdx = d.items.length - 1;
  const last = d.items[lastIdx];
  if (last && last.kind === 'thinking' && !last.text) {
    d.items[lastIdx] = { ...last, tokens: tokens ?? last.tokens };
    return;
  }
  push(d, { kind: 'thinking', text: '', tokens });
}

/** Adjacent tool cards merge into one bordered group (design 0b). */
function addToolCall(d: Draft, call: ToolCall): void {
  const lastIdx = d.items.length - 1;
  const last = d.items[lastIdx];
  if (last && last.kind === 'tools') {
    const calls = last.calls.concat(call);
    d.items[lastIdx] = { ...last, calls };
    d.index[call.toolUseId] = { i: lastIdx, j: calls.length - 1 };
    return;
  }
  push(d, { kind: 'tools', calls: [call] });
  d.index[call.toolUseId] = { i: d.items.length - 1, j: 0 };
}

function patchCall(d: Draft, toolUseId: string, patch: Partial<ToolCall>): ToolCall | null {
  const at = d.index[toolUseId];
  if (!at) return null;
  const item = d.items[at.i];
  if (!item || item.kind !== 'tools') return null;
  const calls = item.calls.slice();
  const next = { ...calls[at.j], ...patch };
  calls[at.j] = next;
  d.items[at.i] = { ...item, calls };
  return next;
}

/** A todo mutation refreshes the trailing todo card, or starts a new one. */
function snapshotTodos(d: Draft): void {
  const tasks = d.todos.map((t) => ({ ...t }));
  const lastIdx = d.items.length - 1;
  const last = d.items[lastIdx];
  if (last && last.kind === 'todo') d.items[lastIdx] = { ...last, tasks };
  else push(d, { kind: 'todo', tasks });
}

function applyTodoTool(d: Draft, call: { toolUseId: string; name: string; input: any }): void {
  const input = call.input ?? {};
  d.todos = d.todos.slice();
  if (call.name === 'TaskCreate') {
    // The numeric id only exists in the tool_result; key on the tool_use id until then.
    d.todos.push({ key: call.toolUseId, subject: String(input.subject ?? input.description ?? '任务'), status: 'pending' });
  } else {
    const id = String(input.taskId ?? '');
    const found = d.todos.findIndex((t) => t.key === id);
    const status = ['pending', 'in_progress', 'completed', 'deleted'].includes(input.status) ? input.status : undefined;
    if (found >= 0) d.todos[found] = { ...d.todos[found], ...(input.subject ? { subject: String(input.subject) } : {}), ...(status ? { status } : {}) };
    else if (id) d.todos.push({ key: id, subject: String(input.subject ?? `任务 #${id}`), status: status ?? 'pending' });
  }
  d.todos = d.todos.filter((t) => t.status !== 'deleted');
  snapshotTodos(d);
}

/** `Task #3 created successfully: …` — learn the real id so later TaskUpdates line up. */
function learnTodoId(d: Draft, toolUseId: string, result: string): void {
  const m = /Task #(\d+)/.exec(result);
  if (!m) return;
  const at = d.todos.findIndex((t) => t.key === toolUseId);
  if (at < 0) return;
  d.todos = d.todos.slice();
  d.todos[at] = { ...d.todos[at], key: m[1] };
  // Refresh whichever todo card is showing this snapshot.
  for (let i = d.items.length - 1; i >= 0; i--) {
    const it = d.items[i];
    if (it.kind === 'todo') { d.items[i] = { ...it, tasks: d.todos.map((t) => ({ ...t })) }; break; }
  }
}

function closeOpenPermission(d: Draft, toolUseId: string): void {
  if (d.live.permission && d.live.permission.toolUseId === toolUseId) d.live.permission = undefined;
}

// ── the reducer ──
export function reduce(state: TranscriptState, payload: any, opts: { isHistory: boolean } = { isHistory: false }): TranscriptState {
  if (!payload || typeof payload !== 'object') return state;
  const d = draftOf(state);
  const ts = timeOf(payload);

  switch (payload.type) {
    case 'system': return system(d, payload);
    case 'assistant': return assistant(d, payload, ts, opts.isHistory);
    case 'user': return user(d, payload, ts, opts.isHistory);
    case 'result': return result(d, payload);
    case 'control_request': return controlRequest(d, payload);
    case 'stream_event': return streamEvent(d, payload, opts.isHistory);
    default: return state; // keep_alive, control_response echo, anything new
  }
}

function system(d: Draft, p: any): TranscriptState {
  switch (p.subtype) {
    case 'init':
      if (typeof p.model === 'string') d.live.model = p.model;
      if (typeof p.permissionMode === 'string') d.live.permissionMode = p.permissionMode;
      if (typeof p.cwd === 'string' && p.cwd) d.live.cwd = p.cwd; // '' on REPL (/rc) sessions
      if (Array.isArray(p.slash_commands)) d.live.slashCommands = p.slash_commands.filter((c: unknown) => typeof c === 'string');
      if (Array.isArray(p.skills)) d.live.skills = p.skills.filter((c: unknown) => typeof c === 'string');
      return d;
    case 'thinking_tokens':
      // The estimate only grows while the model reasons, so its arrival IS "thinking now".
      d.live.thinking = true;
      if (typeof p.estimated_tokens === 'number') d.live.thinkingTokens = p.estimated_tokens;
      return d;
    case 'post_turn_summary':
      // Named for when it is emitted: the turn is over. `result` normally says so, but it is not
      // guaranteed to arrive (a dropped worker, a bridge that stops relaying), and a turn whose
      // end is never announced would leave the activity line spinning for good. A later assistant
      // message legitimately flips `busy` back on, so this is a floor, not a latch.
      idle(d);
      if (typeof p.status_detail === 'string' && p.status_detail.trim()) push(d, { kind: 'status', text: p.status_detail.trim() });
      return d;
    case 'task_started': {
      const taskId = String(p.task_id ?? '');
      if (!taskId || d.items.some((i) => i.kind === 'bgtask' && i.taskId === taskId)) return d;
      push(d, { kind: 'bgtask', taskId, description: String(p.description ?? '后台任务'), status: 'running' });
      return d;
    }
    case 'task_notification': {
      const taskId = String(p.task_id ?? '');
      const status = p.status === 'failed' ? 'failed' : 'completed';
      const at = d.items.findIndex((i) => i.kind === 'bgtask' && i.taskId === taskId);
      if (at >= 0) d.items[at] = { ...(d.items[at] as any), status };
      else if (taskId) push(d, { kind: 'bgtask', taskId, description: String(p.summary ?? '后台任务'), status });
      return d;
    }
    case 'background_tasks_changed': {
      // The list holds what is still tracked; anything that dropped off has finished. Inferred,
      // because a task can complete without ever emitting its own task_notification.
      const live = new Set<string>((Array.isArray(p.tasks) ? p.tasks : []).map((t: any) => String(t?.task_id ?? '')));
      for (let i = 0; i < d.items.length; i++) {
        const it = d.items[i];
        if (it.kind === 'bgtask' && it.status === 'running' && !live.has(it.taskId)) d.items[i] = { ...it, status: 'completed' };
      }
      return d;
    }
    case 'api_error':
    case 'permission_denied':
    case 'mirror_error':
      push(d, { kind: 'error', title: String(p.subtype).replace(/_/g, ' '), detail: typeof p.message === 'string' ? p.message : undefined });
      return d;
    default:
      return d; // forward-compatible no-op
  }
}

function assistant(d: Draft, p: any, ts: number | undefined, isHistory: boolean): TranscriptState {
  const content = p.message?.content;
  if (!Array.isArray(content)) return d;
  if (!isHistory) d.live.busy = true;
  for (const b of content) {
    if (!b || typeof b !== 'object') continue;
    // Blocks arrive in the order the model produced them, so the last one wins: a message that
    // reasoned and then answered ends on `text` and the thinking glyph gives way.
    if (b.type === 'text') {
      if (!isHistory) d.live.thinking = false;
      if (typeof b.text === 'string' && b.text.trim()) settleStreamed(d, 'prose', b.text);
    } else if (b.type === 'thinking') {
      if (!isHistory) d.live.thinking = true;
      // Real transcripts carry `thinking: ""` — the data plane relays the signature only, never
      // the reasoning text. So a thinking block is a *marker* ("it thought, for N tokens"),
      // and only becomes expandable prose if a future version starts sending the text.
      const text = typeof b.thinking === 'string' ? b.thinking : '';
      if (text.trim()) settleStreamed(d, 'thinking', text, d.live.thinkingTokens);
      else markThinking(d, d.live.thinkingTokens);
    } else if (b.type === 'tool_use') {
      if (!isHistory) d.live.thinking = false;
      if (isPushNotificationToolUse(b) || HIDDEN_TOOLS.has(b.name)) continue;
      if (b.name === QUESTION_TOOL) continue; // rendered as a question card from its permission request
      const toolUseId = String(b.id ?? '');
      if (!toolUseId) continue;
      if (TODO_TOOLS.has(b.name)) {
        applyTodoTool(d, { toolUseId, name: b.name, input: b.input });
        d.index[toolUseId] = { i: -1, j: -1 }; // known but not a tool card
        continue;
      }
      addToolCall(d, { toolUseId, name: String(b.name ?? 'Tool'), input: b.input, status: 'running', startedAt: ts });
      d.live.running = { name: String(b.name ?? 'Tool'), arg: toolArg(b.name, b.input), since: ts ?? Date.now() };
    }
  }
  return d;
}

/**
 * The agent has taken a turn we sent while it was busy, so that bubble is no longer queued.
 * Oldest match first: `pendingWeb` is consumed FIFO, so two identical queued texts settle in
 * the order they were sent.
 */
function settleQueued(d: Draft, text: string): void {
  const at = d.items.findIndex((i) => i.kind === 'user' && i.state === 'queued' && i.text === text);
  if (at >= 0) d.items[at] = { ...(d.items[at] as Extract<Item, { kind: 'user' }>), state: 'sent' };
}

function user(d: Draft, p: any, ts: number | undefined, isHistory: boolean): TranscriptState {
  const taken = takeVisibleUserTexts(p, d.pendingWeb, isHistory);
  d.pendingWeb = taken.pendingWeb;
  for (const text of taken.consumed) settleQueued(d, text);
  for (const text of taken.texts) {
    push(d, { kind: 'user', text, state: 'sent' });
    // A fresh turn has not reasoned yet — whatever the previous one ended on must not carry over.
    if (!isHistory) { d.live.busy = true; d.live.thinking = false; }
  }
  const content = p.message?.content;
  if (Array.isArray(content)) {
    for (const b of content) {
      if (b?.type !== 'tool_result' || typeof b.tool_use_id !== 'string') continue;
      const id = b.tool_use_id;
      const body = textOf(b.content);
      closeOpenPermission(d, id);

      const q = d.items.findIndex((i) => i.kind === 'question' && i.toolUseId === id);
      if (q >= 0) { d.items[q] = { ...(d.items[q] as any), answered: body }; continue; }

      const at = d.index[id];
      if (at && at.i < 0) { learnTodoId(d, id, body); continue; } // a Task* call
      const call = patchCall(d, id, { status: b.is_error ? 'error' : 'ok', result: body, endedAt: ts });
      if (call && d.live.running && call.toolUseId === id) d.live.running = undefined;
    }
  }
  return d;
}

/**
 * Drop the live "work is happening" flags — everything the activity line reads. Kept separate
 * from the transcript cleanup below because `post_turn_summary` may stop the spinner but must
 * never settle a tool card: only a real `tool_result` (or `result`) knows how a call ended.
 */
function idle(d: Draft): void {
  d.live.busy = false;
  d.live.running = undefined;
  d.live.thinking = false;
  d.live.thinkingTokens = undefined;
}

/** Wind the turn down: nothing, live or rendered, may keep claiming to be in flight. */
function endTurn(d: Draft, failed = false): void {
  idle(d);
  d.live.permission = undefined;
  for (let i = 0; i < d.items.length; i++) {
    const it = d.items[i];
    if (it.kind !== 'tools') continue;
    if (!it.calls.some((c) => c.status === 'running' || c.status === 'awaiting')) continue;
    d.items[i] = { ...it, calls: it.calls.map((c) => (c.status === 'running' || c.status === 'awaiting' ? { ...c, status: failed ? 'error' : 'ok' } : c)) };
  }
  for (let i = 0; i < d.items.length; i++) {
    const it = d.items[i];
    if (it.kind === 'prose' && it.streaming) d.items[i] = { ...it, streaming: false };
    if (it.kind === 'thinking' && it.streaming) d.items[i] = { ...it, streaming: false };
  }
}

function result(d: Draft, p: any): TranscriptState {
  const failed = p.subtype && p.subtype !== 'success';
  endTurn(d, failed);
  if (failed) {
    push(d, { kind: 'error', title: String(p.subtype), detail: typeof p.result === 'string' ? p.result : undefined });
  }
  return d;
}

function controlRequest(d: Draft, p: any): TranscriptState {
  const req = p.request;
  if (req?.subtype !== 'can_use_tool') return d;
  const requestId = String(p.request_id ?? '');
  const toolUseId = typeof req.tool_use_id === 'string' ? req.tool_use_id : undefined;

  if (req.tool_name === QUESTION_TOOL) {
    const questions = Array.isArray(req.input?.questions) ? req.input.questions : [];
    if (!questions.length) return d;
    if (d.items.some((i) => i.kind === 'question' && i.requestId === requestId)) return d;
    push(d, { kind: 'question', requestId, toolUseId, questions });
    return d;
  }
  if (toolUseId) patchCall(d, toolUseId, { status: 'awaiting' });
  d.live.permission = {
    requestId, toolUseId,
    toolName: String(req.tool_name ?? 'Tool'),
    displayName: typeof req.display_name === 'string' ? req.display_name : undefined,
    input: req.input,
    reason: typeof req.decision_reason === 'string' ? req.decision_reason : undefined,
    suggestions: Array.isArray(req.permission_suggestions) ? req.permission_suggestions : [],
  };
  return d;
}

function streamEvent(d: Draft, p: any, isHistory: boolean): TranscriptState {
  const e = p.event;
  const t = e?.type;
  if (t === 'content_block_delta') {
    const delta = e.delta ?? {};
    if (delta.type === 'text_delta' && typeof delta.text === 'string') {
      appendStreamed(d, 'prose', delta.text);
      if (!isHistory) d.live.thinking = false;
    } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
      appendStreamed(d, 'thinking', delta.thinking);
      if (!isHistory) d.live.thinking = true;
    }
    if (!isHistory) d.live.busy = true;
  } else if (t === 'message_stop') {
    for (let i = d.items.length - 1; i >= 0; i--) {
      const it = d.items[i];
      if ((it.kind === 'prose' || it.kind === 'thinking') && it.streaming) { d.items[i] = { ...it, streaming: false }; break; }
    }
  }
  return d;
}

// ── local (optimistic) mutations ──

/** A web-sent turn appears immediately; `queued` while the agent still holds the turn. */
export function localSend(state: TranscriptState, text: string, queued: boolean): TranscriptState {
  const d = draftOf(state);
  d.pendingWeb = d.pendingWeb.concat(text);
  push(d, { kind: 'user', text, state: queued ? 'queued' : 'sent' });
  d.live.busy = true;
  d.live.thinking = false;
  return d;
}

/** Fold our own answer into the card so it settles without waiting for the round trip. */
export function markQuestionAnswered(state: TranscriptState, requestId: string, summary: string): TranscriptState {
  const d = draftOf(state);
  const at = d.items.findIndex((i) => i.kind === 'question' && i.requestId === requestId);
  if (at >= 0) d.items[at] = { ...(d.items[at] as any), answered: summary };
  return d;
}

/** Clear the permission sheet the moment we answer it. */
export function clearPermission(state: TranscriptState): TranscriptState {
  const d = draftOf(state);
  const p = d.live.permission;
  d.live.permission = undefined;
  if (p?.toolUseId) patchCall(d, p.toolUseId, { status: 'running' });
  return d;
}

/**
 * Does a backfill end mid-turn? The reducer deliberately never infers `busy` from history — a
 * replay is not activity — but the REPL bridge replays the whole conversation, so a turn that is
 * genuinely still in flight arrives as history too, and reopening that session must still show the
 * Stop button and the activity line.
 *
 * Scanning backwards for the last turn boundary is the same rule the server folds into the session
 * digest (src/server/store.ts, foldDigest): `result` — or a `post_turn_summary`, which is emitted
 * once the turn is over and covers the case where no `result` ever arrives — ends a turn, a user
 * or assistant message starts or continues one, everything else is neutral.
 */
export function turnActiveIn(payloads: unknown[]): boolean {
  for (let i = payloads.length - 1; i >= 0; i--) {
    const p = payloads[i] as any;
    const t = p?.type;
    if (t === 'result') return false;
    if (t === 'system' && p?.subtype === 'post_turn_summary') return false;
    if (t === 'user' || t === 'assistant' || t === 'stream_event') return true;
  }
  return false;
}

export function reduceAll(payloads: unknown[], opts: { isHistory: boolean } = { isHistory: true }): TranscriptState {
  let s = initialState();
  for (const p of payloads) s = reduce(s, p, opts);
  return s;
}
