/**
 * Lưu trữ file do AI sinh ra (Excel/PDF/Word/HTML) để tải về + chia sẻ public.
 * Bytes lưu ra đĩa data/generated/<id>.<ext>; metadata index JSON data/generated.json.
 */
import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { config } from './config.js';

export type FileKind = 'excel' | 'word' | 'pdf' | 'html';
export type GenFile = {
  id: string; owner: string; kind: FileKind; filename: string; mime: string;
  createdAt: number; expiresAt: number; shareToken: string;
};

const DATA_DIR = resolve(process.cwd(), 'data');
const GEN_DIR = resolve(DATA_DIR, 'generated');
const INDEX_FILE = resolve(DATA_DIR, 'generated.json');
const TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 ngày

export const KIND_EXT: Record<FileKind, string> = { excel: 'xlsx', word: 'docx', pdf: 'pdf', html: 'html' };
export const KIND_MIME: Record<FileKind, string> = {
  excel: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  word: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pdf: 'application/pdf',
  html: 'text/html; charset=utf-8',
};
// pdf/html xem thẳng trên trình duyệt (inline); excel/word tải về (attachment).
export const isInline = (k: FileKind) => k === 'pdf' || k === 'html';

let index: GenFile[] | null = null;
let writing: Promise<void> = Promise.resolve();
async function idx(): Promise<GenFile[]> {
  if (!index) { try { index = JSON.parse(await readFile(INDEX_FILE, 'utf8')); } catch { index = []; } }
  return index ?? [];
}
async function persist() {
  const data = index ?? [];
  writing = writing.then(async () => { await mkdir(dirname(INDEX_FILE), { recursive: true }); await writeFile(INDEX_FILE, JSON.stringify(data, null, 2)); });
  return writing;
}
function pathOf(f: GenFile) { return resolve(GEN_DIR, `${f.id}.${KIND_EXT[f.kind]}`); }

function sanitize(name: string, kind: FileKind): string {
  const base = String(name || 'bao-cao').replace(/[^\p{L}\p{N}\-_ .]+/gu, '').replace(/\.(xlsx|docx|pdf|html?)$/i, '').trim().slice(0, 60) || 'bao-cao';
  return `${base}.${KIND_EXT[kind]}`;
}

export type SavedFile = { id: string; kind: FileKind; filename: string; downloadUrl: string; viewUrl: string; shareUrl: string };

export async function saveGenerated(owner: string, kind: FileKind, filename: string, buffer: Buffer): Promise<SavedFile> {
  await sweep().catch(() => {});
  const list = await idx();
  const id = randomBytes(8).toString('hex');
  const shareToken = randomBytes(16).toString('hex');
  const rec: GenFile = { id, owner, kind, filename: sanitize(filename, kind), mime: KIND_MIME[kind], createdAt: Date.now(), expiresAt: Date.now() + TTL_MS, shareToken };
  await mkdir(GEN_DIR, { recursive: true });
  await writeFile(pathOf(rec), buffer);
  list.push(rec); await persist();
  const base = config.public.baseUrl.replace(/\/$/, '');
  return { id, kind, filename: rec.filename, downloadUrl: `/api/files/${id}`, viewUrl: `${base}/f/${shareToken}`, shareUrl: `${base}/f/${shareToken}` };
}

async function readBytes(f: GenFile): Promise<{ rec: GenFile; bytes: Buffer } | null> {
  if (Date.now() > f.expiresAt) return null;
  try { return { rec: f, bytes: await readFile(pathOf(f)) }; } catch { return null; }
}

export async function getById(id: string, owner: string) {
  const f = (await idx()).find((x) => x.id === id);
  if (!f || f.owner !== owner) return null;
  return readBytes(f);
}
export async function getByToken(token: string) {
  const f = (await idx()).find((x) => x.shareToken === token);
  if (!f) return null;
  return readBytes(f);
}

function htmlPathOf(f: GenFile) { return resolve(GEN_DIR, `${f.id}.html`); }

// Metadata (kiểm chủ sở hữu + hạn) — cho các route preview/edit.
export async function getRec(id: string, owner: string): Promise<GenFile | null> {
  const f = (await idx()).find((x) => x.id === id);
  if (!f || f.owner !== owner || Date.now() > f.expiresAt) return null;
  return f;
}

// Ghi đè bytes file (Excel sau khi sửa).
export async function updateBytes(id: string, owner: string, buf: Buffer): Promise<boolean> {
  const f = await getRec(id, owner);
  if (!f) return false;
  await writeFile(pathOf(f), buf);
  return true;
}

// Lấy HTML cho editor: word → sidecar .html nếu có, không thì mammoth(docx); html → chính file .html.
export async function readHtml(id: string, owner: string): Promise<string | null> {
  const f = await getRec(id, owner);
  if (!f) return null;
  if (f.kind === 'html') { try { return await readFile(pathOf(f), 'utf8'); } catch { return ''; } }
  if (f.kind === 'word') {
    try { return await readFile(htmlPathOf(f), 'utf8'); } catch { /* chưa có sidecar → mammoth */ }
    try { const { docxToHtml } = await import('./ai/docgen.js'); return await docxToHtml(await readFile(pathOf(f))); } catch { return ''; }
  }
  return null;
}

// Lưu HTML từ editor: html → ghi thẳng; word → sidecar .html (nguồn chuẩn) + best-effort regenerate .docx.
export async function writeHtml(id: string, owner: string, html: string): Promise<{ ok: boolean; docxWarning?: string } | null> {
  const f = await getRec(id, owner);
  if (!f) return null;
  if (f.kind === 'html') { await writeFile(pathOf(f), html, 'utf8'); return { ok: true }; }
  if (f.kind === 'word') {
    await writeFile(htmlPathOf(f), html, 'utf8'); // lưu nguồn chuẩn trước (không mất sửa)
    try { const { htmlToDocx } = await import('./ai/docgen.js'); await writeFile(pathOf(f), await htmlToDocx(html)); return { ok: true }; }
    catch (e: any) { return { ok: true, docxWarning: String(e?.message ?? e) }; }
  }
  return null;
}

// Xoá file + metadata đã quá hạn.
export async function sweep() {
  const list = await idx();
  const now = Date.now();
  const dead = list.filter((f) => now > f.expiresAt);
  if (!dead.length) return;
  for (const f of dead) { try { await unlink(pathOf(f)); } catch { /* đã mất */ } }
  index = list.filter((f) => now <= f.expiresAt);
  await persist();
}
