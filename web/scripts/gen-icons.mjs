/**
 * Compose the PWA PNG icons from the official Claude symbol (public/icons/claude-symbol.svg).
 *
 * Proportions are not invented: they are measured off Anthropic's own app icon
 * (claude.ai/apple-touch-icon.png) — coral ground #d97757, mark #fefcfb, mark occupying 74.4%
 * of the square, centred. Two variants deviate: the maskable one shrinks the mark to 56% so it
 * survives Android's circular crop (the safe zone is the central 80%), and the favicon drops the
 * ground entirely — see FAVICON_INSET.
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
/* The browser-tab icon is the one that carries no ground: a tab strip supplies its own
   background, and a coral tile sitting in it reads as a chip rather than as a mark. Without a
   ground the mark also stops needing the app icon's breathing room — the 74.4% inset exists to
   float it inside a rounded tile — so it grows to fill the square, which is what makes it legible
   at the 16px browsers actually paint. It is drawn in the brand coral rather than the near-white
   used on the tile, because a transparent icon has to survive BOTH a light and a dark tab strip
   and #fefcfb vanishes on light. */
const FAVICON_INSET = 92;

/** The `<path>` out of the committed official symbol — never a second copy of the geometry. */
function symbolPath() {
  const svg = readFileSync(join(ICONS, 'claude-symbol.svg'), 'utf8');
  const d = /<path[^>]*\sd="([^"]+)"/.exec(svg);
  if (!d) throw new Error('no <path d="…"> in claude-symbol.svg');
  return d[1];
}

const page = (path, { span, ground = GROUND, mark = MARK }) => `<!doctype html><html><head><meta charset="utf-8"><style>
  html, body { margin: 0; padding: 0; width: 100%; height: 100%; background: ${ground}; overflow: hidden; }
  svg { position: absolute; left: ${(100 - span) / 2}%; top: ${(100 - span) / 2}%; width: ${span}%; height: ${span}%; fill: ${mark}; }
</style></head><body>
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="${path}"/></svg>
</body></html>`;

/* Only the favicon goes transparent. The home-screen icons must not: iOS composites
   apple-touch-icon onto black, and Android's maskable crop assumes a filled square — a
   transparent mark would come out as a coral-less blob on a black tile in both. */
const TARGETS = [
  { file: 'icon-192.png', size: 192, span: INSET },
  { file: 'icon-512.png', size: 512, span: INSET },
  { file: 'icon-512-maskable.png', size: 512, span: MASKABLE_INSET },
  { file: 'apple-touch-icon.png', size: 180, span: INSET },
  { file: 'favicon-32.png', size: 32, span: FAVICON_INSET, ground: 'transparent', mark: GROUND },
];

const path = symbolPath();
mkdirSync(ICONS, { recursive: true });
const work = mkdtempSync(join(tmpdir(), 'ccc-icons-'));
try {
  for (const t of TARGETS) {
    const html = join(work, `${t.file}.html`);
    writeFileSync(html, page(path, t));
    const out = join(ICONS, t.file);
    execFileSync(BIN, [
      '--headless', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
      '--no-first-run', '--no-default-browser-check',
      `--user-data-dir=${join(work, 'profile')}`,
      '--force-device-scale-factor=1',
      `--window-size=${t.size},${t.size}`,
      // A CSS-transparent page still screenshots onto chromium's own opaque white base layer;
      // only this flag (RGBA, alpha last) makes the base itself transparent.
      ...(t.ground === 'transparent' ? ['--default-background-color=00000000'] : []),
      `--screenshot=${out}`,
      `file://${html}`,
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    console.log(`${t.file.padEnd(24)} ${t.size}×${t.size}  mark ${t.span}%  ${t.ground === 'transparent' ? 'transparent' : 'coral'}  ${statSync(out).size} B`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
console.log('wrote icons to', ICONS);
