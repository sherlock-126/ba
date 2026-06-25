/**
 * In-process MCP server — bộ tool ĐỌC CODE (read-only) cho agent.
 * Mọi truy cập file bị "giam" trong các thư mục repo (config.repos[].path) — chống path traversal.
 * Không có tool ghi/chạy lệnh tuỳ ý: agent chỉ liệt kê / đọc / grep / xem git (read-only).
 */
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { rgPath } from '@vscode/ripgrep';
import { z } from 'zod';
import { spawn } from 'node:child_process';
import { readFile, readdir, stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { config, type RepoCfg } from '../config.js';
import { wsRequest, type WsKey } from '../workspaces.js';
import { runReadOnlyQuery, listTables, describeTable, dbAvailable, dbKeys } from '../db.js';
import { fetchLogs, serverStatus, listServers, serverKeys, serverByKey, readServerEnv, apiCall } from '../servers.js';
import { buildDocPayload, blockNoteToText, slugify } from '../docs.js';
import { buildExcel, buildWord, buildPdf, htmlShell } from './docgen.js';
import { saveGenerated } from '../generated-files.js';

// ripgrep binary tuyệt đối (không dựa vào `rg` trên PATH — môi trường này rg chỉ là shell function).
const RG = rgPath;

const MAX_PAYLOAD = 40_000; // ~40KB text trả model mỗi lần
const IGNORE_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.next', 'target', 'out', '.turbo', 'coverage']);

function asText(obj: unknown) {
  let s = typeof obj === 'string' ? obj : JSON.stringify(obj, null, 0);
  if (s.length > MAX_PAYLOAD) s = s.slice(0, MAX_PAYLOAD) + '\n…(đã cắt bớt — đọc tiếp bằng offset/limit hoặc thu hẹp truy vấn)';
  return { content: [{ type: 'text' as const, text: s }] };
}

// ── fetch_url: đọc URL công khai (GET) — guard SSRF chặn nội bộ/metadata ──
function isPrivateIp(ipRaw: string): boolean {
  const ip = ipRaw.replace(/^\[|\]$/g, '').split('%')[0];
  const v4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (v4) return isPrivateIp(v4[1]);
  if (ip === '::1' || ip === '::' || /^(127\.|0\.|10\.|192\.168\.|169\.254\.)/.test(ip)) return true;
  const m = /^172\.(\d+)\./.exec(ip); if (m && +m[1] >= 16 && +m[1] <= 31) return true;
  if (/^(fc|fd|fe80:)/i.test(ip)) return true; // IPv6 ULA / link-local
  return false;
}
async function assertPublicUrl(raw: string): Promise<URL> {
  let u: URL;
  try { u = new URL(raw); } catch { throw new Error('URL không hợp lệ'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Chỉ hỗ trợ http/https');
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) throw new Error('Chặn host nội bộ');
  if (isIP(host)) { if (isPrivateIp(host)) throw new Error('Chặn IP nội bộ/riêng tư'); return u; }
  let addrs;
  try { addrs = await lookup(host, { all: true }); } catch { throw new Error('Không phân giải được tên miền'); }
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw new Error('Tên miền trỏ tới địa chỉ nội bộ — bị chặn');
  return u;
}
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<\/(p|div|h[1-6]|li|tr|br|section|article|head)\s*>/gi, '\n').replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}
async function readCapped(res: Response, cap: number): Promise<string> {
  if (Number(res.headers.get('content-length') || 0) > cap) throw new Error('Nội dung quá lớn (>8MB)');
  const reader = res.body?.getReader();
  if (!reader) return (await res.text()).slice(0, cap * 2);
  const chunks: Uint8Array[] = []; let total = 0;
  for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    if (value) { total += value.length; if (total > cap) { await reader.cancel().catch(() => {}); throw new Error('Nội dung quá lớn (>8MB)'); } chunks.push(value); }
  }
  const out = new Uint8Array(total); let o = 0; for (const c of chunks) { out.set(c, o); o += c.length; }
  return new TextDecoder('utf-8').decode(out);
}
async function safeFetch(raw: string): Promise<{ status: number; contentType: string; body: string }> {
  let url = raw;
  for (let hop = 0; hop < 4; hop++) {
    const u = await assertPublicUrl(url);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    let res: Response;
    try {
      res = await fetch(u.toString(), { method: 'GET', redirect: 'manual', signal: ctrl.signal,
        // UA trình duyệt (nhiều WAF chặn UA "bot" → trả 500), kèm Accept rõ.
        headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36', Accept: 'application/json, text/html, text/*, */*', 'Accept-Language': 'en-US,en;q=0.9' } });
    } finally { clearTimeout(timer); }
    const loc = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && loc) { url = new URL(loc, u).toString(); continue; } // re-validate hop kế
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    let body = await readCapped(res, 8 * 1024 * 1024);
    if (/json/.test(ct) || /\.json(\?|$)/i.test(u.pathname)) { try { body = JSON.stringify(JSON.parse(body), null, 2); } catch { /* giữ nguyên */ } }
    else if (/html/.test(ct) || /^\s*(<!doctype html|<html)/i.test(body)) body = htmlToText(body);
    return { status: res.status, contentType: ct, body };
  }
  throw new Error('Quá nhiều chuyển hướng (redirect)');
}

/** Giải đường dẫn an toàn: bắt buộc nằm trong repo.path. Trả về absolute hoặc null nếu vi phạm. */
function safeResolve(repo: RepoCfg, rel: string): string | null {
  const abs = resolve(repo.path, rel || '.');
  const root = resolve(repo.path);
  if (abs !== root && !abs.startsWith(root + sep)) return null;
  return abs;
}

/** Chạy lệnh read-only (rg/git), trả stdout. Không dùng shell (mảng args) → an toàn injection. */
function run(cmd: string, args: string[], cwd: string, timeoutMs = 15000): Promise<{ out: string; code: number }> {
  return new Promise((res) => {
    const p = spawn(cmd, args, { cwd });
    let out = '';
    let err = '';
    const t = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.stdout.on('data', (d) => { out += d; if (out.length > MAX_PAYLOAD * 2) p.kill('SIGKILL'); });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => { clearTimeout(t); res({ out: out || err, code: code ?? -1 }); });
    p.on('error', (e) => { clearTimeout(t); res({ out: 'Lỗi chạy lệnh: ' + String(e), code: -1 }); });
  });
}

export type ToolCtx = {
  emit: (type: string, data: unknown) => void;
  userId?: string;                                         // chủ sở hữu file sinh ra (cho /api/files/:id)
  sheetOpen?: boolean;                                     // copilot: đang mở Excel → bật tool fill_cells
  docOpen?: boolean;                                       // copilot: đang mở Word/HTML → bật tool edit_doc
  isAdmin?: boolean;                                       // admin → bật tool DB/log server + repo/workspace adminOnly
  onAudit?: (action: string, target?: string, detail?: string) => void;
  // Scope theo DỰ ÁN: nếu có, chỉ cho phép đúng các key này (chồng lên admin-gating).
  repoKeys?: string[]; wsKeys?: string[]; dbKeys?: string[]; serverKeys?: string[];
};

export function createCodeMcp(ctx: ToolCtx) {
  // Lọc theo quyền (adminOnly) + theo dự án (repoKeys). repo phải qua cả hai.
  const visibleRepos = () => config.repos.filter((r) => (ctx.isAdmin || !r.adminOnly) && (!ctx.repoKeys || ctx.repoKeys.includes(r.key)));
  const findRepo = (key: string): RepoCfg | undefined => visibleRepos().find((r) => r.key === key);
  const repoList = () => visibleRepos().map((r) => `${r.key} (${r.label})`).join(', ');

  const tools: any[] = [
    tool(
      'list_repos',
      'Liệt kê các repo đang phục vụ kèm mô tả + cấu trúc thư mục cấp cao. Gọi đầu tiên để định hướng.',
      {},
      async () => {
        const out: any[] = [];
        for (const r of visibleRepos()) {
          let top: string[] = [];
          try {
            const entries = await readdir(r.path, { withFileTypes: true });
            top = entries.filter((e) => !IGNORE_DIRS.has(e.name) && !e.name.startsWith('.'))
              .map((e) => e.isDirectory() ? e.name + '/' : e.name).sort();
          } catch { /* repo chưa clone */ }
          out.push({ key: r.key, label: r.label, branch: r.branch, blurb: r.blurb, topLevel: top });
        }
        return asText({ repos: out });
      }
    ),

    tool(
      'list_files',
      `Liệt kê file/thư mục trong 1 repo (đệ quy theo glob). repo ∈ {${repoList()}}. path = thư mục con (rỗng = gốc). pattern = glob ripgrep (vd "**/*.ts"). Tự bỏ qua node_modules/.git/build…`,
      {
        repo: z.string().describe('key repo: ' + config.repos.map((r) => r.key).join(' | ')),
        path: z.string().optional().describe('thư mục con tương đối, rỗng = gốc repo'),
        pattern: z.string().optional().describe('glob lọc file, vd "**/*.tsx" hoặc "*.java"'),
      },
      async ({ repo, path, pattern }) => {
        const r = findRepo(repo);
        if (!r) return asText({ error: `repo "${repo}" không tồn tại. Có: ${repoList()}` });
        const base = safeResolve(r, path || '.');
        if (!base) return asText({ error: 'path không hợp lệ (ra ngoài repo).' });
        // rg --files: liệt kê file (đã tôn trọng .gitignore + ignore mặc định).
        const args = ['--files'];
        if (pattern) args.push('-g', pattern);
        for (const d of IGNORE_DIRS) args.push('-g', `!${d}/`);
        const { out } = await run(RG, args, base);
        const files = out.split('\n').filter(Boolean).slice(0, 800);
        return asText({ repo: r.key, base: path || '.', count: files.length, files });
      }
    ),

    tool(
      'read_file',
      `Đọc nội dung 1 file trong repo theo lát dòng. repo ∈ {${repoList()}}. path = đường dẫn tương đối trong repo. offset = dòng bắt đầu (1-based), limit = số dòng (mặc định 400). File dài → đọc nhiều lần tăng offset.`,
      {
        repo: z.string(),
        path: z.string().describe('đường dẫn file tương đối trong repo'),
        offset: z.number().int().min(1).optional(),
        limit: z.number().int().min(1).max(1500).optional(),
      },
      async ({ repo, path, offset, limit }) => {
        const r = findRepo(repo);
        if (!r) return asText({ error: `repo "${repo}" không tồn tại.` });
        const abs = safeResolve(r, path);
        if (!abs) return asText({ error: 'path không hợp lệ (ra ngoài repo).' });
        try {
          const st = await stat(abs);
          if (st.isDirectory()) return asText({ error: `"${path}" là thư mục — dùng list_files.` });
          if (st.size > 2_000_000) return asText({ error: 'File quá lớn (>2MB), có thể là file build/binary.' });
          const content = await readFile(abs, 'utf8');
          const lines = content.split('\n');
          const start = (offset ?? 1) - 1;
          const lim = limit ?? 400;
          const slice = lines.slice(start, start + lim);
          const numbered = slice.map((l, i) => `${start + i + 1}\t${l}`).join('\n');
          return asText({
            repo: r.key, path, totalLines: lines.length,
            shown: `${start + 1}-${Math.min(start + lim, lines.length)}`,
            hasMore: start + lim < lines.length,
            content: numbered,
          });
        } catch (e: any) {
          return asText({ error: 'Không đọc được: ' + String(e?.message ?? e) });
        }
      }
    ),

    tool(
      'grep_code',
      `Tìm chuỗi/regex trong code bằng ripgrep. repo ∈ {${repoList()}} (bỏ trống = tìm cả 2 repo). pattern = regex. glob = lọc loại file (vd "*.ts"). Trả về dòng khớp kèm số dòng + đường dẫn. Đây là cách chính để định vị logic.`,
      {
        pattern: z.string().describe('regex cần tìm'),
        repo: z.string().optional().describe('giới hạn 1 repo; bỏ trống = cả hai'),
        glob: z.string().optional().describe('lọc file, vd "*.java" hoặc "*.tsx"'),
        ignoreCase: z.boolean().optional(),
      },
      async ({ pattern, repo, glob, ignoreCase }) => {
        const targets = repo ? visibleRepos().filter((r) => r.key === repo) : visibleRepos();
        if (!targets.length) return asText({ error: `repo "${repo}" không tồn tại.` });
        const results: any[] = [];
        for (const r of targets) {
          const args = ['--line-number', '--no-heading', '--color', 'never', '-m', '40'];
          if (ignoreCase) args.push('-i');
          if (glob) args.push('-g', glob);
          for (const d of IGNORE_DIRS) args.push('-g', `!${d}/`);
          args.push('-e', pattern, '.');
          const { out } = await run(RG, args, r.path);
          const hits = out.split('\n').filter(Boolean).slice(0, 60)
            .map((line) => `${r.key}/${line}`);
          results.push(...hits);
        }
        return asText({ pattern, matchCount: results.length, matches: results.slice(0, 120) });
      }
    ),

    tool(
      'ask_user',
      'Hỏi lại người dùng khi câu hỏi mơ hồ (nhiều cách hiểu). Sau khi gọi, DỪNG và chờ người dùng trả lời.',
      { question: z.string(), options: z.array(z.string()).optional() },
      async ({ question, options }) => {
        ctx.emit('ask_user', { question, options: options ?? [] });
        return asText({ ok: true, note: 'Đã gửi câu hỏi cho người dùng. DỪNG và chờ phản hồi.' });
      }
    ),
  ];

  // ── Tool quản lý ISSUE 2 workspace (READ + CREATE + UPDATE; KHÔNG delete) ──
  const wsKeys = Object.keys(config.workspaces).filter((k) => (ctx.isAdmin || !config.workspaces[k].adminOnly) && (!ctx.wsKeys || ctx.wsKeys.includes(k)));
  // Dự án không có workspace (vd Side Projects) → bỏ qua toàn bộ tool workspace (tránh z.enum rỗng).
  if (wsKeys.length) {
  const wsEnum = z.enum(wsKeys as [string, ...string[]]).describe('workspace issue: ' + wsKeys.map((k) => `${k} = ${config.workspaces[k].label}`).join(' | '));
  const qs = (o: Record<string, any>) =>
    Object.entries(o).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');

  tools.push(
    tool(
      'workspace_list_modules',
      'Liệt kê module (kèm id_prefix) của 1 workspace issue. GỌI TRƯỚC khi tạo issue để chọn đúng module.',
      { workspace: wsEnum },
      async ({ workspace }) => {
        const r = await wsRequest(workspace as WsKey, 'GET', '/api/issue-modules');
        return asText(r.ok ? r.data : { error: `lỗi ${r.status}`, detail: r.data });
      }
    ),
    tool(
      'workspace_list_issues',
      'Liệt kê issue của 1 workspace, lọc theo module/status/sprint (tuỳ chọn).',
      { workspace: wsEnum, module: z.string().optional(), status: z.string().optional(), sprint: z.string().optional() },
      async ({ workspace, module, status, sprint }) => {
        const q = qs({ module, status, sprint });
        const r = await wsRequest(workspace as WsKey, 'GET', `/api/issues${q ? '?' + q : ''}`);
        return asText(r.ok ? r.data : { error: `lỗi ${r.status}`, detail: r.data });
      }
    ),
    tool(
      'workspace_get_issue',
      'Lấy chi tiết 1 issue (kèm comments) theo mã (vd KT-STD-001 / KTM-CMP-002).',
      { workspace: wsEnum, id: z.string() },
      async ({ workspace, id }) => {
        const r = await wsRequest(workspace as WsKey, 'GET', `/api/issues/${encodeURIComponent(id)}`);
        return asText(r.ok ? r.data : { error: `lỗi ${r.status}`, detail: r.data });
      }
    ),
    tool(
      'workspace_create_issue',
      'Tạo issue mới. module phải là id hợp lệ (xem workspace_list_modules). description_md/resolution_md viết theo house style (ERP: Overview/BR/R/EC + AC Given-When-Then; Marketing: Mục tiêu/Phạm vi/Quy tắc/Flow + AC checklist). Marketing yêu cầu chất lượng đủ cao mới tạo được.',
      {
        workspace: wsEnum,
        title: z.string(),
        description_md: z.string(),
        module: z.string().describe('id module (vd students / campaigns)'),
        type: z.enum(['bug', 'feature', 'suggestion', 'ux']).optional(),
        severity: z.enum(['low', 'medium', 'high']).optional(),
        status: z.string().optional(),
        resolution_md: z.string().optional().describe('Acceptance Criteria'),
      },
      async ({ workspace, title, description_md, module, type, severity, status, resolution_md }) => {
        const r = await wsRequest(workspace as WsKey, 'POST', '/api/issues', {
          title, description_md, module, type, severity, status, resolution_md,
        });
        return asText(r.ok ? { ok: true, issue: r.data?.issue ?? r.data } : { ok: false, error: `lỗi ${r.status}`, detail: r.data });
      }
    ),
    tool(
      'workspace_update_issue',
      'Cập nhật 1 issue theo mã. Chỉ gửi field cần đổi (title/description_md/resolution_md/status/severity/type/module/assignee_user_id/sprint_id/due_date).',
      {
        workspace: wsEnum, id: z.string(),
        title: z.string().optional(), description_md: z.string().optional(), resolution_md: z.string().optional(),
        status: z.string().optional(), severity: z.enum(['low', 'medium', 'high']).optional(),
        type: z.enum(['bug', 'feature', 'suggestion', 'ux']).optional(), module: z.string().optional(),
        sprint_id: z.string().optional(), due_date: z.string().optional(),
      },
      async ({ workspace, id, ...fields }) => {
        const body: Record<string, any> = {};
        for (const [k, v] of Object.entries(fields)) if (v !== undefined) body[k] = v;
        const r = await wsRequest(workspace as WsKey, 'PUT', `/api/issues/${encodeURIComponent(id)}`, body);
        return asText(r.ok ? { ok: true, issue: r.data?.issue ?? r.data } : { ok: false, error: `lỗi ${r.status}`, detail: r.data });
      }
    ),
  );

  // ── Tool DOCS (tạo/sửa/xoá) + XOÁ issue ──
  const docFmt = (ws: string): 'markdown' | 'blocknote' => (config.workspaces[ws]?.docsFormat || 'markdown');
  tools.push(
    tool('workspace_list_docs', 'Liệt kê tài liệu (docs) của 1 workspace (id/slug + tiêu đề).', { workspace: wsEnum },
      async ({ workspace }) => {
        const r = await wsRequest(workspace as WsKey, 'GET', '/api/docs');
        const docs = Array.isArray(r.data) ? r.data : (r.data?.docs || []);
        return asText(r.ok ? { docs: docs.map((d: any) => ({ id: d.id || d.slug, title: d.title, group: d.group_title })) } : { error: `lỗi ${r.status}`, detail: r.data });
      }),
    tool('workspace_get_doc', 'Đọc nội dung 1 doc (trả markdown) để xem/đối chiếu với code. id = slug doc (xem workspace_list_docs).',
      { workspace: wsEnum, id: z.string() },
      async ({ workspace, id }) => {
        const r = await wsRequest(workspace as WsKey, 'GET', `/api/docs/${encodeURIComponent(id)}`);
        if (!r.ok) return asText({ error: `lỗi ${r.status}`, detail: r.data });
        const d = r.data?.doc ?? r.data;
        const md = typeof d.content_md === 'string' ? d.content_md
          : (typeof d.body_md === 'string' && d.body_md ? d.body_md : blockNoteToText(d.body_blocknote || d.body || []));
        return asText({ id: d.id || d.slug, title: d.title, version: d.version, markdown: md });
      }),
    tool('workspace_create_doc',
      'Tạo tài liệu mới (chuẩn BA, viết bằng markdown). Sơ đồ trong docs dùng ```mermaid``` (flowchart/sequence…), KHÔNG dùng d2. id tự sinh từ title nếu bỏ trống. group_title = nhóm/menu (tuỳ chọn).',
      { workspace: wsEnum, title: z.string(), content_md: z.string(), id: z.string().optional(), group_title: z.string().optional() },
      async ({ workspace, title, content_md, id, group_title }) => {
        const slug = (id && /^[a-z0-9_-]+$/.test(id)) ? id : slugify(title);
        const payload = buildDocPayload(docFmt(workspace), { id: slug, title, group_title, md: content_md });
        const r = await wsRequest(workspace as WsKey, 'POST', '/api/docs', payload);
        ctx.onAudit?.('workspace_create_doc', workspace, `${slug} — ${title}`.slice(0, 120));
        return asText(r.ok ? { ok: true, id: slug, doc: r.data?.doc ?? r.data } : { ok: false, error: `lỗi ${r.status}`, detail: r.data });
      }),
    tool('workspace_update_doc',
      'Ghi đè nội dung 1 doc (markdown). Mermaid cho sơ đồ. Chỉ gửi title khi muốn đổi tiêu đề.',
      { workspace: wsEnum, id: z.string(), content_md: z.string(), title: z.string().optional() },
      async ({ workspace, id, content_md, title }) => {
        const payload = buildDocPayload(docFmt(workspace), { title, md: content_md });
        const r = await wsRequest(workspace as WsKey, 'PUT', `/api/docs/${encodeURIComponent(id)}`, payload);
        ctx.onAudit?.('workspace_update_doc', workspace, id);
        return asText(r.ok ? { ok: true, id, doc: r.data?.doc ?? r.data } : { ok: false, error: `lỗi ${r.status}`, detail: r.data });
      }),
  );

  // ── Tool XOÁ (phá huỷ) — CHỈ admin (chống thành viên thường lỡ/cố xoá issue/doc) ──
  if (ctx.isAdmin) {
    tools.push(
      tool('workspace_delete_doc', 'XOÁ 1 doc (phá huỷ — hãy chắc người dùng đã đồng ý). id = slug doc.',
        { workspace: wsEnum, id: z.string() },
        async ({ workspace, id }) => {
          ctx.onAudit?.('workspace_delete_doc', workspace, id);
          const r = await wsRequest(workspace as WsKey, 'DELETE', `/api/docs/${encodeURIComponent(id)}`);
          return asText(r.ok ? { ok: true, deleted: id } : { ok: false, error: `lỗi ${r.status}`, detail: r.data });
        }),
      tool('workspace_delete_issue', 'XOÁ 1 issue theo mã (phá huỷ — hãy chắc người dùng đã đồng ý).',
        { workspace: wsEnum, id: z.string() },
        async ({ workspace, id }) => {
          ctx.onAudit?.('workspace_delete_issue', workspace, id);
          const r = await wsRequest(workspace as WsKey, 'DELETE', `/api/issues/${encodeURIComponent(id)}`);
          return asText(r.ok ? { ok: true, deleted: id } : { ok: false, error: `lỗi ${r.status}`, detail: r.data });
        }),
    );
  }
  } // hết khối tool workspace (chỉ khi dự án có workspace)

  // ── Tool TRUY VẤN DB THẬT (read-only) — CHỉ admin, chỉ DB của DỰ ÁN hiện tại ──
  const scopedDb = (ctx.dbKeys ?? dbKeys()).filter((k) => dbAvailable(k));
  const dbOk = (db: string) => scopedDb.includes(db);
  if (ctx.isAdmin && scopedDb.length) {
    const dbDesc = 'db ∈ {' + scopedDb.join(', ') + '} (erp = ERP/Click kientre_checkin | marketing = CRM kientre_marketing)';
    tools.push(
      tool('db_list_tables', 'Liệt kê bảng/view của 1 database thật. ' + dbDesc, { db: z.string() },
        async ({ db }) => {
          if (!dbOk(db)) return asText({ error: `db "${db}" không thuộc dự án này. Có: ${scopedDb.join(', ')}` });
          try { return asText({ db, tables: await listTables(db) }); } catch (e: any) { return asText({ error: String(e?.message ?? e) }); }
        }),
      tool('db_describe', 'Xem cột + kiểu dữ liệu của 1 bảng. table có thể là "schema.table". ' + dbDesc,
        { db: z.string(), table: z.string() },
        async ({ db, table }) => {
          if (!dbOk(db)) return asText({ error: `db "${db}" không thuộc dự án này.` });
          try { return asText({ db, table, columns: await describeTable(db, table) }); } catch (e: any) { return asText({ error: String(e?.message ?? e) }); }
        }),
      tool('db_query', 'Chạy 1 câu SQL SELECT/WITH (CHỈ ĐỌC, tự thêm LIMIT) trên DB thật để đối chiếu logic với dữ liệu. KHÔNG ghi/sửa/xoá. ' + dbDesc,
        { db: z.string(), sql: z.string() },
        async ({ db, sql }) => {
          if (!dbOk(db)) return asText({ error: `db "${db}" không thuộc dự án này.` });
          ctx.onAudit?.('db_query', db, sql.slice(0, 500));
          try { return asText(await runReadOnlyQuery(db, sql)); } catch (e: any) { return asText({ ok: false, error: String(e?.message ?? e) }); }
        }),
    );
  }

  // ── Tool ĐỌC LOG SERVER thật (read-only, allowlist) — CHỈ admin, chỉ server của DỰ ÁN ──
  const scopedServers = (ctx.serverKeys ?? serverKeys()).filter((k) => !!serverByKey(k));
  const srvOk = (s: string) => scopedServers.includes(s);
  if (ctx.isAdmin && scopedServers.length) {
    const srvDesc = 'server ∈ {' + scopedServers.join(', ') + '} (erp = ERP/Click server inet | crm = Marketing CRM server). Gọi server_list trước để biết các "source" (nguồn log) duyệt sẵn.';
    tools.push(
      tool('server_list', 'Liệt kê server thật + các nguồn log (source) duyệt sẵn để đọc. ' + srvDesc, {},
        async () => asText({ servers: listServers().filter((s) => srvOk(s.key)) })),
      tool('server_status', 'Xem trạng thái 1 server: container đang chạy + nginx (chỉ đọc). ' + srvDesc,
        { server: z.string() },
        async ({ server }) => {
          if (!srvOk(server)) return asText({ error: `server "${server}" không thuộc dự án này. Có: ${scopedServers.join(', ')}` });
          ctx.onAudit?.('server_status', server);
          return asText(await serverStatus(server));
        }),
      tool('server_logs',
        'Đọc LOG (chỉ đọc) từ 1 nguồn duyệt sẵn để phân tích luồng/hành vi user & lỗi. ' + srvDesc +
        ' source = tên nguồn (xem server_list). lines = số dòng (mặc định 200, tối đa 2000). ' +
        'since = chỉ nguồn docker, dạng 30m/2h/1d. grep = lọc theo CHUỖI CỐ ĐỊNH (không phải regex), vd " 500 " để tìm lỗi 5xx. ' +
        'Mẹo: tìm lỗi trong khoảng thời gian (docker) → kết hợp since + grep (quét toàn bộ cửa sổ, lấy lines dòng khớp cuối). ' +
        'Với nguồn file (nginx) → grep quét TOÀN BỘ log hiện hành rồi lấy lines dòng khớp cuối. KHÔNG chạy được lệnh tuỳ ý.',
        {
          server: z.string(),
          source: z.string().describe('tên nguồn log (xem server_list)'),
          lines: z.number().int().min(1).max(2000).optional(),
          since: z.string().optional().describe('chỉ docker; vd 30m, 2h, 1d'),
          grep: z.string().optional().describe('lọc chuỗi cố định (không phải regex)'),
        },
        async ({ server, source, lines, since, grep }) => {
          if (!srvOk(server)) return asText({ ok: false, error: `server "${server}" không thuộc dự án này. Có: ${scopedServers.join(', ')}` });
          ctx.onAudit?.('server_logs', server, `${source} lines=${lines ?? 200}${since ? ' since=' + since : ''}${grep ? ' grep=' + grep : ''}`);
          return asText(await fetchLogs({ server, source, lines, since, grep }));
        }),
      tool('server_env',
        'Đọc CẤU HÌNH/biến môi trường của ứng dụng trên server (chỉ đọc) để biết base URL đối tác + TÊN biến chứa secret. ' +
        srvDesc + ' container = tên container docker (mặc định app); xem server_list. ' +
        'LƯU Ý: giá trị secret bị CHE (hiện "<đã set, N ký tự>") — bạn KHÔNG thấy token thật và không cần thấy; ' +
        'để gọi API hãy truyền TÊN biến cho call_api (auth.env). Các biến không phải secret (BASE_URL/ID/HOST) hiện đầy đủ.',
        { server: z.string(), container: z.string().optional().describe('tên container (mặc định app)') },
        async ({ server, container }) => {
          if (!srvOk(server)) return asText({ ok: false, error: `server "${server}" không thuộc dự án này. Có: ${scopedServers.join(', ')}` });
          ctx.onAudit?.('server_env', server, container);
          return asText(await readServerEnv(server, container));
        }),
      tool('call_api',
        'Gọi API THẬT của đối tác/nội bộ từ trong server để CHECK/THAO TÁC dữ liệu (curl chạy ngay trong container — có env + network). ' +
        srvDesc + ' Auth: truyền auth={name:"Authorization",scheme:"Bearer",env:"TÊN_BIẾN"} — secret được lấy NGAY trên server từ biến môi trường (bạn không cần biết giá trị). ' +
        'Lấy base URL + tên biến auth từ server_env, lấy endpoint từ fetch_url (API docs). ' +
        'ĐỌC dữ liệu → method GET (an toàn, gọi thoải mái). ' +
        'GHI dữ liệu (POST/PUT/PATCH/DELETE thay đổi dữ liệu thật) → BẮT BUỘC tóm tắt rõ sẽ gọi gì (method + url + body) và XIN NGƯỜI DÙNG XÁC NHẬN trước, chỉ gọi sau khi họ đồng ý.',
        {
          server: z.string(),
          method: z.enum(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']).describe('GET để đọc; POST/PUT/PATCH/DELETE để ghi (phải xác nhận user trước)'),
          url: z.string().describe('URL đầy đủ http/https (lấy base từ server_env)'),
          container: z.string().optional().describe('container chạy curl (mặc định app)'),
          query: z.record(z.string(), z.string()).optional().describe('query params, được encode an toàn'),
          headers: z.record(z.string(), z.string()).optional().describe('header phụ (KHÔNG để secret ở đây — dùng auth)'),
          auth: z.object({
            name: z.string().describe('tên header, vd "Authorization" hoặc "X-Api-Key"'),
            scheme: z.string().optional().describe('vd "Bearer" (để trống nếu không có)'),
            env: z.string().describe('TÊN biến môi trường chứa secret (vd "VNFAI_API_KEY") — resolve trên server'),
          }).optional().describe('cô lập secret: token lấy từ env trên server, không vào chat'),
          body: z.string().optional().describe('thân request (JSON string) cho POST/PUT/PATCH'),
        },
        async ({ server, method, url, container, query, headers, auth, body }) => {
          if (!srvOk(server)) return asText({ ok: false, error: `server "${server}" không thuộc dự án này. Có: ${scopedServers.join(', ')}` });
          ctx.onAudit?.('call_api', server, `${method} ${url}`); // KHÔNG log body/secret
          return asText(await apiCall({ server, method, url, container, query, headers, auth, body }));
        }),
    );
  }

  // ── ĐỌC URL / API DOCS (GET, công khai, SSRF-guarded) ──
  tools.push(tool('fetch_url',
    'Tải nội dung 1 URL CÔNG KHAI (chỉ GET, chỉ đọc) — API docs / OpenAPI spec / trang web — để tra cứu khi viết spec tích hợp. ' +
    'Trang ReDoc/Swagger là vỏ JS gần như RỖNG → hãy fetch chính file spec (vd .../swagger/v1/swagger.json, /openapi.json, /v3/api-docs). Spec lớn → dùng grep tìm endpoint/tag rồi đọc từng phần bằng offset/limit.',
    {
      url: z.string().describe('URL http/https công khai'),
      grep: z.string().optional().describe('chỉ giữ các DÒNG chứa chuỗi này (lọc spec lớn)'),
      offset: z.number().int().min(0).optional().describe('dòng bắt đầu (mặc định 0)'),
      limit: z.number().int().min(1).max(2000).optional().describe('số dòng trả về (mặc định 400)'),
    },
    async ({ url, grep, offset, limit }) => {
      try {
        const r = await safeFetch(url);
        let lines = r.body.split('\n');
        const total = lines.length;
        if (grep) { const g = grep.toLowerCase(); lines = lines.filter((l) => l.toLowerCase().includes(g)); }
        const off = offset || 0; const shown = lines.slice(off, off + (limit || 400));
        ctx.onAudit?.('fetch_url', url);
        return asText({ status: r.status, contentType: r.contentType, totalLines: total,
          matchedLines: grep ? lines.length : undefined, shown: `${off}..${off + shown.length}`, body: shown.join('\n') });
      } catch (e: any) { return asText({ ok: false, error: String(e?.message ?? e) }); }
    }));

  // ── TẠO FILE để tải về / chia sẻ public (Excel / Word / PDF / HTML) ──
  const owner = ctx.userId || 'anon';
  const onSaved = async (kind: any, filename: string, buf: Buffer) => {
    const f = await saveGenerated(owner, kind, filename, buf);
    ctx.emit('file_ready', { id: f.id, kind: f.kind, filename: f.filename, downloadUrl: f.downloadUrl, viewUrl: f.viewUrl, shareUrl: f.shareUrl });
    ctx.onAudit?.('make_' + kind, f.id, f.filename);
    return asText({ ok: true, kind: f.kind, filename: f.filename, downloadUrl: f.downloadUrl, shareUrl: f.shareUrl, note: 'Đã tạo file. Người dùng bấm Tải/Mở/Copy link trên thẻ file. KHÔNG dán lại nội dung file ra chat.' });
  };
  tools.push(
    tool('make_excel', 'Tạo file Excel (.xlsx) để tải về / chia sẻ. Dùng khi user cần xuất bảng/danh sách/số liệu.', {
      title: z.string().describe('tên file (không cần đuôi)'),
      sheets: z.array(z.object({
        name: z.string().optional().describe('tên sheet'),
        headers: z.array(z.string()).describe('hàng tiêu đề cột'),
        rows: z.array(z.array(z.union([z.string(), z.number(), z.null()]))).describe('các dòng, mỗi dòng = mảng ô theo thứ tự headers'),
      })).min(1).describe('1 hoặc nhiều sheet'),
    }, async ({ title, sheets }) => {
      try { return await onSaved('excel', title, buildExcel(sheets as any)); }
      catch (e: any) { return asText({ ok: false, error: String(e?.message ?? e) }); }
    }),
    tool('make_word', 'Tạo file Word (.docx) báo cáo có heading/đoạn/bảng.', {
      title: z.string(),
      sections: z.array(z.union([
        z.object({ type: z.literal('heading'), text: z.string(), level: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional() }),
        z.object({ type: z.literal('paragraph'), text: z.string(), bold: z.boolean().optional(), align: z.enum(['left', 'center', 'right']).optional() }),
        z.object({ type: z.literal('table'), headers: z.array(z.string()), rows: z.array(z.array(z.union([z.string(), z.number()]))) }),
      ])).describe('các khối nội dung theo thứ tự'),
    }, async ({ title, sections }) => {
      try { return await onSaved('word', title, await buildWord(title, sections as any)); }
      catch (e: any) { return asText({ ok: false, error: String(e?.message ?? e) }); }
    }),
    tool('make_pdf', 'Tạo file PDF báo cáo từ HTML (bạn tự viết body HTML — chỉ thẻ <h1..h3>,<p>,<table>,<ul>,<b>,<div> + class; KHÔNG ảnh/URL ngoài). Hệ thống tự bọc font + CSS in ấn.', {
      title: z.string(),
      body_html: z.string().describe('phần thân HTML (không cần <html>/<head>)'),
    }, async ({ title, body_html }) => {
      try { return await onSaved('pdf', title, await buildPdf(title, body_html)); }
      catch (e: any) { return asText({ ok: false, error: String(e?.message ?? e) }); }
    }),
    tool('make_html', 'Tạo trang HTML (xem/chia sẻ trực tiếp trên trình duyệt). Body HTML như make_pdf.', {
      title: z.string(),
      body_html: z.string().describe('phần thân HTML'),
    }, async ({ title, body_html }) => {
      try { return await onSaved('html', title, Buffer.from(htmlShell(title, body_html), 'utf8')); }
      catch (e: any) { return asText({ ok: false, error: String(e?.message ?? e) }); }
    }),
  );

  // ── COPILOT: sửa file ĐANG MỞ trong canvas (patch về frontend qua SSE) ──
  if (ctx.sheetOpen) {
    tools.push(tool('fill_cells', 'Điền/sửa các ô của BẢNG TÍNH người dùng ĐANG MỞ. ref = địa chỉ kiểu Excel ("B2"); value = số/chuỗi HOẶC công thức bắt đầu bằng "=" (vd "=SUM(B2:B5)").', {
      cells: z.array(z.object({ ref: z.string(), value: z.union([z.string(), z.number()]), sheet: z.string().optional() })).min(1),
    }, async ({ cells }) => {
      ctx.emit('cells_patch', { cells });
      ctx.onAudit?.('fill_cells', undefined, `${cells.length} ô`);
      return asText({ ok: true, filled: cells.length, note: 'Đã điền vào bảng tính đang mở. Nhắc người dùng bấm 💾 Lưu để ghi vào file.' });
    }));
  }
  if (ctx.docOpen) {
    tools.push(tool('edit_doc', 'Chèn/sửa nội dung TÀI LIỆU ĐANG MỞ. ops = mảng thao tác: {action:"append",html} | {action:"insert_after",anchorHeading,html} | {action:"replace",find,html}. html = đoạn HTML (vd "<h2>..</h2><p>..</p>").', {
      ops: z.array(z.object({ action: z.enum(['append', 'insert_after', 'replace']), find: z.string().optional(), anchorHeading: z.string().optional(), html: z.string() })).min(1),
    }, async ({ ops }) => {
      ctx.emit('doc_patch', { ops });
      ctx.onAudit?.('edit_doc', undefined, `${ops.length} thao tác`);
      return asText({ ok: true, applied: ops.length, note: 'Đã cập nhật tài liệu đang mở. Nhắc người dùng bấm 💾 Lưu để ghi vào file.' });
    }));
  }

  const server = createSdkMcpServer({ name: 'code', version: '1.0.0', tools });
  const allowedToolNames = tools.map((t) => `mcp__code__${(t as any).name}`);
  return { server, allowedToolNames };
}
