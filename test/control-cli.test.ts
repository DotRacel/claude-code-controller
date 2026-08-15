/**
 * control-cli.test.ts — the CLI contract of `control-claude`: interactive by default and
 * every unknown argument forwarded to claude verbatim (order preserved).
 * Run: node --test test/control-cli.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, withDebugFlag, alignProcessTitle } from '../src/control-cli.ts';
import { normalizeUrl } from '../src/cli-auth.ts';

test('interactive is the default; --headless opts out; -i stays accepted', () => {
  assert.equal(parseArgs([]).headless, false);
  assert.equal(parseArgs(['--headless']).headless, true);
  assert.equal(parseArgs(['--no-interactive']).headless, true);
  assert.equal(parseArgs(['--headless', '--interactive']).headless, false);
  const compat = parseArgs(['-i', '--server', 'http://x']);
  assert.equal(compat.headless, false);
  assert.deepEqual(compat.claudeArgs, []); // -i is consumed, not forwarded
});

test('controller flags are consumed; everything else goes to claude in order', () => {
  const cli = parseArgs(['--resume', '--server', 'http://h:1/', '--model', 'opus', '--cwd', '/tmp', 'fix the bug']);
  assert.equal(cli.server, 'http://h:1/');
  assert.equal(cli.cwd, '/tmp');
  assert.deepEqual(cli.claudeArgs, ['--resume', '--model', 'opus', 'fix the bug']);
});

test('--flag=value form works for controller flags', () => {
  const cli = parseArgs(['--log-dir=/var/log/ccc', '--credential=ccc_abc', '--claude-bin=/opt/claude', '-c']);
  assert.equal(cli.logDir, '/var/log/ccc');
  assert.equal(cli.credential, 'ccc_abc');
  assert.equal(cli.claudeBin, '/opt/claude');
  assert.deepEqual(cli.claudeArgs, ['-c']);
});

test('claude args that collide with our names pass through after --', () => {
  const cli = parseArgs(['--server', 'http://h', '--', '--help', '--server', 'x']);
  assert.equal(cli.server, 'http://h');
  assert.equal(cli.help, false);
  assert.deepEqual(cli.claudeArgs, ['--help', '--server', 'x']);
});

test('-h/--help before -- is ours', () => {
  assert.equal(parseArgs(['--help']).help, true);
  assert.equal(parseArgs(['-h']).help, true);
});

// tmux/screen name the window after the foreground process group's argv[0], which is this host,
// not the claude child — so the host must wear claude's name for `#W` to track claude.
test('alignProcessTitle renames the host to claude, and CCC_NO_PROCESS_TITLE opts out', () => {
  const prevEnv = process.env.CCC_NO_PROCESS_TITLE;
  const prevTitle = process.title;
  try {
    delete process.env.CCC_NO_PROCESS_TITLE;
    assert.equal(alignProcessTitle(), 'claude');
    assert.equal(process.title, 'claude');

    process.title = 'ccc-test-host';
    process.env.CCC_NO_PROCESS_TITLE = '1';
    assert.equal(alignProcessTitle(), 'ccc-test-host');
    assert.equal(process.title, 'ccc-test-host'); // untouched
  } finally {
    if (prevEnv === undefined) delete process.env.CCC_NO_PROCESS_TITLE;
    else process.env.CCC_NO_PROCESS_TITLE = prevEnv;
    process.title = prevTitle;
  }
});

test('withDebugFlag only adds --debug under CCC_CLAUDE_DEBUG, and never twice', () => {
  const prev = process.env.CCC_CLAUDE_DEBUG;
  try {
    delete process.env.CCC_CLAUDE_DEBUG;
    assert.deepEqual(withDebugFlag(['-c']), ['-c']);
    process.env.CCC_CLAUDE_DEBUG = '1';
    assert.deepEqual(withDebugFlag(['-c']), ['-c', '--debug']);
    assert.deepEqual(withDebugFlag(['--debug']), ['--debug']);
  } finally {
    if (prev === undefined) delete process.env.CCC_CLAUDE_DEBUG;
    else process.env.CCC_CLAUDE_DEBUG = prev;
  }
});

test('an explicitly typed scheme is never rewritten', () => {
  assert.equal(normalizeUrl('http://ccc.racel.dev'), 'http://ccc.racel.dev');
  assert.equal(normalizeUrl('https://192.168.1.10:8787'), 'https://192.168.1.10:8787');
  assert.equal(normalizeUrl('HTTP://ccc.racel.dev'), 'HTTP://ccc.racel.dev');
  assert.equal(normalizeUrl('  https://ccc.racel.dev/  '), 'https://ccc.racel.dev');
});

test('a bare hostname gets https; anything that smells like the LAN gets http', () => {
  assert.equal(normalizeUrl('ccc.racel.dev'), 'https://ccc.racel.dev');
  assert.equal(normalizeUrl('ccc.racel.dev:8443'), 'https://ccc.racel.dev:8443');
  assert.equal(normalizeUrl('ccc.racel.dev/'), 'https://ccc.racel.dev');

  assert.equal(normalizeUrl('localhost:8787'), 'http://localhost:8787');
  assert.equal(normalizeUrl('192.168.1.10:8787'), 'http://192.168.1.10:8787');
  assert.equal(normalizeUrl('127.0.0.1'), 'http://127.0.0.1');
  assert.equal(normalizeUrl('[::1]:8787'), 'http://[::1]:8787');
  assert.equal(normalizeUrl('nas:8787'), 'http://nas:8787'); // no dot — a LAN box, not a domain
  assert.equal(normalizeUrl('mac.local:8787'), 'http://mac.local:8787'); // mDNS
});

test('normalizeUrl leaves empty input alone (the caller treats it as "not answered")', () => {
  assert.equal(normalizeUrl(''), '');
  assert.equal(normalizeUrl('   '), '');
});
