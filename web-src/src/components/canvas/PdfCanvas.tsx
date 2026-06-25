import { useEffect, useRef, useState } from 'react';
import * as pdfjsLib from 'pdfjs-dist';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString();

// Xem PDF (pdfjs render canvas, phân trang). Chỉ xem — không sửa.
export default function PdfCanvas({ id }: { id: string }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const bufRef = useRef<ArrayBuffer | null>(null);
  const [count, setCount] = useState(0);
  const [err, setErr] = useState('');

  useEffect(() => {
    let dead = false;
    (async () => {
      try {
        const r = await fetch(`/api/files/${id}/raw`); if (!r.ok) throw new Error('Không tải được file');
        bufRef.current = await r.arrayBuffer();
        const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(bufRef.current.slice(0)) }).promise;
        if (!dead) setCount(pdf.numPages);
        pdf.destroy?.();
      } catch (e: any) { if (!dead) setErr(String(e?.message || e)); }
    })();
    return () => { dead = true; };
  }, [id]);

  useEffect(() => {
    if (!count || !bufRef.current) return;
    let dead = false;
    (async () => {
      const wrap = wrapRef.current; if (!wrap) return;
      const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(bufRef.current!.slice(0)) }).promise;
      const scale = Math.min(1.6, ((wrap.clientWidth || 800) - 32) / 595) || 1.2;
      for (let p = 1; p <= pdf.numPages && !dead; p++) {
        const page = await pdf.getPage(p);
        const viewport = page.getViewport({ scale });
        const holder = wrap.querySelector(`[data-page="${p}"]`) as HTMLElement | null;
        if (!holder) continue;
        const canvas = document.createElement('canvas');
        canvas.width = viewport.width; canvas.height = viewport.height; canvas.className = 'block h-auto w-full';
        const ctx = canvas.getContext('2d'); if (!ctx) continue;
        holder.innerHTML = ''; holder.prepend(canvas);
        await page.render({ canvas, canvasContext: ctx, viewport } as any).promise;
      }
      pdf.destroy?.();
    })();
    return () => { dead = true; };
  }, [count]);

  if (err) return <div className="p-4 text-sm text-amber-700">Không mở được PDF: {err}</div>;
  return (
    <div className="h-full overflow-auto bg-slate-100 p-4">
      <div ref={wrapRef} className="mx-auto max-w-3xl">
        {!count && <div className="p-6 text-center text-sm text-muted">Đang mở PDF…</div>}
        {Array.from({ length: count }, (_, i) => i + 1).map((p) => (
          <div key={p} data-page={p} className="mx-auto mb-4 min-h-[120px] rounded border border-line bg-white shadow-card" />
        ))}
      </div>
    </div>
  );
}
