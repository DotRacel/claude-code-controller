/**
 * control-cli.test.ts — the CLI contract of `control-claude-code`: interactive by default and
 * every unknown argument forwarded to claude verbatim (order preserved).
 * Run: node --test test/control-cli.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, withDebugFlag } from '../src/control-cli.ts';

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
