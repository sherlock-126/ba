import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import {
  ReactFlow, Background, Controls, MarkerType, Position, Handle, getNodesBounds,
  BaseEdge, EdgeLabelRenderer, getSmoothStepPath, useInternalNode,
  useNodesState, useEdgesState, type Node, type Edge, type EdgeProps, type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import * as htmlToImage from 'html-to-image';

export type FlowHandle = { exportBlob: () => Promise<Blob> };

// D2 dùng để COMPILE (layout ELK) + RENDER (SVG cho loại đặc biệt). Lazy + serialize.
let d2Promise: Promise<any> | null = null;
async function getD2() {
  if (!d2Promise) d2Promise = import('@terrastruct/d2').then((m: any) => new m.D2());
  return d2Promise;
}
let chain: Promise<any> = Promise.resolve();
function runD2<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn); chain = next.catch(() => {}); return next;
}

// Chỉ sequence/ER mới render D2 NATIVE (SVG tĩnh). Swimlane (grid) → React Flow (kéo-thả + fit + mũi tên vuông).
const STRUCTURED = /shape:\s*(sequence_diagram|sql_table|class)\b/;

// Shape draw.io mà D2 KHÔNG có từ khoá → khai bằng `class:` (D2 truyền classes qua compile).
const CUSTOM_CLASSES = ['manual-input', 'manual-op', 'delay', 'off-page', 'card', 'internal-storage', 'predefined'];
// Preamble định nghĩa các class custom → map về shape D2 thật để ELK layout đúng (ta vẽ SVG riêng sau).
const CLASS_PREAMBLE = `classes: {
  manual-input: { shape: parallelogram }
  manual-op: { shape: hexagon }
  delay: { shape: rectangle }
  off-page: { shape: hexagon }
  card: { shape: rectangle }
  internal-storage: { shape: rectangle }
  predefined: { shape: rectangle }
}
`;

const hs: React.CSSProperties = { opacity: 0, width: 1, height: 1, minWidth: 0, minHeight: 0, border: 'none' };
const center: React.CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center', fontFamily: 'inherit', lineHeight: 1.2 };

// ── Bộ shape Flowchart kiểu draw.io, vẽ bằng SVG (viewBox 0..100, co giãn theo node) ──
// Theme sạch: nền trắng, viền mảnh slate; vector-effect non-scaling-stroke → viền luôn sắc nét.
const SW = 1.6;
function ShapeSVG({ shape, fill, stroke }: { shape: string; fill: string; stroke: string }) {
  const c: any = { fill, stroke, strokeWidth: SW, vectorEffect: 'non-scaling-stroke', strokeLinejoin: 'round' };
  const line = { fill: 'none', stroke, strokeWidth: SW, vectorEffect: 'non-scaling-stroke' as const };
  let g: React.ReactNode;
  switch (shape) {
    case 'diamond': g = <polygon points="50,2 98,50 50,98 2,50" {...c} />; break;
    case 'oval': g = <rect x="1.5" y="1.5" width="97" height="97" rx="50" ry="50" {...c} />; break;
    case 'circle': g = <ellipse cx="50" cy="50" rx="48" ry="48" {...c} />; break;
    case 'square': g = <rect x="2" y="2" width="96" height="96" rx="2" {...c} />; break;
    case 'parallelogram': g = <polygon points="22,2 98,2 78,98 2,98" {...c} />; break;
    case 'document': g = <path d="M2,2 H98 V78 C76,97 24,60 2,80 Z" {...c} />; break;
    case 'cylinder': g = <><path d="M2,13 C2,4 98,4 98,13 V87 C98,96 2,96 2,87 Z" {...c} /><path d="M2,13 C2,22 98,22 98,13" {...line} /></>; break;
    case 'queue': g = <><path d="M87,2 H13 C4,2 4,98 13,98 H87 C96,98 96,2 87,2 Z" {...c} /><path d="M87,2 C78,2 78,98 87,98" {...line} /></>; break;
    case 'hexagon': g = <polygon points="24,2 76,2 98,50 76,98 24,98 2,50" {...c} />; break;
    case 'step': g = <polygon points="2,2 80,2 98,50 80,98 2,98 20,50" {...c} />; break;
    case 'stored_data': g = <path d="M16,2 H98 C86,28 86,72 98,98 H16 C28,72 28,28 16,2 Z" {...c} />; break;
    case 'callout': g = <path d="M5,2 H95 Q98,2 98,5 V64 Q98,67 95,67 H40 L30,92 L26,67 H5 Q2,67 2,64 V5 Q2,2 5,2 Z" {...c} />; break;
    case 'person': g = <><circle cx="50" cy="23" r="17" {...c} /><path d="M13,98 C13,57 87,57 87,98" {...c} /></>; break;
    case 'cloud': g = <path d="M28,84 C10,84 7,58 26,55 C20,33 56,25 64,46 C88,38 96,72 76,82 C70,86 38,86 28,84 Z" {...c} />; break;
    case 'page': g = <><path d="M2,2 H74 L98,26 V98 H2 Z" {...c} /><path d="M74,2 V26 H98" {...line} /></>; break;
    case 'package': g = <path d="M2,12 H38 L45,2 H98 V98 H2 Z" {...c} />; break;
    // ── shape draw.io bổ sung (qua class:) ──
    case 'manual-input': g = <polygon points="2,22 98,2 98,98 2,98" {...c} />; break;
    case 'manual-op': g = <polygon points="2,2 98,2 82,98 18,98" {...c} />; break;
    case 'delay': g = <path d="M2,2 H58 C92,2 92,98 58,98 H2 Z" {...c} />; break;
    case 'off-page': g = <polygon points="2,2 98,2 98,66 50,98 2,66" {...c} />; break;
    case 'card': g = <polygon points="22,2 98,2 98,98 2,98 2,22" {...c} />; break;
    case 'internal-storage': g = <><rect x="2" y="2" width="96" height="96" rx="2" {...c} /><path d="M22,2 V98 M2,24 H98" {...line} /></>; break;
    case 'predefined': g = <><rect x="2" y="2" width="96" height="96" rx="2" {...c} /><path d="M12,2 V98 M88,2 V98" {...line} /></>; break;
    default: g = <rect x="1.5" y="1.5" width="97" height="97" rx="4" {...c} />; // rectangle / process
  }
  return <svg viewBox="0 0 100 100" preserveAspectRatio="none" width="100%" height="100%" style={{ position: 'absolute', inset: 0, overflow: 'visible' }}>{g}</svg>;
}

// Chỉ nhận MÃ MÀU CSS thật (hex/rgb/hsl). D2 trả s.fill là token nội bộ KHÔNG hợp lệ với SVG
// (đặt vào fill="" → SVG render ĐEN) → lọc bỏ, để dùng THEME. Hex agent set (vd #fee2e2) được giữ.
const validColor = (v: any): string | undefined =>
  (typeof v === 'string' && /^#[0-9a-fA-F]{3,8}$|^rgb|^hsl/.test(v.trim())) ? v.trim() : undefined;

// Bảng màu mặc định theo shape — hài hoà với brand hệ thống (#1f6fd0). Mềm, dễ đọc.
type Tone = { fill: string; stroke: string; color: string };
const RECT: Tone = { fill: '#eef4fc', stroke: '#1f6fd0', color: '#16315f' };
const DB: Tone = { fill: '#e6f6fb', stroke: '#0e7490', color: '#164e63' };
const NEUTRAL: Tone = { fill: '#f3f6fa', stroke: '#64748b', color: '#334155' };
const THEME: Record<string, Tone> = {
  rectangle: RECT, step: RECT, square: RECT,
  oval: { fill: '#e8f5ee', stroke: '#16a34a', color: '#14532d' },
  diamond: { fill: '#fef6e0', stroke: '#ca8a04', color: '#713f12' },
  parallelogram: { fill: '#eef0fb', stroke: '#4f46e5', color: '#312e81' },
  document: { fill: '#f3f6fa', stroke: '#475569', color: '#1e293b' },
  cylinder: DB, queue: DB, stored_data: DB,
  hexagon: { fill: '#f6eefb', stroke: '#9333ea', color: '#581c87' },
  person: { fill: '#fef0e6', stroke: '#ea580c', color: '#7c2d12' },
  callout: { fill: '#fffaeb', stroke: '#d97706', color: '#78350f' },
  circle: NEUTRAL, cloud: NEUTRAL, page: NEUTRAL, package: NEUTRAL,
  'manual-input': { fill: '#eef0fb', stroke: '#4f46e5', color: '#312e81' },
  'manual-op': { fill: '#f6eefb', stroke: '#9333ea', color: '#581c87' },
  'card': RECT, 'predefined': RECT, 'internal-storage': DB, 'delay': NEUTRAL, 'off-page': NEUTRAL,
  text: { fill: 'none', stroke: 'none', color: '#475569' },
};

// Ý nghĩa từng ký hiệu (cho bảng chú thích), theo thứ tự hiển thị.
export const SHAPE_MEANINGS: { shape: string; label: string }[] = [
  { shape: 'rectangle', label: 'Bước xử lý' },
  { shape: 'oval', label: 'Bắt đầu / Kết thúc' },
  { shape: 'diamond', label: 'Quyết định / Rẽ nhánh' },
  { shape: 'parallelogram', label: 'Nhập / Xuất dữ liệu' },
  { shape: 'document', label: 'Tài liệu / Biểu mẫu' },
  { shape: 'cylinder', label: 'Cơ sở dữ liệu' },
  { shape: 'stored_data', label: 'Lưu trữ dữ liệu' },
  { shape: 'hexagon', label: 'Chuẩn bị / Thiết lập' },
  { shape: 'step', label: 'Bước con / Giai đoạn' },
  { shape: 'circle', label: 'Điểm nối' },
  { shape: 'person', label: 'Tác nhân / Người dùng' },
  { shape: 'cloud', label: 'Dịch vụ ngoài' },
  { shape: 'queue', label: 'Hàng đợi' },
  { shape: 'callout', label: 'Chú thích' },
  { shape: 'page', label: 'Trang / Báo cáo' },
  { shape: 'package', label: 'Gói chức năng' },
  { shape: 'square', label: 'Ô / Khối' },
  { shape: 'manual-input', label: 'Nhập tay' },
  { shape: 'manual-op', label: 'Thao tác tay' },
  { shape: 'delay', label: 'Chờ / Trễ' },
  { shape: 'off-page', label: 'Nối sang trang' },
  { shape: 'card', label: 'Thẻ' },
  { shape: 'internal-storage', label: 'Lưu nội bộ' },
  { shape: 'predefined', label: 'Quy trình con' },
  { shape: 'text', label: 'Ghi chú' },
];

// Icon nhỏ (tái dùng ShapeSVG) cho bảng chú thích.
export function ShapeIcon({ shape }: { shape: string }) {
  if (shape === 'text') return <span style={{ display: 'inline-flex', width: 26, height: 17, alignItems: 'center', justifyContent: 'center', fontStyle: 'italic', fontSize: 11, color: '#475569', flex: 'none' }}>Aa</span>;
  return <span style={{ position: 'relative', display: 'inline-block', width: 26, height: 17, flex: 'none' }}><ShapeSVG shape={shape} fill="#ffffff" stroke="#475569" /></span>;
}

// Lề chữ theo từng shape (để nhãn không tràn ra phần vát/cong) — tính theo % cạnh node.
function padFor(shape: string): React.CSSProperties {
  switch (shape) {
    case 'diamond': return { padding: '16% 20%' };
    case 'parallelogram': return { padding: '8% 18%' };
    case 'hexagon': return { padding: '10% 20%' };
    case 'step': return { padding: '8% 20%' };
    case 'cylinder': return { padding: '22% 10% 8%' };
    case 'queue': return { padding: '8% 18% 8% 8%' };
    case 'document': return { padding: '6% 8% 16%' };
    case 'circle': return { padding: '14% 16%' };
    case 'oval': return { padding: '8% 16%' };
    case 'callout': return { padding: '6% 8% 24%' };
    case 'person': return { padding: '46% 6% 6%' };
    case 'cloud': return { padding: '26% 17% 16%' };
    case 'page': return { padding: '8% 16% 8% 8%' };
    case 'package': return { padding: '16% 8% 8%' };
    case 'stored_data': return { padding: '8% 12% 8% 18%' };
    case 'manual-input': return { padding: '16% 10% 8%' };
    case 'manual-op': return { padding: '10% 20%' };
    case 'delay': return { padding: '10% 24% 10% 10%' };
    case 'off-page': return { padding: '8% 12% 20%' };
    case 'card': return { padding: '16% 8% 8%' };
    case 'internal-storage': return { padding: '26% 8% 8% 24%' };
    case 'predefined': return { padding: '8% 16%' };
    default: return { padding: '6px 10px' };
  }
}

// Node tổng quát: vẽ shape SVG + nhãn căn giữa. shape='text' → chỉ chữ, không viền.
function ShapeNode({ data }: NodeProps) {
  const d = data as any;
  const shape: string = d.shape || 'rectangle';
  const t = THEME[shape] || THEME.rectangle;
  const custom = validColor(d.fill);          // chỉ màu agent set hợp lệ mới override
  const fill = custom || t.fill;
  const stroke = custom ? '#94a3b8' : t.stroke; // fill tuỳ chỉnh → viền slate trung tính cho hợp
  const color = t.color;
  const isText = shape === 'text';
  // Actor: icon người NHỎ, tỉ lệ cố định (không giãn theo node) + nhãn dưới → gọn đẹp.
  if (shape === 'person') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 3, width: '100%', height: '100%', boxSizing: 'border-box', padding: '7px 12px', background: fill, border: `1.5px solid ${stroke}`, borderRadius: 10 }}>
        <Handle type="target" position={Position.Top} style={hs} />
        <Handle type="source" position={Position.Bottom} style={hs} />
        <svg width="20" height="23" viewBox="0 0 24 28" style={{ flex: 'none' }}>
          <circle cx="12" cy="6" r="5" fill="none" stroke={stroke} strokeWidth="1.8" />
          <path d="M2.5,27 C2.5,17 21.5,17 21.5,27" fill="none" stroke={stroke} strokeWidth="1.8" strokeLinejoin="round" />
        </svg>
        <div style={{ textAlign: 'center', fontSize: 13.5, fontWeight: 600, lineHeight: 1.2, color }}>{d.label}</div>
      </div>
    );
  }
  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      {!isText && <ShapeSVG shape={shape} fill={fill} stroke={stroke} />}
      <Handle type="target" position={Position.Top} style={hs} />
      <Handle type="source" position={Position.Bottom} style={hs} />
      <div style={{ ...center, position: 'absolute', inset: 0, boxSizing: 'border-box', ...padFor(shape), fontSize: 14, fontWeight: 600, fontStyle: isText ? 'italic' : 'normal', color }}>
        {d.label}
      </div>
    </div>
  );
}
function GroupNode({ data }: NodeProps) {
  const d = data as any;
  return (
    <div style={{ width: '100%', height: '100%', background: d.fill || 'rgba(31,111,208,0.05)', border: '1.5px solid #c7d6ef', borderRadius: 10 }}>
      <Handle type="target" position={Position.Top} style={hs} />
      <Handle type="source" position={Position.Bottom} style={hs} />
      <div style={{ position: 'absolute', top: 6, left: 0, right: 0, textAlign: 'center', fontSize: 13, fontWeight: 700, color: d.color || '#334155' }}>{d.label}</div>
    </div>
  );
}
const nodeTypes = { shape: ShapeNode, group: GroupNode };

// D2 shape (s.type) → khoá shape nội bộ. Mặc định rectangle.
function normalizeShape(t: any): string {
  const s = String(t || '').toLowerCase();
  if (/diamond/.test(s)) return 'diamond';
  if (/parallelogram/.test(s)) return 'parallelogram';
  if (/stored_data|stored data|storeddata/.test(s)) return 'stored_data';
  if (/document/.test(s)) return 'document';
  if (/cylinder/.test(s)) return 'cylinder';
  if (/queue/.test(s)) return 'queue';
  if (/hexagon/.test(s)) return 'hexagon';
  if (/package/.test(s)) return 'package';
  if (/person/.test(s)) return 'person';
  if (/callout/.test(s)) return 'callout';
  if (/cloud/.test(s)) return 'cloud';
  if (/circle/.test(s)) return 'circle';
  if (/oval/.test(s)) return 'oval';
  if (/step/.test(s)) return 'step';
  if (/page/.test(s)) return 'page';
  if (/square/.test(s)) return 'square';
  if (/text|code/.test(s)) return 'text';
  return 'rectangle';
}

// Chọn khoá shape: ưu tiên class custom (manual-input…), sau đó shape D2 (s.type).
function pickShape(type: any, classes: any): string {
  if (Array.isArray(classes)) { const c = classes.find((x) => CUSTOM_CLASSES.includes(String(x))); if (c) return String(c); }
  return normalizeShape(type);
}

// Các ký hiệu THỰC SỰ xuất hiện trong sơ đồ (luôn kèm 'rectangle' = bước xử lý cơ bản) → cho legend.
export function shapesUsed(code: string): { shape: string; label: string }[] {
  const used = new Set<string>(['rectangle']);
  for (const m of code.matchAll(/shape:\s*([a-z_]+)/gi)) used.add(normalizeShape(m[1]));
  for (const m of code.matchAll(/class:\s*([a-z-]+)/gi)) if (CUSTOM_CLASSES.includes(m[1])) used.add(m[1]);
  return SHAPE_MEANINGS.filter((s) => used.has(s.shape));
}

// ── Floating edge (kéo node → mũi tên bám cạnh node) ──
function rect(n: any) {
  const p = n.internals.positionAbsolute; const w = n.measured?.width ?? 140, h = n.measured?.height ?? 50;
  return { x: p.x, y: p.y, w, h, cx: p.x + w / 2, cy: p.y + h / 2 };
}
// Neo mũi tên vào GIỮA cạnh (top/bottom/left/right) hướng về node kia → ra/vào đều, trật tự như draw.io.
function anchor(a: any, b: any): { x: number; y: number; pos: Position } {
  const dx = b.cx - a.cx, dy = b.cy - a.cy;
  if (Math.abs(dy) / (a.h || 1) >= Math.abs(dx) / (a.w || 1)) {
    return dy >= 0 ? { x: a.cx, y: a.y + a.h, pos: Position.Bottom } : { x: a.cx, y: a.y, pos: Position.Top };
  }
  return dx >= 0 ? { x: a.x + a.w, y: a.cy, pos: Position.Right } : { x: a.x, y: a.cy, pos: Position.Left };
}
function FloatingEdge({ source, target, markerEnd, style, label }: EdgeProps) {
  const s = useInternalNode(source); const t = useInternalNode(target);
  if (!s || !t) return null;
  const A = rect(s), B = rect(t); const sp = anchor(A, B), tp = anchor(B, A);
  // Routing vuông góc (orthogonal) từ giữa cạnh → gọn gàng, đều đặn.
  const [path, lx, ly] = getSmoothStepPath({ sourceX: sp.x, sourceY: sp.y, sourcePosition: sp.pos, targetX: tp.x, targetY: tp.y, targetPosition: tp.pos, borderRadius: 10 });
  return (
    <>
      <BaseEdge path={path} markerEnd={markerEnd} style={style} />
      {label ? (
        <EdgeLabelRenderer>
          <div style={{ position: 'absolute', transform: `translate(-50%,-50%) translate(${lx}px,${ly}px)`, padding: '1px 6px', borderRadius: 6, fontSize: 11, color: '#475569', background: '#f4f7fc', pointerEvents: 'none' }}>{label as any}</div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
}
const edgeTypes = { floating: FloatingEdge };

const F = (s: any, ...keys: string[]) => { for (const k of keys) { if (s && s[k] != null && s[k] !== '') return s[k]; if (s?.style && s.style[k] != null && s.style[k] !== '') return s.style[k]; } return undefined; };

async function compileD2(code: string, withClasses = false) {
  const d2 = await getD2();
  // Chỉ chèn preamble KHI sơ đồ thực sự dùng class custom → flowchart thường giữ nguyên (0 rủi ro hồi quy).
  const needs = withClasses && new RegExp('class:\\s*(' + CUSTOM_CLASSES.join('|') + ')').test(code);
  const src = (needs ? CLASS_PREAMBLE + '\n' : '') + code.trim();
  // dagre = layout mặc định D2, tối ưu flowchart phân lớp (trục dọc thẳng, nhánh gọn hơn elk).
  return d2.compile(src, { layout: 'dagre' });
}

function buildGraph(diagram: any): { nodes: Node[]; edges: Edge[]; height: number } {
  const allShapes: any[] = diagram?.shapes || [];
  if (!allShapes.length) throw new Error('Sơ đồ không có node nào');
  const allIds = allShapes.map((s) => String(s.id));
  const isContainer = (id: string) => allIds.some((o) => o !== id && o.startsWith(id + '.'));
  const groups: Node[] = []; const leaves: Node[] = [];
  for (const s of allShapes) {
    const id = String(s.id);
    // Chỉ giữ màu agent CHỦ ĐỘNG set (hex hợp lệ); bỏ token resolve của D2 → để THEME lo màu mặc định.
    const data = { label: s.label || id, fill: validColor(F(s, 'fill')) };
    const pos = { x: s.pos?.x ?? 0, y: s.pos?.y ?? 0 };
    const style = { width: Math.max(60, s.width || 140), height: Math.max(30, s.height || 50) };
    if (isContainer(id)) {
      groups.push({ id, type: 'group', position: pos, data, draggable: false, selectable: false, zIndex: 0, style });
    } else {
      const shape = pickShape(s.type, s.classes);
      leaves.push({ id, type: 'shape', position: pos, data: { ...data, shape }, draggable: true, zIndex: 1, style });
    }
  }
  const nodes = [...groups, ...leaves]; // group trước → vẽ phía sau
  const ys = allShapes.map((s) => (s.pos?.y ?? 0) + (s.height || 50));
  const height = Math.max(60, Math.max(...ys) - Math.min(...allShapes.map((s) => s.pos?.y ?? 0)));
  const ids = new Set(nodes.map((n) => n.id));
  const edges: Edge[] = (diagram?.connections || [])
    .map((c: any, i: number): Edge => {
      const stroke = validColor(F(c, 'stroke')) || '#94a3b8';
      const dash = F(c, 'strokeDash');
      return {
        id: 'e' + i, source: String(c.src), target: String(c.dst), label: c.label || undefined, type: 'floating',
        markerEnd: { type: MarkerType.ArrowClosed, color: stroke, width: 16, height: 16 },
        style: { stroke, strokeWidth: 1.6, ...(dash ? { strokeDasharray: '5 4' } : {}) },
      };
    })
    .filter((e: Edge) => ids.has(e.source) && ids.has(e.target));
  return { nodes, edges, height };
}

// Chèn width/height vào <svg> ngoài cùng của D2 (chống SVG 0×0).
function sizeSvg(svg: string): string {
  return svg.replace(/<svg([^>]*?)>/, (m, attrs) => {
    if (/\swidth=/.test(attrs) && /\sheight=/.test(attrs)) return m;
    const vb = /viewBox="([\d.\- ]+)"/.exec(attrs);
    let w = '100%', h = '100%';
    if (vb) { const p = vb[1].trim().split(/\s+/); if (p.length === 4) { w = p[2]; h = p[3]; } }
    return `<svg${attrs} width="${w}" height="${h}" style="max-width:none">`;
  });
}

// Khung pan/zoom cho SVG tĩnh của D2 (cuộn=zoom quanh con trỏ, kéo nền=di chuyển).
function PanZoom({ html }: { html: string }) {
  const wrap = useRef<HTMLDivElement>(null);
  const [t, setT] = useState({ x: 16, y: 16, k: 1 });
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  // Tự canh vừa khung (responsive): đo SVG vs container → scale fit + căn giữa.
  useEffect(() => {
    const el = wrap.current; if (!el) return;
    const fit = () => {
      const svg = el.querySelector('svg'); if (!svg) return;
      const vb = (svg as any).viewBox?.baseVal;
      const sw = vb?.width || parseFloat(svg.getAttribute('width') || '0');
      const sh = vb?.height || parseFloat(svg.getAttribute('height') || '0');
      const cw = el.clientWidth, ch = el.clientHeight;
      if (!sw || !sh || !cw || !ch) return;
      const k = Math.min(cw / sw, ch / sh, 1.5) * 0.94;
      setT({ k, x: (cw - sw * k) / 2, y: (ch - sh * k) / 2 });
    };
    const id = requestAnimationFrame(fit);
    const ro = new ResizeObserver(fit); ro.observe(el);
    return () => { cancelAnimationFrame(id); ro.disconnect(); };
  }, [html]);
  useEffect(() => {
    const el = wrap.current; if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect(); const mx = e.clientX - r.left, my = e.clientY - r.top;
      setT((s) => { const k = Math.min(5, Math.max(0.2, s.k * (e.deltaY < 0 ? 1.12 : 0.89))); return { k, x: mx - (mx - s.x) * (k / s.k), y: my - (my - s.y) * (k / s.k) }; });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);
  return (
    <div ref={wrap} className="relative h-full w-full overflow-hidden bg-white" style={{ cursor: drag.current ? 'grabbing' : 'grab' }}
      onPointerDown={(e) => { drag.current = { x: e.clientX, y: e.clientY, ox: t.x, oy: t.y }; (e.target as HTMLElement).setPointerCapture?.(e.pointerId); }}
      onPointerMove={(e) => { const dr = drag.current; if (!dr) return; const nx = dr.ox + (e.clientX - dr.x), ny = dr.oy + (e.clientY - dr.y); setT((s) => ({ ...s, x: nx, y: ny })); }}
      onPointerUp={() => { drag.current = null; }}>
      <div style={{ transform: `translate(${t.x}px,${t.y}px) scale(${t.k})`, transformOrigin: '0 0' }} dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}

// SVG D2 native → PNG blob ở kích thước tự nhiên ×2 (crisp, crop sát).
async function svgToBlob(svg: string): Promise<Blob> {
  let w = 0, h = 0;
  const wm = /\bwidth="([\d.]+)"/.exec(svg), hm = /\bheight="([\d.]+)"/.exec(svg);
  if (wm) w = parseFloat(wm[1]); if (hm) h = parseFloat(hm[1]);
  if (!w || !h) { const vb = /viewBox="([\d.\- ]+)"/.exec(svg); if (vb) { const p = vb[1].trim().split(/\s+/); if (p.length === 4) { w = +p[2]; h = +p[3]; } } }
  if (!w || !h) { w = 1200; h = 800; }
  const img = new Image();
  await new Promise<void>((res, rej) => { img.onload = () => res(); img.onerror = () => rej(new Error('SVG load fail')); img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg); });
  const scale = 2;
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(w * scale); canvas.height = Math.ceil(h * scale);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return await new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('toBlob fail'))), 'image/png'));
}

export const FlowDiagram = forwardRef<FlowHandle, { code: string; full?: boolean }>(function FlowDiagram({ code, full }, ref) {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [svg, setSvg] = useState<string>('');
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(true);
  const [natH, setNatH] = useState(300);
  const reqRef = useRef(0);
  const wrapRef = useRef<HTMLDivElement>(null);
  const structured = STRUCTURED.test(code);

  // Xuất ảnh PNG crop SÁT vùng sơ đồ, độ phân giải ×2 (gửi khách rõ nét).
  async function exportBlob(): Promise<Blob> {
    try { await (document as any).fonts?.ready; } catch { /* bỏ qua */ }
    if (structured) {
      if (!svg) throw new Error('Sơ đồ chưa vẽ xong, đợi chút');
      return svgToBlob(svg);
    }
    if (!nodes.length) throw new Error('Sơ đồ chưa vẽ xong, đợi chút');
    const vp = wrapRef.current?.querySelector('.react-flow__viewport') as HTMLElement | null;
    if (!vp) throw new Error('Sơ đồ chưa sẵn sàng');
    const b = getNodesBounds(nodes);
    const PAD = 24;
    const w = Math.ceil(b.width + PAD * 2), h = Math.ceil(b.height + PAD * 2);
    const blob = await htmlToImage.toBlob(vp, {
      backgroundColor: '#ffffff', pixelRatio: 2, width: w, height: h, cacheBust: true,
      style: { width: w + 'px', height: h + 'px', transform: `translate(${-b.x + PAD}px,${-b.y + PAD}px) scale(1)`, transformOrigin: '0 0' },
    });
    if (!blob || !blob.size) throw new Error('Không tạo được ảnh');
    return blob;
  }
  useImperativeHandle(ref, () => ({ exportBlob }), [structured, svg, nodes]);

  useEffect(() => {
    const my = ++reqRef.current;
    setLoading(true); setErr('');
    const tm = setTimeout(() => {
      runD2(async () => {
        if (structured) {
          if (code.length > 6000) throw new Error('Sơ đồ quá lớn — hãy tách nhỏ.');
          const d2 = await getD2();
          const res = await compileD2(code);            // sequence/ER/swimlane: D2 native render
          const s = await d2.render(res.diagram, { ...res.renderOptions, sketch: false, pad: 16, noXMLTag: true });
          return { svg: sizeSvg(String(s)) };
        }
        const res = await compileD2(code, true);        // flowchart: React Flow (kéo-thả) + class custom
        return buildGraph(res.diagram);
      })
        .then((g: any) => {
          if (my !== reqRef.current) return;
          if (g.svg) setSvg(g.svg);
          else { setNodes(g.nodes); setEdges(g.edges); setNatH(g.height); }
          setLoading(false);
        })
        .catch((e) => { if (my === reqRef.current) { setErr(String(e?.message || e).slice(0, 200)); setLoading(false); } });
    }, 350);
    return () => clearTimeout(tm);
  }, [code, structured, setNodes, setEdges]);

  if (err) {
    return (
      <div className="rounded-b-lg border-amber-300 bg-amber-50 p-3 text-[12px] text-amber-800">
        ⚠️ Không vẽ được sơ đồ: <span className="font-mono text-[11px]">{err}</span>
        <pre className="mt-1.5 overflow-auto whitespace-pre-wrap font-mono text-[11px] text-amber-700">{code.trim()}</pre>
      </div>
    );
  }

  const inlineH = Math.min(typeof window !== 'undefined' ? window.innerHeight * 0.6 : 520, Math.max(240, natH + 80));
  return (
    <div ref={wrapRef} className="bg-white" style={{ height: full ? '100%' : inlineH }}>
      {loading ? (
        <div className="p-4 text-xs text-muted">Đang vẽ sơ đồ…</div>
      ) : structured ? (
        <PanZoom html={svg} />
      ) : (
        <ReactFlow
          key={`${code.length}-${nodes.length}`}
          nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes}
          onNodesChange={onNodesChange} onEdgesChange={onEdgesChange}
          nodesConnectable={false} nodesDraggable elementsSelectable
          fitView fitViewOptions={{ padding: 0.08 }} minZoom={0.1} maxZoom={3}
          proOptions={{ hideAttribution: true }}
        >
          <Background color="#e3e8f1" gap={18} />
          <Controls showInteractive={false} />
        </ReactFlow>
      )}
    </div>
  );
});
