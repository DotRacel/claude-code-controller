/**
 * history-audit.ts — feed a real history dump through the actual web reducer and report which
 * payloads it does not consume, so a shape the front-end never learned to render shows up as a
 * number instead of as a bug report from a phone.
 *
 * Detection is dynamic on purpose: rather than a hand-kept list of supported types (which goes
 * stale the moment the CLI emits a new `system` subtype), every payload is reduced and the
 * before/after state compared. `reduce` returns the SAME object for a type it does not know, so
 * reference equality is "ignored outright"; a deep-equal but distinct object is "consumed with
 * no visible effect". Both mean nothing reached the screen.
 *
 * It also flags the opposite failure — a payload that IS consumed but renders as raw JSON,
 * which is what a non-text tool_result (an image) looks like once textOf() stringifies it.
 *
 * Export a dump first (see docs/HISTORY-EXPORT.md), then:
 *   node test/history-audit.ts artifacts/history/events.jsonl [--samples]
 * Lines are either a bare payload or the {sid,eid,p} envelope the export query produces.
 */
import { readFileSync } from 'node:fs';
import { initialState, reduce, type TranscriptState } from '../web/src/model.ts';

const FILE = process.argv[2] ?? 'artifacts/history/events.jsonl';
const SHOW_SAMPLES = process.argv.includes('--samples');

/** How a payload is bucketed in the report: type plus whatever discriminates it further. */
function shapeOf(p: any): string {
  const t = p?.type ?? '?';
  if (t === 'system') return `system:${p.subtype ?? '?'}`;
  if (t === 'result') return `result:${p.subtype ?? '?'}`;
  if (t === 'stream_event') return `stream_event:${p.event?.type ?? '?'}`;
  if (t === 'control_request') return `control_request:${p.request?.subtype ?? '?'}`;
  if (t === 'control_response') return `control_response:${p.response?.subtype ?? '?'}`;
  if (t === 'assistant' || t === 'user') {
    const c = p.message?.content;
    if (typeof c === 'string') return `${t}:<string>`;
    if (!Array.isArray(c)) return `${t}:<${c == null ? 'missing' : typeof c}>`;
    const kinds = [...new Set(c.map((b: any) => b?.type ?? '?'))].sort();
    return `${t}:[${kinds.join('+') || 'empty'}]`;
  }
  return String(t);
}

/** Content blocks whose own shape matters (a tool_result carrying an image, say). */
function subShapes(p: any): string[] {
  const c = p?.message?.content;
  if (!Array.isArray(c)) return [];
  const out: string[] = [];
  for (const b of c) {
    if (b?.type !== 'tool_result') continue;
    const cc = b.content;
    if (typeof cc === 'string') continue;
    if (Array.isArray(cc)) for (const x of cc) out.push(`tool_result.content[].${x?.type ?? '?'}`);
    else out.push(`tool_result.content:<${cc == null ? 'missing' : typeof cc}>`);
  }
  return out;
}

/**
 * Did anything visible change? Compared by reference, never by serialising: the reducer updates
 * immutably (a touched item is replaced, not mutated), so identity is exact — and a transcript
 * holding a 600 KB base64 screenshot must not be stringified once per payload.
 */
function sameItems(a: readonly unknown[], b: readonly unknown[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** `live` is rebuilt on every draft, so its fields are compared instead of its identity. */
function sameLive(a: any, b: any): boolean {
  if (a.busy !== b.busy || a.thinking !== b.thinking || a.thinkingTokens !== b.thinkingTokens) return false;
  if (a.model !== b.model || a.permissionMode !== b.permissionMode || a.cwd !== b.cwd) return false;
  if (a.running?.name !== b.running?.name || a.running?.arg !== b.running?.arg || a.running?.since !== b.running?.since) return false;
  if (a.permission?.requestId !== b.permission?.requestId || a.permission?.toolUseId !== b.permission?.toolUseId) return false;
  return a.slashCommands.length === b.slashCommands.length && a.skills.length === b.skills.length;
}

const unchanged = (a: TranscriptState, b: TranscriptState): boolean =>
  sameItems(a.items, b.items) && sameItems(a.todos, b.todos) && sameLive(a.live, b.live);

interface Bucket { total: number; ignored: number; inert: number; sample?: any }
const buckets = new Map<string, Bucket>();
const subCounts = new Map<string, number>();
/** Items whose text is raw JSON rather than prose — a shape that reached the screen unrendered. */
const rawJson = new Map<string, { count: number; sample: string }>();
/** The worst version of that: a base64 blob, which is megabytes of noise in a chat bubble. */
const blobs = { count: 0, chars: 0, tools: new Map<string, number>() };

const RAW_JSON_HEAD = /^\s*[[{]/;
/** A stringified image content block — `textOf` produced this from a non-text tool_result. */
const BLOB_JSON = /"type"\s*:\s*"(image|document)"|"media_type"\s*:\s*"(image|application)\//;

const trunc = (o: any, d = 0): any => {
  if (typeof o === 'string') return o.length > 80 ? `${o.slice(0, 80)}…[${o.length} chars]` : o;
  if (Array.isArray(o)) return d > 2 ? `[${o.length} items]` : o.slice(0, 2).map((x) => trunc(x, d + 1));
  if (o && typeof o === 'object') {
    const r: Record<string, unknown> = {};
    for (const k of Object.keys(o)) r[k] = trunc(o[k], d + 1);
    return r;
  }
  return o;
};

let state = initialState();
let lines = 0;
let bad = 0;

for (const line of readFileSync(FILE, 'utf8').split('\n')) {
  if (!line.trim()) continue;
  lines++;
  let payload: any;
  try {
    const parsed = JSON.parse(line);
    payload = parsed && typeof parsed === 'object' && 'p' in parsed ? parsed.p : parsed;
  } catch {
    bad++;
    continue;
  }

  const shape = shapeOf(payload);
  const b = buckets.get(shape) ?? { total: 0, ignored: 0, inert: 0 };
  b.total++;
  if (!b.sample) b.sample = trunc(payload);

  const before = state;
  // History mode: this is a backfill, which is what a phone reopening a session gets.
  const after = reduce(before, payload, { isHistory: true });
  if (after === before) b.ignored++;
  else if (unchanged(before, after)) b.inert++;
  state = after;

  buckets.set(shape, b);
  for (const s of subShapes(payload)) subCounts.set(s, (subCounts.get(s) ?? 0) + 1);
}

// A second sweep over the folded transcript: any tool result or bubble that is really JSON.
for (const item of state.items) {
  const texts: Array<[string, string]> =
    item.kind === 'tools' ? item.calls.map((c) => [`tool:${c.name}`, c.result ?? ''])
    : item.kind === 'user' || item.kind === 'prose' ? [[item.kind, item.text]]
    : [];
  for (const [where, text] of texts) {
    if (!text || !RAW_JSON_HEAD.test(text)) continue;
    if (BLOB_JSON.test(text.slice(0, 400))) {
      blobs.count++;
      blobs.chars += text.length;
      blobs.tools.set(where, (blobs.tools.get(where) ?? 0) + 1);
      continue;
    }
    // `[Request interrupted by user]` also starts with a bracket: require it to actually parse.
    try {
      const v = JSON.parse(text);
      if (v === null || typeof v !== 'object') continue;
    } catch {
      continue;
    }
    const cur = rawJson.get(where) ?? { count: 0, sample: '' };
    cur.count++;
    if (!cur.sample) cur.sample = text.length > 120 ? `${text.slice(0, 120)}…[${text.length} chars]` : text;
    rawJson.set(where, cur);
  }
}

const pad = (n: number | string, w: number) => String(n).padStart(w);
console.log(`${FILE}: ${lines} payloads${bad ? `, ${bad} unparseable` : ''}\n`);

const rows = [...buckets.entries()].sort((a, b) => b[1].total - a[1].total);
console.log('  total  ignored    inert  shape');
for (const [shape, b] of rows) {
  const flag = b.ignored === b.total ? ' ← never rendered' : b.ignored + b.inert === b.total ? ' ← no visible effect' : '';
  console.log(`${pad(b.total, 7)}${pad(b.ignored, 9)}${pad(b.inert, 9)}  ${shape}${flag}`);
}

const dropped = rows.filter(([, b]) => b.ignored + b.inert === b.total);
if (dropped.length) {
  console.log(`\n${dropped.length} shape(s) produce nothing on screen:`);
  for (const [shape, b] of dropped) console.log(`  ${shape}  ×${b.total}`);
}

if (subCounts.size) {
  console.log('\nNon-text tool_result content:');
  for (const [k, v] of [...subCounts].sort((a, b) => b[1] - a[1])) console.log(`  ${pad(v, 5)}  ${k}`);
}

if (blobs.count) {
  const mb = (blobs.chars / 1e6).toFixed(1);
  console.log(`\nBase64 blobs stringified into the transcript: ${blobs.count} results, ${mb} MB of text`);
  for (const [where, n] of [...blobs.tools].sort((a, b) => b[1] - a[1])) console.log(`  ${pad(n, 5)}  ${where}`);
}

if (rawJson.size) {
  console.log('\nRendered as JSON text (may be legitimate — a command that prints JSON):');
  for (const [where, v] of [...rawJson].sort((a, b) => b[1].count - a[1].count)) {
    console.log(`  ${pad(v.count, 5)}  ${where}\n         ${v.sample}`);
  }
}

console.log(`\nfolded transcript: ${state.items.length} items`);
if (SHOW_SAMPLES) {
  console.log('\n--- one sample per shape (strings truncated) ---');
  for (const [shape, b] of rows) console.log(`\n[${shape}]\n${JSON.stringify(b.sample, null, 1)}`);
}
