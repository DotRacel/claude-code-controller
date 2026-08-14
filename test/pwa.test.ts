/**
 * pwa.test.ts — installability contract: valid manifest, SW does not intercept
 * the data-plane, and the controller serves PWA files with the right MIME.
 * Run: node --test test/pwa.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createControllerServer } from '../src/server/index.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const pub = path.resolve(here, '../web/public');

test('manifest is a valid installable PWA manifest', () => {
  const m = JSON.parse(readFileSync(path.join(pub, 'manifest.webmanifest'), 'utf8'));
  assert.equal(typeof m.name, 'string');
  assert.ok(m.name.length > 0);
  assert.equal(typeof m.short_name, 'string');
  assert.equal(m.display, 'standalone');
  assert.ok(m.start_url);
  assert.ok(m.theme_color);
  assert.ok(m.background_color);
  const sizes = new Set(m.icons.map((i: { sizes: string }) => i.sizes));
  assert.ok(sizes.has('192x192'), '192 icon');
  assert.ok(sizes.has('512x512'), '512 icon');
  assert.ok(m.icons.some((i: { purpose?: string }) => (i.purpose || '').includes('maskable')), 'maskable icon');
});

test('service worker leaves /v1 and /ws alone', () => {
  const sw = readFileSync(path.join(pub, 'sw.js'), 'utf8');
  assert.match(sw, /\/v1/);
  assert.match(sw, /\/ws/);
  assert.match(sw, /addEventListener\('fetch'/);
});

test('controller serves manifest + SW with installable MIME and no-cache', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ccc-pwa-'));
  try {
    mkdirSync(path.join(dir, 'icons'));
    writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>t</title>');
    writeFileSync(path.join(dir, 'sw.js'), '/* sw */');
    writeFileSync(path.join(dir, 'manifest.webmanifest'), '{"name":"t","display":"standalone"}');
    writeFileSync(path.join(dir, 'icons', 'icon-192.png'), 'png');
    const server = await createControllerServer({ staticDir: dir });
    try {
      const sw = await fetch(`${server.baseUrl}/sw.js`);
      assert.equal(sw.status, 200);
      assert.match(sw.headers.get('content-type') || '', /javascript/);
      assert.match(sw.headers.get('cache-control') || '', /no-cache/);
      assert.equal(await sw.text(), '/* sw */');

      const man = await fetch(`${server.baseUrl}/manifest.webmanifest`);
      assert.equal(man.status, 200);
      assert.match(man.headers.get('content-type') || '', /manifest\.json|json/);
      assert.match(man.headers.get('cache-control') || '', /no-cache/);
      assert.equal((await man.json()).display, 'standalone');

      const icon = await fetch(`${server.baseUrl}/icons/icon-192.png`);
      assert.equal(icon.status, 200);
      assert.match(icon.headers.get('content-type') || '', /png/);
    } finally {
      server.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
