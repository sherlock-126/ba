import { useEffect, type RefObject } from 'react';

/**
 * Bám khung chat full-screen theo bàn phím (iOS/Android) bằng cách ĐO TRỰC TIẾP visualViewport
 * rồi set inline height/top lên element gốc → composer luôn nằm gọn ngay trên bàn phím.
 * Re-measure nhiều khung hình + timeout để bắt chiều cao bàn phím ĐÃ ỔN ĐỊNH (iOS bắn resize
 * ở giá trị trung gian lúc bàn phím bung). Khi đóng → xóa inline để CSS h-[100dvh]/top-0 lo.
 * (Học từ dhco/src/lib/use-viewport-height.ts.)
 */
export function useKeyboardViewport(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const vv = typeof window !== 'undefined' ? window.visualViewport : null;
    let raf = 0;
    const timers: ReturnType<typeof setTimeout>[] = [];

    const apply = () => {
      const h = vv?.height ?? window.innerHeight;
      const top = vv?.offsetTop ?? 0;
      const kbOpen = !!vv && window.innerHeight - top - h > 80;
      const el = ref.current;
      if (el) {
        if (kbOpen) {
          el.style.height = `${Math.round(h)}px`;
          el.style.top = `${Math.round(top)}px`;
        } else {
          el.style.height = '';
          el.style.top = '';
        }
      }
      document.documentElement.dataset.kb = kbOpen ? 'open' : '';
    };

    const burst = () => {
      cancelAnimationFrame(raf);
      let n = 0;
      const tick = () => { apply(); if (n++ < 8) raf = requestAnimationFrame(tick); };
      raf = requestAnimationFrame(tick);
      timers.push(setTimeout(apply, 250), setTimeout(apply, 450));
    };

    apply();
    burst();

    const onResize = () => burst();
    const onScroll = () => apply();
    const onBlur = () => { window.scrollTo(0, 0); burst(); };
    if (vv) {
      vv.addEventListener('resize', onResize);
      vv.addEventListener('scroll', onScroll);
    }
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
    document.addEventListener('focusin', onResize, true);
    document.addEventListener('focusout', onBlur, true);

    return () => {
      cancelAnimationFrame(raf);
      timers.forEach(clearTimeout);
      if (vv) {
        vv.removeEventListener('resize', onResize);
        vv.removeEventListener('scroll', onScroll);
      }
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
      document.removeEventListener('focusin', onResize, true);
      document.removeEventListener('focusout', onBlur, true);
      document.documentElement.dataset.kb = '';
    };
  }, [ref]);
}
