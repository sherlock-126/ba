/**
 * Vòng lặp agent: gọi Claude (Agent SDK) với in-process MCP code-tools, stream sự kiện SSE.
 * Mỗi call là 1 session mới; lịch sử hội thoại được gộp vào prompt.
 */
import { query } from '@anthropic-ai/claude-agent-sdk';
import { config, type ProjectCfg } from '../config.js';
import { createCodeMcp } from './tools.js';
import { systemPrompt } from './prompts.js';
import { fileToBlocks, type InFile } from '../files.js';

export type ChatMsg = { role: 'user' | 'assistant'; content: string };

export type RunAgentOpts = {
  messages: ChatMsg[];
  abortController: AbortController;
  emit: (type: string, data: unknown) => void;
  isAdmin?: boolean;                                       // admin → có tool truy vấn DB thật
  onAudit?: (action: string, target?: string, detail?: string) => void;
  images?: string[];                                       // ảnh đính kèm tin nhắn cuối (data URL)
  files?: InFile[];                                        // file đính kèm mọi loại (pdf/excel/word/text/…)
  project?: ProjectCfg;                                    // khoanh vùng dự án (repo/ws/db/log)
};

/** Tách data URL "data:image/png;base64,XXXX" → {mediaType, data}. */
function parseDataUrl(u: string): { mediaType: string; data: string } | null {
  const m = /^data:([^;,]+);base64,(.+)$/s.exec(u);
  return m ? { mediaType: m[1], data: m[2] } : null;
}

export async function runAgent(opts: RunAgentOpts): Promise<{ text: string }> {
  const token = config.ai.oauthToken;
  if (token) process.env.CLAUDE_CODE_OAUTH_TOKEN = token;
  // Nới trần token output để bài ghi issue dài (mô tả + tiêu chí nghiệm thu) không bị cắt giữa chừng.
  if (!process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS) process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = '24000';

  const p = opts.project;
  // Khi CÓ dự án → luôn truyền mảng (mặc định rỗng) để khoanh vùng tuyệt đối:
  // dự án không khai dbKeys/serverKeys → KHÔNG có tool DB/log (tránh fallback về toàn bộ).
  const { server, allowedToolNames } = createCodeMcp({
    emit: opts.emit, isAdmin: opts.isAdmin, onAudit: opts.onAudit,
    repoKeys: p ? p.repos : undefined,
    wsKeys: p ? p.workspaces : undefined,
    dbKeys: p ? (p.dbKeys ?? []) : undefined,
    serverKeys: p ? (p.serverKeys ?? []) : undefined,
  });

  const all = opts.messages.filter((m) => m && typeof m.content === 'string');
  const last = all[all.length - 1];
  // Giới hạn ngữ cảnh: chỉ giữ tối đa 12 lượt gần nhất (tránh prompt phình + vượt context khi hội thoại dài).
  const HISTORY_LIMIT = 12;
  const history = all.slice(0, -1).slice(-HISTORY_LIMIT);
  let prompt = '';
  if (history.length) {
    prompt += 'BỐI CẢNH HỘI THOẠI TRƯỚC:\n' +
      history.map((m) => `${m.role === 'user' ? 'NGƯỜI DÙNG' : 'TRỢ LÝ'}: ${m.content}`).join('\n') + '\n\n';
  }
  prompt += `CÂU HỎI HIỆN TẠI:\n${last?.content ?? ''}`;

  // Đính kèm (ảnh/PDF/excel/word/text/…) → gửi prompt dạng message với content blocks để Claude đọc.
  const imgs = (opts.images ?? []).map(parseDataUrl).filter((x): x is { mediaType: string; data: string } => !!x);
  const fileBlocks: any[] = [];
  for (const f of opts.files ?? []) {
    try { fileBlocks.push(...await fileToBlocks(f)); }
    catch { fileBlocks.push({ type: 'text', text: `📎 [Không xử lý được file "${f?.name || '?'}"]` }); }
  }
  let promptInput: any = prompt;
  if (imgs.length || fileBlocks.length) {
    const content = [
      { type: 'text', text: prompt + (fileBlocks.length ? '\n\n(Người dùng có đính kèm file — nội dung đã trích ở các khối kèm theo.)' : '') },
      ...imgs.map((im) => ({ type: 'image', source: { type: 'base64', media_type: im.mediaType, data: im.data } })),
      ...fileBlocks,
    ];
    promptInput = (async function* () { yield { type: 'user', parent_tool_use_id: null, message: { role: 'user', content } }; })();
  }

  let finalText = '';
  let wroteIssue = false;                 // đã gọi tool GHI issue (create/update) trong phiên chưa
  let lastSubtype = '';                   // subtype của result gần nhất (chỉ nudge khi 'success')
  const toolNames = new Map<string, string>();
  const WRITE_TOOLS = new Set(['workspace_create_issue', 'workspace_update_issue']);

  const queryOptions = {
    model: config.ai.model,
    systemPrompt: systemPrompt({ isAdmin: !!opts.isAdmin, project: opts.project }),
    mcpServers: { code: server },
    allowedTools: allowedToolNames,
    // CHỈ cho phép các tool đọc-code của ta. Chặn mọi tool built-in (Bash/Read/Write/Edit/
    // WebFetch/ToolSearch…) — đảm bảo read-only và không truy cập ngoài 2 repo.
    canUseTool: async (name: string, input: Record<string, unknown>) => {
      if (name.startsWith('mcp__code__')) return { behavior: 'allow' as const, updatedInput: input };
      return { behavior: 'deny' as const, message: 'Chỉ được dùng các tool đọc code (mcp__code__*).' };
    },
    includePartialMessages: true,
    maxTurns: config.ai.maxTurns,
    abortController: opts.abortController,
    stderr: () => {},
  };

  // Tiêu thụ 1 phiên query: stream text, phát sự kiện tool, theo dõi tool ghi + kết quả.
  const consume = async (it: AsyncIterable<any>) => {
    for await (const m of it) {
      if (m.type === 'stream_event') {
        const ev = m.event;
        if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
          finalText += ev.delta.text;
          opts.emit('text_delta', { delta: ev.delta.text });
        }
      } else if (m.type === 'assistant') {
        for (const b of m.message?.content ?? []) {
          if (b.type === 'tool_use') {
            const short = String(b.name).replace('mcp__code__', '');
            if (WRITE_TOOLS.has(short)) wroteIssue = true;
            toolNames.set(b.id, short);
            opts.emit('tool_use_start', { id: b.id, name: short, input: b.input });
          }
        }
        const sr = m.message?.stop_reason;
        if (sr && sr !== 'end_turn' && sr !== 'tool_use') console.warn(`[agent] stop_reason=${sr}`);
      } else if (m.type === 'user') {
        const content = m.message?.content;
        if (Array.isArray(content)) {
          for (const b of content) {
            if (b.type === 'tool_result') {
              const nm = toolNames.get(b.tool_use_id) || 'tool';
              let preview = '';
              if (Array.isArray(b.content)) preview = b.content.map((c: any) => c.text || '').join('').slice(0, 300);
              else if (typeof b.content === 'string') preview = b.content.slice(0, 300);
              opts.emit('tool_result', { id: b.tool_use_id, name: nm, preview, error: !!b.is_error });
            }
          }
        }
      } else if (m.type === 'result') {
        const u = m.usage || {};
        lastSubtype = String(m.subtype);
        console.warn(`[agent] result subtype=${m.subtype} turns=${m.num_turns ?? '?'} out_tokens=${u.output_tokens ?? '?'} finalTextLen=${finalText.length} wroteIssue=${wroteIssue}`);
        if (m.subtype === 'success') {
          if (!finalText && typeof m.result === 'string') { finalText = m.result; opts.emit('text_delta', { delta: m.result }); }
        } else if (/max.?turn/i.test(String(m.subtype))) {
          opts.emit('error', {
            message: finalText
              ? '\n\n_(Đã đạt giới hạn số bước tra cứu — câu trả lời có thể chưa đầy đủ. Hãy hỏi cụ thể hơn để mình đào sâu phần bạn cần.)_'
              : 'Câu hỏi cần quá nhiều bước tra cứu. Hãy thu hẹp phạm vi (nêu rõ repo/module/tên hàm) để mình trả lời chính xác hơn.',
          });
        } else {
          opts.emit('error', { message: 'AI gặp lỗi khi xử lý (' + (m.subtype || 'unknown') + ').' });
        }
      }
    }
  };

  try {
    await consume(query({ prompt: promptInput, options: queryOptions }) as AsyncIterable<any>);

    // Chống "hứa rồi dừng": model CAM KẾT (ngôi thứ nhất) sẽ ghi/cập nhật issue nhưng KHÔNG gọi tool ghi → ép thực hiện đúng 1 lần.
    // Siết để tránh false-positive: phải là cam kết "em/mình sẽ ghi/điền/cập nhật…" (không phải chỉ nhắc tới),
    // + đúng ngữ cảnh issue, + không phải câu hỏi, + pass đầu thành công, + người dùng chưa huỷ.
    const t = finalText.trim();
    // Cam kết MẠNH (idiom ghi đè issue — tự thân đủ ý định ghi):
    const strongCommit = /ghi đè|ghi đè lại|ghi đè ngay|điền nốt|cập nhật ngay/i;
    // Cam kết MỀM (ngôi 1 + động từ ghi) — cần kèm ngữ cảnh issue để tránh nhầm:
    const softCommit = /(em|mình)\s*(sẽ|xin|đã|vừa)?\s*(cập nhật|ghi lại|điền|đóng mục|tạo issue|tạo lại|lưu)\b/i;
    const aboutIssue = /\bissue\b|KT-[A-Z]|KTM-[A-Z]/i;
    // Đang CHỜ người dùng (hỏi giá trị / xin xác nhận) → KHÔNG ép ghi:
    const waiting = /(cho em xin|chị (cho|xác nhận|chọn|muốn|quyết)|nếu chị|chờ (chị|anh|cô|bạn)|bạn (xác nhận|chọn|cho)|chọn hướng)/i;
    const intendsWrite = !t.endsWith('?') && !waiting.test(t) && (strongCommit.test(t) || (softCommit.test(t) && aboutIssue.test(t)));
    if (lastSubtype === 'success' && !wroteIssue && intendsWrite && !opts.abortController.signal.aborted) {
      console.warn('[agent] promised-but-didnt-write → nudge ép gọi tool');
      const nudge =
        `${prompt}\n\n[TRỢ LÝ VỪA TRẢ LỜI]:\n${finalText}\n\n` +
        `[HỆ THỐNG — BẮT BUỘC]: Bạn vừa nói sẽ ghi/cập nhật issue NHƯNG CHƯA gọi tool ghi nào (workspace_update_issue/workspace_create_issue). ` +
        `HÃY GỌI NGAY tool ghi với nội dung đầy đủ như đã mô tả. KHÔNG giải thích thêm, chỉ thực hiện. Sau khi tool trả kết quả mới báo ngắn gọn "đã cập nhật ✓" (hoặc nêu lỗi nếu thất bại).`;
      opts.emit('text_delta', { delta: '\n\n' });
      await consume(query({ prompt: nudge, options: queryOptions }) as AsyncIterable<any>);
    }
  } catch (e: any) {
    const raw = String(e?.message ?? e);
    const authish = /auth|token|oauth|credential|401|unauthor/i.test(raw);
    opts.emit('error', {
      message: authish
        ? `Chưa cấu hình token AI hoặc token không hợp lệ (cần CLAUDE_CODE_OAUTH_TOKEN trong .env). Chi tiết: ${raw}`
        : raw,
    });
  }

  return { text: finalText };
}
