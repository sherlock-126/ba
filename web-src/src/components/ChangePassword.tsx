import { useState } from 'react';
import { api } from '../api';

export function ChangePassword({ forced, onDone, onCancel }: { forced?: boolean; onDone: () => void; onCancel?: () => void }) {
  const [oldPw, setOldPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [confirm, setConfirm] = useState('');
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);

  async function submit() {
    if (newPw.length < 6) return setErr('Mật khẩu mới tối thiểu 6 ký tự');
    if (newPw !== confirm) return setErr('Xác nhận mật khẩu không khớp');
    setLoading(true); setErr('');
    try { await api.changePassword(oldPw, newPw); onDone(); }
    catch (e: any) { setErr(e.message || 'Lỗi'); }
    finally { setLoading(false); }
  }

  const body = (
    <div className="w-full max-w-sm rounded-2xl border border-line bg-surface p-8 shadow-cardhover">
      <h1 className="text-lg font-extrabold text-navy">{forced ? 'Đổi mật khẩu lần đầu' : 'Đổi mật khẩu'}</h1>
      <p className="mt-1 text-sm text-muted">{forced ? 'Vì lý do bảo mật, hãy đặt mật khẩu mới của riêng bạn.' : ''}</p>
      <input className="input mt-4 w-full" type="password" placeholder="Mật khẩu hiện tại" value={oldPw} onChange={(e) => setOldPw(e.target.value)} />
      <input className="input mt-2 w-full" type="password" placeholder="Mật khẩu mới (≥ 6 ký tự)" value={newPw} onChange={(e) => setNewPw(e.target.value)} />
      <input className="input mt-2 w-full" type="password" placeholder="Nhập lại mật khẩu mới" value={confirm} onChange={(e) => setConfirm(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') submit(); }} />
      {err && <div className="mt-2 text-xs text-red-600">{err}</div>}
      <div className="mt-4 flex gap-2">
        <button className="btn-primary flex-1" disabled={loading || !oldPw || !newPw} onClick={submit}>{loading ? 'Đang lưu…' : 'Lưu mật khẩu'}</button>
        {!forced && onCancel && <button className="btn-ghost" onClick={onCancel}>Huỷ</button>}
      </div>
    </div>
  );

  if (forced) return <div className="flex h-full items-center justify-center bg-app px-4">{body}</div>;
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4" onClick={onCancel}><div onClick={(e) => e.stopPropagation()}>{body}</div></div>;
}
