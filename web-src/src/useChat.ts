import { useCallback, useRef, useState } from 'react';

export type ToolEvent = { id?: string; name: string; input?: any; result?: string; error?: boolean };
export type ChatTurn = {
  role: 'user' | 'assistant';
  content: string;
  images?: string[];
  files?: { name: string; type: string }[];
  tools?: ToolEvent[];
  ask?: { question: string; options: string[] } | null;
  pending?: boolean;
  errored?: boolean;
  ts?: number;
};

function parseSse(chunk: string): { event: string; data: any } | null {
  let event = 'message';
  let data = '';
  for (const line of chunk.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data += line.slice(5).trim();
  }
  if (!data) return null;
  try { return { event, data: JSON.parse(data) }; } catch { return { event, data }; }
}

export function useChat(onConversationStart?: (id: string) => void) {
  const [messages, setMessages] = useState<ChatTurn[]>([]);
  const [busy, setBusy] = useState(false);
  const convId = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const cancelled = useRef(false);

  const patchAt = useCallback((idx: number, fn: (t: ChatTurn) => ChatTurn) => {
    setMessages((arr) => (idx < 0 || idx >= arr.length ? arr : arr.map((t, i) => (i === idx ? fn(t) : t))));
  }, []);

  const applyEvent = useCallback((aIdx: number, event: string, data: any) => {
    const p = (fn: (t: ChatTurn) => ChatTurn) => patchAt(aIdx, fn);
    if (event === 'conversation') {
      const isNew = !convId.current;
      convId.current = data.id || convId.current;
      if (isNew && convId.current) onConversationStart?.(convId.current);
    } else if (event === 'text_delta') {
      p((x) => ({ ...x, content: x.content + (data.delta || '') }));
    } else if (event === 'tool_use_start') {
      p((x) => ({ ...x, tools: [...(x.tools || []), { id: data.id, name: data.name, input: data.input }] }));
    } else if (event === 'tool_result') {
      p((x) => {
        const tools = (x.tools || []).slice();
        let i = data.id ? tools.findIndex((t) => t.id === data.id) : -1;
        if (i < 0) for (let k = tools.length - 1; k >= 0; k--) if (tools[k].result === undefined) { i = k; break; }
        if (i >= 0) tools[i] = { ...tools[i], result: data.preview, error: data.error };
        return { ...x, tools };
      });
    } else if (event === 'ask_user') {
      p((x) => ({ ...x, ask: { question: data.question, options: data.options || [] } }));
    } else if (event === 'error') {
      p((x) => ({ ...x, content: x.content + (x.content ? '\n\n' : '') + `⚠️ ${data.message || 'Lỗi'}`, errored: true }));
    } else if (event === 'done') {
      p((x) => ({ ...x, pending: false }));
    }
  }, [patchAt, onConversationStart]);

  const send = useCallback(async (text: string, images?: string[], project?: string, files?: { name: string; type: string; data: string }[]) => {
    const t = text.trim();
    if ((!t && !(images && images.length) && !(files && files.length)) || busy) return;
    const fileMeta = files?.map((f) => ({ name: f.name, type: f.type }));
    const history = [...messages, { role: 'user' as const, content: t }];
    const aIdx = messages.length + 1;
    setMessages((arr) => [
      ...arr,
      { role: 'user', content: t, images, files: fileMeta, ts: Date.now() },
      { role: 'assistant', content: '', tools: [], pending: true, ts: Date.now() },
    ]);
    setBusy(true);
    cancelled.current = false;
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const res = await fetch('/api/chat', {
        method: 'POST', credentials: 'same-origin', signal: ac.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: t, conversationId: convId.current, images: images || [], project, files: files || [] }),
      });
      if (res.status === 401) { window.location.reload(); return; }
      if (!res.ok || !res.body) {
        patchAt(aIdx, (x) => ({ ...x, content: `Lỗi HTTP ${res.status}`, pending: false, errored: true }));
        return;
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const ev = parseSse(buf.slice(0, idx));
          buf = buf.slice(idx + 2);
          if (ev) applyEvent(aIdx, ev.event, ev.data);
        }
      }
    } catch {
      if (!cancelled.current) patchAt(aIdx, (x) => ({ ...x, content: x.content || 'Mất kết nối tới server.', errored: true }));
    } finally {
      setBusy(false);
      abortRef.current = null;
      patchAt(aIdx, (x) => ({ ...x, pending: false }));
    }
  }, [busy, messages, patchAt, applyEvent]);

  const cancel = useCallback(() => { cancelled.current = true; abortRef.current?.abort(); }, []);
  const reset = useCallback(() => { convId.current = null; setMessages([]); }, []);
  const seed = useCallback((id: string, turns: ChatTurn[]) => { convId.current = id; setMessages(turns); }, []);

  return { messages, busy, send, cancel, reset, seed, conversationId: convId };
}
