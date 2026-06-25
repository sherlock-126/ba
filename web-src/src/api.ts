// API client cho ba-autonow.

export type Project = { key: string; label: string; blurb: string };
export type ConvMeta = { id: string; title: string; project?: string; createdAt: number; updatedAt: number };
export type OutFile = { id: string; kind: 'excel' | 'word' | 'pdf' | 'html'; filename: string; downloadUrl: string; viewUrl: string; shareUrl: string };
export type Message = { role: 'user' | 'assistant'; content: string; ts: number; images?: string[]; files?: { name: string; type: string }[]; outFiles?: OutFile[] };
export type Conversation = ConvMeta & { messages: Message[] };
export type Me = { id: string; email: string; role: 'admin' | 'member'; mustChangePassword: boolean };
export type AdminUser = { id: string; email: string; role: 'admin' | 'member'; active: boolean; mustChangePassword: boolean; createdAt: number; lastLoginAt: number | null };
export type AuditEntry = { ts: number; actorEmail: string; action: string; target?: string; detail?: string };

export type PullResult = { repo: string; label: string; branch: string; ok: boolean; short: string; author: string; commitISO: string; subject: string };
export type Status = { repos: { key: string; label: string; branch: string }[]; lastPull: { at: number; results: PullResult[] }; model: string };

async function j<T>(url: string, opts?: RequestInit): Promise<T> {
  const r = await fetch(url, { credentials: 'same-origin', ...opts });
  if (!r.ok) { const e = await r.json().catch(() => null); throw new Error(e?.error || `HTTP ${r.status}`); }
  return r.json() as Promise<T>;
}
const post = (url: string, body?: unknown) => j(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });

export const api = {
  me: () => fetch('/api/me', { credentials: 'same-origin' }).then((r) => (r.ok ? r.json().then((d) => d.user as Me) : null)),
  login: (email: string, password: string) => post('/api/login', { email, password }).then((d: any) => d.user as Me),
  logout: () => post('/api/logout'),
  changePassword: (oldPassword: string, newPassword: string) => post('/api/me/password', { oldPassword, newPassword }),
  status: (project?: string) => j<Status>(`/api/status${project ? '?project=' + encodeURIComponent(project) : ''}`),
  refresh: (project?: string) => j<{ results: Status['lastPull']['results'] }>(`/api/refresh${project ? '?project=' + encodeURIComponent(project) : ''}`, { method: 'POST' }),
  projects: () => j<{ projects: Project[] }>('/api/projects').then((d) => d.projects),
  listConversations: (project?: string) => j<{ conversations: ConvMeta[] }>(`/api/conversations${project ? '?project=' + encodeURIComponent(project) : ''}`).then((d) => d.conversations),
  getConversation: (id: string) => j<Conversation>(`/api/conversations/${id}`),
  deleteConversation: (id: string) => j(`/api/conversations/${id}`, { method: 'DELETE' }),
  // admin
  listUsers: () => j<{ users: AdminUser[] }>('/api/users').then((d) => d.users),
  createUser: (email: string, password: string, role: 'admin' | 'member') => post('/api/users', { email, password, role }),
  updateUser: (id: string, patch: { role?: string; active?: boolean }) => j(`/api/users/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) }),
  resetPassword: (id: string, password: string) => post(`/api/users/${id}/reset-password`, { password }),
  deleteUser: (id: string) => j(`/api/users/${id}`, { method: 'DELETE' }),
  listAudit: () => j<{ entries: AuditEntry[] }>('/api/audit').then((d) => d.entries),
};
