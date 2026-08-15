/**
 * cli-auth.ts — which server control-claude-code talks to, and as whom.
 *
 * A credential (凭证A) is now an account's server-issued token, so the CLI can no longer just
 * generate one: it has to log in and be given one. This file owns the config file that
 * remembers the answer, and the TUI flow that obtains it when it is missing.
 *
 * The config replaces the old single-line `credential` file, because one token is no longer the
 * whole story — a token belongs to a specific backend, and the same machine may talk to more
 * than one (the shared LAN server, a laptop running its own).
 *
 *   ~/.config/claude-code-controller/config.json  (0600)
 *   { "current": "http://…", "backends": [{ "url": "http://…", "token": "ccc_…", "username": "…" }] }
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { select, input, note, fail, heading, closePrompts, Cancelled } from './tui.ts';

export const CONFIG_DIR = path.join(os.homedir(), '.config', 'claude-code-controller');
export const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
/** Pre-2.0 layout: a bare, self-generated credential. Useless under account auth. */
export const LEGACY_CREDENTIAL_FILE = path.join(CONFIG_DIR, 'credential');

/**
 * The backend a fresh install points at: the hosted controller. Self-hosters pick
 * 「添加新后端…」 once and their server is remembered in the config from then on.
 */
export const DEFAULT_BACKEND = 'https://ccc.racel.dev';

export interface Backend {
  url: string;
  token?: string;
  username?: string;
}
export interface CliConfig {
  current?: string;
  backends: Backend[];
}

/**
 * Which scheme to assume for an address typed without one. A routable hostname is behind TLS
 * essentially always; an IP literal, `localhost`, a bare hostname, or an mDNS `.local` name is a
 * box on the LAN that almost never has a certificate. Guessing https for the first group is what
 * makes `ccc.racel.dev` work when typed bare.
 */
function schemeFor(authority: string): 'http' | 'https' {
  const host = authority.split('/')[0].replace(/:\d+$/, '').toLowerCase();
  if (host.startsWith('[')) return 'http'; // [::1], [fe80::1] — an IPv6 literal is a LAN address
  if (host === 'localhost' || host.endsWith('.localhost')) return 'http';
  if (/^\d+(\.\d+){3}$/.test(host)) return 'http'; // IPv4
  if (!host.includes('.')) return 'http'; // bare hostname, e.g. `nas:8787`
  if (host.endsWith('.local')) return 'http'; // mDNS
  return 'https';
}

/**
 * Trailing slashes and a missing scheme are the two ways a hand-typed URL fails to match.
 * An explicit scheme is always honoured — we only guess when the user left it out.
 */
export function normalizeUrl(raw: string): string {
  const s = raw.trim().replace(/\/+$/, '');
  if (!s) return s;
  return /^https?:\/\//i.test(s) ? s : `${schemeFor(s)}://${s}`;
}

export function loadConfig(): CliConfig {
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    const backends: Backend[] = Array.isArray(parsed?.backends)
      ? parsed.backends
        .filter((b: any) => b && typeof b.url === 'string')
        .map((b: any) => ({
          url: normalizeUrl(b.url),
          token: typeof b.token === 'string' && b.token ? b.token : undefined,
          username: typeof b.username === 'string' && b.username ? b.username : undefined,
        }))
      : [];
    return { current: typeof parsed?.current === 'string' ? normalizeUrl(parsed.current) : undefined, backends };
  } catch {
    return { backends: [] };
  }
}

export function saveConfig(config: CliConfig): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  // 0600: the file holds tokens, each of which is full access to that account's sessions.
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
}

export const findBackend = (config: CliConfig, url: string): Backend | undefined =>
  config.backends.find((b) => b.url === url);

/** Insert or update one backend's saved token, and make it the current one. */
export function rememberBackend(config: CliConfig, backend: Backend): CliConfig {
  const backends = config.backends.filter((b) => b.url !== backend.url);
  backends.unshift(backend);
  return { current: backend.url, backends };
}

export type TokenCheck =
  | { status: 'ok'; username: string }
  | { status: 'rejected' }
  | { status: 'unreachable'; reason: string };

/**
 * Ask the server whether a token is still good.
 *
 * 'rejected' and 'unreachable' must stay distinct: only the first means log in again. Treating
 * an unreachable server as a bad token would force a login every time the user opens their
 * laptop away from the LAN, and the token would still be perfectly valid.
 */
export async function checkToken(serverUrl: string, token: string, timeoutMs = 5000): Promise<TokenCheck> {
  try {
    const r = await fetch(`${serverUrl}/v1/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (r.status === 401) return { status: 'rejected' };
    if (!r.ok) return { status: 'unreachable', reason: `HTTP ${r.status}` };
    const body: any = await r.json().catch(() => ({}));
    return { status: 'ok', username: String(body?.username ?? '') };
  } catch (e: any) {
    return { status: 'unreachable', reason: e?.name === 'TimeoutError' ? '超时' : (e?.message ?? '连接失败') };
  }
}

/** POST /v1/auth/login. Returns the account's fixed token, or a message to show the user. */
export async function login(serverUrl: string, username: string, password: string): Promise<{ token: string; username: string } | { error: string }> {
  try {
    const r = await fetch(`${serverUrl}/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password }),
      signal: AbortSignal.timeout(15000),
    });
    const body: any = await r.json().catch(() => ({}));
    if (!r.ok) return { error: body?.error?.message || `登录失败（HTTP ${r.status}）` };
    return { token: String(body.token), username: String(body.username) };
  } catch (e: any) {
    return { error: `连不上服务器: ${e?.message ?? e}` };
  }
}

// ── the interactive flow ──

/**
 * Pick a backend, then make sure we hold a working token for it.
 *
 * Returns the resolved server + credential, or undefined if the user cancelled (Ctrl-C), which
 * the caller treats as "don't launch claude".
 */
export async function runLoginFlow(config: CliConfig, opts: { serverHint?: string } = {}): Promise<{ config: CliConfig; serverUrl: string; credential: string } | undefined> {
  try {
    const serverUrl = opts.serverHint ?? (await chooseBackend(config));
    const existing = findBackend(config, serverUrl);

    // A token we already hold is worth a round trip before asking for a password.
    if (existing?.token) {
      const check = await checkToken(serverUrl, existing.token);
      if (check.status === 'ok') {
        note(`已登录为 ${check.username || existing.username || '?'}`);
        return { config: rememberBackend(config, { ...existing, username: check.username || existing.username }), serverUrl, credential: existing.token };
      }
      if (check.status === 'unreachable') {
        // Offline but previously authenticated: the token is still the best answer we have.
        note(`连不上 ${serverUrl}（${check.reason}），沿用已保存的登录状态`);
        return { config: rememberBackend(config, existing), serverUrl, credential: existing.token };
      }
      fail('已保存的登录已失效，请重新登录');
    }

    const account = await obtainToken(serverUrl);
    if (!account) return undefined;
    return {
      config: rememberBackend(config, { url: serverUrl, token: account.token, username: account.username }),
      serverUrl,
      credential: account.token,
    };
  } catch (e) {
    if (e instanceof Cancelled) return undefined;
    throw e;
  } finally {
    // The non-TTY reader keeps stdin open; claude needs it back (and the process needs to exit).
    closePrompts();
  }
}

const ADD_NEW = Symbol('add-new');

async function chooseBackend(config: CliConfig): Promise<string> {
  const seen = new Set<string>();
  const choices: Array<{ value: string | typeof ADD_NEW; label: string; hint?: string }> = [];

  const push = (url: string, label: string, hint?: string) => {
    if (seen.has(url)) return;
    seen.add(url);
    choices.push({ value: url, label, hint });
  };

  push(DEFAULT_BACKEND, '默认后端', DEFAULT_BACKEND);
  for (const b of config.backends) push(b.url, b.username ? `${b.url}` : b.url, b.username ? `已登录 ${b.username}` : '未登录');
  choices.push({ value: ADD_NEW, label: '添加新后端…' });

  // Start on whatever is already in use, so Enter means "keep going as before".
  const current = config.current ?? DEFAULT_BACKEND;
  const initial = Math.max(0, choices.findIndex((c) => c.value === current));

  const picked = await select('选择后端', choices, initial);
  if (picked !== ADD_NEW) return picked as string;

  return await input('后端地址', {
    validate: (v) => {
      const url = normalizeUrl(v);
      if (!url) return '请输入地址，例如 ccc.racel.dev 或 192.168.1.10:8787（协议可省略）';
      try { new URL(url); } catch { return '地址格式不对'; }
      return undefined;
    },
  }).then(normalizeUrl);
}

/** Log in, or take a pasted token — either way the token is verified before it is saved. */
async function obtainToken(serverUrl: string): Promise<{ token: string; username: string } | undefined> {
  heading(`登录 ${serverUrl}`);
  for (;;) {
    const how = await select('登录方式', [
      { value: 'password' as const, label: '账号密码登录' },
      { value: 'token' as const, label: '直接输入 token', hint: 'ccc_…' },
    ]);

    if (how === 'password') {
      const username = await input('用户名', { validate: (v) => (v ? undefined : '用户名不能为空') });
      const password = await input('密码', { hidden: true, validate: (v) => (v ? undefined : '密码不能为空') });
      const result = await login(serverUrl, username, password);
      if ('token' in result) return result;
      fail(result.error);
      note('账号在 web 端注册（需要邀请码）');
      continue;
    }

    const token = await input('token', { validate: (v) => (v ? undefined : 'token 不能为空') });
    const check = await checkToken(serverUrl, token);
    if (check.status === 'ok') return { token, username: check.username };
    fail(check.status === 'rejected' ? '这个 token 无效或已失效' : `连不上服务器（${check.reason}）`);
  }
}

/**
 * The old `credential` file is a token this CLI generated for itself, which the server now
 * refuses. Say so once, when it is the only thing the user has — otherwise its silent failure
 * looks like the server being broken.
 */
export function legacyCredentialNotice(): string | undefined {
  if (fs.existsSync(CONFIG_FILE) || !fs.existsSync(LEGACY_CREDENTIAL_FILE)) return undefined;
  return `检测到旧的凭证文件 ${LEGACY_CREDENTIAL_FILE}\n  它是本机自行生成的，服务器现在只认账号签发的 token —— 请登录一次。`;
}
