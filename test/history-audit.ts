/**
 * history-audit.ts — feed a real history dump through the actual web reducer and report which
 * payloads it does not consume, so a shape the front-end never learned to render shows up as a
 * number instead of as a bug report from a phone.
 *
 * Two independent signals, cross-checked against each other:
 *
 *  - **declared** — `verdictOf` (src/wire-shape.ts) says whether we have a decision about this
 *    shape: handled, ignored on purpose (with a reason), or `unknown` = nobody decided yet.
 *  - **measured** — the payload is actually reduced and the before/after state compared, by
 *    reference (the reducer replaces what it touches, so identity is exact).
 *
 * Neither alone is enough. Measurement cannot tell a heartbeat we drop on purpose from a subtype
 * we have never seen, and a declaration can be wrong or go stale. Together they catch drift in
 * both directions: an `unknown` shape arriving in real traffic is the backlog, and a shape
 * declared `handled` that never changes anything is a dead branch or a lie.
 *
 * It also flags the opposite failure — a payload that IS consumed but renders as raw JSON,
 * which is what a non-text tool_result (an image) looks like once it is stringified.
 *
 * Export a dump first (see docs/HISTORY-EXPORT.md), then:
 *   node test/history-audit.ts artifacts/history/events.jsonl [--samples] [--promote]
 * Lines are either a bare payload or the {sid,eid,p} envelope the export query produces.
 *
 * `--promote` appends one redacted payload per undecided shape to the fixture corpus, which makes
 * `npm test` fail until it is handled — discovery, then a permanent regression, in one step.
 */
import { appendFileSync, readFileSync } from 'node:fs';
import { initialState, reduce, type TranscriptState } from '../web/src/model.ts';
import { shapeOf, verdictOf, whyIgnored } from '../src/wire-shape.ts';

const FILE = process.argv[2] ?? 'artifacts/history/events.jsonl';
const SHOW_SAMPLES = process.argv.includes('--samples');
const WANT_PROMOTE = process.argv.includes('--promote');
const FIXTURE = new URL('fixtures/transcript-shapes.jsonl', import.meta.url);

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

interface Bucket {
  total: number; ignored: number; inert: number;
  /** Strings truncated hard — for reading in `--samples`. */
  sample?: any;
  /** Kept only for undecided shapes, and only under --promote: the payload a fixture line needs. */
  promotable?: any;
}
const buckets = new Map<string, Bucket>();
const subCounts = new Map<string, number>();
/** Items whose text is raw JSON rather than prose — a shape that reached the screen unrendered. */
const rawJson = new Map<string, { count: number; sample: string }>();
/** The worst version of that: a base64 blob, which is megabytes of noise in a chat bubble. */
const blobs = { count: 0, chars: 0, tools: new Map<string, number>() };

/**
 * A payload trimmed down to its SHAPE, for appending to the fixture corpus.
 *
 * The corpus lives in git, and a real payload is real conversation history — this audit's own
 * report has found an access token echoed by a Bash call. So promotion keeps the structure and
 * throws the content away: image bytes go (stripImageBlobs), and every string is capped, which is
 * also what stops a 600 KB tool result from landing in a test fixture. Nothing about matching a
 * shape needs the text, and a human still reviews the diff before it is committed.
 */
const PROMOTE_STR_MAX = 120;
function redact(o: any): any {
  if (typeof o === 'string') return o.length > PROMOTE_STR_MAX ? `${o.slice(0, PROMOTE_STR_MAX)}…` : o;
  if (Array.isArray(o)) return o.map(redact);
  if (o && typeof o === 'object') {
    const r: Record<string, unknown> = {};
    for (const k of Object.keys(o)) r[k] = redact(o[k]);
    return r;
  }
  return o;
}

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
  if (WANT_PROMOTE && !b.promotable && verdictOf(shape) === 'unknown') b.promotable = redact(payload);

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
/** Every payload of this shape left the state untouched — measured, not declared. */
const inertAll = (b: Bucket) => b.ignored + b.inert === b.total;

console.log('  total  no-effect  declared   shape');
for (const [shape, b] of rows) {
  const v = verdictOf(shape);
  const mark = v === 'unknown' ? '←' : ' ';
  console.log(`${pad(b.total, 7)}${pad(b.ignored + b.inert, 11)}  ${v.padEnd(8)} ${mark} ${shape}`);
}

// ── the backlog: shapes real traffic contains and nobody has decided about ──
const backlog = rows.filter(([shape]) => verdictOf(shape) === 'unknown');
if (backlog.length) {
  console.log(`\n⚠ ${backlog.length} shape(s) to adapt — present in this history, no decision in src/wire-shape.ts:`);
  for (const [shape, b] of backlog) console.log(`  ${pad(b.total, 6)}  ${shape}`);
  console.log('  (adapt them in web/src/model.ts, or declare them ignored with a reason)');
  if (!WANT_PROMOTE) console.log('  --promote appends one payload of each to test/fixtures/transcript-shapes.jsonl');
} else {
  console.log('\n✅ every shape in this history has a decision');
}

/*
 * Promotion: the corpus is this project's memory of what production has taught it, and the only
 * defence against un-learning a shape during a refactor. So a shape gets one line in the fixture
 * the moment it is discovered — before anyone adapts it — and test/model.test.ts then holds the
 * reducer to it forever ('nothing in the fixture is an undecided shape any more' fails until it
 * is handled, and keeps failing if the handling is ever lost).
 */
if (WANT_PROMOTE) {
  const have = new Set(
    readFileSync(FIXTURE, 'utf8').split('\n').filter((l) => l.trim())
      .map((l) => { try { return shapeOf(JSON.parse(l)); } catch { return ''; } }),
  );
  const add = backlog.filter(([shape, b]) => b.promotable && !have.has(shape));
  if (!add.length) {
    console.log('\nnothing to promote — the fixture already covers every undecided shape here');
  } else {
    appendFileSync(FIXTURE, add.map(([, b]) => JSON.stringify(b.promotable)).join('\n') + '\n');
    console.log(`\npromoted ${add.length} shape(s) into test/fixtures/transcript-shapes.jsonl:`);
    for (const [shape] of add) console.log(`  + ${shape}`);
    console.log('\n  Strings are capped and image bytes stripped, but READ THE DIFF before committing:');
    console.log('  these lines came out of a real conversation.');
    console.log('  `npm test` now fails until each one is handled or declared ignored — that is the point.');
  }
}

// ── drift the other way: a declaration the measurement contradicts ──
const lying = rows.filter(([shape, b]) => verdictOf(shape) === 'handled' && inertAll(b));
if (lying.length) {
  console.log(`\n⚠ declared handled but never changed anything (dead branch, or the rule is wrong):`);
  for (const [shape, b] of lying) console.log(`  ${pad(b.total, 6)}  ${shape}`);
}
const noisy = rows.filter(([shape, b]) => verdictOf(shape) === 'ignored' && !inertAll(b));
if (noisy.length) {
  console.log(`\n⚠ declared ignored but DID change the transcript:`);
  for (const [shape, b] of noisy) console.log(`  ${pad(b.total, 6)}  ${shape} — "${whyIgnored(shape) ?? ''}"`);
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
