/**
 * attach.ts — spawn `claude` with the Bun inspector open and attach an InspectorClient.
 *
 * Ported/adapted from cc-injector (src/inspector/attach.js), minus the PTY/TUI path.
 * Stable orchestration: pick a free port, spawn with BUN_INSPECT set, wait for the
 * debugger port, connect, and enable Runtime/Debugger with breakpoints armed (JSC leaves
 * breakpoints inert until `setBreakpointsActive`).
 *
 * Empirically (cc-injector + our own probes): the `--inspect` FLAG is rejected by the
 * compiled binary; the BUN_INSPECT env var opens the channel; SIGUSR1 kills the process
 * (so there is no attach-to-running); `?wait=1` blocks the whole app with no JSC release
 * — so we never use it and rely on breakpoint-pause for timing instead.
 */
import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { InspectorClient } from './ws-client.ts';

export const DEFAULT_CLAUDE = process.env.CLAUDE_BIN || 'claude';
const BUN_INSPECT_ENV = 'BUN_INSPECT';

/** pid → its direct children, from a single /proc scan (Linux). */
function childMap(): Map<number, number[]> {
  const byParent = new Map<number, number[]>();
  let names: string[];
  try { names = fs.readdirSync('/proc'); } catch { return byParent; }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = fs.readFileSync(`/proc/${name}/stat`, 'utf8');
      // `comm` can contain spaces and parens, so parse after the LAST ')': state ppid …
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      const ppid = Number(fields[1]);
      if (!Number.isFinite(ppid)) continue;
      const arr = byParent.get(ppid) ?? [];
      arr.push(Number(name));
      byParent.set(ppid, arr);
    } catch { /* process vanished mid-scan */ }
  }
  return byParent;
}

/**
 * Kill the child AND every process it spawned.
 *
 * `claude remote-control` forks a worker claude (`--print --sdk-url …`) as a GRANDCHILD. Killing
 * only the direct child orphans that worker (PPID→1, verified), and it then retries a dead
 * --sdk-url forever holding ~370MB — ten of them piled up in one day of testing.
 *
 * Why walk /proc instead of using a process group: the worker inherits whatever group it was
 * spawned in, which is the CALLER's — so `kill(-pid)` would take out the user's own shell/tmux
 * window. `detached: true` would fix that but moves the child out of the caller's group entirely,
 * which makes the SIGKILL-the-host case (where no cleanup code can run at all) leak more reliably
 * than before. Snapshotting the tree costs one /proc scan and has neither problem.
 *
 * The snapshot must be taken BEFORE anything dies: once an intermediate process exits, its
 * children are re-parented to init and unreachable from `root`. Deepest-first for the same reason.
 */
export function killTree(child: ChildProcess, signal: NodeJS.Signals = 'SIGKILL'): void {
  const root = child.pid;
  if (!root) { try { child.kill(signal); } catch {} return; }
  const tree = childMap();
  const descendants: number[] = [];
  const walk = (p: number) => { for (const c of tree.get(p) ?? []) { descendants.push(c); walk(c); } };
  walk(root);
  for (const p of descendants.reverse()) { try { process.kill(p, signal); } catch {} }
  try { child.kill(signal); } catch {}
}

/**
 * killTree + a net for hosts that exit without calling it (a test script that just returns).
 * Cannot help when the host itself is SIGKILLed — nothing can.
 */
export function treeKiller(child: ChildProcess, isDead: () => boolean): () => void {
  const onHostExit = () => { if (!isDead()) killTree(child); };
  process.once('exit', onHostExit);
  return () => {
    process.removeListener('exit', onHostExit);
    if (!isDead()) killTree(child);
  };
}

export function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

export function waitForPort(port: number, host: string, timeoutMs: number, isDead: () => boolean = () => false): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      if (isDead()) return reject(new Error('claude exited before the inspector port opened'));
      const s = net.connect({ port, host }, () => { s.destroy(); resolve(); });
      s.on('error', () => {
        s.destroy();
        Date.now() > deadline ? reject(new Error(`inspector port ${port} never opened`)) : setTimeout(tryOnce, 80);
      });
    };
    tryOnce();
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface AttachHandle {
  ic: InspectorClient;
  child: ChildProcessWithoutNullStreams;
  ws: string;
  port: number;
  kill: () => void;
  isDead: () => boolean;
}

export interface LaunchOpts {
  claudeBin?: string;
  args?: string[];
  env?: Record<string, string | undefined>;
  cwd?: string;
  timeoutMs?: number;
  attempts?: number;
  onStdout?: (b: Buffer) => void;
  onStderr?: (b: Buffer) => void;
  /** enable Debugger domain + arm breakpoints (default true). */
  debugger?: boolean;
}

/**
 * Launch claude + attach an InspectorClient with Runtime (and optionally Debugger)
 * enabled. `args` is the full claude argv (e.g. ['-p','--input-format','stream-json']
 * for an idle host, or ['remote-control'] for the bridge).
 */
export async function launchAndAttach(opts: LaunchOpts = {}): Promise<AttachHandle> {
  const {
    claudeBin = DEFAULT_CLAUDE,
    args = [],
    env = {},
    cwd,
    timeoutMs = 20000,
    attempts = 3,
    onStdout,
    onStderr,
    debugger: enableDebugger = true,
  } = opts;

  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const port = await getFreePort();
    const token = '/cc-' + crypto.randomBytes(6).toString('hex');
    const wsUrl = `ws://127.0.0.1:${port}${token}`;
    const launchEnv = { ...process.env, ...env, [BUN_INSPECT_ENV]: wsUrl };

    const child = spawn(claudeBin, args, { env: launchEnv as NodeJS.ProcessEnv, cwd, stdio: ['pipe', 'pipe', 'pipe'] }) as ChildProcessWithoutNullStreams;
    let dead = false;
    child.on('exit', () => { dead = true; });
    if (onStdout) child.stdout.on('data', onStdout);
    if (onStderr) child.stderr.on('data', onStderr);
    const kill = treeKiller(child, () => dead); // takes any worker grandchild with it

    try {
      await waitForPort(port, '127.0.0.1', timeoutMs, () => dead);
      const ic = new InspectorClient();
      await ic.connect(wsUrl, { timeout: 8000 });
      await ic.send('Runtime.enable', {});
      if (enableDebugger) {
        await ic.send('Debugger.enable', {});
        await ic.send('Debugger.setBreakpointsActive', { active: true }); // JSC: inert until armed
      }
      return { ic, child, ws: wsUrl, port, kill, isDead: () => dead };
    } catch (e) {
      lastErr = e;
      kill();
      if (attempt < attempts) await sleep(150);
    }
  }
  throw lastErr;
}
