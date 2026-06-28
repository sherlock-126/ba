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
  userId?: string;                                         // chủ sở hữu file AI sinh ra
  openFile?: { kind: string; context: string };           // copilot: file đang mở trong canvas
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

export async function runAgent(opts: RunAgentOpts): Promise<{ text: string; outFiles: any[] }> {
  const token = config.ai.oauthToken;
  if (token) process.env.CLAUDE_CODE_OAUTH_TOKEN = token;
  // Nới trần token output để bài ghi issue dài (mô tả + tiêu chí nghiệm thu) không bị cắt giữa chừng.
  if (!process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS) process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = '24000';

  // Bắt sự kiện file_ready để LƯU kèm tin nhắn (mở lại hội thoại vẫn thấy thẻ file).
  const outFiles: any[] = [];
  const emit = (type: string, data: unknown) => { if (type === 'file_ready') outFiles.push(data); opts.emit(type, data); };

  const p = opts.project;
  // Khi CÓ dự án → luôn truyền mảng (mặc định rỗng) để khoanh vùng tuyệt đối:
  // dự án không khai dbKeys/serverKeys → KHÔNG có tool DB/log (tránh fallback về toàn bộ).
  const { server, allowedToolNames } = createCodeMcp({
    emit, userId: opts.userId, isAdmin: opts.isAdmin, onAudit: opts.onAudit,
    sheetOpen: opts.openFile?.kind === 'excel',
    docOpen: opts.openFile?.kind === 'word' || opts.openFile?.kind === 'html',
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
  // Copilot: file đang mở trong canvas → nhét ảnh chụp nội dung + chỉ dẫn dùng tool sửa trực tiếp.
  const of = opts.openFile;
  if (of?.kind === 'excel') {
    prompt += 'BẢNG TÍNH ĐANG MỞ (địa chỉ ô = nội dung). Sửa/điền bằng tool **fill_cells** (ref kiểu "B2", value số/chuỗi, hoặc công thức "=SUM(A2:A5)"):\n' + (of.context || '(trống)') + '\n\n';
  } else if (of?.kind === 'word' || of?.kind === 'html') {
    prompt += 'TÀI LIỆU ĐANG MỞ (văn bản hiện tại). Chèn/sửa bằng tool **edit_doc** (ops: append | insert_after{anchorHeading} | replace{find}, mỗi op kèm html):\n' + (of.context || '(trống)') + '\n\n';
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
  let stalled = false;                    // watchdog: KHÔNG tiến triển thật quá lâu → tự abort
  let rateLimited = false;                // SDK báo chạm trần hạn mức (five_hour) → đang chờ reset
  let rlNotified = false;                 // đã báo người dùng về rate limit (1 lần)
  const toolNames = new Map<string, string>();
  const WRITE_TOOLS = new Set(['workspace_create_issue', 'workspace_update_issue']);
  // NGUYÊN NHÂN TREO THẬT: khi tài khoản chạm trần hạn mức 5h, SDK nhả rate_limit_event đều đều và
  // CHỜ reset (im lặng, không output) → nhìn như treo. Mấy message đó KHÔNG phải tiến triển thật.
  // → Watchdog tính theo "thời gian KHÔNG có tiến triển thật" (text/tool/result), bỏ qua housekeeping.
  const IDLE_MS = Number(process.env.AI_IDLE_TIMEOUT_MS || 150_000);

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
  // Tự "bơm" iterator + RACE mỗi bước với idle-timeout. KHÔNG dựa vào abortController phá vòng lặp:
  // SDK query in-process có thể treo trên network read mà KHÔNG quan sát abort → for-await treo vô hạn.
  // Race đảm bảo consume luôn thoát sau IDLE_MS nếu next() không resolve (vẫn gọi abort để dọn dẹp).
  // "Tiến triển thật" = có chữ/tool/kết quả; KHÔNG tính system/rate_limit_event/status (housekeeping).
  const isProgress = (m: any) =>
    m.type === 'assistant' || m.type === 'user' || m.type === 'result' ||
    (m.type === 'stream_event' && m.event?.type === 'content_block_delta' && m.event.delta?.type === 'text_delta');

  const consume = async (it: AsyncIterable<any>) => {
    const iter = it[Symbol.asyncIterator]();
    let lastProgress = Date.now();
    while (true) {
      const nextP = iter.next();
      nextP.catch(() => {}); // tránh unhandledRejection nếu nó reject sau khi ta đã bỏ qua
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeoutP = new Promise<never>((_, rej) => {
        const tick = () => {
          const idleFor = Date.now() - lastProgress;
          if (idleFor >= IDLE_MS) {
            stalled = true;
            console.warn(`[agent] WATCHDOG: ${idleFor}ms không tiến triển (rateLimited=${rateLimited}, finalTextLen=${finalText.length})`);
            try { opts.abortController.abort(); } catch {}
            rej(new Error('idle-timeout'));
          } else {
            timer = setTimeout(tick, IDLE_MS - idleFor + 50); // chờ thêm cho đủ IDLE_MS kể từ tiến triển cuối
          }
        };
        // LỊCH theo lastProgress (KHÔNG phải "now") — nếu không, message housekeeping tới dồn dập sẽ
        // liên tục huỷ/đặt lại timer khiến nó không bao giờ kịp chạy (đúng lỗi của bản watchdog cũ).
        timer = setTimeout(tick, Math.max(50, IDLE_MS - (Date.now() - lastProgress)));
      });
      let res: IteratorResult<any>;
      try { res = await Promise.race([nextP, timeoutP]); }
      finally { if (timer) clearTimeout(timer); }
      if (res.done) break;
      if (isProgress(res.value)) lastProgress = Date.now(); // chỉ reset đồng hồ khi có tiến triển thật
      await handle(res.value);
    }
  };
  const handle = async (m: any) => {
    {
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
      } else if (m.type === 'rate_limit_event') {
        // SDK báo trạng thái hạn mức. status='allowed' = bình thường; khác đi = đang bị giới hạn/chờ reset.
        const info = m.rate_limit_info || {};
        const blocked = info.status && info.status !== 'allowed' && info.status !== 'allowed_warning';
        if (blocked || info.isUsingOverage) {
          rateLimited = true;
          if (!rlNotified) {
            rlNotified = true;
            const reset = info.resetsAt ? new Date(info.resetsAt * 1000) : null;
            const hhmm = reset ? reset.toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' }) : '?';
            console.warn(`[agent] RATE LIMIT status=${info.status} type=${info.rateLimitType} resetsAt=${info.resetsAt} overage=${info.isUsingOverage}`);
            opts.emit('text_delta', { delta: `\n\n⏳ _Tài khoản Claude đang chạm trần hạn mức dùng (${info.rateLimitType || 'rate limit'})${reset ? ', dự kiến reset lúc ' + hhmm : ''}. Đang chờ — nếu lâu, bạn thử lại sau hoặc hỏi gọn hơn để đỡ tốn hạn mức._\n\n` });
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

  const promptLen = typeof promptInput === 'string' ? prompt.length : prompt.length;
  console.warn(`[agent] start: promptChars=${promptLen} history=${history.length} imgs=${imgs.length} files=${(opts.files ?? []).length} fileBlocks=${fileBlocks.length} idleMs=${IDLE_MS} model=${config.ai.model}`);
  try {
    console.warn('[agent] → query() consume start');
    await consume(query({ prompt: promptInput, options: queryOptions }) as AsyncIterable<any>);
    console.warn(`[agent] ← consume done (lastSubtype=${lastSubtype} finalTextLen=${finalText.length})`);

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
    if (stalled && rateLimited) {
      console.warn(`[agent] abort do RATE LIMIT (không tiến triển ${IDLE_MS}ms)`);
      opts.emit('error', {
        message: '\n\n_(Đã tạm dừng: tài khoản Claude đang bị giới hạn hạn mức dùng (cửa sổ 5 giờ). Vui lòng thử lại sau khi reset, hoặc hỏi gọn hơn / tránh tạo file quá lớn để đỡ tốn hạn mức.)_',
      });
    } else if (stalled) {
      console.warn(`[agent] idle-timeout abort sau ${IDLE_MS}ms — không tiến triển (finalTextLen=${finalText.length})`);
      opts.emit('error', {
        message: finalText
          ? '\n\n_(Kết nối tới AI bị gián đoạn giữa chừng — câu trả lời có thể chưa trọn. Bạn gửi lại hoặc hỏi gọn hơn nhé.)_'
          : 'Kết nối tới AI bị gián đoạn (không nhận được phản hồi quá lâu). Bạn thử gửi lại; nếu câu hỏi dài, hãy chia nhỏ hoặc nêu rõ phạm vi.',
      });
    } else {
      console.warn(`[agent] ERROR (non-stall): ${raw.slice(0, 400)}`);
      const authish = /auth|token|oauth|credential|401|unauthor/i.test(raw);
      opts.emit('error', {
        message: authish
          ? `Chưa cấu hình token AI hoặc token không hợp lệ (cần CLAUDE_CODE_OAUTH_TOKEN trong .env). Chi tiết: ${raw}`
          : raw,
      });
    }
  }

  return { text: finalText, outFiles };
}
