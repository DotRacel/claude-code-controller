/**
 * auth.ts — the account REST calls (see /v1/auth/* in src/server/index.ts).
 *
 * A token is issued once at registration and never rotates, so "logging in" is really just
 * fetching the token again — which is why the same value can be pasted into a second device.
 */

export interface Account {
  token: string;
  username: string;
}

/** Carries the server's own message: it already explains the failure, in the user's language. */
export class AuthError extends Error {
  constructor(message: string, readonly type: string) { super(message); }
}

const FALLBACK: Record<string, string> = {
  registration_closed: '服务端未开放注册',
  bad_invite_code: '邀请码不正确',
  bad_username: '用户名不符合要求',
  weak_password: '密码太短',
  username_taken: '用户名已被占用',
  bad_credentials: '用户名或密码错误',
  too_many_attempts: '尝试次数过多，请稍后再试',
};

async function post(path: string, body: unknown): Promise<Account> {
  let r: Response;
  try {
    r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  } catch {
    throw new AuthError('连不上服务器，检查网络后重试', 'network');
  }
  const data = await r.json().catch(() => ({} as any));
  if (!r.ok) {
    const type = data?.error?.type ?? 'unknown';
    throw new AuthError(data?.error?.message || FALLBACK[type] || `请求失败（${r.status}）`, type);
  }
  return { token: String(data.token), username: String(data.username) };
}

export const register = (username: string, password: string, inviteCode: string): Promise<Account> =>
  post('/v1/auth/register', { username, password, invite_code: inviteCode });

export const login = (username: string, password: string): Promise<Account> =>
  post('/v1/auth/login', { username, password });

/**
 * Is this token still good?
 *
 * The three outcomes are deliberately distinct: a 401 means the token is dead and the user must
 * log in again, but a network failure means we simply cannot tell — and kicking someone back to
 * the login screen because the server was briefly unreachable would lose a perfectly good
 * session. Only 'rejected' clears the cookie.
 */
export async function checkToken(token: string): Promise<{ status: 'ok'; username: string } | { status: 'rejected' } | { status: 'unreachable' }> {
  try {
    const r = await fetch('/v1/auth/me', { headers: { Authorization: `Bearer ${token}` } });
    if (r.status === 401) return { status: 'rejected' };
    if (!r.ok) return { status: 'unreachable' };
    const data = await r.json().catch(() => ({} as any));
    return { status: 'ok', username: String(data.username ?? '') };
  } catch {
    return { status: 'unreachable' };
  }
}
