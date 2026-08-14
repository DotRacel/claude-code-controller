#!/usr/bin/env -S node
/**
 * control-cli.ts — `control-claude-code`: launch a gate-rebound `claude remote-control`
 * whose bridge (control-plane + data-plane) points at the hosted central server, owned by
 * the user's credential (凭证A). No local server, no in-process conversation — the phone
 * drives it over the web. Keeps claude alive until Ctrl-C.
 *
 * Usage:
 *   control-claude-code [--credential <A>] [--server <url>] [--cwd <dir>]
 *   env: CCC_CREDENTIAL, CCC_SERVER, CLAUDE_BIN
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { launchWithGatesRebound, launchInteractiveWithGatesRebound } from './injector/gate-rebind.ts';

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) out[a.slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
  }
  return out;
}

function loadOrCreateCredential(explicit?: string): { credential: string; generated: boolean; file: string } {
  const dir = path.join(os.homedir(), '.config', 'claude-code-controller');
  const file = path.join(dir, 'credential');
  if (explicit) return { credential: explicit, generated: false, file };
  if (fs.existsSync(file)) return { credential: fs.readFileSync(file, 'utf8').trim(), generated: false, file };
  const credential = 'ccc_' + crypto.randomBytes(24).toString('base64url');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, credential, { mode: 0o600 });
  return { credential, generated: true, file };
}

const ts = () => new Date().toISOString().slice(11, 23);

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const serverUrl = (args.server || process.env.CCC_SERVER || 'http://127.0.0.1:8787').replace(/\/+$/, '');
  const cwd = args.cwd || process.cwd();
  const claudeBin = args['claude-bin'] || process.env.CLAUDE_BIN || 'claude';
  const { credential, generated, file } = loadOrCreateCredential(args.credential || process.env.CCC_CREDENTIAL);

  if (generated) {
    console.log(`\n🔑 Generated a new credential (saved to ${file}):\n\n    ${credential}\n\n   Enter it in the web app to see this machine's sessions. Keep it safe — losing it loses access.\n`);
  }
  const interactive = args.interactive === 'true' || process.argv.slice(2).includes('-i');
  if (interactive) return runInteractive({ claudeBin, cwd, serverUrl, credential });

  console.log(`${ts()} control-claude-code → ${serverUrl}  cred=${credential.slice(0, 10)}…  cwd=${cwd}`);
  const h = await launchWithGatesRebound({
    claudeBin,
    cwd,
    bridgeBaseUrl: serverUrl,
    bridgeToken: credential,
    log: (m) => process.env.CCC_VERBOSE && console.log(`${ts()} ${m}`),
    onStderr: (s) => process.stderr.write(`\x1b[2m[claude] ${s}\x1b[0m`),
  });

  console.log(`${ts()} claude remote-control launched — bridge redirected to your server.`);
  console.log(`${ts()} Open the web app on your phone, enter the credential, and your session will appear. Ctrl-C to stop.`);

  const stop = () => { try { h.kill(); } catch {} process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  // Keep the process alive; exit if claude dies.
  const iv = setInterval(() => { if (h.isDead()) { console.log(`${ts()} claude exited.`); clearInterval(iv); process.exit(0); } }, 1000);
}

/**
 * Interactive mode (`-i` / `--interactive`): launch the claude TUI with the `/rc` gates
 * rebound. The user works normally; when they want remote control they type `/rc`, the REPL
 * bridge connects our server, and the session appears on their phone. The TUI owns the
 * terminal (stdio inherit), so injector logs go to a file and we don't intercept Ctrl-C.
 */
async function runInteractive(o: { claudeBin: string; cwd: string; serverUrl: string; credential: string }) {
  const logFile = path.join(os.tmpdir(), 'ccc-interactive.log');
  const log = (m: string) => { try { fs.appendFileSync(logFile, `${ts()} ${m}\n`); } catch {} };
  console.log(`${ts()} 启动交互式 claude + 注入 remote control 支持…  bridge → ${o.serverUrl}  cred=${o.credential.slice(0, 10)}…`);
  console.log(`${ts()} 注入日志: ${logFile}`);
  const dbgFile = '/tmp/ccc-claude-debug.log';
  if (process.env.CCC_CLAUDE_DEBUG) { try { fs.writeFileSync(dbgFile, ''); } catch {} }
  const h = await launchInteractiveWithGatesRebound({
    claudeBin: o.claudeBin,
    cwd: o.cwd,
    bridgeBaseUrl: o.serverUrl,
    bridgeToken: o.credential,
    stdio: 'inherit',
    extraArgs: process.env.CCC_CLAUDE_DEBUG ? ['--debug'] : [],
    log,
    onStderr: process.env.CCC_CLAUDE_DEBUG ? (s) => { try { fs.appendFileSync(dbgFile, s); } catch {} } : undefined,
  });
  const okN = h.reports.filter((r) => r.located).length;
  console.log(`${ts()} 就绪 — ${okN}/${h.reports.length} gates rebound。进入 claude；需要远程时输入 \x1b[1m/rc\x1b[0m，会话即出现在手机上。\n`);
  // The TUI now owns the terminal. Don't intercept Ctrl-C — let claude handle it; we exit when it does.
  process.on('SIGINT', () => {});
  await new Promise<void>((resolve) => {
    const iv = setInterval(() => { if (h.isDead()) { clearInterval(iv); resolve(); } }, 500);
  });
  console.log(`\n${ts()} claude 已退出。`);
  process.exit(0);
}

main().catch((e) => { console.error('[control-cli] fatal:', e); process.exit(1); });
