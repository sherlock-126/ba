/**
 * Truy vấn DB thật (ERP + Marketing) — CHỈ ĐỌC. Theo pattern ADG runReadOnlyQuery:
 * transaction read-only ở tầng DB + chặn regex ghi + timeout + auto-LIMIT (chống ghi tuyệt đối).
 */
import pg from 'pg';
import { config } from './config.js';

const pools = new Map<string, pg.Pool>();
function getPool(dbKey: string): pg.Pool {
  const url = config.db[dbKey];
  if (!url) throw new Error(`Database "${dbKey}" chưa cấu hình`);
  let p = pools.get(dbKey);
  if (!p) { p = new pg.Pool({ connectionString: url, max: 3, idleTimeoutMillis: 30000, connectionTimeoutMillis: 8000 }); pools.set(dbKey, p); }
  return p;
}
export function dbAvailable(dbKey: string): boolean { return !!config.db[dbKey]; }
export const dbKeys = () => Object.keys(config.db).filter((k) => config.db[k]);

export type QueryResult = { ok: true; fields: string[]; rows: any[]; rowCount: number; elapsedMs: number };

export async function runReadOnlyQuery(dbKey: string, sql: string, limit = 200): Promise<QueryResult> {
  // An toàn 3 lớp (không dùng regex từ-khoá để tránh chặn nhầm SELECT có chữ "comment"/"update"…):
  //  (1) chỉ cho bắt đầu SELECT/WITH/EXPLAIN; (2) không cho nhiều câu lệnh (;);
  //  (3) chạy trong transaction default_transaction_read_only=on → DB từ chối MỌI thao tác ghi
  //      (kể cả INSERT/DELETE trong CTE, hàm volatile…). Đây là lớp chặn ghi thực sự.
  const trimmed = String(sql || '').trim().replace(/;\s*$/, '');
  if (!trimmed) throw new Error('SQL rỗng');
  if (!/^(select|with|explain)\b/i.test(trimmed)) throw new Error('Chỉ cho phép truy vấn ĐỌC — câu lệnh phải bắt đầu bằng SELECT / WITH / EXPLAIN.');
  if (/^explain\b/i.test(trimmed) && /\banalyze\b/i.test(trimmed)) throw new Error('EXPLAIN ANALYZE không được phép (thực thi query).');
  if (/;/.test(trimmed)) throw new Error('Không cho phép nhiều câu lệnh (;).');

  const client = await getPool(dbKey).connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL statement_timeout = 15000');
    await client.query('SET LOCAL default_transaction_read_only = on');
    const t0 = Date.now();
    const safe = /^explain\b/i.test(trimmed) ? trimmed : `SELECT * FROM (${trimmed}) AS _q LIMIT ${limit}`;
    const r = await client.query(safe);
    await client.query('ROLLBACK'); // chỉ đọc → rollback luôn cho sạch
    return { ok: true, fields: r.fields.map((f) => f.name), rows: r.rows, rowCount: r.rowCount ?? r.rows.length, elapsedMs: Date.now() - t0 };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { client.release(); }
}

export async function listTables(dbKey: string): Promise<{ schema: string; table: string }[]> {
  const r = await runReadOnlyQuery(dbKey,
    `SELECT table_schema AS schema, table_name AS table FROM information_schema.tables
     WHERE table_type IN ('BASE TABLE','VIEW') AND table_schema NOT IN ('pg_catalog','information_schema')
     ORDER BY table_schema, table_name`, 1000);
  return r.rows as any;
}

export async function describeTable(dbKey: string, table: string): Promise<{ column: string; type: string; nullable: string }[]> {
  // table có thể là "schema.table" hoặc "table"
  const [a, b] = table.includes('.') ? table.split('.') : ['public', table];
  const r = await runReadOnlyQuery(dbKey,
    `SELECT column_name AS column, data_type AS type, is_nullable AS nullable FROM information_schema.columns
     WHERE table_schema = '${a.replace(/'/g, "''")}' AND table_name = '${b.replace(/'/g, "''")}'
     ORDER BY ordinal_position`, 500);
  return r.rows as any;
}
