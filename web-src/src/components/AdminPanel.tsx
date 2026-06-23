import { useEffect, useState } from 'react';
import { api, type AdminUser, type AuditEntry } from '../api';
import { fmtRelative } from '../time';

const ACTION_LABEL: Record<string, string> = {
  login: 'Đăng nhập', login_failed: 'Đăng nhập thất bại', logout: 'Đăng xuất',
  create_user: 'Tạo user', update_user: 'Sửa user', delete_user: 'Xoá user',
  reset_password: 'Reset mật khẩu', change_own_password: 'Đổi mật khẩu', chat: 'Hỏi chatbot',
};

export function AdminPanel({ meId, onClose }: { meId: string; onClose: () => void }) {
  const [tab, setTab] = useState<'users' | 'audit'>('users');
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [err, setErr] = useState('');
  // form thêm user
  const [email, setEmail] = useState(''); const [pw, setPw] = useState(''); const [role, setRole] = useState<'admin' | 'member'>('member');

  const loadUsers = () => api.listUsers().then(setUsers).catch((e) => setErr(e.message));
  const loadAudit = () => api.listAudit().then(setAudit).catch((e) => setErr(e.message));
  useEffect(() => { loadUsers(); }, []);
  useEffect(() => { if (tab === 'audit') loadAudit(); }, [tab]);

  async function addUser() {
    setErr('');
    try { await api.createUser(email, pw, role); setEmail(''); setPw(''); setRole('member'); loadUsers(); }
    catch (e: any) { setErr(e.message); }
  }
  const act = async (fn: () => Promise<any>) => { setErr(''); try { await fn(); loadUsers(); } catch (e: any) { setErr(e.message); } };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 pt-12" onClick={onClose}>
      <div className="flex max-h-[85vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-cardhover" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 border-b border-line px-4 py-3">
          <b className="text-navy">Quản trị</b>
          <button className={`rounded px-2 py-1 text-xs ${tab === 'users' ? 'bg-brand/10 text-brand-dark' : 'text-muted'}`} onClick={() => setTab('users')}>Người dùng</button>
          <button className={`rounded px-2 py-1 text-xs ${tab === 'audit' ? 'bg-brand/10 text-brand-dark' : 'text-muted'}`} onClick={() => setTab('audit')}>Nhật ký</button>
          <button className="ml-auto text-muted hover:text-ink" onClick={onClose}>✕</button>
        </div>
        {err && <div className="border-b border-line bg-red-50 px-4 py-2 text-xs text-red-600">{err}</div>}

        {tab === 'users' ? (
          <div className="overflow-auto p-4">
            <div className="mb-4 flex flex-wrap items-end gap-2 rounded-lg border border-line bg-app/60 p-3">
              <input className="input flex-1" type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
              <input className="input w-40" type="text" placeholder="Mật khẩu tạm" value={pw} onChange={(e) => setPw(e.target.value)} />
              <select className="input" value={role} onChange={(e) => setRole(e.target.value as any)}>
                <option value="member">Thành viên</option><option value="admin">Admin</option>
              </select>
              <button className="btn-primary" disabled={!email || !pw} onClick={addUser}>+ Thêm</button>
            </div>
            <table className="w-full text-sm">
              <thead><tr className="border-b border-line text-left text-[11px] uppercase text-muted">
                <th className="py-1.5">Email</th><th>Vai trò</th><th>Trạng thái</th><th>Đăng nhập cuối</th><th></th>
              </tr></thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id} className="border-b border-line/60">
                    <td className="py-2">{u.email}{u.id === meId && <span className="ml-1 text-[10px] text-muted">(bạn)</span>}</td>
                    <td><span className={`rounded px-1.5 py-0.5 text-[11px] ${u.role === 'admin' ? 'bg-brand/10 text-brand-dark' : 'bg-slate-100 text-muted'}`}>{u.role === 'admin' ? 'Admin' : 'Thành viên'}</span></td>
                    <td>{u.active ? <span className="text-green-600">Hoạt động</span> : <span className="text-red-600">Đã khoá</span>}</td>
                    <td className="text-[11px] text-muted">{u.lastLoginAt ? fmtRelative(u.lastLoginAt) : 'chưa'}</td>
                    <td className="text-right text-[11px]">
                      {u.id !== meId && (
                        <div className="flex justify-end gap-2">
                          <button className="text-muted hover:text-brand-dark" onClick={() => act(() => api.updateUser(u.id, { active: !u.active }))}>{u.active ? 'Khoá' : 'Mở'}</button>
                          <button className="text-muted hover:text-brand-dark" onClick={() => act(() => api.updateUser(u.id, { role: u.role === 'admin' ? 'member' : 'admin' }))}>{u.role === 'admin' ? '↓Member' : '↑Admin'}</button>
                          <button className="text-muted hover:text-brand-dark" onClick={() => { const p = prompt('Mật khẩu mới cho ' + u.email); if (p) act(() => api.resetPassword(u.id, p)); }}>Reset MK</button>
                          <button className="text-muted hover:text-red-600" onClick={() => { if (confirm('Xoá ' + u.email + '?')) act(() => api.deleteUser(u.id)); }}>Xoá</button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="overflow-auto p-4">
            <table className="w-full text-[12px]">
              <thead><tr className="border-b border-line text-left text-[11px] uppercase text-muted">
                <th className="py-1.5">Thời gian</th><th>Ai</th><th>Hành động</th><th>Chi tiết</th>
              </tr></thead>
              <tbody>
                {audit.map((e, i) => (
                  <tr key={i} className="border-b border-line/60 align-top">
                    <td className="whitespace-nowrap py-1.5 text-muted" title={new Date(e.ts).toLocaleString('vi-VN')}>{fmtRelative(e.ts)}</td>
                    <td className="whitespace-nowrap pr-2">{e.actorEmail}</td>
                    <td className="whitespace-nowrap pr-2 font-medium">{ACTION_LABEL[e.action] || e.action}</td>
                    <td className="text-muted">{e.target ? <b className="text-ink">{e.target}</b> : ''} {e.detail || ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!audit.length && <div className="py-4 text-center text-xs text-muted">Chưa có nhật ký.</div>}
          </div>
        )}
      </div>
    </div>
  );
}
