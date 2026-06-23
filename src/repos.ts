/**
 * Quản lý 2 bản clone repo của service: tự git pull theo lịch + refresh thủ công.
 * Dùng `fetch --depth 1 + reset --hard FETCH_HEAD` → bản clone LUÔN khớp đúng branch GitHub
 * (GitHub là source of truth; mọi lệch local bị ghi đè). FETCH_HEAD robust cho mọi branch.
 */
import cron from 'node-cron';
import { spawn } from 'node:child_process';
import { config, type RepoCfg } from './config.js';

function git(args: string[], cwd: string): Promise<{ out: string; code: number }> {
  return new Promise((res) => {
    const p = spawn('git', args, { cwd });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('close', (code) => res({ out: out.trim(), code: code ?? -1 }));
    p.on('error', (e) => res({ out: String(e), code: -1 }));
  });
}

export type PullResult = {
  repo: string; label: string; branch: string; ok: boolean;
  short: string;        // hash ngắn commit cuối
  author: string;       // người commit cuối
  commitISO: string;    // thời điểm commit cuối (ISO) = lúc code cập nhật trên GitHub
  subject: string;      // tiêu đề commit cuối
  detail: string;
};

export async function pullRepo(r: RepoCfg): Promise<PullResult> {
  const base: PullResult = { repo: r.key, label: r.label, branch: r.branch, ok: false, short: '', author: '', commitISO: '', subject: '', detail: '' };
  const f = await git(['fetch', '--depth', '1', 'origin', r.branch], r.path);
  if (f.code !== 0) return { ...base, detail: 'fetch lỗi: ' + f.out.slice(0, 200) };
  const reset = await git(['reset', '--hard', 'FETCH_HEAD'], r.path);
  const info = await git(['log', '-1', '--format=%h%x1f%an%x1f%cI%x1f%s'], r.path);
  const [short = '', author = '', commitISO = '', subject = ''] = info.out.split('\x1f');
  return {
    ...base, ok: reset.code === 0, short, author, commitISO, subject,
    detail: reset.code === 0 ? `HEAD=${short}` : 'reset lỗi: ' + reset.out.slice(0, 200),
  };
}

export async function pullAll(): Promise<PullResult[]> {
  const out: PullResult[] = [];
  for (const r of config.repos) out.push(await pullRepo(r));
  return out;
}

let lastPull: { at: number; results: PullResult[] } = { at: 0, results: [] };
export function getLastPull() { return lastPull; }

export async function refreshNow(): Promise<PullResult[]> {
  const results = await pullAll();
  lastPull = { at: Date.now(), results };
  return results;
}

export function startAutoPull() {
  // Pull ngay khi khởi động để status có dữ liệu liền (không chờ cron).
  refreshNow().then((r) => console.log('[repos] pull lúc khởi động:', r.map((x) => `${x.repo}:${x.ok ? x.short : 'FAIL'}`).join(' '))).catch(() => {});
  if (!cron.validate(config.pullCron)) {
    console.warn('[repos] PULL_CRON không hợp lệ:', config.pullCron, '— bỏ qua auto-pull');
    return;
  }
  cron.schedule(config.pullCron, async () => {
    const results = await pullAll();
    lastPull = { at: Date.now(), results };
    console.log('[repos] auto-pull:', results.map((r) => `${r.repo}:${r.ok ? r.short : 'FAIL'}`).join(' '));
  });
  console.log('[repos] auto-pull lịch:', config.pullCron);
}
