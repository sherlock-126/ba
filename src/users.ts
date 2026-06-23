/**
 * Quản lý user (email + mật khẩu scrypt + role). Lưu data/users.json.
 * Theo mô hình ADG: password = scrypt$salt$hash, timingSafeEqual; không self-register.
 */
import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { config } from './config.js';

const USERS_FILE = resolve(process.cwd(), 'data', 'users.json');

export type Role = 'admin' | 'member';
export type User = {
  id: string; email: string; passwordHash: string; role: Role;
  active: boolean; mustChangePassword: boolean; createdAt: number; lastLoginAt: number | null;
};

let users: User[] | null = null;
let writing: Promise<void> = Promise.resolve();

async function ref(): Promise<User[]> {
  if (!users) { try { users = JSON.parse(await readFile(USERS_FILE, 'utf8')); } catch { users = []; } }
  return users!;
}
async function persist() {
  const data = users;
  writing = writing.then(async () => { await mkdir(dirname(USERS_FILE), { recursive: true }); await writeFile(USERS_FILE, JSON.stringify(data, null, 2)); });
  return writing;
}

const norm = (e: string) => String(e || '').trim().toLowerCase();

export function hashPassword(pw: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(pw, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}
export function verifyPassword(pw: string, stored: string): boolean {
  try {
    const [scheme, saltHex, hashHex] = stored.split('$');
    if (scheme !== 'scrypt') return false;
    const expected = Buffer.from(hashHex, 'hex');
    const actual = scryptSync(pw, Buffer.from(saltHex, 'hex'), expected.length);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch { return false; }
}

function publicUser(u: User) {
  const { passwordHash, ...rest } = u; return rest;
}
export type PublicUser = ReturnType<typeof publicUser>;

export async function listUsers(): Promise<PublicUser[]> {
  return (await ref()).map(publicUser).sort((a, b) => a.createdAt - b.createdAt);
}
export async function getUserById(id: string): Promise<User | undefined> { return (await ref()).find((u) => u.id === id); }
export async function getUserByEmail(email: string): Promise<User | undefined> { const e = norm(email); return (await ref()).find((u) => u.email === e); }

export async function createUser(email: string, password: string, role: Role): Promise<PublicUser> {
  const e = norm(email);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) throw new Error('Email không hợp lệ');
  if (!password || password.length < 6) throw new Error('Mật khẩu tối thiểu 6 ký tự');
  const all = await ref();
  if (all.some((u) => u.email === e)) throw new Error('Email đã tồn tại');
  const u: User = {
    id: randomBytes(8).toString('hex'), email: e, passwordHash: hashPassword(password),
    role, active: true, mustChangePassword: true, createdAt: Date.now(), lastLoginAt: null,
  };
  all.push(u); await persist(); return publicUser(u);
}

export async function updateUser(id: string, patch: { role?: Role; active?: boolean }): Promise<PublicUser | null> {
  const all = await ref(); const u = all.find((x) => x.id === id); if (!u) return null;
  if (patch.role) u.role = patch.role;
  if (typeof patch.active === 'boolean') u.active = patch.active;
  await persist(); return publicUser(u);
}
export async function setPassword(id: string, password: string, mustChange: boolean): Promise<boolean> {
  if (!password || password.length < 6) throw new Error('Mật khẩu tối thiểu 6 ký tự');
  const all = await ref(); const u = all.find((x) => x.id === id); if (!u) return false;
  u.passwordHash = hashPassword(password); u.mustChangePassword = mustChange; await persist(); return true;
}
export async function markLogin(id: string): Promise<void> {
  const all = await ref(); const u = all.find((x) => x.id === id); if (u) { u.lastLoginAt = Date.now(); await persist(); }
}
export async function deleteUser(id: string): Promise<boolean> {
  const all = await ref(); const i = all.findIndex((x) => x.id === id); if (i < 0) return false;
  all.splice(i, 1); await persist(); return true;
}
export async function countActiveAdmins(): Promise<number> {
  return (await ref()).filter((u) => u.role === 'admin' && u.active).length;
}

/** Lúc khởi động: nếu chưa có user nào → tạo admin với mật khẩu tạm random, in ra log 1 lần. */
export async function seedAdmin(): Promise<void> {
  const all = await ref();
  if (all.length) return;
  const temp = randomBytes(6).toString('base64url'); // ~8 ký tự
  const u: User = {
    id: randomBytes(8).toString('hex'), email: norm(config.admin.email), passwordHash: hashPassword(temp),
    role: 'admin', active: true, mustChangePassword: true, createdAt: Date.now(), lastLoginAt: null,
  };
  all.push(u); await persist();
  console.log('\n========================================');
  console.log('[ba] Đã tạo ADMIN đầu tiên:');
  console.log('     Email:    ' + u.email);
  console.log('     Mật khẩu tạm: ' + temp + '   (đổi ngay khi đăng nhập lần đầu)');
  console.log('========================================\n');
}
