/**
 * Sinh file Excel / Word / HTML / PDF từ dữ liệu AI cung cấp.
 */
import * as XLSX from 'xlsx';

// ── Excel (.xlsx) ──
export type ExcelSheet = { name?: string; headers: string[]; rows: (string | number | null)[][] };
export function buildExcel(sheets: ExcelSheet[]): Buffer {
  const wb = XLSX.utils.book_new();
  const used = new Set<string>();
  sheets.forEach((sh, i) => {
    const aoa = [sh.headers || [], ...(sh.rows || []).map((r) => (Array.isArray(r) ? r : []))];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    if (sh.headers?.length) ws['!cols'] = sh.headers.map((h) => ({ wch: Math.min(40, Math.max(10, String(h).length + 4)) }));
    let name = (sh.name || `Sheet${i + 1}`).replace(/[\\/?*[\]:]/g, ' ').slice(0, 28).trim() || `Sheet${i + 1}`;
    let n = name, k = 2; while (used.has(n.toLowerCase())) n = `${name} ${k++}`.slice(0, 31);
    used.add(n.toLowerCase());
    XLSX.utils.book_append_sheet(wb, ws, n);
  });
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

// ── Word (.docx) ──
export type DocxSection =
  | { type: 'heading'; text: string; level?: 1 | 2 | 3 }
  | { type: 'paragraph'; text: string; bold?: boolean; align?: 'left' | 'center' | 'right' }
  | { type: 'table'; headers: string[]; rows: (string | number)[][] };
export async function buildWord(title: string, sections: DocxSection[]): Promise<Buffer> {
  const { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, Table, TableRow, TableCell, WidthType, BorderStyle } = await import('docx');
  const HL: any = { 1: HeadingLevel.HEADING_1, 2: HeadingLevel.HEADING_2, 3: HeadingLevel.HEADING_3 };
  const AL: any = { left: AlignmentType.LEFT, center: AlignmentType.CENTER, right: AlignmentType.RIGHT };
  const children: any[] = [];
  if (title) children.push(new Paragraph({ text: title, heading: HeadingLevel.TITLE }));
  const border = { style: BorderStyle.SINGLE, size: 1, color: 'CBD5E1' };
  const borders = { top: border, bottom: border, left: border, right: border };
  for (const s of sections || []) {
    if (s.type === 'heading') children.push(new Paragraph({ text: s.text || '', heading: HL[s.level || 2] }));
    else if (s.type === 'paragraph') children.push(new Paragraph({ alignment: AL[s.align || 'left'], children: [new TextRun({ text: s.text || '', bold: !!s.bold })] }));
    else if (s.type === 'table') {
      const mk = (cells: (string | number)[], head: boolean) => new TableRow({
        children: cells.map((c) => new TableCell({ borders, children: [new Paragraph({ children: [new TextRun({ text: String(c ?? ''), bold: head })] })] })),
      });
      const rows = [mk(s.headers || [], true), ...(s.rows || []).map((r) => mk(r, false))];
      children.push(new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows }));
      children.push(new Paragraph({ text: '' }));
    }
  }
  const doc = new Document({ sections: [{ children }] });
  return (await Packer.toBuffer(doc)) as Buffer;
}

// ── HTML shell (font tiếng Việt + CSS in ấn + template tài liệu giải pháp) ──
export function htmlShell(title: string, body: string): string {
  return `<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title || 'Báo cáo')}</title>
<style>
  *{box-sizing:border-box} body{font-family:"DejaVu Sans","Liberation Sans","Noto Sans",Arial,sans-serif;color:#1f2d4d;max-width:920px;margin:0 auto;padding:32px 30px;line-height:1.6;font-size:14px}
  h1{font-size:25px;color:#1a4f96;margin:.2em 0 .5em;line-height:1.25} h2{font-size:18px;color:#1a4f96;margin:1.5em 0 .5em;padding-bottom:.25em;border-bottom:2px solid #e3e8f1} h3{font-size:15px;color:#16315f;margin:1.1em 0 .3em}
  p{margin:.5em 0} ul,ol{margin:.4em 0 .8em;padding-left:22px} li{margin:.25em 0}
  table{border-collapse:collapse;width:100%;margin:12px 0;font-size:13px} th,td{border:1px solid #cbd5e1;padding:8px 11px;text-align:left;vertical-align:top}
  th{background:#1f6fd0;color:#fff;font-weight:700} tr:nth-child(even) td{background:#f4f8fd}
  .muted{color:#64748b} .right{text-align:right} @page{margin:16mm 14mm}
  /* Trang bìa */
  .cover{background:linear-gradient(120deg,#1a4f96,#1f6fd0);color:#fff;border-radius:14px;padding:34px 32px;margin:0 0 26px}
  .cover h1{color:#fff;margin:0 0 8px;font-size:27px} .cover .sub{color:#e3edfb;font-size:15px;margin:0 0 14px} .cover .meta{color:#cfe0f7;font-size:12.5px}
  /* Hộp nhấn mạnh */
  .callout,.note,.warn,.ok{border-left:4px solid #1f6fd0;background:#eff5fd;border-radius:0 8px 8px 0;padding:11px 15px;margin:12px 0;font-size:13.5px}
  .note{border-color:#64748b;background:#f5f7fa} .warn{border-color:#d97706;background:#fff7ed} .ok{border-color:#16a34a;background:#ecfdf3}
  /* Nhãn trạng thái */
  .badge{display:inline-block;background:#eef4fc;color:#1a4f96;border:1px solid #c7d6ef;border-radius:999px;padding:1px 9px;font-size:11.5px;font-weight:600;margin:0 2px}
  /* Thẻ vai trò (input → output) */
  .role{border:1px solid #e3e8f1;border-radius:10px;padding:13px 16px;margin:10px 0;background:#fff} .role>.r-name{font-weight:700;color:#16315f;margin-bottom:4px}
  .io{display:flex;gap:10px;flex-wrap:wrap;font-size:13px} .io>div{flex:1;min-width:200px;background:#f8fafc;border:1px solid #eef2f7;border-radius:8px;padding:8px 11px}
  .io .lbl{font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.03em}
  /* Bảng khoá–giá trị (cấu hình) */
  table.kv th{width:42%}
</style></head><body><div class="doc">${body}</div></body></html>`;
}
function escapeHtml(s: string) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string)); }

// ── Word ↔ HTML (cho editor TipTap) ──
export async function docxToHtml(buf: Buffer): Promise<string> {
  const mammoth: any = await import('mammoth');
  const mm = mammoth.default ?? mammoth;
  const convertImage = mm.images?.imgElement
    ? mm.images.imgElement(async (image: any) => { const b64 = await image.read('base64'); return { src: `data:${image.contentType};base64,${b64}` }; })
    : undefined;
  const r = await mm.convertToHtml({ buffer: buf }, convertImage ? { convertImage } : undefined);
  return String(r?.value ?? '');
}
export async function htmlToDocx(html: string): Promise<Buffer> {
  const mod: any = await import('@turbodocx/html-to-docx');
  const HTMLtoDOCX = mod.default ?? mod;
  const out = await HTMLtoDOCX(
    `<!doctype html><html><head><meta charset="utf-8"></head><body>${html}</body></html>`,
    null,
    { table: { row: { cantSplit: true } } },
    null,
  );
  return Buffer.isBuffer(out) ? out : Buffer.from(out as ArrayBuffer);
}

// ── PDF (HTML → Chromium headless) ──
export async function buildPdf(title: string, bodyHtml: string): Promise<Buffer> {
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome-stable', headless: true, args: ['--no-sandbox', '--disable-gpu'] });
  try {
    const page = await browser.newPage();
    // Chống SSRF: chỉ cho data:/blob:/about: — chặn mọi request mạng ngoài.
    await page.route('**/*', (route) => { const u = route.request().url(); if (/^(data:|blob:|about:)/i.test(u)) route.continue(); else route.abort(); });
    await page.setContent(htmlShell(title, bodyHtml), { waitUntil: 'load', timeout: 30000 });
    const buf = await page.pdf({ format: 'A4', printBackground: true, margin: { top: '16mm', bottom: '16mm', left: '14mm', right: '14mm' } });
    return buf as Buffer;
  } finally { await browser.close().catch(() => {}); }
}
