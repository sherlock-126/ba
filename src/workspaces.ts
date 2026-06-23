/**
 * Client gọi API issue của 2 workspace hub (ERP + Marketing) bằng tài khoản "BA Bot".
 * Auth: cookie session (login email/password; auto-register nếu chưa có account). Không có API key tĩnh.
 * Chỉ READ + CREATE + UPDATE issue (không delete/deploy) — đúng phạm vi đã chốt.
 */
import { config } from './config.js';

export type WsKey = string;
const cookies = new Map<WsKey, string>();

function wsBase(ws: WsKey): string {
  const c = config.workspaces[ws];
  if (!c) throw new Error(`workspace "${ws}" không tồn tại (có: ${Object.keys(config.workspaces).join(' | ')})`);
  return c.base.replace(/\/+$/, '');
}

/** Gom Set-Cookie thành 1 chuỗi "k=v; k2=v2" để resend. */
function captureCookies(res: Response): string {
  const list = (res.headers as any).getSetCookie?.() as string[] | undefined;
  if (!list || !list.length) return '';
  return list.map((c) => c.split(';')[0]).join('; ');
}

async function login(ws: WsKey): Promise<boolean> {
  const res = await fetch(`${wsBase(ws)}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: config.bot.email, password: config.bot.password }),
  });
  if (!res.ok) return false;
  const ck = captureCookies(res);
  if (ck) { cookies.set(ws, ck); return true; }
  return false;
}

async function register(ws: WsKey): Promise<boolean> {
  // ERP dùng /api/auth/register, Marketing dùng /api/auth/signup → thử cả hai.
  // gửi cả name + display_name để hợp cả 2 server; register tự set cookie (auto-login).
  const body = JSON.stringify({ email: config.bot.email, password: config.bot.password, name: config.bot.name, display_name: config.bot.name });
  for (const path of ['/api/auth/register', '/api/auth/signup']) {
    const res = await fetch(`${wsBase(ws)}${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
    });
    if (res.status === 404) continue; // path không tồn tại ở workspace này → thử path kia
    if (res.ok) { const ck = captureCookies(res); if (ck) { cookies.set(ws, ck); return true; } }
    // 409 = email đã tồn tại → account có sẵn → login
    return login(ws);
  }
  return login(ws);
}

async function ensureSession(ws: WsKey): Promise<void> {
  if (cookies.get(ws)) return;
  if (await login(ws)) return;
  if (await register(ws)) return;
  throw new Error(`Không đăng nhập được workspace "${ws}" (kiểm tra service đang chạy + BOT_EMAIL/BOT_PASSWORD).`);
}

export type WsResult = { ok: boolean; status: number; data: any };

export async function wsRequest(ws: WsKey, method: string, path: string, body?: unknown): Promise<WsResult> {
  await ensureSession(ws);
  const doFetch = () => fetch(`${wsBase(ws)}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Cookie: cookies.get(ws) || '' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let res = await doFetch();
  if (res.status === 401) { // session hết hạn → login lại 1 lần
    cookies.delete(ws);
    await ensureSession(ws);
    res = await doFetch();
  }
  let data: any = null;
  const text = await res.text();
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { ok: res.ok, status: res.status, data };
}
