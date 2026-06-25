/**
 * Đọc LOG server thật (ERP inet + Marketing CRM) qua SSH — CHỈ ĐỌC, danh sách nguồn duyệt sẵn.
 *
 * An toàn: AGENT KHÔNG bao giờ truyền lệnh shell. Nó chỉ chọn server + source (tên nguồn cố định
 * trong registry) + vài tham số phụ (lines/since/grep). Lệnh remote được DỰNG từ template cố định
 * (container/đường-dẫn là HẰNG trong config) → không có injection. grep pattern được single-quote-escape.
 * Chỉ các binary đọc: `docker logs`, `tail`, `pm2 logs`, `docker ps`, `systemctl is-active`.
 */
import { spawn } from 'node:child_process';
import { config, type ServerCfg, type LogSource } from './config.js';

const OUTPUT_CAP = 256 * 1024; // 256KB stdout tối đa
const SSH_TIMEOUT_MS = 20_000;

export function serverByKey(key: string): ServerCfg | undefined {
  return config.servers.find((s) => s.key === key);
}
export const serverKeys = () => config.servers.map((s) => s.key);
function sourceByName(srv: ServerCfg, name: string): LogSource | undefined {
  return srv.sources.find((s) => s.name === name);
}

/** Bọc chuỗi cho shell remote an toàn (single-quote, escape ' → '\'' ). */
function shQuote(s: string): string {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/** Chạy 1 lệnh remote (đã dựng sẵn, read-only) qua ssh với key/host/port tường minh. */
function runRemote(srv: ServerCfg, remoteCmd: string): Promise<{ stdout: string; truncated: boolean; code: number; elapsedMs: number }> {
  const args = [
    '-i', srv.ssh.identityFile,
    '-o', 'IdentitiesOnly=yes',
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ConnectTimeout=10',
    '-p', String(srv.ssh.port),
    `${srv.ssh.user}@${srv.ssh.host}`,
    remoteCmd,
  ];
  const t0 = Date.now();
  return new Promise((res) => {
    const p = spawn('ssh', args);
    let out = '';
    let truncated = false;
    const t = setTimeout(() => p.kill('SIGKILL'), SSH_TIMEOUT_MS);
    p.stdout.on('data', (d) => {
      out += d;
      if (out.length > OUTPUT_CAP) { out = out.slice(0, OUTPUT_CAP); truncated = true; p.kill('SIGKILL'); }
    });
    p.stderr.on('data', (d) => { if (out.length < OUTPUT_CAP) out += d; });
    p.on('close', (code) => { clearTimeout(t); res({ stdout: out, truncated, code: code ?? -1, elapsedMs: Date.now() - t0 }); });
    p.on('error', (e) => { clearTimeout(t); res({ stdout: 'Lỗi chạy ssh: ' + String(e), truncated: false, code: -1, elapsedMs: Date.now() - t0 }); });
  });
}

/** Dựng lệnh đọc log từ 1 source (template cố định theo kind/ref). grep là chuỗi cố định (đã escape). */
function buildLogCmd(src: LogSource, lines: number, since?: string, grep?: string): string {
  const g = grep ? ` | grep -a -F -- ${shQuote(grep)}` : '';
  switch (src.kind) {
    case 'docker': {
      // Go duration của docker KHÔNG có đơn vị ngày → quy đổi Nd → (N*24)h.
      let s = since;
      const dm = since && /^(\d+)d$/.exec(since);
      if (dm) s = `${Number(dm[1]) * 24}h`;
      const ref = shQuote(src.ref);
      if (grep) {
        // Có since → grep TOÀN BỘ cửa sổ thời gian rồi lấy N dòng khớp cuối; không since → grep trong N dòng cuối.
        return s
          ? `docker logs --since ${shQuote(s)} ${ref} 2>&1 | grep -a -F -- ${shQuote(grep)} | tail -n ${lines}`
          : `docker logs --tail ${lines} ${ref} 2>&1 | grep -a -F -- ${shQuote(grep)}`;
      }
      const sinceArg = s ? ` --since ${shQuote(s)}` : '';
      return `docker logs --tail ${lines}${sinceArg} ${ref} 2>&1`;
    }
    case 'pm2':
      return `pm2 logs ${shQuote(src.ref)} --lines ${lines} --nostream 2>&1${g}`;
    case 'journal': {
      // journalctl --since cần thời gian tương đối kiểu "30 min ago" → quy đổi từ 30m/2h/1d.
      let sinceArg = '';
      const jm = since && /^(\d+)([smhd])$/.exec(since);
      if (jm) sinceArg = ` --since ${shQuote(`${jm[1]} ${({ s: 'sec', m: 'min', h: 'hour', d: 'day' } as any)[jm[2]]} ago`)}`;
      return grep
        ? `journalctl -u ${shQuote(src.ref)}${sinceArg} --no-pager 2>&1 | grep -a -F -- ${shQuote(grep)} | tail -n ${lines}`
        : `journalctl -u ${shQuote(src.ref)} -n ${lines}${sinceArg} --no-pager 2>&1`;
    }
    case 'file':
    default:
      // Có grep: tìm trên TOÀN BỘ log hiện hành rồi lấy N dòng khớp cuối (không bị giới hạn cửa sổ tail).
      // Không grep: N dòng cuối.
      return grep
        ? `grep -a -F -- ${shQuote(grep)} ${shQuote(src.ref)} 2>&1 | tail -n ${lines}`
        : `tail -n ${lines} -- ${shQuote(src.ref)} 2>&1`;
  }
}

export type LogResult =
  | { ok: true; server: string; source: string; lines: number; truncated: boolean; elapsedMs: number; output: string }
  | { ok: false; error: string };

/** Đọc log từ 1 nguồn duyệt sẵn (có thể lọc grep, giới hạn dòng/khoảng thời gian). */
export async function fetchLogs(opts: {
  server: string; source: string; lines?: number; since?: string; grep?: string;
}): Promise<LogResult> {
  const srv = serverByKey(opts.server);
  if (!srv) return { ok: false, error: `server "${opts.server}" không tồn tại. Có: ${serverKeys().join(', ')}` };
  const src = sourceByName(srv, opts.source);
  if (!src) return { ok: false, error: `nguồn "${opts.source}" không có ở server ${srv.key}. Có: ${srv.sources.map((s) => s.name).join(', ')}` };

  let lines = Math.floor(Number(opts.lines ?? 200));
  if (!Number.isFinite(lines) || lines < 1) lines = 200;
  if (lines > 2000) lines = 2000;

  let since: string | undefined;
  if (opts.since) {
    if (!/^\d+[smhd]$/.test(opts.since)) return { ok: false, error: 'since không hợp lệ — dùng dạng như 30m, 2h, 1d.' };
    if (src.kind !== 'docker' && src.kind !== 'journal') return { ok: false, error: `nguồn "${src.name}" (${src.kind}) không hỗ trợ lọc theo thời gian (since); chỉ docker/journal hỗ trợ.` };
    since = opts.since;
  }

  const grep = opts.grep ? String(opts.grep).slice(0, 200) : undefined;
  const cmd = buildLogCmd(src, lines, since, grep);

  const r = await runRemote(srv, cmd);
  return {
    ok: true, server: srv.key, source: src.name, lines, truncated: r.truncated, elapsedMs: r.elapsedMs,
    output: r.stdout.trimEnd() || '(không có dòng log nào khớp)',
  };
}

/** Trạng thái server: container đang chạy + nginx (lệnh cố định, read-only). */
export async function serverStatus(serverKey: string): Promise<LogResult> {
  const srv = serverByKey(serverKey);
  if (!srv) return { ok: false, error: `server "${serverKey}" không tồn tại.` };
  const cmd = `echo "# docker"; docker ps --format '{{.Names}}\\t{{.Status}}' 2>&1 | sort; echo; echo "# nginx"; systemctl is-active nginx 2>&1`;
  const r = await runRemote(srv, cmd);
  return { ok: true, server: srv.key, source: 'status', lines: 0, truncated: r.truncated, elapsedMs: r.elapsedMs, output: r.stdout.trimEnd() };
}

// ── ĐỌC ENV + GỌI API thật trên server (admin) ─────────────────────────────
// Secret được CÔ LẬP: server_env che giá trị; call_api resolve secret NGAY trong
// container (qua ${ENV}) — token KHÔNG bao giờ rời server / không vào LLM.

const SECRET_KEY_RE = /KEY|SECRET|PASSWORD|TOKEN|HASH|PRIVATE|CREDENTIAL|PWD|AUTH/i;
const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']);
const ENV_NAME_RE = /^[A-Z0-9_]+$/;
const HDR_NAME_RE = /^[A-Za-z0-9-]+$/;
const SCHEME_RE = /^[A-Za-z0-9-]*$/;
const QKEY_RE = /^[A-Za-z0-9_.\-[\]]+$/;

/** Các container docker duyệt sẵn của 1 server (từ registry — không từ AI). */
function dockerRefs(srv: ServerCfg): string[] {
  return srv.sources.filter((s) => s.kind === 'docker').map((s) => s.ref);
}

export type EnvResult =
  | { ok: true; server: string; container: string; count: number; env: Record<string, string> }
  | { ok: false; error: string };

/** Đọc biến môi trường của 1 container (printenv) — giá trị secret bị CHE. */
export async function readServerEnv(server: string, container?: string): Promise<EnvResult> {
  const srv = serverByKey(server);
  if (!srv) return { ok: false, error: `server "${server}" không tồn tại. Có: ${serverKeys().join(', ')}` };
  const refs = dockerRefs(srv);
  if (!refs.length) return { ok: false, error: `server "${server}" không có container docker để đọc env.` };
  const c = container ?? refs[0];
  if (!refs.includes(c)) return { ok: false, error: `container "${c}" không thuộc server ${server}. Có: ${refs.join(', ')}` };

  const r = await runRemote(srv, `docker exec ${shQuote(c)} printenv`);
  if (!r.stdout.trim()) return { ok: false, error: `đọc env thất bại (mã ${r.code}).` };
  const env: Record<string, string> = {};
  for (const line of r.stdout.split('\n')) {
    const i = line.indexOf('=');
    if (i <= 0) continue;
    const k = line.slice(0, i);
    const v = line.slice(i + 1);
    env[k] = SECRET_KEY_RE.test(k) ? `<đã set, ${v.length} ký tự>` : v;
  }
  return { ok: true, server: srv.key, container: c, count: Object.keys(env).length, env };
}

export type ApiAuth = { name: string; scheme?: string; env: string };
export type ApiCallOpts = {
  server: string; method: string; url: string; container?: string;
  query?: Record<string, string>; headers?: Record<string, string>; auth?: ApiAuth; body?: string;
};
export type ApiResult =
  | { ok: true; server: string; container: string; method: string; httpStatus: number | null; truncated: boolean; elapsedMs: number; body: string }
  | { ok: false; error: string };

/**
 * Gọi API thật — chạy `curl` NGAY trong container (có env + network đối tác).
 * Secret cô lập: auth dựng header `-H "<name>: <scheme> ${ENV}"` (double-quote → CONTAINER sh
 * expand ${ENV} từ env; agent chỉ truyền TÊN biến). Mọi tham số khác shQuote (single-quote) →
 * không injection. Chỉ chạy curl dựng từ mảng tham số, không lệnh tuỳ ý.
 */
export async function apiCall(o: ApiCallOpts): Promise<ApiResult> {
  const srv = serverByKey(o.server);
  if (!srv) return { ok: false, error: `server "${o.server}" không tồn tại. Có: ${serverKeys().join(', ')}` };
  const refs = dockerRefs(srv);
  if (!refs.length) return { ok: false, error: `server "${o.server}" không có container để gọi API.` };
  const c = o.container ?? refs[0];
  if (!refs.includes(c)) return { ok: false, error: `container "${c}" không thuộc server ${o.server}. Có: ${refs.join(', ')}` };

  const method = String(o.method || 'GET').toUpperCase();
  if (!METHODS.has(method)) return { ok: false, error: `method "${method}" không hợp lệ. Cho phép: ${[...METHODS].join(', ')}` };

  const url = String(o.url || '');
  if (!/^https?:\/\//i.test(url)) return { ok: false, error: 'url phải bắt đầu bằng http:// hoặc https://' };
  // Chặn khoảng trắng, ký tự điều khiển và metachar shell trong URL (defense-in-depth; shQuote đã cô lập).
  if (/\s/.test(url) || /[\x00-\x1f]/.test(url) || /[`"'<>\\^{}|$();]/.test(url)) {
    return { ok: false, error: 'url chứa ký tự không hợp lệ (khoảng trắng / ký tự điều khiển / ký tự shell).' };
  }

  // query string (encode an toàn)
  let qs = '';
  if (o.query && Object.keys(o.query).length) {
    const parts: string[] = [];
    for (const [k, v] of Object.entries(o.query)) {
      if (!QKEY_RE.test(k)) return { ok: false, error: `tên query param không hợp lệ: ${k}` };
      parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
    }
    qs = (url.includes('?') ? '&' : '?') + parts.join('&');
  }

  // Dựng curl bằng MẢNG tham số (mỗi phần shQuote) — container sh chạy y nguyên, không injection.
  const a: string[] = ['curl', '-sS', '-m', '30', '-w', shQuote('\\n<<<HTTP:%{http_code}>>>'), '-X', method, shQuote(url + qs)];

  for (const [k, v] of Object.entries(o.headers || {})) {
    if (!HDR_NAME_RE.test(k)) return { ok: false, error: `tên header không hợp lệ: ${k}` };
    a.push('-H', shQuote(`${k}: ${String(v).replace(/[\r\n]/g, '')}`));
  }

  if (o.auth) {
    if (!HDR_NAME_RE.test(o.auth.name)) return { ok: false, error: 'auth.name không hợp lệ.' };
    const scheme = o.auth.scheme ?? '';
    if (!SCHEME_RE.test(scheme)) return { ok: false, error: 'auth.scheme không hợp lệ.' };
    if (!ENV_NAME_RE.test(o.auth.env)) return { ok: false, error: 'auth.env không hợp lệ (chỉ A-Z 0-9 _).' };
    // DOUBLE-quote để container sh expand ${ENV}; name/scheme/env đã validate → an toàn.
    a.push('-H', `"${o.auth.name}: ${scheme ? scheme + ' ' : ''}\${${o.auth.env}}"`);
  }

  if (o.body != null && o.body !== '' && method !== 'GET' && method !== 'HEAD') {
    a.push('--data', shQuote(String(o.body)));
  }

  const remoteCmd = `docker exec ${shQuote(c)} sh -c ${shQuote(a.join(' '))}`;
  const r = await runRemote(srv, remoteCmd);

  let body = r.stdout;
  let httpStatus: number | null = null;
  const m = /<<<HTTP:(\d+)>>>\s*$/.exec(body);
  if (m) { httpStatus = Number(m[1]); body = body.slice(0, m.index); }
  return { ok: true, server: srv.key, container: c, method, httpStatus, truncated: r.truncated, elapsedMs: r.elapsedMs, body: body.trimEnd() || '(rỗng)' };
}

/** Liệt kê server + nguồn log (không kèm secret) cho tool/endpoint. */
export function listServers() {
  return config.servers.map((s) => ({
    key: s.key, label: s.label,
    sources: s.sources.map((x) => ({ name: x.name, label: x.label, kind: x.kind })),
  }));
}
