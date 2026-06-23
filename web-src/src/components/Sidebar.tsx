import type { ConvMeta } from '../api';
import { fmtRelative } from '../time';

export function Sidebar({ convs, activeId, onNew, onOpen, onDelete, onClose }: {
  convs: ConvMeta[];
  activeId: string | null;
  onNew: () => void;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
  onClose?: () => void;   // chỉ truyền ở chế độ drawer (mobile) → hiện thanh tiêu đề + nút đóng
}) {
  return (
    <aside className="flex h-full w-72 max-w-[82vw] shrink-0 flex-col border-r border-line bg-surface md:w-60 md:max-w-none">
      {onClose && (
        <div className="flex items-center justify-between border-b border-line px-3 pb-2"
          style={{ paddingTop: 'calc(0.5rem + env(safe-area-inset-top))' }}>
          <span className="text-sm font-bold text-navy">Lịch sử hội thoại</span>
          <button className="btn-ghost px-2 py-1" onClick={onClose} aria-label="Đóng">✕</button>
        </div>
      )}
      <div className="p-2.5">
        <button className="btn-primary w-full" onClick={onNew}>+ Hỏi mới</button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-2 pb-2">
        {!onClose && <div className="px-1.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted">Lịch sử</div>}
        {convs.length === 0 && <div className="px-1.5 py-2 text-xs text-muted">Chưa có hội thoại.</div>}
        {convs.map((c) => (
          <div
            key={c.id}
            onClick={() => onOpen(c.id)}
            className={`group flex cursor-pointer items-center gap-1 rounded-lg px-2.5 py-2.5 text-[13px] ${
              c.id === activeId ? 'bg-brand/10 font-medium text-brand-dark' : 'text-ink hover:bg-slate-50'
            }`}
          >
            <div className="min-w-0 flex-1">
              <div className="truncate">{c.title}</div>
              <div className="text-[10px] font-normal text-muted">{fmtRelative(c.updatedAt)}</div>
            </div>
            {/* Luôn hiển thị (mobile không có hover); mờ nhẹ, vùng chạm rộng. */}
            <button
              title="Xoá hội thoại"
              aria-label="Xoá hội thoại"
              className="shrink-0 rounded-md p-2 text-muted opacity-50 transition hover:bg-red-50 hover:text-red-600 hover:opacity-100"
              onClick={(e) => { e.stopPropagation(); onDelete(c.id); }}
            >✕</button>
          </div>
        ))}
      </div>
    </aside>
  );
}
