import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Nhập bằng giọng nói (dictation) qua Web Speech API — tiếng Việt.
 * onText nhận transcript hiện tại (final + interim) MỖI lần cập nhật; Composer tự ghép vào ô soạn.
 * Không hỗ trợ (Firefox / iOS cũ) → supported=false để ẩn nút.
 */
export function useVoice(onText: (transcript: string) => void) {
  const SR = typeof window !== 'undefined' ? ((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition) : null;
  const supported = !!SR;
  const [listening, setListening] = useState(false);
  const recRef = useRef<any>(null);
  const onTextRef = useRef(onText);
  onTextRef.current = onText;

  const stop = useCallback(() => {
    try { recRef.current?.stop(); } catch { /* ignore */ }
  }, []);

  const start = useCallback(() => {
    if (!SR || recRef.current) return;
    const rec = new SR();
    rec.lang = 'vi-VN';
    rec.interimResults = true;
    rec.continuous = true;
    rec.onresult = (e: any) => {
      let txt = '';
      for (let i = 0; i < e.results.length; i++) txt += e.results[i][0].transcript;
      onTextRef.current(txt.trim());
    };
    rec.onerror = (e: any) => {
      if (e?.error === 'not-allowed' || e?.error === 'service-not-allowed') {
        alert('Cần cấp quyền micro cho trang này để nhập bằng giọng nói.');
      }
      // 'no-speech' / 'network' / 'aborted' → dừng im lặng (onend sẽ reset).
    };
    rec.onend = () => { recRef.current = null; setListening(false); };
    recRef.current = rec;
    try { rec.start(); setListening(true); }
    catch { recRef.current = null; setListening(false); }
  }, [SR]);

  const toggle = useCallback(() => {
    if (recRef.current) stop(); else start();
  }, [start, stop]);

  // Dọn dẹp khi unmount.
  useEffect(() => () => { try { recRef.current?.abort?.(); } catch { /* ignore */ } recRef.current = null; }, []);

  return { supported, listening, toggle, stop };
}
