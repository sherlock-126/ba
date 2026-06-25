import { useEffect, useRef, useState } from 'react';
import type { ChatTurn } from '../useChat';
import type { Project } from '../api';
import { Message } from './Message';
import { Composer } from './Composer';
import { Empty } from './Empty';
import { DiagramSelectionProvider, DiagramExportBar } from './diagramExport';

export function ChatPanel({ messages, busy, onSend, onCancel, project }: {
  messages: ChatTurn[];
  busy: boolean;
  onSend: (t: string, images?: string[], files?: { name: string; type: string; data: string }[]) => void;
  onCancel: () => void;
  project?: Project;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const atBottomRef = useRef(true);

  function onScroll() {
    const el = scrollRef.current; if (!el) return;
    const b = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    atBottomRef.current = b; setAtBottom(b);
  }
  const scrollToBottom = (smooth = false) => {
    const el = scrollRef.current; if (el) el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  };
  useEffect(() => { if (atBottom) scrollToBottom(); }, [messages, atBottom]);

  // Bàn phím mở (visualViewport co) → nếu đang ở đáy thì giữ tin nhắn cuối hiển thị trên bàn phím.
  useEffect(() => {
    const vv = window.visualViewport; if (!vv) return;
    const onVV = () => { if (atBottomRef.current) requestAnimationFrame(() => scrollToBottom()); };
    vv.addEventListener('resize', onVV);
    return () => vv.removeEventListener('resize', onVV);
  }, []);

  // Focus ô nhập → cuộn xuống đáy sau khi bàn phím settle.
  const onComposerFocus = () => setTimeout(() => scrollToBottom(true), 300);

  return (
    <DiagramSelectionProvider>
    <div className="relative flex min-w-0 flex-1 flex-col">
      <div ref={scrollRef} onScroll={onScroll} className="flex-1 overflow-auto overscroll-contain">
        {messages.length === 0 ? (
          <Empty onPick={onSend} project={project} />
        ) : (
          <div className="mx-auto max-w-3xl space-y-5 px-4 py-6">
            {messages.map((m, i) => <Message key={i} m={m} onPick={onSend} />)}
          </div>
        )}
      </div>
      {!atBottom && (
        <button
          onClick={() => { setAtBottom(true); scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' }); }}
          className="absolute bottom-24 left-1/2 -translate-x-1/2 rounded-full border border-line bg-surface px-3 py-1 text-xs text-muted shadow-cardhover hover:text-brand-dark"
        >↓ Mới nhất</button>
      )}
      <DiagramExportBar />
      <Composer busy={busy} onSend={onSend} onCancel={onCancel} onFocus={onComposerFocus} />
    </div>
    </DiagramSelectionProvider>
  );
}
