/** Auth: login email+mật khẩu → session cookie (theo userId). */
import { randomBytes } from 'node:crypto';
import { config } from './config.js';
import { createSession, getSession, deleteSession } from './store.js';
import { getUserByEmail, verifyPassword, markLogin, getUserById, type User } from './users.js';

export const COOKIE = 'ba_sid';

export function parseCookie(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  (header || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

/** Đăng nhập. Trả {token, user} nếu đúng + active; null nếu sai. */
export async function login(email: string, password: string): Promise<{ token: string; user: User } | null> {
  const u = await getUserByEmail(email);
  if (!u || !u.active) return null;
  if (!verifyPassword(password, u.passwordHash)) return null;
  const token = randomBytes(24).toString('hex');
  await createSession(token, u.id);
  await markLogin(u.id);
  return { token, user: u };
}

export async function logout(cookieHeader: string | undefined): Promise<void> {
  await deleteSession(parseCookie(cookieHeader)[COOKIE]);
}

/** Lấy user hiện tại từ cookie (kiểm session TTL + user còn active). */
export async function sessionUser(cookieHeader: string | undefined): Promise<User | null> {
  const token = parseCookie(cookieHeader)[COOKIE];
  const sess = await getSession(token, config.app.sessionTtlMs);
  if (!sess) return null;
  const u = await getUserById(sess.userId);
  return u && u.active ? u : null;
}

export function cookieHeader(token: string): string {
  return `${COOKIE}=${token}; HttpOnly; Path=/; Max-Age=${Math.floor(config.app.sessionTtlMs / 1000)}; SameSite=Lax` +
    (config.app.cookieSecure ? '; Secure' : '');
}
