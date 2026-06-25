import { forwardRef, useEffect, useImperativeHandle, useState } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import type { CanvasHandle } from './SheetCanvas';
import { StarterKit } from '@tiptap/starter-kit';
import { Underline } from '@tiptap/extension-underline';
import { Image } from '@tiptap/extension-image';
import { Table, TableRow, TableHeader, TableCell } from '@tiptap/extension-table';

// Soạn thảo Word/HTML bằng TipTap. Nguồn chuẩn = HTML (PUT /api/files/:id/html).
// Word: server tự regenerate .docx từ html. HTML: ghi thẳng.
const DocxCanvas = forwardRef<CanvasHandle, { id: string; kind: string }>(function DocxCanvas({ id }, ref) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  const editor = useEditor({
    extensions: [StarterKit, Underline, Image, Table.configure({ resizable: true }), TableRow, TableHeader, TableCell],
    content: '',
    editorProps: { attributes: { class: 'markdown max-w-none min-h-full px-6 py-5 focus:outline-none' } },
  });

  useEffect(() => {
    if (!editor) return;
    let dead = false;
    (async () => {
      try { const r = await fetch(`/api/files/${id}/html`); const d = await r.json(); if (!dead) editor.commands.setContent(d.html || '<p></p>'); }
      catch { if (!dead) setMsg('Không tải được nội dung'); }
      if (!dead) setLoading(false);
    })();
    return () => { dead = true; };
  }, [editor, id]);

  const save = async () => {
    if (!editor) return;
    setSaving(true); setMsg('');
    try {
      const r = await fetch(`/api/files/${id}/html`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ html: editor.getHTML() }) });
      const d = await r.json();
      setMsg(!r.ok ? 'Lưu lỗi' : d.docxWarning ? 'Đã lưu HTML (·.docx cảnh báo)' : 'Đã lưu ✓');
    } catch { setMsg('Lưu lỗi'); }
    finally { setSaving(false); setTimeout(() => setMsg(''), 2800); }
  };

  // Copilot: cung cấp văn bản hiện tại + nhận lệnh chèn/sửa HTML từ AI.
  useImperativeHandle(ref, () => ({
    context: () => (editor?.getText() || '').slice(0, 9000),
    applyEdit: (ops) => {
      if (!editor) return;
      let html = editor.getHTML();
      for (const op of ops || []) {
        const frag = op.html || '';
        if (op.action === 'append') html += frag;
        else if (op.action === 'replace' && op.find) { html = html.includes(op.find) ? html.replace(op.find, frag) : html + frag; }
        else if (op.action === 'insert_after' && op.anchorHeading) {
          const re = new RegExp(`(<h[1-6][^>]*>${String(op.anchorHeading).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</h[1-6]>)`, 'i');
          html = re.test(html) ? html.replace(re, `$1${frag}`) : html + frag;
        }
      }
      editor.commands.setContent(html);
    },
  }), [editor]);

  const btn = (active: boolean) => 'rounded px-2 py-1 text-[13px] ' + (active ? 'bg-brand text-white' : 'text-ink hover:bg-slate-100');
  return (
    <div className="flex h-full flex-col bg-white">
      <div className="flex flex-wrap items-center gap-1 border-b border-line px-3 py-1.5">
        <button className={btn(!!editor?.isActive('bold'))} onClick={() => editor?.chain().focus().toggleBold().run()}><b>B</b></button>
        <button className={btn(!!editor?.isActive('italic'))} onClick={() => editor?.chain().focus().toggleItalic().run()}><i>I</i></button>
        <button className={btn(!!editor?.isActive('underline'))} onClick={() => editor?.chain().focus().toggleUnderline().run()}><u>U</u></button>
        <span className="mx-1 text-line">|</span>
        <button className={btn(!!editor?.isActive('heading', { level: 1 }))} onClick={() => editor?.chain().focus().toggleHeading({ level: 1 }).run()}>H1</button>
        <button className={btn(!!editor?.isActive('heading', { level: 2 }))} onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()}>H2</button>
        <button className={btn(!!editor?.isActive('bulletList'))} onClick={() => editor?.chain().focus().toggleBulletList().run()}>• Danh sách</button>
        <button className={btn(!!editor?.isActive('orderedList'))} onClick={() => editor?.chain().focus().toggleOrderedList().run()}>1. Số</button>
        <button className={btn(false)} onClick={() => editor?.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}>⊞ Bảng</button>
        <div className="flex-1" />
        {msg && <span className="text-xs text-muted">{msg}</span>}
        <button className="rounded-md bg-brand px-3 py-1 text-[13px] font-semibold text-white transition hover:bg-brand-dark disabled:opacity-50" disabled={saving} onClick={save}>{saving ? 'Đang lưu…' : '💾 Lưu'}</button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto bg-slate-50">
        {loading ? <div className="p-6 text-sm text-muted">Đang tải…</div> : <div className="mx-auto my-4 max-w-3xl rounded border border-line bg-white shadow-card"><EditorContent editor={editor} /></div>}
      </div>
    </div>
  );
});

export default DocxCanvas;
