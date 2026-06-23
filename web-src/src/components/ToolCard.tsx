import type { ToolEvent } from '../useChat';

const LABEL: Record<string, string> = {
  list_repos: 'Xem danh sách repo',
  list_files: 'Liệt kê file',
  read_file: 'Đọc file',
  grep_code: 'Tìm trong code',
  ask_user: 'Chờ bạn chọn',
  workspace_list_modules: 'Xem module workspace',
  workspace_list_issues: 'Liệt kê issue',
  workspace_get_issue: 'Xem chi tiết issue',
  workspace_create_issue: 'Tạo issue',
  workspace_update_issue: 'Cập nhật issue',
  db_list_tables: 'Xem bảng DB thật',
  db_describe: 'Xem cấu trúc bảng',
  db_query: 'Truy vấn DB thật',
  server_list: 'Xem server & nguồn log',
  server_status: 'Trạng thái server',
  server_logs: 'Đọc log server',
  workspace_list_docs: 'Xem danh sách docs',
  workspace_get_doc: 'Đọc doc',
  workspace_create_doc: 'Tạo doc',
  workspace_update_doc: 'Cập nhật doc',
  workspace_delete_doc: 'Xoá doc',
  workspace_delete_issue: 'Xoá issue',
};
export const toolLabel = (n?: string) => (n ? LABEL[n] || n : 'công cụ');

function brief(input: any): string {
  if (!input || typeof input !== 'object') return '';
  if (input.title && input.workspace) return `${input.workspace}/${input.title}`;
  if (input.id && input.workspace) return `${input.workspace}/${input.id}`;
  if (input.source) return `${input.server ? input.server + '/' : ''}${input.source}${input.grep ? ' ~"' + input.grep + '"' : ''}`;
  if (input.sql) return String(input.sql).slice(0, 80);
  if (input.table) return `${input.db ? input.db + '.' : ''}${input.table}`;
  if (input.pattern) return `"${input.pattern}"${input.repo ? ' @' + input.repo : ''}`;
  if (input.path) return `${input.repo ? input.repo + '/' : ''}${input.path}`;
  if (input.server) return input.server;
  if (input.db) return input.db;
  if (input.repo) return input.repo;
  return '';
}

export function ToolCard({ t }: { t: ToolEvent }) {
  const icon = t.result === undefined ? '⏳' : t.error ? '⚠️' : '✓';
  return (
    <details className="group mt-1.5 rounded-md border border-line bg-slate-50/70 text-[11px]">
      <summary className="flex cursor-pointer items-center gap-1.5 px-2.5 py-1.5 text-muted marker:content-['']">
        <span>{icon}</span>
        <span className="font-medium text-brand-dark">{toolLabel(t.name)}</span>
        <span className="truncate font-mono text-slate-500">{brief(t.input)}</span>
      </summary>
      {t.result !== undefined && (
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words border-t border-line px-2.5 py-2 font-mono text-[10.5px] leading-relaxed text-slate-600">
          {t.result}
        </pre>
      )}
    </details>
  );
}
