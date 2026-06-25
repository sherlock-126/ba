import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type ConvMeta, type Status, type Me, type Project } from './api';
import { useKeyboardViewport } from './useKeyboardViewport';
import { fmtRelative } from './time';
import { useChat, type ChatTurn } from './useChat';
import { Login } from './components/Login';
import { Sidebar } from './components/Sidebar';
import { ChatPanel } from './components/ChatPanel';
import { ChangePassword } from './components/ChangePassword';
import { AdminPanel } from './components/AdminPanel';

export function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [adminOpen, setAdminOpen] = useState(false);
  const [changePw, setChangePw] = useState(false);
  const [userMenu, setUserMenu] = useState(false);
  const [convs, setConvs] = useState<ConvMeta[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false); // drawer trên mobile
  const [codeOpen, setCodeOpen] = useState(false); // popover thông tin mã nguồn
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProject, setActiveProject] = useState<string>('kientre'); // dự án đang chọn
  const [projMenu, setProjMenu] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useKeyboardViewport(rootRef); // ghim khung chat theo bàn phím (gọi vô điều kiện, an toàn khi ref null)

  const loadConvs = useCallback(() => { api.listConversations(activeProject).then(setConvs).catch(() => {}); }, [activeProject]);
  const loadStatus = useCallback(() => { api.status(activeProject).then(setStatus).catch(() => {}); }, [activeProject]);

  const chat = useChat(() => { loadConvs(); });

  useEffect(() => { api.me().then(setMe); }, []);
  const authed = !!me;
  useEffect(() => { if (authed) { loadStatus(); api.projects().then(setProjects).catch(() => {}); } }, [authed, loadStatus]);
  useEffect(() => { if (authed) loadConvs(); }, [authed, loadConvs]); // loadConvs đổi theo activeProject → tự reload lịch sử

  async function logout() { await api.logout().catch(() => {}); chat.reset(); setMe(null); }

  async function openConv(id: string) {
    const c = await api.getConversation(id);
    if (c.project && c.project !== activeProject) setActiveProject(c.project); // mở hội thoại cũ → về đúng dự án của nó
    const turns: ChatTurn[] = (c.messages || []).map((m) => ({ role: m.role, content: m.content, ts: m.ts, images: m.images, files: m.files, outFiles: m.outFiles }));
    chat.seed(id, turns);
    setActiveId(id);
  }
  function newConv() { chat.reset(); setActiveId(null); }
  function switchProject(key: string) {
    setProjMenu(false); setSidebarOpen(false);
    if (key === activeProject) return;
    setActiveProject(key); chat.reset(); setActiveId(null); // đổi dự án → khung chat mới (không lẫn ngữ cảnh)
  }
  async function delConv(id: string) {
    if (!window.confirm('Xoá hội thoại này? (không khôi phục được)')) return;
    await api.deleteConversation(id).catch(() => {});
    if (id === activeId) newConv();
    loadConvs();
  }
  // khi gửi tin nhắn đầu của hội thoại mới → cập nhật activeId theo conversationId hook tạo
  function handleSend(t: string, images?: string[], files?: { name: string; type: string; data: string }[]) {
    chat.send(t, images, activeProject, files).then(() => { if (chat.conversationId.current) setActiveId(chat.conversationId.current); loadConvs(); });
  }
  async function doRefresh() {
    setRefreshing(true);
    await api.refresh(activeProject).catch(() => {});
    await loadStatus();
    setRefreshing(false);
  }

  if (me === undefined) return <div className="flex h-full items-center justify-center text-muted">Đang tải…</div>;
  if (!me) return <Login onOk={setMe} />;
  if (me.mustChangePassword) return <ChangePassword forced onDone={() => api.me().then(setMe)} />;

  const head = status?.lastPull?.results?.map((r) => `${r.repo}@${r.ok ? r.short : '?'}`).join(' · ');

  return (
    <div ref={rootRef} className="fixed inset-x-0 top-0 flex h-[100dvh] flex-col">
      {/* Thanh brand trên cùng + chừa vùng tai thỏ (safe-area-inset-top) tô màu brand */}
      <div className="bg-brand" style={{ height: 'calc(4px + env(safe-area-inset-top))' }} />
      <header className="flex flex-nowrap items-center gap-2 border-b border-line bg-surface px-3 py-2.5 sm:gap-3 sm:px-4">
        <button className="btn-ghost shrink-0 px-2 py-1 md:hidden" title="Danh sách hội thoại" aria-label="Danh sách hội thoại" onClick={() => setSidebarOpen(true)}>☰</button>
        <div className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand text-sm font-extrabold text-white">BA</div>
        <div className="min-w-0 flex-1">
          <div className="truncate whitespace-nowrap text-sm font-extrabold leading-tight text-navy">BA Code Assistant</div>
          {projects.length > 1 ? (
            <div className="relative">
              <button className="mt-0.5 inline-flex max-w-full items-center gap-1 rounded-md bg-brand/10 px-2 py-0.5 text-[11px] font-semibold text-brand-dark" onClick={() => setProjMenu((o) => !o)} title="Đổi dự án">
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-brand" />
                <span className="truncate">{projects.find((p) => p.key === activeProject)?.label || 'Dự án'}</span> ▾
              </button>
              {projMenu && (
                <>
                  <div className="fixed inset-0 z-30" onClick={() => setProjMenu(false)} />
                  <div className="absolute left-0 z-40 mt-1 w-64 max-w-[80vw] rounded-xl border border-line bg-surface p-1 text-xs shadow-cardhover">
                    <div className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted">Chọn dự án</div>
                    {projects.map((p) => (
                      <button key={p.key} onClick={() => switchProject(p.key)}
                        className={`block w-full rounded-lg px-3 py-2 text-left hover:bg-slate-50 ${p.key === activeProject ? 'bg-brand/10 font-semibold text-brand-dark' : 'text-ink'}`}>
                        {p.label}
                        <div className="text-[10px] font-normal text-muted">{p.blurb}</div>
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          ) : (
            <div className="hidden truncate text-[11px] text-muted sm:block">{status?.model || '…'}{head ? ' · ' + head : ''}</div>
          )}
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1.5 sm:gap-2">
        {me.role === 'admin' && (
          <button className="btn-ghost px-2.5 py-1.5 text-xs" title="Quản trị" aria-label="Quản trị" onClick={() => setAdminOpen(true)}>👤<span className="hidden sm:inline"> Quản trị</span></button>
        )}
        <div className="relative">
          <button className="btn-ghost max-w-[26vw] px-2 py-1.5 text-xs sm:max-w-none" onClick={() => setUserMenu((o) => !o)} title={me.email} aria-label="Tài khoản">
            <span className="truncate">{me.email.split('@')[0]}</span> <span className="shrink-0">▾</span>
          </button>
          {userMenu && (
            <>
              <div className="fixed inset-0 z-30" onClick={() => setUserMenu(false)} />
              <div className="absolute right-0 z-40 mt-1 w-52 rounded-xl border border-line bg-surface p-1 text-xs shadow-cardhover">
                <div className="truncate px-3 py-2 text-muted">{me.email} · {me.role === 'admin' ? 'Admin' : 'Thành viên'}</div>
                <button className="block w-full rounded px-3 py-2 text-left hover:bg-slate-50" onClick={() => { setUserMenu(false); setChangePw(true); }}>Đổi mật khẩu</button>
                <button className="block w-full rounded px-3 py-2 text-left text-red-600 hover:bg-red-50" onClick={() => { setUserMenu(false); logout(); }}>Đăng xuất</button>
              </div>
            </>
          )}
        </div>
        <div className="relative">
          <button className="btn-ghost px-2.5 py-1.5 text-xs" onClick={() => setCodeOpen((o) => !o)} title="Thông tin & đồng bộ mã nguồn" aria-label="Cập nhật code">
            ↻<span className="hidden sm:inline"> Cập nhật code</span>
          </button>
          {codeOpen && (
            <>
              <div className="fixed inset-0 z-30" onClick={() => setCodeOpen(false)} />
              <div className="absolute right-0 z-40 mt-1 w-80 rounded-xl border border-line bg-surface p-3 text-xs shadow-cardhover">
                <div className="mb-1 font-semibold text-navy">Mã nguồn — GitHub là nguồn chuẩn</div>
                <div className="mb-2 text-[11px] text-muted">Tự đồng bộ định kỳ; mỗi lần lấy đúng nhánh chuẩn, ghi đè mọi thay đổi cục bộ.</div>
                {(status?.lastPull?.results ?? []).map((r) => (
                  <div key={r.repo} className="mb-2 rounded-lg border border-line bg-app/60 p-2">
                    <div className="flex items-center justify-between">
                      <span className="font-semibold text-ink">{r.label}</span>
                      <span className="rounded bg-brand/10 px-1.5 py-0.5 font-mono text-[10px] text-brand-dark">{r.branch}</span>
                    </div>
                    {r.ok ? (
                      <div className="mt-1 text-[11px] text-muted">
                        <div className="truncate text-ink"><span className="font-mono text-brand-dark">{r.short}</span> {r.subject}</div>
                        <div>Cập nhật trên GitHub: <b>{r.commitISO ? fmtRelative(new Date(r.commitISO).getTime()) : '—'}</b>{r.author ? ` · ${r.author}` : ''}</div>
                        <div className="text-slate-400" title={r.commitISO}>{r.commitISO ? new Date(r.commitISO).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }) : ''}</div>
                      </div>
                    ) : (
                      <div className="mt-1 text-[11px] text-red-600">⚠️ Chưa đồng bộ được</div>
                    )}
                  </div>
                ))}
                <div className="mb-2 text-[11px] text-muted">Đồng bộ gần nhất: {status?.lastPull?.at ? fmtRelative(status.lastPull.at) : '—'}</div>
                <button className="btn-primary w-full py-1.5 text-xs" disabled={refreshing} onClick={doRefresh}>
                  {refreshing ? 'Đang đồng bộ…' : '↻ Đồng bộ ngay từ GitHub'}
                </button>
              </div>
            </>
          )}
        </div>
        </div>
      </header>
      <div className="flex min-h-0 flex-1">
        {/* Desktop: sidebar tĩnh */}
        <div className="hidden md:flex"><Sidebar convs={convs} activeId={activeId} onNew={newConv} onOpen={openConv} onDelete={delConv} /></div>
        {/* Mobile: drawer phủ */}
        {sidebarOpen && (
          <div className="fixed inset-0 z-40 md:hidden" onClick={() => setSidebarOpen(false)}>
            <div className="absolute inset-0 bg-black/40" />
            <div className="absolute left-0 top-0 h-full shadow-cardhover" onClick={(e) => e.stopPropagation()}>
              <Sidebar
                convs={convs} activeId={activeId}
                onNew={() => { newConv(); setSidebarOpen(false); }}
                onOpen={(id) => { openConv(id); setSidebarOpen(false); }}
                onDelete={delConv}
                onClose={() => setSidebarOpen(false)}
              />
            </div>
          </div>
        )}
        <ChatPanel messages={chat.messages} busy={chat.busy} onSend={handleSend} onCancel={chat.cancel} project={projects.find((p) => p.key === activeProject)} />
      </div>
      {adminOpen && <AdminPanel meId={me.id} onClose={() => setAdminOpen(false)} />}
      {changePw && <ChangePassword onDone={() => setChangePw(false)} onCancel={() => setChangePw(false)} />}
    </div>
  );
}
