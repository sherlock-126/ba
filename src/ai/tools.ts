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
import { config, type RepoCfg } from '../config.js';
import { wsRequest, type WsKey } from '../workspaces.js';
import { runReadOnlyQuery, listTables, describeTable, dbAvailable, dbKeys } from '../db.js';
import { fetchLogs, serverStatus, listServers, serverKeys, serverByKey } from '../servers.js';
import { buildDocPayload, blockNoteToText, slugify } from '../docs.js';

// ripgrep binary tuyệt đối (không dựa vào `rg` trên PATH — môi trường này rg chỉ là shell function).
const RG = rgPath;

const MAX_PAYLOAD = 40_000; // ~40KB text trả model mỗi lần
const IGNORE_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.next', 'target', 'out', '.turbo', 'coverage']);

function asText(obj: unknown) {
  let s = typeof obj === 'string' ? obj : JSON.stringify(obj, null, 0);
  if (s.length > MAX_PAYLOAD) s = s.slice(0, MAX_PAYLOAD) + '\n…(đã cắt bớt — đọc tiếp bằng offset/limit hoặc thu hẹp truy vấn)';
  return { content: [{ type: 'text' as const, text: s }] };
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
    );
  }

  const server = createSdkMcpServer({ name: 'code', version: '1.0.0', tools });
  const allowedToolNames = tools.map((t) => `mcp__code__${(t as any).name}`);
  return { server, allowedToolNames };
}
