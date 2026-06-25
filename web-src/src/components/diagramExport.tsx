import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

// ── Chọn nhiều sơ đồ + xuất PNG (copy clipboard / tải) để gửi nhanh cho khách ──
export type DiagramItem = { id: string; label: string; getBlob: () => Promise<Blob> };

type Ctx = {
  register: (item: DiagramItem) => void;
  unregister: (id: string) => void;
  items: DiagramItem[];
  selected: Set<string>;
  toggle: (id: string) => void;
  clear: () => void;
};
const DiagramSel = createContext<Ctx | null>(null);
export function useDiagramSel() { return useContext(DiagramSel); }

export function DiagramSelectionProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<DiagramItem[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const register = useCallback((item: DiagramItem) => {
    setItems((xs) => (xs.some((x) => x.id === item.id) ? xs.map((x) => (x.id === item.id ? item : x)) : [...xs, item]));
  }, []);
  const unregister = useCallback((id: string) => {
    setItems((xs) => xs.filter((x) => x.id !== id));
    setSelected((s) => { if (!s.has(id)) return s; const n = new Set(s); n.delete(id); return n; });
  }, []);
  const toggle = useCallback((id: string) => setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; }), []);
  const clear = useCallback(() => setSelected(new Set()), []);
  const value = useMemo(() => ({ register, unregister, items, selected, toggle, clear }), [register, unregister, items, selected, toggle, clear]);
  return <DiagramSel.Provider value={value}>{children}</DiagramSel.Provider>;
}

function loadImg(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const img = new Image(); const url = URL.createObjectURL(blob);
    img.onload = () => { URL.revokeObjectURL(url); res(img); };
    img.onerror = (e) => { URL.revokeObjectURL(url); rej(e); };
    img.src = url;
  });
}

// Ghép nhiều ảnh sơ đồ → 1 ảnh xếp DỌC (nền trắng, căn giữa, cách 24px).
export async function combineBlobs(blobs: Blob[]): Promise<Blob> {
  if (blobs.length === 1) return blobs[0];
  const imgs = await Promise.all(blobs.map(loadImg));
  const gap = 24, pad = 16;
  const w = Math.max(...imgs.map((i) => i.width)) + pad * 2;
  const h = imgs.reduce((s, i) => s + i.height, 0) + gap * (imgs.length - 1) + pad * 2;
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, w, h);
  let y = pad;
  for (const img of imgs) { ctx.drawImage(img, (w - img.width) / 2, y); y += img.height + gap; }
  return await new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('toBlob fail'))), 'image/png'));
}

function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Xuất các phần tử sơ đồ thành 1 ảnh PNG.
 * QUAN TRỌNG (copy): gọi clipboard.write NGAY (đồng bộ) với 1 Promise → giữ "user activation",
 * việc chụp ảnh chạy bên trong Promise. Nếu await chụp xong mới write thì trình duyệt CHẶN clipboard.
 * Phải được gọi TRỰC TIẾP trong onClick (trước bất kỳ await nào).
 */
export async function exportDiagrams(getBlobs: (() => Promise<Blob>)[], mode: 'copy' | 'download', filename: string): Promise<'copied' | 'downloaded'> {
  if (!getBlobs.length) throw new Error('Không tìm thấy sơ đồ để xuất');
  const makeBlob = async () => combineBlobs(await Promise.all(getBlobs.map((g) => g())));
  if (mode === 'copy' && navigator.clipboard && (window as any).ClipboardItem) {
    try {
      await navigator.clipboard.write([new (window as any).ClipboardItem({ 'image/png': makeBlob() })]);
      return 'copied';
    } catch { /* mất activation / không hỗ trợ → tải file */ }
  }
  download(await makeBlob(), filename);
  return 'downloaded';
}

// Thanh nổi khi đã chọn ≥1 sơ đồ.
export function DiagramExportBar() {
  const ctx = useDiagramSel();
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState('');
  if (!ctx || ctx.selected.size === 0) return null;
  const n = ctx.selected.size;
  const run = (mode: 'copy' | 'download') => {
    setBusy(true); setToast('');
    const getBlobs = ctx.items.filter((it) => ctx.selected.has(it.id)).map((it) => it.getBlob);
    exportDiagrams(getBlobs, mode, `so-do-${n}.png`)
      .then((r) => setToast(r === 'copied' ? `Đã copy ${n} sơ đồ ✓ (dán vào Zalo)` : `Đã tải ảnh ${n} sơ đồ ✓`))
      .catch((e) => setToast('Lỗi: ' + String(e?.message || e).slice(0, 90)))
      .finally(() => { setBusy(false); setTimeout(() => setToast(''), 3000); });
  };
  return (
    <div className="absolute bottom-24 left-1/2 z-20 -translate-x-1/2">
      {toast && <div className="mb-2 max-w-[90vw] rounded-lg bg-navy/90 px-3 py-1.5 text-center text-[11px] text-white shadow-cardhover">{toast}</div>}
      <div className="flex items-center gap-2 rounded-full border border-line bg-surface px-3 py-1.5 text-xs shadow-cardhover">
        <span className="font-semibold text-navy">{n} sơ đồ đã chọn</span>
        <button disabled={busy} className="rounded-full bg-brand px-3 py-1 font-semibold text-white transition hover:bg-brand-dark disabled:opacity-50" onClick={() => run('copy')}>{busy ? '…' : '📋 Copy PNG'}</button>
        <button disabled={busy} className="rounded-full border border-line px-2.5 py-1 text-ink transition hover:border-brand hover:text-brand-dark disabled:opacity-50" onClick={() => run('download')}>⬇ Tải</button>
        <button className="text-muted hover:text-brand-dark" onClick={ctx.clear}>Bỏ chọn</button>
      </div>
    </div>
  );
}
