/**
 * Đính kèm mọi loại file → content block cho Claude.
 * Ảnh/PDF: Claude đọc trực tiếp. Excel/Word: trích text. Text/code: đưa nguyên. Còn lại: ghi chú (không đọc được).
 */
import * as XLSX from 'xlsx';
import mammoth from 'mammoth';

export type InFile = { name: string; type: string; data: string };
const TEXT_CAP = 200_000; // cắt nội dung text để khỏi nổ context

function b64(data: string): string {
  const m = /^data:[^;,]*;base64,(.+)$/s.exec(data);
  return m ? m[1] : data;
}
function buf(data: string): Buffer { return Buffer.from(b64(data), 'base64'); }
function clip(s: string): string { return s.length > TEXT_CAP ? s.slice(0, TEXT_CAP) + '\n…(đã cắt bớt)' : s; }
function human(n: number): string { return n < 1024 ? n + 'B' : n < 1048576 ? (n / 1024).toFixed(0) + 'KB' : (n / 1048576).toFixed(1) + 'MB'; }
function isBinary(s: string): boolean { return /[\x00-\x08\x0e-\x1f]/.test(s.slice(0, 4000)); }

const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|jsonl|xml|html?|js|jsx|ts|tsx|py|java|go|rs|rb|php|c|cpp|h|hpp|cs|sql|ya?ml|toml|ini|env|log|css|scss|less|sh|bash|conf)$/i;
function looksText(type: string, name: string): boolean {
  if (type.startsWith('text/')) return true;
  if (/(json|xml|javascript|csv|html|x-yaml|yaml|markdown|x-sh)/.test(type)) return true;
  return TEXT_EXT.test(name);
}
function noteBlock(name: string, type: string, data: string): any {
  return { type: 'text', text: `📎 [Đính kèm "${name}" (${type || 'không rõ loại'}, ${human(buf(data).length)}) — không đọc trực tiếp được nội dung loại file này.]` };
}

/** 1 file → mảng content block (thường 1 phần tử). Lỗi parse → ghi chú, không throw. */
export async function fileToBlocks(f: InFile): Promise<any[]> {
  const name = f.name || 'file';
  const type = (f.type || '').toLowerCase();
  try {
    if (type.startsWith('image/')) {
      return [{ type: 'image', source: { type: 'base64', media_type: type, data: b64(f.data) } }];
    }
    if (type === 'application/pdf' || /\.pdf$/i.test(name)) {
      return [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64(f.data) }, title: name }];
    }
    if (/sheet|excel/.test(type) || /\.xlsx?$/i.test(name)) {
      const wb = XLSX.read(buf(f.data), { type: 'buffer' });
      let out = '';
      for (const sn of wb.SheetNames) {
        out += `## Sheet: ${sn}\n` + XLSX.utils.sheet_to_csv(wb.Sheets[sn]) + '\n\n';
        if (out.length > TEXT_CAP) break;
      }
      return [{ type: 'text', text: `📎 Excel "${name}" (đã trích sang CSV):\n\n${clip(out) || '(rỗng)'}` }];
    }
    if (/wordprocessing/.test(type) || /\.docx$/i.test(name)) {
      const r = await mammoth.extractRawText({ buffer: buf(f.data) });
      return [{ type: 'text', text: `📎 Word "${name}":\n\n${clip(r.value || '(rỗng)')}` }];
    }
    if (looksText(type, name)) {
      const txt = buf(f.data).toString('utf8');
      if (isBinary(txt)) return [noteBlock(name, type, f.data)];
      return [{ type: 'text', text: `📎 File "${name}":\n\n\`\`\`\n${clip(txt)}\n\`\`\`` }];
    }
    return [noteBlock(name, type, f.data)];
  } catch (e: any) {
    return [{ type: 'text', text: `📎 [Không đọc được file "${name}" (${type}): ${String(e?.message ?? e).slice(0, 120)}]` }];
  }
}
