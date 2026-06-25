/**
 * Truy vấn DB thật (PostgreSQL: ERP/Marketing/dhco/thg · MySQL: ecount) — CHỈ ĐỌC.
 * Engine tự nhận theo URL (mysql:// → MySQL, còn lại pg). Read-only 3 lớp:
 * (1) chỉ cho bắt đầu SELECT/WITH/EXPLAIN; (2) chặn nhiều câu lệnh (;);
 * (3) chạy trong transaction READ ONLY (pg: default_transaction_read_only / mysql: START TRANSACTION READ ONLY)
 *     → DB từ chối MỌI thao tác ghi. + timeout + auto-LIMIT.
 */
import pg from 'pg';
import { createPool as createMyPool, type Pool as MyPool } from 'mysql2/promise';
import { config } from './config.js';

type Engine = 'pg' | 'mysql';
function urlOf(dbKey: string): string { const u = config.db[dbKey]; if (!u) throw new Error(`Database "${dbKey}" chưa cấu hình`); return u; }
function engineOf(dbKey: string): Engine { return /^mysql/i.test(urlOf(dbKey)) ? 'mysql' : 'pg'; }

const pgPools = new Map<string, pg.Pool>();
const myPools = new Map<string, MyPool>();
function getPgPool(dbKey: string): pg.Pool {
  let p = pgPools.get(dbKey);
  if (!p) { p = new pg.Pool({ connectionString: urlOf(dbKey), max: 3, idleTimeoutMillis: 30000, connectionTimeoutMillis: 8000 }); pgPools.set(dbKey, p); }
  return p;
}
function getMyPool(dbKey: string): MyPool {
  let p = myPools.get(dbKey);
  if (!p) { p = createMyPool({ uri: urlOf(dbKey), connectionLimit: 3, connectTimeout: 8000, dateStrings: true }); myPools.set(dbKey, p); }
  return p;
}

export function dbAvailable(dbKey: string): boolean { return !!config.db[dbKey]; }
export const dbKeys = () => Object.keys(config.db).filter((k) => config.db[k]);

export type QueryResult = { ok: true; fields: string[]; rows: any[]; rowCount: number; elapsedMs: number };

export async function runReadOnlyQuery(dbKey: string, sql: string, limit = 200): Promise<QueryResult> {
  const trimmed = String(sql || '').trim().replace(/;\s*$/, '');
  if (!trimmed) throw new Error('SQL rỗng');
  if (!/^(select|with|explain)\b/i.test(trimmed)) throw new Error('Chỉ cho phép truy vấn ĐỌC — câu lệnh phải bắt đầu bằng SELECT / WITH / EXPLAIN.');
  if (/^explain\b/i.test(trimmed) && /\banalyze\b/i.test(trimmed)) throw new Error('EXPLAIN ANALYZE không được phép (thực thi query).');
  if (/;/.test(trimmed)) throw new Error('Không cho phép nhiều câu lệnh (;).');
  const isExplain = /^explain\b/i.test(trimmed);
  const safe = isExplain ? trimmed : `SELECT * FROM (${trimmed}) AS _q LIMIT ${limit}`;

  if (engineOf(dbKey) === 'mysql') {
    const conn = await getMyPool(dbKey).getConnection();
    try {
      await conn.query('SET SESSION max_execution_time = 15000'); // ms — giới hạn thời gian SELECT
      await conn.query('START TRANSACTION READ ONLY'); // InnoDB từ chối mọi ghi trong transaction này
      const t0 = Date.now();
      const [rows, fields] = await conn.query(safe);
      await conn.rollback().catch(() => {});
      const rs: any[] = Array.isArray(rows) ? rows : [];
      const fnames = Array.isArray(fields) ? (fields as any[]).map((f: any) => f.name) : (rs[0] ? Object.keys(rs[0]) : []);
      return { ok: true, fields: fnames, rows: rs, rowCount: rs.length, elapsedMs: Date.now() - t0 };
    } finally { conn.release(); }
  }

  const client = await getPgPool(dbKey).connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL statement_timeout = 15000');
    await client.query('SET LOCAL default_transaction_read_only = on');
    const t0 = Date.now();
    const r = await client.query(safe);
    await client.query('ROLLBACK'); // chỉ đọc → rollback luôn cho sạch
    return { ok: true, fields: r.fields.map((f) => f.name), rows: r.rows, rowCount: r.rowCount ?? r.rows.length, elapsedMs: Date.now() - t0 };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { client.release(); }
}

export async function listTables(dbKey: string): Promise<{ schema: string; table: string }[]> {
  const sql = engineOf(dbKey) === 'mysql'
    ? "SELECT table_schema AS `schema`, table_name AS `table` FROM information_schema.tables WHERE table_type IN ('BASE TABLE','VIEW') AND table_schema = DATABASE() ORDER BY table_name"
    : `SELECT table_schema AS schema, table_name AS table FROM information_schema.tables
       WHERE table_type IN ('BASE TABLE','VIEW') AND table_schema NOT IN ('pg_catalog','information_schema')
       ORDER BY table_schema, table_name`;
  const r = await runReadOnlyQuery(dbKey, sql, 1000);
  return r.rows as any;
}

export async function describeTable(dbKey: string, table: string): Promise<{ column: string; type: string; nullable: string }[]> {
  if (engineOf(dbKey) === 'mysql') {
    const t = (table.includes('.') ? table.split('.').pop()! : table).replace(/'/g, "''");
    const r = await runReadOnlyQuery(dbKey,
      "SELECT column_name AS `column`, data_type AS `type`, is_nullable AS nullable FROM information_schema.columns " +
      `WHERE table_schema = DATABASE() AND table_name = '${t}' ORDER BY ordinal_position`, 500);
    return r.rows as any;
  }
  const [a, b] = table.includes('.') ? table.split('.') : ['public', table];
  const r = await runReadOnlyQuery(dbKey,
    `SELECT column_name AS column, data_type AS type, is_nullable AS nullable FROM information_schema.columns
     WHERE table_schema = '${a.replace(/'/g, "''")}' AND table_name = '${b.replace(/'/g, "''")}'
     ORDER BY ordinal_position`, 500);
  return r.rows as any;
}
