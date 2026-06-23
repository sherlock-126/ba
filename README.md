# ba.autonow.vn — BA Code Assistant

Trợ lý AI hỏi-đáp **logic source code** 2 repo (ERP Kiến Trẻ + Kiến Trẻ Marketing) cho team BA.
Khuôn theo "AI Ask" của adg_database, nhưng hỏi về CODE thay vì DATA. Agent đọc code on-demand
(grep/read, **chỉ đọc**) qua Claude Agent SDK — như một "Claude Code chỉ-đọc" có giao diện chat web.

## Chạy
```bash
npm install
npm run setup-clones          # clone ERP(master) + marketing(develop) vào clones/
# Cấu hình .env: TEAM_PASSWORD + CLAUDE_CODE_OAUTH_TOKEN (bắt buộc khi chạy ngoài Claude Code)
npm run dev                   # hoặc: npm start   → http://localhost:3600
```

## Token AI (quan trọng)
Service gọi Claude qua `@anthropic-ai/claude-agent-sdk`. Cần `CLAUDE_CODE_OAUTH_TOKEN` trong `.env`:
```bash
claude setup-token            # tạo token, dán vào .env
```
(Khi chạy bên trong môi trường Claude Code interactive thì dùng creds ambient — nhưng systemd/production thì BẮT BUỘC có token trong .env.)

## Kiến trúc
- `src/server.ts` — Fastify: `/api/login`, `/api/chat` (SSE), `/api/conversations`, `/api/refresh`, `/api/status`.
- `src/ai/tools.ts` — MCP tool **đọc code read-only**: `list_repos`, `list_files`, `read_file`, `grep_code` (ripgrep), `ask_user`. Path bị giam trong 2 repo (chống traversal).
- `src/ai/agent.ts` — agent loop; `canUseTool` **chỉ cho phép `mcp__code__*`**, chặn mọi tool built-in (Bash/Read/Write…).
- `src/ai/prompts.ts` — system prompt mô tả 2 repo + phong cách trả lời cho BA (trích `file:line`, tiếng Việt).
- `src/repos.ts` — auto `git pull` (node-cron, mặc định 10') + `/api/refresh`. Clone riêng trong `clones/` (không đụng thư mục dev).
- `src/store.ts` — lịch sử hội thoại + session lưu file JSON trong `data/`.
- `web-src/` — UI chat React + Vite + Tailwind (clone look ADG: light/xanh, Plus Jakarta Sans, markdown + highlight, tool-card, streaming, sidebar). Build: `npm run build:web` → ra `web/` (Fastify serve tĩnh). `web/` là OUTPUT build, không sửa tay.

## Bảo mật
- Read-only tuyệt đối: không có tool ghi/chạy lệnh; built-in tools bị `canUseTool` chặn.
- File access giam trong 2 repo clone (`safeResolve`).
- Auth: mật khẩu chung team → cookie session (7 ngày).

## Còn lại (Pha 2)
- Tool `find_symbol` / `git_log` / `git_show` (cần clone sâu hơn — hiện shallow depth 1).
- Deploy: systemd unit + cloudflared cho `ba.autonow.vn`.
