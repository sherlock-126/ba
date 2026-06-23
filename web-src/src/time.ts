// Định dạng thời gian theo giờ VN.
const TZ = 'Asia/Ho_Chi_Minh';

export function fmtTime(ts?: number): string {
  if (!ts) return '';
  return new Date(ts).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', timeZone: TZ });
}

export function fmtRelative(ts?: number): string {
  if (!ts) return '';
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'vừa xong';
  if (m < 60) return `${m} phút trước`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} giờ trước`;
  const d = Math.floor(h / 24);
  if (d === 1) return 'hôm qua';
  if (d < 7) return `${d} ngày trước`;
  return new Date(ts).toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', timeZone: TZ });
}
