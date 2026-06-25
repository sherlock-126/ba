import { useEffect, useId, useRef, useState } from 'react';
import { FlowDiagram, ShapeIcon, shapesUsed, type FlowHandle } from './FlowDiagram';
import { useDiagramSel, exportDiagrams } from './diagramExport';

/** Khối sơ đồ: render tương tác bằng React Flow (kéo-thả node, mũi tên tự nối, fit/zoom/pan).
 *  Có nút xem nguồn D2 + phóng to + chú thích ký hiệu + chọn/copy/tải PNG. */
export function D2Block({ code }: { code: string }) {
  const [showSrc, setShowSrc] = useState(false);
  const [full, setFull] = useState(false);
  const [showLegend, setShowLegend] = useState(false);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState('');
  const fdRef = useRef<FlowHandle>(null);
  const id = useId();
  const sel = useDiagramSel();
  const getBlob = () => {
    const fd = fdRef.current;
    if (!fd) return Promise.reject(new Error('Sơ đồ chưa sẵn sàng'));
    return fd.exportBlob();
  };

  // Đăng ký sơ đồ này vào bộ chọn (để xuất nhiều cùng lúc).
  useEffect(() => {
    if (!sel) return;
    const label = code.split('\n').map((s) => s.trim()).find((s) => s && !/^(#|direction|grid-|classes|shape:)/.test(s))?.slice(0, 40) || 'Sơ đồ';
    sel.register({ id, label, getBlob });
    return () => sel.unregister(id);
  }, [id, code, sel?.register, sel?.unregister]);

  function exportOne(mode: 'copy' | 'download') {
    setBusy(true); setToast('');
    // Gọi exportDiagrams ĐỒNG BỘ trong onClick (giữ user-activation cho clipboard).
    exportDiagrams([getBlob], mode, 'so-do.png')
      .then((r) => setToast(r === 'copied' ? 'Đã copy ảnh ✓ (dán vào Zalo)' : 'Đã tải ảnh ✓'))
      .catch((e) => setToast('Lỗi: ' + String(e?.message || e).slice(0, 80)))
      .finally(() => { setBusy(false); setTimeout(() => setToast(''), 2500); });
  }

  // Bảng chú thích: chỉ liệt kê ký hiệu CÓ trong sơ đồ đang xem.
  const Legend = () => (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-b border-line bg-white px-3 py-2 text-[11px] text-slate-600">
      {shapesUsed(code).map((it) => (
        <span key={it.shape} className="inline-flex items-center gap-1.5"><ShapeIcon shape={it.shape} />{it.label}</span>
      ))}
    </div>
  );

  useEffect(() => {
    if (!full) return;
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') setFull(false); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [full]);

  const checked = !!sel?.selected.has(id);
  const Header = ({ inFull }: { inFull?: boolean }) => (
    <div className="flex items-center justify-between border-b border-line bg-slate-50 px-3 py-1 text-[11px] text-muted">
      <span className="inline-flex items-center gap-2">
        {sel && !inFull && (
          <button title="Chọn để xuất nhiều sơ đồ" className={checked ? 'text-brand-dark' : 'hover:text-brand-dark'} onClick={() => sel.toggle(id)}>{checked ? '☑' : '☐'}</button>
        )}
        📊 Sơ đồ {!inFull && <span className="hidden text-slate-400 sm:inline">· kéo node, cuộn để zoom</span>}
      </span>
      <div className="flex gap-2.5">
        {!showSrc && <button disabled={busy} className="hover:text-brand-dark disabled:opacity-50" onClick={() => exportOne('copy')}>{busy ? '…' : '📋 Copy'}</button>}
        {!showSrc && <button disabled={busy} className="hover:text-brand-dark disabled:opacity-50" onClick={() => exportOne('download')} title="Tải PNG">⬇</button>}
        {!showSrc && <button className="hover:text-brand-dark" onClick={() => setShowLegend((s) => !s)}>{showLegend ? 'Ẩn KH' : 'ⓘ Ký hiệu'}</button>}
        {!inFull && <button className="hover:text-brand-dark" onClick={() => setShowSrc((s) => !s)}>{showSrc ? 'Xem hình' : '</> Nguồn'}</button>}
        <button className="hover:text-brand-dark" onClick={() => setFull((f) => !f)}>{inFull ? '✕ Đóng' : '⛶ Phóng to'}</button>
      </div>
    </div>
  );

  return (
    <>
      <div className="relative my-2.5 overflow-hidden rounded-lg border border-line bg-white">
        <Header />
        {showLegend && !showSrc && <Legend />}
        <div>
          {showSrc
            ? <pre className="overflow-auto p-3 font-mono text-[11.5px] leading-relaxed text-ink">{code.trim()}</pre>
            : <FlowDiagram ref={fdRef} code={code} />}
        </div>
        {toast && <div className="pointer-events-none absolute bottom-2 left-1/2 -translate-x-1/2 rounded-lg bg-navy/90 px-3 py-1 text-[11px] text-white shadow-cardhover">{toast}</div>}
      </div>

      {full && (
        <div className="fixed inset-0 z-50 flex flex-col bg-black/60 p-4" onClick={() => setFull(false)}>
          <div className="mx-auto flex h-full w-full max-w-6xl flex-col overflow-hidden rounded-xl bg-white shadow-cardhover" onClick={(e) => e.stopPropagation()}>
            <Header inFull />
            {showLegend && <Legend />}
            <div className="flex-1"><FlowDiagram code={code} full /></div>
          </div>
        </div>
      )}
    </>
  );
}
