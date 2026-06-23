/**
 * Tiện ích DOCS cho workspace hub.
 * - Hub markdown (ERP/workspace-standalone): docs = field `content_md`.
 * - Hub BlockNote (marketing/dhco/thghub): docs = field `body_blocknote` (JSON blocks; viewer CHỈ render cái này).
 *   → cần convert markdown (agent viết) sang mảng BlockNote blocks; mermaid là custom block {type:'mermaid'}.
 */
import { randomUUID } from 'node:crypto';

type Style = Record<string, boolean>;
type Run = { type: 'text'; text: string; styles: Style } | { type: 'link'; href: string; content: { type: 'text'; text: string; styles: Style }[] };

const props = (extra: Record<string, any> = {}) => ({ backgroundColor: 'default', textColor: 'default', textAlignment: 'left', ...extra });
const block = (type: string, p: any, content?: any[]) => ({ id: randomUUID(), type, props: p, ...(content !== undefined ? { content } : {}), children: [] as any[] });

/** Inline markdown → các run BlockNote (bold/italic/code/link). */
function parseInline(text: string): Run[] {
  const runs: Run[] = [];
  const re = /(\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)]+)\)|\*([^*]+)\*|_([^_]+)_)/g;
  let last = 0, m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) runs.push({ type: 'text', text: text.slice(last, m.index), styles: {} });
    if (m[2] !== undefined) runs.push({ type: 'text', text: m[2], styles: { bold: true } });
    else if (m[3] !== undefined) runs.push({ type: 'text', text: m[3], styles: { code: true } });
    else if (m[4] !== undefined) runs.push({ type: 'link', href: m[5], content: [{ type: 'text', text: m[4], styles: {} }] });
    else if (m[6] !== undefined) runs.push({ type: 'text', text: m[6], styles: { italic: true } });
    else if (m[7] !== undefined) runs.push({ type: 'text', text: m[7], styles: { italic: true } });
    last = re.lastIndex;
  }
  if (last < text.length) runs.push({ type: 'text', text: text.slice(last), styles: {} });
  return runs.length ? runs : [{ type: 'text', text, styles: {} }];
}

const SPECIAL = /^(#{1,3}\s|```|[-*]\s|\d+\.\s|>\s?|\s*\|)/;

/** Markdown → mảng BlockNote blocks (đủ cho docs BA: heading/đoạn/list/mermaid/code/quote/bảng). */
export function mdToBlockNote(md: string): any[] {
  const lines = String(md || '').replace(/\r/g, '').split('\n');
  const out: any[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = /^```(\w*)/.exec(line.trim());
    if (fence) {
      const lang = fence[1] || '';
      const buf: string[] = []; i++;
      while (i < lines.length && !/^```/.test(lines[i].trim())) { buf.push(lines[i]); i++; }
      i++; // bỏ dòng đóng ```
      const code = buf.join('\n');
      if (lang === 'mermaid') out.push(block('mermaid', { code }));
      else out.push(block('codeBlock', props({ language: lang || 'text' }), [{ type: 'text', text: code, styles: {} }]));
      continue;
    }
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) { out.push(block('heading', props({ level: h[1].length }), parseInline(h[2]))); i++; continue; }
    if (/^---+$/.test(line.trim())) { i++; continue; }
    if (/^>\s?/.test(line)) { out.push(block('quote', props(), parseInline(line.replace(/^>\s?/, '')))); i++; continue; }
    // Bảng markdown → degrade: hàng đầu = tiêu đề (đậm), các hàng sau = bulletListItem "cột: giá trị".
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        const cells = lines[i].trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
        if (!cells.every((c) => /^:?-{2,}:?$/.test(c) || c === '')) rows.push(cells); // bỏ hàng phân cách ---
        i++;
      }
      if (rows.length) {
        const header = rows[0];
        out.push(block('paragraph', props(), [{ type: 'text', text: header.join('  |  '), styles: { bold: true } }]));
        for (const r of rows.slice(1)) {
          const txt = header.map((hd, k) => `${hd}: ${r[k] ?? ''}`).join(' · ');
          out.push(block('bulletListItem', props(), parseInline(txt)));
        }
      }
      continue;
    }
    const b = /^[-*]\s+(.*)$/.exec(line);
    if (b) { out.push(block('bulletListItem', props(), parseInline(b[1]))); i++; continue; }
    const n = /^\d+\.\s+(.*)$/.exec(line);
    if (n) { out.push(block('numberedListItem', props(), parseInline(n[1]))); i++; continue; }
    if (!line.trim()) { i++; continue; }
    const para = [line]; i++;
    while (i < lines.length && lines[i].trim() && !SPECIAL.test(lines[i]) && !/^---+$/.test(lines[i].trim())) { para.push(lines[i]); i++; }
    out.push(block('paragraph', props(), parseInline(para.join(' '))));
  }
  if (!out.length) out.push(block('paragraph', props(), []));
  return out;
}

/** BlockNote blocks → markdown thô (để đọc lại doc + đối chiếu code). */
export function blockNoteToText(blocks: any[]): string {
  const runText = (content: any): string => Array.isArray(content)
    ? content.map((r: any) => (r.type === 'link' ? runText(r.content) : (r.text || ''))).join('')
    : '';
  const lines: string[] = [];
  const walk = (arr: any[]) => {
    for (const bk of arr || []) {
      const t = runText(bk.content);
      if (bk.type === 'heading') lines.push('#'.repeat(bk.props?.level || 1) + ' ' + t);
      else if (bk.type === 'bulletListItem') lines.push('- ' + t);
      else if (bk.type === 'numberedListItem') lines.push('1. ' + t);
      else if (bk.type === 'quote') lines.push('> ' + t);
      else if (bk.type === 'mermaid') lines.push('```mermaid\n' + (bk.props?.code || '') + '\n```');
      else if (bk.type === 'codeBlock') lines.push('```' + (bk.props?.language || '') + '\n' + t + '\n```');
      else lines.push(t);
      if (Array.isArray(bk.children) && bk.children.length) walk(bk.children);
    }
  };
  walk(blocks || []);
  return lines.join('\n\n');
}

/** title → slug hợp lệ [a-z0-9_-]. */
export function slugify(title: string): string {
  return String(title || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'd')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'doc-' + Date.now();
}

/** Dựng payload tạo/sửa doc đúng định dạng hub. */
export function buildDocPayload(format: 'markdown' | 'blocknote', d: { id?: string; title?: string; group_title?: string; md: string }) {
  const base: any = {};
  if (d.id) base.id = d.id;
  if (d.title) base.title = d.title;
  if (d.group_title) base.group_title = d.group_title;
  if (format === 'blocknote') { base.body_blocknote = mdToBlockNote(d.md); base.body_md = d.md; }
  else base.content_md = d.md;
  return base;
}
