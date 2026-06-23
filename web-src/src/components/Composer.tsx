import { useEffect, useRef, useState } from 'react';
import { useVoice } from '../useVoice';

type Attach = { name: string; type: string; data: string };
const MAX_FILE = 20 * 1024 * 1024;   // 20MB / file
const MAX_FILES = 6;

// Đọc + thu nhỏ ảnh (cạnh dài ≤1568px, JPEG) để payload nhẹ mà Claude vẫn đọc rõ.
function imageToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const MAX = 1568;
        const scale = Math.min(1, MAX / Math.max(img.width, img.height));
        const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d')!.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', 0.9));
      };
      img.onerror = reject;
      img.src = reader.result as string;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
function readDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}
function humanSize(n: number): string { return n < 1024 ? n + 'B' : n < 1048576 ? Math.round(n / 1024) + 'KB' : (n / 1048576).toFixed(1) + 'MB'; }
function fileIcon(type: string, name: string): string {
  const t = (type || '').toLowerCase(); const n = name.toLowerCase();
  if (t.includes('pdf') || n.endsWith('.pdf')) return '📕';
  if (t.includes('sheet') || t.includes('excel') || /\.(xlsx?|csv)$/.test(n)) return '📊';
  if (t.includes('word') || n.endsWith('.docx')) return '📝';
  if (t.startsWith('video/')) return '🎬';
  if (t.startsWith('audio/')) return '🎵';
  if (t.startsWith('text/') || /\.(txt|md|json|xml|html?|js|ts|py|sql|ya?ml|log)$/.test(n)) return '📄';
  return '📦';
}

export function Composer({ busy, onSend, onCancel, onFocus }: {
  busy: boolean;
  onSend: (t: string, images?: string[], files?: Attach[]) => void;
  onCancel: () => void;
  onFocus?: () => void;
}) {
  const [text, setText] = useState('');
  const [imgs, setImgs] = useState<string[]>([]);
  const [files, setFiles] = useState<Attach[]>([]);
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const baseRef = useRef('');
  const voice = useVoice((tr) => { const b = baseRef.current; setText((b ? b + ' ' : '') + tr); });
  function toggleMic() { if (!voice.listening) baseRef.current = text.trim(); voice.toggle(); }

  useEffect(() => {
    const el = ref.current; if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 160) + 'px';
  }, [text]);

  async function addFiles(list: FileList | File[]) {
    const arr = [...list];
    const tooBig: string[] = [];
    for (const f of arr) {
      if (f.type.startsWith('image/')) {
        if (imgs.length >= 4) continue;
        try { const url = await imageToDataUrl(f); setImgs((a) => (a.length >= 4 ? a : [...a, url])); } catch { /* skip */ }
      } else {
        if (f.size > MAX_FILE) { tooBig.push(`${f.name} (${humanSize(f.size)})`); continue; }
        try {
          const data = await readDataUrl(f);
          setFiles((a) => (a.length >= MAX_FILES ? a : [...a, { name: f.name, type: f.type || '', data }]));
        } catch { /* skip */ }
      }
    }
    if (tooBig.length) alert('File quá lớn (>20MB), bỏ qua:\n' + tooBig.join('\n'));
  }
  function onPaste(e: React.ClipboardEvent) {
    const items = [...(e.clipboardData?.items || [])].filter((it) => it.kind === 'file');
    if (!items.length) return;
    e.preventDefault();
    addFiles(items.map((it) => it.getAsFile()!).filter(Boolean));
  }

  function submit() {
    const t = text.trim();
    if ((!t && !imgs.length && !files.length) || busy) return;
    voice.stop();
    onSend(t, imgs.length ? imgs : undefined, files.length ? files : undefined);
    setText(''); setImgs([]); setFiles([]); baseRef.current = '';
  }
  const hasAttach = imgs.length > 0 || files.length > 0;

  return (
    <div className="composer-bar border-t border-line bg-surface/80 p-3 backdrop-blur"
      style={{ paddingBottom: 'calc(0.75rem + env(safe-area-inset-bottom))' }}>
      <div className="mx-auto max-w-3xl">
        {(imgs.length > 0 || files.length > 0) && (
          <div className="mb-2 flex flex-wrap gap-2">
            {imgs.map((src, i) => (
              <div key={'i' + i} className="relative">
                <img src={src} alt="" className="h-16 w-16 rounded-md border border-line object-cover" />
                <button className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-red-600 text-[11px] text-white shadow"
                  onClick={() => setImgs((arr) => arr.filter((_, j) => j !== i))}>×</button>
              </div>
            ))}
            {files.map((f, i) => (
              <div key={'f' + i} className="relative flex max-w-[200px] items-center gap-1.5 rounded-lg border border-line bg-app/60 px-2.5 py-1.5 text-xs">
                <span>{fileIcon(f.type, f.name)}</span>
                <span className="truncate text-ink">{f.name}</span>
                <span className="shrink-0 text-[10px] text-muted">{humanSize(Math.ceil(f.data.length * 0.73))}</span>
                <button className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-red-600 text-[11px] text-white shadow"
                  onClick={() => setFiles((arr) => arr.filter((_, j) => j !== i))}>×</button>
              </div>
            ))}
          </div>
        )}
        <div className="flex items-end gap-2">
          <button className="btn-ghost h-[44px] px-2.5" title="Đính kèm file (mọi loại)" aria-label="Đính kèm file" onClick={() => fileRef.current?.click()}>📎</button>
          {voice.supported && (
            <button
              className={`h-[44px] px-2.5 rounded-lg border transition ${voice.listening
                ? 'animate-pulse border-red-400 bg-red-50 text-red-600'
                : 'border-line bg-surface text-ink hover:bg-slate-50'}`}
              title={voice.listening ? 'Đang nghe… bấm để dừng' : 'Nhập bằng giọng nói'}
              aria-label="Nhập bằng giọng nói"
              onClick={toggleMic}
            >🎤</button>
          )}
          <input ref={fileRef} type="file" accept="*/*" multiple className="hidden"
            onChange={(e) => { if (e.target.files) addFiles(e.target.files); e.target.value = ''; }} />
          <textarea
            ref={ref} rows={1} value={text} onFocus={onFocus}
            onChange={(e) => setText(e.target.value)} onPaste={onPaste}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } }}
            placeholder="Hỏi về logic code… (đính kèm file 📎 · dán ảnh Ctrl+V · Enter gửi)"
            className="input min-h-[44px] flex-1 resize-none leading-relaxed"
          />
          {busy ? (
            <button className="btn-ghost h-[44px]" onClick={onCancel}>⏹ Dừng</button>
          ) : (
            <button className="btn-primary h-[44px]" disabled={!text.trim() && !hasAttach} onClick={submit}>Gửi</button>
          )}
        </div>
      </div>
    </div>
  );
}
