import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import type { OutFile } from '../useChat';
import type { CanvasHandle } from './canvas/SheetCanvas';

const PdfCanvas = lazy(() => import('./canvas/PdfCanvas'));
const SheetCanvas = lazy(() => import('./canvas/SheetCanvas'));
const DocxCanvas = lazy(() => import('./canvas/DocxCanvas'));

const ICON: Record<string, string> = { excel: '📊', word: '📝', pdf: '📄', html: '🌐' };

// Modal xem/sửa file + thanh lệnh AI sửa trực tiếp (copilot).
export function FileViewer({ file, onClose }: { file: OutFile; onClose: () => void }) {
  const canvasRef = useRef<CanvasHandle>(null);
  const [cmd, setCmd] = useState('');
  const [busy, setBusy] = useState(false);
  const [reply, setReply] = useState('');
  const copilot = file.kind === 'excel' || file.kind === 'word' || file.kind === 'html';

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);

  const runCopilot = async () => {
    const message = cmd.trim(); if (!message || busy) return;
    setBusy(true); setReply(''); setCmd('');
    try {
      const context = canvasRef.current?.context?.() || '';
      const res = await fetch('/api/chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, openFile: { id: file.id, kind: file.kind, context } }),
      });
      if (!res.ok || !res.body) throw new Error('Không gọi được AI');
      const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
      for (;;) {
        const { value, done } = await reader.read(); if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, idx); buf = buf.slice(idx + 2);
          let ev = 'message', dat = '';
          for (const line of chunk.split('\n')) { if (line.startsWith('event:')) ev = line.slice(6).trim(); else if (line.startsWith('data:')) dat += line.slice(5).trim(); }
          if (!dat) continue;
          let d: any; try { d = JSON.parse(dat); } catch { continue; }
          if (ev === 'cells_patch') canvasRef.current?.applyPatch?.(d.cells);
          else if (ev === 'doc_patch') canvasRef.current?.applyEdit?.(d.ops);
          else if (ev === 'text_delta') setReply((r) => (r + (d.delta || '')).slice(0, 600));
          else if (ev === 'error') setReply((r) => r + ' ⚠️ ' + (d.message || ''));
        }
      }
    } catch (e: any) { setReply('Lỗi: ' + String(e?.message || e)); }
    finally { setBusy(false); }
  };

  const body = file.kind === 'pdf' ? <PdfCanvas id={file.id} />
    : file.kind === 'excel' ? <SheetCanvas ref={canvasRef} id={file.id} />
      : <DocxCanvas ref={canvasRef} id={file.id} kind={file.kind} />;

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black/60 p-3 sm:p-4" onClick={onClose}>
      <div className="mx-auto flex h-full w-full max-w-6xl flex-col overflow-hidden rounded-xl bg-white shadow-cardhover" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-line bg-slate-50 px-3 py-1.5 text-xs">
          <span className="truncate font-semibold text-ink">{ICON[file.kind] || '📄'} {file.filename}</span>
          <div className="flex items-center gap-3">
            <a href={file.downloadUrl} download={file.filename} className="hover:text-brand-dark">📥 Tải</a>
            <button className="hover:text-brand-dark" onClick={onClose}>✕ Đóng</button>
          </div>
        </div>
        <div className="min-h-0 flex-1">
          <Suspense fallback={<div className="p-6 text-sm text-muted">Đang tải trình xem…</div>}>{body}</Suspense>
        </div>
        {copilot && (
          <div className="border-t border-line bg-white px-3 py-2">
            {reply && <div className="mb-1.5 max-h-16 overflow-auto rounded bg-slate-50 px-2 py-1 text-[11px] text-slate-600">{reply}</div>}
            <div className="flex items-center gap-2">
              <span className="text-sm">🤖</span>
              <input
                className="min-w-0 flex-1 rounded-lg border border-line px-3 py-1.5 text-sm outline-none focus:border-brand"
                placeholder={file.kind === 'excel' ? 'Nhờ AI: vd "điền cột Thành tiền = SL×Đơn giá"…' : 'Nhờ AI: vd "thêm đoạn kết luận", "viết lại phần X gọn hơn"…'}
                value={cmd} disabled={busy}
                onChange={(e) => setCmd(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') runCopilot(); }}
              />
              <button className="rounded-lg bg-brand px-3 py-1.5 text-sm font-semibold text-white transition hover:bg-brand-dark disabled:opacity-50" disabled={busy || !cmd.trim()} onClick={runCopilot}>{busy ? '…' : 'Gửi'}</button>
            </div>
            <div className="mt-1 text-[10px] text-muted">AI sửa trực tiếp trên file đang mở — xong nhớ bấm 💾 Lưu.</div>
          </div>
        )}
      </div>
    </div>
  );
}
