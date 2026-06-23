import 'dotenv/config';
import { resolve } from 'node:path';
import { homedir } from 'node:os';

/** Cấu hình service. Token Claude lấy từ CLAUDE_CODE_OAUTH_TOKEN (env hoặc .env). */
export type RepoCfg = { key: string; label: string; path: string; branch: string; blurb: string; adminOnly?: boolean };

/** Nguồn log duyệt sẵn trên 1 server (ref = container/đường-dẫn/process CỐ ĐỊNH — không từ AI). */
export type LogSource = { name: string; label: string; kind: 'docker' | 'file' | 'pm2' | 'journal'; ref: string };
export type ServerCfg = {
  key: string; label: string;
  ssh: { host: string; port: number; user: string; identityFile: string };
  sources: LogSource[];
};

const CLONES = resolve(process.cwd(), 'clones');

/** Parse "user@host:port" → {host,port,user}. */
function parseSsh(spec: string, defUser = 'root', defPort = 22) {
  const m = /^(?:([^@]+)@)?([^:]+)(?::(\d+))?$/.exec(spec.trim());
  if (!m) return { host: spec, port: defPort, user: defUser };
  return { host: m[2], port: m[3] ? Number(m[3]) : defPort, user: m[1] || defUser };
}
const expandTilde = (p: string) => (p.startsWith('~') ? resolve(homedir(), p.slice(1).replace(/^[/\\]/, '')) : p);

export const config = {
  app: {
    port: Number(process.env.PORT || 3600),
    host: process.env.HOST || '0.0.0.0',
    // Mật khẩu chung cho team BA. Đổi trong .env.
    teamPassword: process.env.TEAM_PASSWORD || 'kientre',
    sessionTtlMs: 1000 * 60 * 60 * 24 * 7, // 7 ngày
    // Bật khi chạy sau HTTPS (cloudflared/production) để cookie có cờ Secure.
    cookieSecure: process.env.COOKIE_SECURE === '1',
  },
  admin: {
    email: process.env.ADMIN_EMAIL || 'admin@autonow.vn',
  },
  // DB thật (chỉ admin truy vấn read-only). Trống = không bật.
  db: {
    erp: process.env.ERP_DB_URL || '',
    marketing: process.env.MKT_DB_URL || '',
    thg: process.env.THG_DB_URL || '',
    dhco: process.env.DHCO_DB_URL || '',
  } as Record<string, string>,
  // Server thật (chỉ admin đọc LOG read-only qua SSH). Nguồn log duyệt sẵn — KHÔNG chạy lệnh tuỳ ý.
  servers: [
    {
      key: 'erp',
      label: 'ERP (Click) — server inet',
      ssh: { ...parseSsh(process.env.ERP_SSH || 'root@103.216.116.75:24700', 'root', 24700),
             identityFile: expandTilde(process.env.ERP_SSH_KEY || '~/.ssh/id_ed25519') },
      sources: [
        { name: 'app', label: 'Ứng dụng ERP (Next.js)', kind: 'docker', ref: 'kientre' },
        { name: 'zalo-browser', label: 'Zalo browser', kind: 'docker', ref: 'kientre-zalo-browser' },
        { name: 'messenger', label: 'Tiến trình messenger (pm2)', kind: 'pm2', ref: 'kientre-messenger' },
        { name: 'nginx-access', label: 'Nginx access (luồng request user)', kind: 'file', ref: '/var/log/nginx/access.log' },
        { name: 'nginx-error', label: 'Nginx error', kind: 'file', ref: '/var/log/nginx/error.log' },
      ],
    },
    {
      key: 'crm',
      label: 'Marketing CRM — server cloud',
      ssh: { ...parseSsh(process.env.CRM_SSH || 'root@103.216.117.107:24700', 'root', 24700),
             identityFile: expandTilde(process.env.CRM_SSH_KEY || '~/.ssh/ba_autonow_ed25519') },
      sources: [
        { name: 'marketing-fe', label: 'Marketing frontend (Next.js)', kind: 'docker', ref: 'kientre-marketing' },
        { name: 'marketing-backend', label: 'Marketing backend (Spring Boot)', kind: 'docker', ref: 'kientre-marketing-backend' },
        { name: 'zalo-bridge', label: 'Zalo bridge', kind: 'docker', ref: 'zalo-bridge' },
        { name: 'click-fe', label: 'Click frontend', kind: 'docker', ref: 'fe-kientre' },
        { name: 'nginx-access', label: 'Nginx access (luồng request user)', kind: 'file', ref: '/var/log/nginx/access.log' },
        { name: 'nginx-error', label: 'Nginx error', kind: 'file', ref: '/var/log/nginx/error.log' },
      ],
    },
    {
      key: 'thg',
      label: 'THG — server thghub',
      ssh: { ...parseSsh(process.env.THG_SSH || 'root@103.56.160.84:24700', 'root', 24700),
             identityFile: expandTilde(process.env.THG_SSH_KEY || '~/.ssh/id_ed25519') },
      sources: [
        { name: 'app', label: 'Ứng dụng THG (thg-hub)', kind: 'docker', ref: 'thg-hub' },
        { name: 'cron', label: 'Tác vụ định kỳ (thg-cron)', kind: 'docker', ref: 'thg-cron' },
        { name: 'nginx-access', label: 'Nginx access (luồng request user)', kind: 'file', ref: '/var/log/nginx/access.log' },
        { name: 'nginx-error', label: 'Nginx error', kind: 'file', ref: '/var/log/nginx/error.log' },
      ],
    },
    {
      key: 'dhco',
      label: 'DHP — server dhco',
      ssh: { ...parseSsh(process.env.DHCO_SSH || 'root@103.57.222.127:24700', 'root', 24700),
             identityFile: expandTilde(process.env.DHCO_SSH_KEY || '~/.ssh/id_ed25519') },
      sources: [
        { name: 'app', label: 'Ứng dụng DHP (dhco-next, systemd)', kind: 'journal', ref: 'dhco-next' },
      ],
    },
  ] as ServerCfg[],
  ai: {
    oauthToken: process.env.CLAUDE_CODE_OAUTH_TOKEN || '',
    model: process.env.AI_MODEL || 'opus',
    maxTurns: Number(process.env.AI_MAX_TURNS || 25),
  },
  // Lịch tự pull (cron). Mặc định mỗi 10 phút.
  pullCron: process.env.PULL_CRON || '*/10 * * * *',
  // Tài khoản "BA Bot" để CRUD issue trên 2 workspace (auto-register nếu chưa có).
  bot: {
    email: process.env.BOT_EMAIL || 'ba-bot@autonow.vn',
    password: process.env.BOT_PASSWORD || 'BaBot!2026#kientre',
    name: process.env.BOT_NAME || 'BA Bot',
  },
  // Workspace hub (issue tracker). base = gốc API (đã gồm base path nếu có). adminOnly = chỉ admin thấy.
  workspaces: {
    erp: { label: 'ERP (Click) — KT-*', base: process.env.ERP_WS_BASE || 'http://localhost:3500/docs/workspace', docsFormat: 'markdown' },
    marketing: { label: 'Marketing (CRM) — KTM-*', base: process.env.MKT_WS_BASE || 'http://localhost:3399', docsFormat: 'blocknote' },
    dhco: { label: 'DHP Management (dhco)', base: process.env.DHCO_WS_BASE || 'http://localhost:3120', adminOnly: true, docsFormat: 'blocknote' },
    thghub: { label: 'THG (thghub)', base: process.env.THGHUB_WS_BASE || 'http://localhost:3199', adminOnly: true, docsFormat: 'blocknote' },
    labs: { label: 'Side Projects', base: process.env.LABS_WS_BASE || 'http://localhost:3700/workspace', adminOnly: true, docsFormat: 'markdown' },
  } as Record<string, { label: string; base: string; adminOnly?: boolean; docsFormat: 'markdown' | 'blocknote' }>,
  repos: [
    {
      key: 'erp',
      label: 'ERP Kiến Trẻ',
      path: resolve(CLONES, 'erp'),
      branch: process.env.ERP_BRANCH || 'master',
      blurb:
        'Hệ thống ERP trung tâm giáo dục ("Click"). Next.js 16 + React 19 + Prisma + PostgreSQL. ' +
        'Đa tenant KIENTRE/KIENGIASU. Code chính: src/app/admin/** (UI admin), src/app/api/** (REST), ' +
        'src/lib/** (logic nghiệp vụ: chatbot, ai-dashboard, zalo-multi, services), prisma/schema.prisma (data model).',
    },
    {
      key: 'marketing',
      label: 'Kiến Trẻ Marketing (CRM)',
      path: resolve(CLONES, 'marketing'),
      branch: process.env.MARKETING_BRANCH || 'main',
      blurb:
        'CRM + AI Sales Agent đa kênh (front-of-funnel của ERP). 3 phần: backend/ Spring Boot (Java 17 — ' +
        'controller/entity/service/repository), frontend/ Next.js 16, zalo-bridge/ Node (Fastify + zca-js). ' +
        'Sync học sinh sang ERP ("Click"). Docs kiến trúc: AI_SALES_AGENT_PLAN.md.',
    },
    {
      key: 'dhco',
      label: 'DHP Management (dhco)',
      path: resolve(CLONES, 'dhco'),
      branch: process.env.DHCO_BRANCH || 'main',
      adminOnly: true,
      blurb: 'Hệ thống quản lý DHP (dhco). Next.js. Có workspace issue hub riêng. Chỉ admin truy cập.',
    },
    {
      key: 'thghub',
      label: 'THG (thghub)',
      path: resolve(CLONES, 'thghub'),
      branch: process.env.THGHUB_BRANCH || 'main',
      adminOnly: true,
      blurb: 'Hệ thống THG (thghub). Next.js. Có workspace issue hub riêng. Chỉ admin truy cập.',
    },
    // Side projects (chưa có workspace) — chỉ admin, chỉ hỏi-đáp code.
    { key: 'video_ai', label: 'video_ai', path: resolve(CLONES, 'video_ai'), branch: process.env.VIDEO_AI_BRANCH || 'main', adminOnly: true, blurb: 'Side project: video_ai.' },
    { key: 'adg_database', label: 'adg_database', path: resolve(CLONES, 'adg_database'), branch: process.env.ADG_BRANCH || 'main', adminOnly: true, blurb: 'Side project: adg_database (repo tham chiếu AI-ask của ba.autonow).' },
    { key: 'auto_facebook', label: 'auto_facebook', path: resolve(CLONES, 'auto_facebook'), branch: process.env.AUTO_FB_BRANCH || 'productize-nextclaw', adminOnly: true, blurb: 'Side project: auto_facebook.' },
    { key: 'design_printposs', label: 'design_printposs', path: resolve(CLONES, 'design_printposs'), branch: process.env.PRINTPOSS_BRANCH || 'main', adminOnly: true, blurb: 'Side project: design_printposs.' },
  ] as RepoCfg[],
};

export function repoByKey(key: string): RepoCfg | undefined {
  return config.repos.find((r) => r.key === key);
}

/** Dự án = nhóm hệ thống. Chọn dự án nào thì chat khoanh vùng đúng repo/workspace/db/log của nó. */
export type ProjectCfg = {
  key: string; label: string; blurb: string;
  repos: string[]; workspaces: string[]; dbKeys?: string[]; serverKeys?: string[]; adminOnly?: boolean;
};
export const DEFAULT_PROJECT = 'kientre';
export const projects: ProjectCfg[] = [
  {
    key: 'kientre', label: 'Kiến Trẻ (ERP + CRM)',
    blurb: 'Trung tâm giáo dục Kiến Trẻ — ERP/Click + Marketing/CRM (2 hệ thống liên kết).',
    repos: ['erp', 'marketing'], workspaces: ['erp', 'marketing'],
    dbKeys: ['erp', 'marketing'], serverKeys: ['erp', 'crm'],
  },
  {
    key: 'dhco', label: 'DHP Management', blurb: 'Hệ thống quản lý DHP (dhco).',
    repos: ['dhco'], workspaces: ['dhco'], dbKeys: ['dhco'], serverKeys: ['dhco'], adminOnly: true,
  },
  {
    key: 'thghub', label: 'THG', blurb: 'Hệ thống THG (thghub).',
    repos: ['thghub'], workspaces: ['thghub'], dbKeys: ['thg'], serverKeys: ['thg'], adminOnly: true,
  },
  {
    key: 'labs', label: 'Side Projects', blurb: 'Các side project chưa thành dự án chính — hỏi-đáp code + workspace chung (issue/docs).',
    repos: ['video_ai', 'adg_database', 'auto_facebook', 'design_printposs'], workspaces: ['labs'], adminOnly: true,
  },
];
export function projectByKey(key: string): ProjectCfg | undefined {
  return projects.find((p) => p.key === key);
}
export function visibleProjects(isAdmin: boolean): ProjectCfg[] {
  return projects.filter((p) => isAdmin || !p.adminOnly);
}
