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

/** Liệt kê server + nguồn log (không kèm secret) cho tool/endpoint. */
export function listServers() {
  return config.servers.map((s) => ({
    key: s.key, label: s.label,
    sources: s.sources.map((x) => ({ name: x.name, label: x.label, kind: x.kind })),
  }));
}
