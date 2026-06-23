/**
 * Lưu trữ JSON file: hội thoại (theo owner) + session (theo userId) + audit log.
 */
import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';

const DATA_DIR = resolve(process.cwd(), 'data');
const CONV_FILE = resolve(DATA_DIR, 'conversations.json');
const SESS_FILE = resolve(DATA_DIR, 'sessions.json');
const AUDIT_FILE = resolve(DATA_DIR, 'audit.jsonl');

export type Message = { role: 'user' | 'assistant'; content: string; ts: number; images?: string[]; files?: { name: string; type: string }[] };
export type Conversation = { id: string; owner: string; project?: string; title: string; createdAt: number; updatedAt: number; messages: Message[] };
type SessionRec = { userId: string; createdAt: number };

let convs: Conversation[] | null = null;
let sessions: Record<string, SessionRec> | null = null;
let writing: Promise<void> = Promise.resolve();

async function load<T>(file: string, fallback: T): Promise<T> {
  try { return JSON.parse(await readFile(file, 'utf8')) as T; } catch { return fallback; }
}
async function persist(file: string, data: unknown) {
  writing = writing.then(async () => { await mkdir(dirname(file), { recursive: true }); await writeFile(file, JSON.stringify(data, null, 2)); });
  return writing;
}
async function convsRef(): Promise<Conversation[]> { if (!convs) convs = await load<Conversation[]>(CONV_FILE, []); return convs; }
async function sessRef(): Promise<Record<string, SessionRec>> { if (!sessions) sessions = await load<Record<string, SessionRec>>(SESS_FILE, {}); return sessions; }

// ── Conversations (theo owner) ──────────────────────────────────
export async function listConversations(owner: string, project?: string): Promise<Array<Omit<Conversation, 'messages'>>> {
  return (await convsRef())
    .filter((c) => c.owner === owner && (!project || (c.project ?? 'kientre') === project))
    .sort((a, b) => b.updatedAt - a.updatedAt).map(({ messages, ...meta }) => meta);
}
export async function getConversation(id: string, owner: string): Promise<Conversation | undefined> {
  const c = (await convsRef()).find((x) => x.id === id);
  return c && c.owner === owner ? c : undefined; // chặn xem chéo
}
export async function createConversation(id: string, owner: string, title: string, project?: string): Promise<Conversation> {
  const all = await convsRef();
  const c: Conversation = { id, owner, project: project || 'kientre', title: title.slice(0, 80), createdAt: Date.now(), updatedAt: Date.now(), messages: [] };
  all.push(c); await persist(CONV_FILE, all); return c;
}
export async function appendMessage(id: string, msg: Message): Promise<void> {
  const all = await convsRef(); const c = all.find((x) => x.id === id); if (!c) return;
  c.messages.push(msg); c.updatedAt = Date.now(); await persist(CONV_FILE, all);
}
export async function deleteConversation(id: string, owner: string): Promise<void> {
  const all = await convsRef(); const i = all.findIndex((x) => x.id === id && x.owner === owner);
  if (i >= 0) { all.splice(i, 1); await persist(CONV_FILE, all); }
}

// ── Sessions (token → userId) ───────────────────────────────────
export async function createSession(token: string, userId: string): Promise<void> {
  const s = await sessRef(); s[token] = { userId, createdAt: Date.now() }; await persist(SESS_FILE, s);
}
export async function getSession(token: string | undefined, ttlMs: number): Promise<SessionRec | null> {
  if (!token) return null;
  const s = await sessRef(); const rec = s[token]; if (!rec) return null;
  if (Date.now() - rec.createdAt > ttlMs) { delete s[token]; await persist(SESS_FILE, s); return null; }
  return rec;
}
export async function deleteSession(token: string | undefined): Promise<void> {
  if (!token) return; const s = await sessRef(); if (s[token]) { delete s[token]; await persist(SESS_FILE, s); }
}
/** Vô hiệu toàn bộ session của 1 user (khi bị khoá/đổi mật khẩu/xoá). */
export async function killUserSessions(userId: string): Promise<void> {
  const s = await sessRef(); let changed = false;
  for (const t of Object.keys(s)) if (s[t].userId === userId) { delete s[t]; changed = true; }
  if (changed) await persist(SESS_FILE, s);
}

// ── Audit log (append JSONL) ────────────────────────────────────
export type AuditEntry = { ts: number; actorId: string; actorEmail: string; action: string; target?: string; detail?: string };
export async function appendAudit(e: AuditEntry): Promise<void> {
  try { await mkdir(DATA_DIR, { recursive: true }); await appendFile(AUDIT_FILE, JSON.stringify(e) + '\n'); } catch { /* best-effort */ }
}
export async function listAudit(limit = 200): Promise<AuditEntry[]> {
  try {
    const lines = (await readFile(AUDIT_FILE, 'utf8')).split('\n').filter(Boolean);
    return lines.slice(-limit).reverse().map((l) => JSON.parse(l));
  } catch { return []; }
}
