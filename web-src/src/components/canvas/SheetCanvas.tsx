import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { createUniver } from '@univerjs/presets';
import { LocaleType, mergeLocales } from '@univerjs/core';
import { UniverSheetsCorePreset } from '@univerjs/preset-sheets-core';
import sheetsViVN from '@univerjs/preset-sheets-core/locales/vi-VN';
import '@univerjs/preset-sheets-core/lib/index.css';
import { xlsxToUniver, applyChangesToXlsx, snapshotValueMap, diffSnapshots, refToRC, rcToRef } from './sheetConvert';

export type CanvasHandle = { context: () => string; applyPatch?: (cells: any[]) => void; applyEdit?: (ops: any[]) => void };

// base64 cho ArrayBuffer lớn (không stack-overflow).
function abToB64(ab: ArrayBuffer): string {
  const bytes = new Uint8Array(ab); let bin = ''; const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(bin);
}

// Bảng tính Univer: mở/sửa/lưu Excel (chỉ ghi ô đã đổi vào file gốc → giữ format).
const SheetCanvas = forwardRef<CanvasHandle, { id: string }>(function SheetCanvas({ id }, ref) {
  const containerRef = useRef<HTMLDivElement>(null);
  const apiRef = useRef<any>(null);
  const univerRef = useRef<any>(null);
  const originalBuf = useRef<ArrayBuffer | null>(null);
  const initialVals = useRef<Map<string, any>>(new Map());
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    let disposed = false;
    setReady(false);
    (async () => {
      const r = await fetch(`/api/files/${id}/raw`); if (!r.ok) throw new Error('Không tải được file');
      const buf = await r.arrayBuffer();
      originalBuf.current = buf;
      const snap = await xlsxToUniver(buf);
      initialVals.current = snapshotValueMap(snap);
      if (disposed || !containerRef.current) return;
      const { univer, univerAPI } = createUniver({
        locale: LocaleType.VI_VN,
        locales: { [LocaleType.VI_VN]: mergeLocales((sheetsViVN as any).default ?? sheetsViVN) },
        presets: [UniverSheetsCorePreset({ container: containerRef.current })],
      });
      univerRef.current = univer; apiRef.current = univerAPI;
      univerAPI.createWorkbook(snap);
      setReady(true);
    })().catch((e) => setMsg('Không mở được bảng tính: ' + (e?.message ?? e)));
    return () => { disposed = true; try { univerRef.current?.dispose(); } catch { /* ignore */ } apiRef.current = null; };
  }, [id]);

  const snapshot = () => apiRef.current?.getActiveWorkbook?.()?.save?.();
  const save = async () => {
    if (!ready) return;
    setSaving(true); setMsg('');
    try {
      const snap = snapshot(); if (!snap) throw new Error('Bảng tính chưa sẵn sàng');
      const buf = await applyChangesToXlsx(originalBuf.current, diffSnapshots(snap, initialVals.current));
      const res = await fetch(`/api/files/${id}/raw`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data: abToB64(buf) }) });
      if (!res.ok) throw new Error('Lưu thất bại');
      originalBuf.current = buf;
      initialVals.current = snapshotValueMap(snapshot());
      setMsg('Đã lưu ✓');
    } catch (e: any) { setMsg(String(e?.message ?? e)); }
    finally { setSaving(false); setTimeout(() => setMsg(''), 2800); }
  };

  // Copilot: cung cấp ngữ cảnh ô hiện tại + nhận lệnh điền ô từ AI.
  useImperativeHandle(ref, () => ({
    context: () => {
      const snap = snapshot(); if (!snap) return '';
      const order: string[] = snap.sheetOrder?.length ? snap.sheetOrder : Object.keys(snap.sheets || {});
      const lines: string[] = [];
      for (const sid of order.slice(0, 3)) {
        const sh = snap.sheets?.[sid]; if (!sh) continue;
        lines.push(`# Sheet: ${sh.name}`);
        const cd = sh.cellData || {};
        for (const r of Object.keys(cd).slice(0, 80)) for (const c of Object.keys(cd[r])) {
          const v = cd[r][c]?.v; if (v !== '' && v != null) lines.push(`${rcToRef(Number(r), Number(c))}=${String(v).slice(0, 50)}`);
        }
      }
      return lines.join('\n').slice(0, 9000);
    },
    applyPatch: (cells) => {
      const wb = apiRef.current?.getActiveWorkbook?.(); if (!wb) return;
      for (const cell of cells || []) {
        const parts = String(cell.ref).split('!');
        const refPart = parts.length > 1 ? parts[1] : parts[0];
        const sheetName = cell.sheet || (parts.length > 1 ? parts[0].replace(/^'|'$/g, '') : undefined);
        const rc = refToRC(refPart); if (!rc) continue;
        try { ((sheetName && wb.getSheetByName?.(sheetName)) || wb.getActiveSheet()).getRange(rc.r, rc.c).setValue(cell.value); } catch { /* bỏ ref lỗi */ }
      }
    },
  }), [ready]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-line bg-white px-3 py-1.5 text-xs">
        <span className="font-semibold text-ink">📊 Bảng tính · sửa ô rồi bấm Lưu</span>
        <div className="flex-1" />
        {msg && <span className="text-muted">{msg}</span>}
        <button className="rounded-md bg-brand px-3 py-1 font-semibold text-white transition hover:bg-brand-dark disabled:opacity-50" onClick={save} disabled={saving || !ready}>{saving ? 'Đang lưu…' : '💾 Lưu'}</button>
      </div>
      <div className="relative min-h-0 flex-1">
        {!ready && <div className="absolute inset-0 z-10 flex items-center justify-center bg-white/80 text-muted">Đang mở bảng tính…</div>}
        <div ref={containerRef} className="h-full w-full" />
      </div>
    </div>
  );
});

export default SheetCanvas;
