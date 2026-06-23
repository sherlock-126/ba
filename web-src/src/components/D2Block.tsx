import { useEffect, useState } from 'react';
import { FlowDiagram, ShapeIcon, shapesUsed } from './FlowDiagram';

/** Khối sơ đồ: render tương tác bằng React Flow (kéo-thả node, mũi tên tự nối, fit/zoom/pan).
 *  Có nút xem nguồn D2 + phóng to toàn màn hình + bảng chú thích ký hiệu. */
export function D2Block({ code }: { code: string }) {
  const [showSrc, setShowSrc] = useState(false);
  const [full, setFull] = useState(false);
  const [showLegend, setShowLegend] = useState(false);

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

  const Header = ({ inFull }: { inFull?: boolean }) => (
    <div className="flex items-center justify-between border-b border-line bg-slate-50 px-3 py-1 text-[11px] text-muted">
      <span>📊 Sơ đồ {!inFull && <span className="text-slate-400">· kéo node để sắp xếp, cuộn để zoom</span>}</span>
      <div className="flex gap-3">
        {!showSrc && <button className="hover:text-brand-dark" onClick={() => setShowLegend((s) => !s)}>{showLegend ? 'Ẩn ký hiệu' : 'ⓘ Ký hiệu'}</button>}
        {!inFull && <button className="hover:text-brand-dark" onClick={() => setShowSrc((s) => !s)}>{showSrc ? 'Xem hình' : '</> Nguồn'}</button>}
        <button className="hover:text-brand-dark" onClick={() => setFull((f) => !f)}>{inFull ? '✕ Đóng' : '⛶ Phóng to'}</button>
      </div>
    </div>
  );

  return (
    <>
      <div className="my-2.5 overflow-hidden rounded-lg border border-line bg-white">
        <Header />
        {showLegend && !showSrc && <Legend />}
        {showSrc
          ? <pre className="overflow-auto p-3 font-mono text-[11.5px] leading-relaxed text-ink">{code.trim()}</pre>
          : full
            ? <div className="p-4 text-xs text-muted">Đang xem toàn màn hình… <button className="text-brand-dark underline" onClick={() => setFull(false)}>đóng</button></div>
            : <FlowDiagram code={code} />}
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
