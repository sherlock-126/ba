/**
 * ba.autonow.vn — Fastify server.
 * Auth email+mật khẩu (theo userId), quản trị user (admin), audit log, chat per-user.
 */
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import httpProxy from '@fastify/http-proxy';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { config, projectByKey, visibleProjects, DEFAULT_PROJECT } from './config.js';
import { COOKIE, login, logout, sessionUser, cookieHeader } from './auth.js';
import {
  listConversations, getConversation, createConversation, appendMessage, deleteConversation,
  appendAudit, listAudit, killUserSessions, type Message,
} from './store.js';
import {
  seedAdmin, listUsers, createUser, updateUser, setPassword, deleteUser, getUserById,
  verifyPassword, countActiveAdmins, type Role, type User,
} from './users.js';
import { runAgent, type ChatMsg } from './ai/agent.js';
import { startAutoPull, refreshNow, getLastPull } from './repos.js';

const app = Fastify({ logger: { level: 'info' } });

// gắn user hiện tại vào request
declare module 'fastify' { interface FastifyRequest { user?: User } }

const audit = (req: any, action: string, target?: string, detail?: string) =>
  appendAudit({ ts: Date.now(), actorId: req.user?.id || '-', actorEmail: req.user?.email || '-', action, target, detail });

// Cho phép khi user CHƯA đổi mật khẩu (mustChangePassword) — chỉ các endpoint này.
const PRE_CHANGE_OK = new Set(['/api/me', '/api/me/password', '/api/logout']);

// ── Auth guard: /api/* (trừ login) cần đăng nhập; /api/users* + /api/audit cần admin ──
app.addHook('onRequest', async (req, reply) => {
  const url = req.url.split('?')[0];
  if (!url.startsWith('/api/') || url === '/api/login') return;
  const u = await sessionUser(req.headers.cookie);
  if (!u) return reply.code(401).send({ error: 'Chưa đăng nhập' });
  req.user = u;
  // Bắt buộc đổi mật khẩu trước khi dùng (chặn cả ở backend, không chỉ FE).
  if (u.mustChangePassword && !PRE_CHANGE_OK.has(url)) {
    return reply.code(403).send({ error: 'Cần đổi mật khẩu trước khi sử dụng', mustChangePassword: true });
  }
  if ((url.startsWith('/api/users') || url === '/api/audit') && u.role !== 'admin') {
    return reply.code(403).send({ error: 'Chỉ admin' });
  }
});

// Rate-limit đăng nhập theo email (chống brute-force). In-memory đủ cho 1 instance.
const loginFails = new Map<string, { n: number; t: number }>();
const RL_WINDOW = 10 * 60 * 1000, RL_MAX = 8;

const me = (u: User) => ({ id: u.id, email: u.email, role: u.role, mustChangePassword: u.mustChangePassword });

// ── Auth ────────────────────────────────────────────────────────
app.post('/api/login', async (req, reply) => {
  const { email, password } = (req.body as any) ?? {};
  const key = String(email ?? '').trim().toLowerCase();
  const fail = loginFails.get(key);
  if (fail && Date.now() - fail.t < RL_WINDOW && fail.n >= RL_MAX) {
    await appendAudit({ ts: Date.now(), actorId: '-', actorEmail: key, action: 'login_blocked' });
    return reply.code(429).send({ error: 'Quá nhiều lần đăng nhập sai. Thử lại sau ít phút.' });
  }
  const r = await login(String(email ?? ''), String(password ?? ''));
  if (!r) {
    const f = loginFails.get(key);
    if (!f || Date.now() - f.t >= RL_WINDOW) loginFails.set(key, { n: 1, t: Date.now() });
    else f.n++;
    await appendAudit({ ts: Date.now(), actorId: '-', actorEmail: key, action: 'login_failed' });
    return reply.code(401).send({ error: 'Sai email hoặc mật khẩu (hoặc tài khoản bị khoá)' });
  }
  loginFails.delete(key); // đăng nhập đúng → reset bộ đếm
  reply.header('Set-Cookie', cookieHeader(r.token));
  await appendAudit({ ts: Date.now(), actorId: r.user.id, actorEmail: r.user.email, action: 'login' });
  return { user: me(r.user) };
});
app.post('/api/logout', async (req) => { await audit(req, 'logout'); await logout(req.headers.cookie); return { ok: true }; });
app.get('/api/me', async (req) => ({ user: me(req.user!) }));
app.post('/api/me/password', async (req, reply) => {
  const { oldPassword, newPassword } = (req.body as any) ?? {};
  const u = req.user!;
  if (!verifyPassword(String(oldPassword ?? ''), u.passwordHash)) return reply.code(400).send({ error: 'Mật khẩu hiện tại không đúng' });
  try { await setPassword(u.id, String(newPassword ?? ''), false); } catch (e: any) { return reply.code(400).send({ error: e.message }); }
  await audit(req, 'change_own_password');
  return { ok: true };
});

// ── Quản trị user (admin) ───────────────────────────────────────
app.get('/api/users', async () => ({ users: await listUsers() }));
app.post('/api/users', async (req, reply) => {
  const { email, password, role } = (req.body as any) ?? {};
  try {
    const u = await createUser(String(email ?? ''), String(password ?? ''), (role === 'admin' ? 'admin' : 'member') as Role);
    await audit(req, 'create_user', u.email, 'role=' + u.role);
    return { user: u };
  } catch (e: any) { return reply.code(400).send({ error: e.message }); }
});
app.patch('/api/users/:id', async (req, reply) => {
  const id = (req.params as any).id; const { role, active } = (req.body as any) ?? {};
  const target = await getUserById(id); if (!target) return reply.code(404).send({ error: 'Không tìm thấy user' });
  if (id === req.user!.id && active === false) return reply.code(400).send({ error: 'Không thể tự khoá chính mình' });
  // chặn khoá / hạ quyền admin cuối cùng
  const removingAdmin = (active === false || role === 'member') && target.role === 'admin' && target.active;
  if (removingAdmin && (await countActiveAdmins()) <= 1) return reply.code(400).send({ error: 'Phải còn ít nhất 1 admin đang hoạt động' });
  const u = await updateUser(id, { role: role === 'admin' || role === 'member' ? role : undefined, active: typeof active === 'boolean' ? active : undefined });
  if (active === false) await killUserSessions(id); // khoá → đá session
  await audit(req, 'update_user', target.email, JSON.stringify({ role, active }));
  return { user: u };
});
app.post('/api/users/:id/reset-password', async (req, reply) => {
  const id = (req.params as any).id; const { password } = (req.body as any) ?? {};
  const target = await getUserById(id); if (!target) return reply.code(404).send({ error: 'Không tìm thấy user' });
  try { await setPassword(id, String(password ?? ''), true); } catch (e: any) { return reply.code(400).send({ error: e.message }); }
  await killUserSessions(id);
  await audit(req, 'reset_password', target.email);
  return { ok: true };
});
app.delete('/api/users/:id', async (req, reply) => {
  const id = (req.params as any).id; const target = await getUserById(id); if (!target) return reply.code(404).send({ error: 'Không tìm thấy user' });
  if (id === req.user!.id) return reply.code(400).send({ error: 'Không thể tự xoá chính mình' });
  if (target.role === 'admin' && target.active && (await countActiveAdmins()) <= 1) return reply.code(400).send({ error: 'Phải còn ít nhất 1 admin' });
  await deleteUser(id); await killUserSessions(id);
  await audit(req, 'delete_user', target.email);
  return { ok: true };
});
app.get('/api/audit', async (req) => ({ entries: await listAudit(Number((req.query as any)?.limit) || 300) }));

// ── Conversations (theo owner) ──────────────────────────────────
// Dự án (project) hiển thị cho user hiện tại (admin thấy cả adminOnly).
app.get('/api/projects', async (req) => ({
  projects: visibleProjects(req.user!.role === 'admin').map((p) => ({ key: p.key, label: p.label, blurb: p.blurb })),
}));
app.get('/api/conversations', async (req) => {
  const project = String((req.query as any)?.project || '') || undefined;
  return { conversations: await listConversations(req.user!.id, project) };
});
app.get('/api/conversations/:id', async (req, reply) => {
  const c = await getConversation((req.params as any).id, req.user!.id);
  if (!c) return reply.code(404).send({ error: 'Không tìm thấy hội thoại' });
  return c;
});
app.delete('/api/conversations/:id', async (req) => { await deleteConversation((req.params as any).id, req.user!.id); return { ok: true }; });

// ── Repos ───────────────────────────────────────────────────────
// Lọc repo theo quyền (adminOnly) + theo DỰ ÁN nếu có ?project= (chỉ repo của dự án đó).
function visibleRepoKeys(req: any): Set<string> {
  const isAdmin = req.user?.role === 'admin';
  let keys = config.repos.filter((r) => isAdmin || !r.adminOnly).map((r) => r.key);
  const proj = projectByKey(String(req.query?.project || ''));
  if (proj && (isAdmin || !proj.adminOnly)) keys = keys.filter((k) => proj.repos.includes(k));
  return new Set(keys);
}
app.post('/api/refresh', async (req) => {
  const allow = visibleRepoKeys(req);
  return { results: (await refreshNow()).filter((x: any) => allow.has(x.repo)) };
});
app.get('/api/status', async (req) => {
  const allow = visibleRepoKeys(req);
  const lp: any = getLastPull();
  return {
    repos: config.repos.filter((r) => allow.has(r.key)).map((r) => ({ key: r.key, label: r.label, branch: r.branch })),
    lastPull: lp ? { ...lp, results: (lp.results || []).filter((x: any) => allow.has(x.repo)) } : lp,
    hasToken: !!config.ai.oauthToken, model: config.ai.model,
  };
});

// ── Chat (SSE) ──────────────────────────────────────────────────
app.post('/api/chat', async (req, reply) => {
  const body = (req.body as any) ?? {};
  const userText: string = String(body.message ?? '').trim();
  let convId: string = String(body.conversationId ?? '');
  const owner = req.user!.id;
  // Ảnh đính kèm (data URL), tối đa 4, mỗi ảnh ≤ 8MB.
  const images: string[] = (Array.isArray(body.images) ? body.images : [])
    .filter((s: any) => typeof s === 'string' && s.startsWith('data:image/') && s.length < 8_000_000).slice(0, 4);
  // File đính kèm mọi loại {name,type,data}, tối đa 6, mỗi file ≤ ~22MB (sau base64).
  const files = (Array.isArray(body.files) ? body.files : [])
    .filter((f: any) => f && typeof f.name === 'string' && typeof f.data === 'string' && f.data.length < 23_000_000)
    .slice(0, 6)
    .map((f: any) => ({ name: String(f.name).slice(0, 200), type: String(f.type || ''), data: f.data }));
  if (!userText && !images.length && !files.length) return reply.code(400).send({ error: 'message rỗng' });

  const isAdmin = req.user!.role === 'admin';
  const visibleProj = new Set(visibleProjects(isAdmin).map((p) => p.key));
  let conv = convId ? await getConversation(convId, owner) : undefined;
  if (!conv) {
    // Dự án từ FE, validate theo quyền (không tin client); mặc định kientre.
    const reqProj = String(body.project || '');
    const projKey = visibleProj.has(reqProj) ? reqProj : DEFAULT_PROJECT;
    convId = randomBytes(8).toString('hex');
    conv = await createConversation(convId, owner, userText || files[0]?.name || '(đính kèm)', projKey);
  }
  // Dự án dùng cho lượt này = dự án của hội thoại; chặn dùng dự án ngoài quyền.
  let project = projectByKey(conv.project ?? DEFAULT_PROJECT);
  if (project?.adminOnly && !isAdmin) project = projectByKey(DEFAULT_PROJECT);
  await appendMessage(convId, { role: 'user', content: userText, ts: Date.now(), images: images.length ? images : undefined,
    files: files.length ? files.map((f: any) => ({ name: f.name, type: f.type })) : undefined }); // lưu tên/loại, không lưu data
  await audit(req, 'chat', convId, userText.slice(0, 500)); // nội dung câu hỏi (audit đầy đủ)

  reply.hijack();
  const raw = reply.raw;
  raw.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  const send = (type: string, data: unknown) => { try { raw.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* gone */ } };
  send('conversation', { id: convId });
  const abortController = new AbortController();
  raw.on('close', () => abortController.abort());
  const history: ChatMsg[] = (conv.messages ?? []).map((m) => ({ role: m.role, content: m.content }));
  const actor = req.user!;
  try {
    const { text } = await runAgent({
      messages: history, abortController, emit: send, images, files, project,
      isAdmin: actor.role === 'admin',
      onAudit: (action, target, detail) => { appendAudit({ ts: Date.now(), actorId: actor.id, actorEmail: actor.email, action, target, detail }); },
    });
    if (text) await appendMessage(convId, { role: 'assistant', content: text, ts: Date.now() });
    send('done', { conversationId: convId });
  } catch (e: any) { send('error', { message: String(e?.message ?? e) }); } finally { raw.end(); }
});

// ── Reverse-proxy /workspace/* → hub Side Projects (labs) trên :3700 (base path /workspace) ──
// Đăng ký TRƯỚC static để thắng catch-all '/'. Auth guard chỉ chặn /api/* nên /workspace đi thẳng;
// hub tự lo auth riêng của nó. Cho phép xem/sửa issue+docs Side Projects tại ba.autonow.vn/workspace.
const SSO_SECRET = process.env.BAHUB_SSO_SECRET || '';
app.register(httpProxy, {
  upstream: process.env.LABS_WS_UPSTREAM || 'http://127.0.0.1:3700',
  prefix: '/workspace',
  rewritePrefix: '/workspace',
  // SSO: chỉ admin ba.autonow đã đăng nhập mới qua; bơm danh tính cho hub (shared secret).
  preHandler: async (req: any, reply: any) => {
    const u = await sessionUser(req.headers.cookie);
    if (!u) {
      if (req.method === 'GET' && String(req.headers.accept || '').includes('text/html')) return reply.redirect('/');
      return reply.code(401).send({ error: 'Chưa đăng nhập ba.autonow' });
    }
    if (u.role !== 'admin') return reply.code(403).send({ error: 'Workspace Side Projects chỉ dành cho admin' });
    req.user = u;
  },
  replyOptions: {
    rewriteRequestHeaders: (req: any, headers: any) => {
      const clean: Record<string, any> = { ...headers };
      for (const k of Object.keys(clean)) if (k.toLowerCase().startsWith('x-bahub-')) delete clean[k]; // chống client giả header
      const u = req.user;
      if (u && SSO_SECRET) {
        clean['x-bahub-auth'] = SSO_SECRET;
        clean['x-bahub-email'] = u.email;
        clean['x-bahub-name'] = String(u.email).split('@')[0];
      }
      return clean;
    },
  },
});

// ── Static web ──────────────────────────────────────────────────
app.register(fastifyStatic, {
  root: resolve(process.cwd(), 'web'),
  prefix: '/',
  setHeaders: (res, path) => {
    // SW + manifest: không cache HTTP để bản PWA mới lan ngay (asset có hash tự cache-bust).
    if (/(?:sw\.js|workbox-[^/]+\.js|manifest\.webmanifest)$/.test(path)) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  },
});

// ── Start ───────────────────────────────────────────────────────
await seedAdmin();
startAutoPull();
app.listen({ port: config.app.port, host: config.app.host })
  .then(() => console.log(`[ba] listening on :${config.app.port}`))
  .catch((e) => { console.error(e); process.exit(1); });
