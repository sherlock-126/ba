import { useState } from 'react';
import { api, type Me } from '../api';

export function Login({ onOk }: { onOk: (me: Me) => void }) {
  const [email, setEmail] = useState('');
  const [pw, setPw] = useState('');
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);

  async function submit() {
    setLoading(true); setErr('');
    try { const me = await api.login(email, pw); onOk(me); }
    catch (e: any) { setErr(e.message || 'Đăng nhập thất bại'); }
    finally { setLoading(false); }
  }

  return (
    <div className="flex h-full items-center justify-center bg-app px-4">
      <div className="w-full max-w-sm rounded-2xl border border-line bg-surface p-8 shadow-cardhover">
        <div className="mb-1 inline-flex h-11 w-11 items-center justify-center rounded-xl bg-brand text-xl font-extrabold text-white shadow-card">BA</div>
        <h1 className="mt-3 text-lg font-extrabold text-navy">BA Code Assistant</h1>
        <p className="mt-1 text-sm text-muted">Đăng nhập bằng tài khoản được cấp.</p>
        <input className="input mt-5 w-full" type="email" placeholder="Email" autoFocus autoComplete="username"
          value={email} onChange={(e) => setEmail(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') submit(); }} />
        <input className="input mt-2 w-full" type="password" placeholder="Mật khẩu" autoComplete="current-password"
          value={pw} onChange={(e) => setPw(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') submit(); }} />
        {err && <div className="mt-2 text-xs text-red-600">{err}</div>}
        <button className="btn-primary mt-4 w-full" disabled={loading || !email || !pw} onClick={submit}>
          {loading ? 'Đang vào…' : 'Đăng nhập'}
        </button>
      </div>
    </div>
  );
}
