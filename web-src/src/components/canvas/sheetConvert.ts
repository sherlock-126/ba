// Chuyển đổi xlsx ↔ Univer (dùng exceljs). Port từ adg_database.
const colLetters = (n: number) => { let s = ''; n++; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };
export const refToRC = (ref: string): { r: number; c: number } | null => {
  const m = ref.toUpperCase().match(/^([A-Z]+)(\d+)$/);
  if (!m) return null;
  let c = 0; for (const ch of m[1]) c = c * 26 + (ch.charCodeAt(0) - 64);
  return { r: parseInt(m[2], 10) - 1, c: c - 1 };
};
export const rcToRef = (r: number, c: number) => `${colLetters(c)}${r + 1}`;

function cellValue(v: any): any {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') {
    if ('result' in v) return v.result ?? '';
    if ('text' in v) return v.text;
    if (Array.isArray(v.richText)) return v.richText.map((t: any) => t.text).join('');
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    if ('error' in v) return v.error;
    return String(v);
  }
  return v;
}

const MAX_ROWS = 5000;

function csvToWorkbook(ExcelJS: any, buf: ArrayBuffer) {
  const text = new TextDecoder('utf-8').decode(buf);
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    if (i >= MAX_ROWS) return;
    const cells = line.match(/(".*?"|[^,]*)(,|$)/g)?.slice(0, -1).map((s) => s.replace(/,$/, '').replace(/^"|"$/g, '').replace(/""/g, '"')) ?? [];
    cells.forEach((v, c) => { if (v !== '') ws.getCell(i + 1, c + 1).value = isFinite(+v) && v.trim() !== '' ? +v : v; });
  });
  return wb;
}

export async function xlsxToUniver(buf: ArrayBuffer): Promise<any> {
  const ExcelJS = (await import('exceljs')).default;
  let wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(buf as any); } catch { wb = csvToWorkbook(ExcelJS, buf); }
  const sheets: Record<string, any> = {};
  const sheetOrder: string[] = [];
  let idx = 0;
  wb.eachSheet((ws: any) => {
    const id = `sheet_${idx++}`;
    sheetOrder.push(id);
    const cellData: Record<number, Record<number, any>> = {};
    let maxR = 0, maxC = 0;
    ws.eachRow({ includeEmpty: false }, (row: any, rNum: number) => {
      if (rNum > MAX_ROWS) return;
      row.eachCell({ includeEmpty: false }, (cell: any, cNum: number) => {
        const r = rNum - 1, c = cNum - 1;
        maxR = Math.max(maxR, r); maxC = Math.max(maxC, c);
        const v = cellValue(cell.value);
        if (v === '') return;
        const s: any = {};
        if (cell.font?.bold) s.bl = 1;
        if (cell.numFmt) s.n = { pattern: cell.numFmt };
        (cellData[r] ||= {})[c] = Object.keys(s).length ? { v, s } : { v };
      });
    });
    const mergeData = (ws.model?.merges || []).map((rng: string) => {
      const [a, b] = rng.split(':'); const s = refToRC(a)!; const e = refToRC(b || a)!;
      return { startRow: s.r, startColumn: s.c, endRow: e.r, endColumn: e.c };
    });
    const columnData: Record<number, any> = {};
    (ws.columns || []).forEach((col: any, i: number) => { if (col?.width) columnData[i] = { w: Math.round(col.width * 7.5) }; });
    sheets[id] = { id, name: ws.name, rowCount: Math.max(maxR + 10, 60), columnCount: Math.max(maxC + 4, 26), cellData, mergeData, columnData };
  });
  if (!sheetOrder.length) { sheets['sheet_0'] = { id: 'sheet_0', name: 'Sheet1', rowCount: 60, columnCount: 26, cellData: {} }; sheetOrder.push('sheet_0'); }
  return { id: `wb_${Date.now()}`, name: wb.title || 'Workbook', sheetOrder, sheets, styles: {} };
}

export type CellChange = { sheetIndex: number; r: number; c: number; value: any };
export function snapshotValueMap(snapshot: any): Map<string, any> {
  const m = new Map<string, any>();
  const order: string[] = snapshot?.sheetOrder?.length ? snapshot.sheetOrder : Object.keys(snapshot?.sheets || {});
  order.forEach((sid, si) => {
    const cd = snapshot?.sheets?.[sid]?.cellData || {};
    for (const r of Object.keys(cd)) for (const c of Object.keys(cd[r])) m.set(`${si}:${r}:${c}`, cd[r][c]?.v);
  });
  return m;
}
export function diffSnapshots(current: any, initial: Map<string, any>): CellChange[] {
  const out: CellChange[] = [];
  const order: string[] = current?.sheetOrder?.length ? current.sheetOrder : Object.keys(current?.sheets || {});
  const seen = new Set<string>();
  order.forEach((sid, si) => {
    const cd = current?.sheets?.[sid]?.cellData || {};
    for (const r of Object.keys(cd)) for (const c of Object.keys(cd[r])) {
      const key = `${si}:${r}:${c}`; seen.add(key);
      const v = cd[r][c]?.v;
      if ((v ?? '') !== (initial.get(key) ?? '')) out.push({ sheetIndex: si, r: Number(r), c: Number(c), value: v });
    }
  });
  for (const key of initial.keys()) {
    if (seen.has(key) || (initial.get(key) ?? '') === '') continue;
    const [si, r, c] = key.split(':').map(Number);
    out.push({ sheetIndex: si, r, c, value: null });
  }
  return out;
}
export async function applyChangesToXlsx(originalBuf: ArrayBuffer | null, changes: CellChange[]): Promise<ArrayBuffer> {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  if (originalBuf) { try { await wb.xlsx.load(originalBuf as any); } catch { /* tạo mới */ } }
  if (!wb.worksheets.length) wb.addWorksheet('Sheet1');
  for (const ch of changes) {
    const ws = wb.worksheets[ch.sheetIndex] || wb.addWorksheet(`Sheet${ch.sheetIndex + 1}`);
    ws.getCell(ch.r + 1, ch.c + 1).value = (ch.value === '' || ch.value === undefined) ? null : ch.value;
  }
  return wb.xlsx.writeBuffer() as Promise<ArrayBuffer>;
}
