import { useState, type ReactNode, isValidElement } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import type { ChatTurn } from '../useChat';
import { ToolCard, toolLabel } from './ToolCard';
import { D2Block } from './D2Block';
import { fmtTime } from '../time';

function Dots({ label }: { label: string }) {
  return (
    <div className="mt-1 flex items-center gap-2 text-xs font-medium text-brand-dark">
      <span className="inline-flex gap-0.5">
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-brand [animation-delay:-0.3s]" />
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-brand [animation-delay:-0.15s]" />
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-brand" />
      </span>
      <span>{label}…</span>
    </div>
  );
}

/** Lấy text thuần từ React children (để trích code mermaid). */
function toText(node: ReactNode): string {
  if (node == null || node === false) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(toText).join('');
  if (isValidElement(node)) return toText((node.props as any).children);
  return '';
}

const MD_COMPONENTS = {
  // Chặn ở cấp <pre>: nếu là khối ```d2 → render sơ đồ D2; còn lại giữ <pre> mặc định.
  pre({ children }: any) {
    const child = Array.isArray(children) ? children[0] : children;
    const cls: string = (isValidElement(child) && (child.props as any).className) || '';
    if (/language-d2/.test(cls)) {
      return <D2Block code={toText((child as any).props.children)} />;
    }
    return <pre>{children}</pre>;
  },
};

function Md({ children }: { children: string }) {
  return (
    <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[[rehypeHighlight, { ignoreMissing: true }]]} components={MD_COMPONENTS}>
      {children}
    </Markdown>
  );
}

/** Tách phần thân trả lời và mục "🔍 Tham chiếu kỹ thuật (cho dev)" (để thu gọn, mặc định đóng). */
function splitTechRef(md: string): { main: string; tech: string | null } {
  const m = md.match(/\n?[ \t>*_-]*🔍?[ *_]*Tham chiếu kỹ thuật[^\n]*\n?/i);
  if (!m || m.index === undefined || m.index === 0) return { main: md, tech: null };
  const tech = md.slice(m.index + m[0].length).replace(/^\s+/, '');
  if (!tech.trim()) return { main: md, tech: null };
  return { main: md.slice(0, m.index).trimEnd(), tech };
}

/** Bỏ ký tự thoát mà model lỡ đưa vào text câu hỏi (\" → ", \n → xuống dòng). */
function unesc(s: string): string {
  return s.replace(/\\(["'\\nt])/g, (_m, c) => (c === 'n' ? '\n' : c === 't' ? '\t' : c));
}

export function Message({ m, onPick }: { m: ChatTurn; onPick?: (t: string) => void }) {
  const [copied, setCopied] = useState(false);

  if (m.role === 'user') {
    return (
      <div className="flex flex-col items-end">
        {!!m.images?.length && (
          <div className="mb-1 flex max-w-[85%] flex-wrap justify-end gap-1.5">
            {m.images.map((src, i) => (
              <a key={i} href={src} target="_blank" rel="noreferrer">
                <img src={src} alt="" className="h-28 max-w-[180px] rounded-lg border border-line object-cover" />
              </a>
            ))}
          </div>
        )}
        {!!m.files?.length && (
          <div className="mb-1 flex max-w-[85%] flex-wrap justify-end gap-1.5">
            {m.files.map((f, i) => (
              <span key={i} className="flex max-w-[200px] items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-xs text-ink">
                <span>{/pdf/i.test(f.type) ? '📕' : /sheet|excel|csv/i.test(f.type + f.name) ? '📊' : /word|docx/i.test(f.type + f.name) ? '📝' : (f.type || '').startsWith('video/') ? '🎬' : (f.type || '').startsWith('audio/') ? '🎵' : '📄'}</span>
                <span className="truncate">{f.name}</span>
              </span>
            ))}
          </div>
        )}
        {m.content && (
          <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-brand px-3.5 py-2 text-sm text-white shadow-card">
            {m.content}
          </div>
        )}
        {m.ts && <div className="mt-1 pr-1 text-[10px] text-muted">{fmtTime(m.ts)}</div>}
      </div>
    );
  }

  const KNOWN = new Set(['list_repos', 'list_files', 'read_file', 'grep_code', 'ask_user',
    'workspace_list_modules', 'workspace_list_issues', 'workspace_get_issue', 'workspace_create_issue', 'workspace_update_issue',
    'db_list_tables', 'db_describe', 'db_query', 'server_list', 'server_status', 'server_logs',
    'workspace_list_docs', 'workspace_get_doc', 'workspace_create_doc', 'workspace_update_doc', 'workspace_delete_doc', 'workspace_delete_issue']);
  const tools = (m.tools || []).filter((t) => KNOWN.has(t.name));
  const running = tools.find((t) => t.result === undefined);
  const label = running ? toolLabel(running.name) : 'Đang soạn câu trả lời';

  function copy() {
    navigator.clipboard.writeText(m.content).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); });
  }

  return (
    <div className="group">
      {tools.map((t, i) => <ToolCard key={t.id || i} t={t} />)}
      {m.content && (() => {
        const { main, tech } = splitTechRef(m.content);
        return (
          <div className="mt-1.5">
            {main && <div className="markdown"><Md>{main}</Md></div>}
            {tech && (
              <details className="group mt-2 overflow-hidden rounded-lg border border-line bg-slate-50/60">
                <summary className="flex cursor-pointer select-none items-center gap-1.5 px-3 py-2 text-[12.5px] font-semibold text-brand-dark marker:content-['']">
                  <span className="text-muted transition group-open:rotate-90">▸</span>
                  🔍 Tham chiếu kỹ thuật (cho dev)
                </summary>
                <div className="markdown border-t border-line px-3 py-2 text-[13px]"><Md>{tech}</Md></div>
              </details>
            )}
          </div>
        );
      })()}
      {m.pending && <Dots label={label} />}
      {m.ask && (
        <div className="mt-2 rounded-xl border border-brand/30 bg-brand/5 p-3 text-sm">
          <div className="whitespace-pre-wrap font-semibold text-navy">{unesc(m.ask.question)}</div>
          {!!m.ask.options.length && (
            <div className="mt-2 flex flex-col gap-1.5">
              {m.ask.options.map((o, i) => (
                <button
                  key={i}
                  onClick={() => onPick?.(unesc(o))}
                  className="rounded-lg border border-brand/30 bg-surface px-3 py-2.5 text-left text-ink shadow-card transition hover:border-brand hover:bg-brand/10 active:scale-[0.99]"
                >{unesc(o)}</button>
              ))}
            </div>
          )}
          {!!m.ask.options.length && <div className="mt-2 text-[11px] text-muted">Chạm để chọn, hoặc tự nhập câu trả lời bên dưới.</div>}
        </div>
      )}
      {!m.pending && m.content && (
        <div className="mt-1 flex items-center gap-3 text-[11px] text-muted opacity-100 transition sm:opacity-0 sm:group-hover:opacity-100">
          <button className="hover:text-brand-dark" onClick={copy}>{copied ? '✓ Đã copy' : '📋 Copy'}</button>
          {m.ts && <span>{fmtTime(m.ts)}</span>}
        </div>
      )}
    </div>
  );
}
