/**
 * AuthGate.tsx — register / log in, and hand the App the account token.
 *
 * The token IS the credential (凭证A) the websocket connects with, so a successful login here
 * replaces what used to be "paste the string the CLI printed". Pasting is still available as a
 * third mode: moving to a second device is legitimately faster that way, and the token is
 * verified against /v1/auth/me before it is stored either way.
 */
import { useState, type FormEvent } from 'react';
import { register, login, checkToken, AuthError, type Account } from '../auth.ts';
import { ClaudeMark } from '../icons.tsx';

type Mode = 'login' | 'register' | 'token';

export function AuthGate({ onAuthed }: { onAuthed: (a: Account) => void }) {
  const [mode, setMode] = useState<Mode>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [invite, setInvite] = useState('');
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const ready = mode === 'token'
    ? token.trim().length > 0
    : username.trim().length > 0 && password.length > 0 && (mode === 'login' || invite.trim().length > 0);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setError('');
    try {
      if (mode === 'token') {
        const t = token.trim();
        const check = await checkToken(t);
        if (check.status === 'ok') onAuthed({ token: t, username: check.username });
        else setError(check.status === 'rejected' ? '这个密钥无效或已失效' : '连不上服务器，检查网络后重试');
      } else if (mode === 'login') {
        onAuthed(await login(username.trim(), password));
      } else {
        onAuthed(await register(username.trim(), password, invite.trim()));
      }
    } catch (err) {
      setError(err instanceof AuthError ? err.message : '出错了，请重试');
    } finally {
      setBusy(false);
    }
  }

  const switchTo = (m: Mode) => { setMode(m); setError(''); };

  return (
    <div className="center-screen">
      <form className="panel" onSubmit={submit}>
        <div className="logo-mark"><ClaudeMark size={34} fill="#fefcfb" /></div>
        <h1>Claude Remote</h1>

        <div className="auth-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={mode === 'login'}
            className={mode === 'login' ? 'on' : ''} onClick={() => switchTo('login')}>登录</button>
          <button type="button" role="tab" aria-selected={mode === 'register'}
            className={mode === 'register' ? 'on' : ''} onClick={() => switchTo('register')}>注册</button>
        </div>

        {mode === 'token' ? (
          <>
            <p>粘贴账号密钥直接连接。</p>
            <input className="cred-input" placeholder="ccc_…" value={token} autoFocus
              onChange={(e) => setToken(e.target.value)}
              autoCapitalize="off" autoCorrect="off" spellCheck={false} />
          </>
        ) : (
          <>
            <input className="cred-input text" placeholder="用户名" value={username}
              onChange={(e) => setUsername(e.target.value)} autoComplete="username"
              autoCapitalize="off" autoCorrect="off" spellCheck={false} />
            <input className="cred-input text" type="password" placeholder="密码" value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'} />
            {mode === 'register' && (
              <input className="cred-input text" placeholder="邀请码" value={invite}
                onChange={(e) => setInvite(e.target.value)}
                autoCapitalize="off" autoCorrect="off" spellCheck={false} />
            )}
          </>
        )}

        {error && <p className="auth-error" role="alert">{error}</p>}

        <button className="btn primary block" type="submit" disabled={!ready || busy}>
          {busy ? '请稍候…' : mode === 'register' ? '注册并连接' : '连接'}
        </button>

        <button type="button" className="auth-alt" onClick={() => switchTo(mode === 'token' ? 'login' : 'token')}>
          {mode === 'token' ? '用账号密码登录' : '使用密钥连接'}
        </button>

        {mode === 'register' && <p>注册需要邀请码，向服务器管理员索取。</p>}
      </form>
    </div>
  );
}
