/**
 * shape-report.ts — the unadapted-shape backlog, straight out of the database.
 *
 * `history-audit.ts` answers the same question but needs a full history export first: prompts,
 * file contents, and any credential a tool ever echoed, on disk, just to count shapes. This reads
 * the `events.shape` column instead, so the answer costs one aggregate query and the report itself
 * carries no conversation content — only shape names, counts, and a row id to look at if you want
 * one.
 *
 *   DATABASE_URL=… node test/shape-report.ts [--backfill] [--all]
 *
 * Upgrading needs no manual step: `ensureSchema` adds the column on the next boot and
 * `runBackfills` stamps the older rows in the background while the server comes up. `--backfill`
 * forces that same pass from here — for a report you want complete *now*, without a restart.
 * `--all` lists every shape, not just the ones needing a decision.
 *
 * `PG_SCHEMA=ccc_test` points it at the tests' own tables, which is how this file gets exercised
 * without reading a real deployment's history.
 *
 * Verdicts come from src/wire-shape.ts at read time, never from the database: adapting a shape
 * changes the verdict, and a stored copy would start lying the moment it did.
 */
import { createPool, selectShapeStats, backfillShapes, type ShapeStat } from '../src/server/db.ts';
import { verdictOf, whyIgnored, type Verdict } from '../src/wire-shape.ts';

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL is required (docker compose up -d db)'); process.exit(1); }
const args = process.argv.slice(2);
const wantBackfill = args.includes('--backfill');
const wantAll = args.includes('--all');

const BATCH = 5000;
const pool = createPool(url, process.env.PG_SCHEMA ? { schema: process.env.PG_SCHEMA } : {});

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

if (wantBackfill) {
  let done = 0;
  for (;;) {
    const n = await backfillShapes(pool, BATCH);
    if (!n) break;
    done += n;
    // Only redraw in place on a terminal; piped into a file, \r just makes one unreadable line.
    if (process.stdout.isTTY) process.stdout.write(`\rbackfilled ${done}…`);
  }
  console.log(done ? `backfilled ${plural(done, 'row')}` : 'nothing to backfill');
}

const stats = await selectShapeStats(pool);
if (!stats.length) { console.log('no events stored yet'); process.exit(0); }

const total = stats.reduce((n, s) => n + s.count, 0);
const pending = stats.filter((s) => s.shape === '<not backfilled>');
const byVerdict = (v: Verdict) => stats.filter((s) => s.shape !== '<not backfilled>' && verdictOf(s.shape) === v);
const day = (iso: string) => (iso.length >= 10 ? iso.slice(0, 10) : iso);
const pad = (v: string | number, w: number) => String(v).padStart(w);

console.log(`${plural(total, 'event')}, ${plural(stats.length - pending.length, 'distinct shape')}\n`);

if (pending.length) {
  console.log(`⚠ ${plural(pending[0].count, 'row')} with no shape yet — run --backfill for a complete picture\n`);
}

const unknown = byVerdict('unknown');
if (unknown.length) {
  console.log(`⚠ ${plural(unknown.length, 'shape')} to adapt — seen in production, no decision in src/wire-shape.ts:`);
  for (const s of unknown) {
    console.log(`  ${pad(s.count, 7)}  ${s.shape.padEnd(40)} first ${day(s.firstSeen)}  event #${s.firstId}`);
  }
  console.log('\n  Look at one:  select payload from events where id = <#>;');
  console.log('  Then either adapt it in web/src/model.ts, or declare it ignored with a reason.');
} else {
  console.log('✅ every shape in this deployment has a decision');
}

if (wantAll) {
  console.log('\n  count  declared   first       last        shape');
  for (const s of stats) {
    if (s.shape === '<not backfilled>') continue;
    const v = verdictOf(s.shape);
    const why = v === 'ignored' ? `  — ${whyIgnored(s.shape) ?? ''}` : '';
    console.log(`${pad(s.count, 7)}  ${v.padEnd(8)}  ${day(s.firstSeen)}  ${day(s.lastSeen)}  ${s.shape}${why}`);
  }
}

await pool.end();
