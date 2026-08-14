/**
 * Compose the PWA PNG icons from the official Claude symbol (public/icons/claude-symbol.svg).
 *
 * Proportions are not invented: they are measured off Anthropic's own app icon
 * (claude.ai/apple-touch-icon.png) — coral ground #d97757, mark #fefcfb, mark occupying 74.4%
 * of the square, centred. The maskable variant is the only one that deviates, shrinking the
 * mark to 56% so it survives Android's circular crop (the safe zone is the central 80%).
 *
 * Rasterising is done by the chromium already used for test/ui-shot.ts rather than by a
 * bespoke rasteriser: an SVG path is the source of truth, so it has to be rendered by
 * something that actually implements SVG.
 *
 * Run: node web/scripts/gen-icons.mjs      (CHROMIUM_BIN to override the browser)
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ICONS = join(dirname(fileURLToPath(import.meta.url)), '../public/icons');
const BIN = process.env.CHROMIUM_BIN || 'chromium';

const GROUND = '#d97757'; // the symbol's own hsl(14.8, 63.1%, 59.6%)
const MARK = '#fefcfb';
const INSET = 74.4; // % of the square the mark spans, per the official app icon
const MASKABLE_INSET = 56;

/** The `<path>` out of the committed official symbol — never a second copy of the geometry. */
function symbolPath() {
  const svg = readFileSync(join(ICONS, 'claude-symbol.svg'), 'utf8');
  const d = /<path[^>]*\sd="([^"]+)"/.exec(svg);
  if (!d) throw new Error('no <path d="…"> in claude-symbol.svg');
  return d[1];
}

const page = (path, span) => `<!doctype html><html><head><meta charset="utf-8"><style>
  html, body { margin: 0; padding: 0; width: 100%; height: 100%; background: ${GROUND}; overflow: hidden; }
  svg { position: absolute; left: ${(100 - span) / 2}%; top: ${(100 - span) / 2}%; width: ${span}%; height: ${span}%; fill: ${MARK}; }
</style></head><body>
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="${path}"/></svg>
</body></html>`;

const TARGETS = [
  { file: 'icon-192.png', size: 192, span: INSET },
  { file: 'icon-512.png', size: 512, span: INSET },
  { file: 'icon-512-maskable.png', size: 512, span: MASKABLE_INSET },
  { file: 'apple-touch-icon.png', size: 180, span: INSET },
  { file: 'favicon-32.png', size: 32, span: INSET },
];

const path = symbolPath();
mkdirSync(ICONS, { recursive: true });
const work = mkdtempSync(join(tmpdir(), 'ccc-icons-'));
try {
  for (const t of TARGETS) {
    const html = join(work, `${t.file}.html`);
    writeFileSync(html, page(path, t.span));
    const out = join(ICONS, t.file);
    execFileSync(BIN, [
      '--headless', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
      '--no-first-run', '--no-default-browser-check',
      `--user-data-dir=${join(work, 'profile')}`,
      '--force-device-scale-factor=1',
      `--window-size=${t.size},${t.size}`,
      `--screenshot=${out}`,
      `file://${html}`,
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    console.log(`${t.file.padEnd(24)} ${t.size}×${t.size}  mark ${t.span}%  ${statSync(out).size} B`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
console.log('wrote icons to', ICONS);
