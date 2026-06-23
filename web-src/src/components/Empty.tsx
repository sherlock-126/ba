import type { Project } from '../api';

const SAMPLES: Record<string, string[]> = {
  kientre: [
    'Flow điểm danh buổi học trong ERP hoạt động thế nào?',
    'Marketing đẩy học sinh sang ERP (Click) như thế nào?',
    'zalo-bridge dùng thư viện gì để kết nối Zalo?',
    'Logic tính sĩ số lớp trong ERP nằm ở đâu?',
  ],
  dhco: [
    'Tổng quan các module chính của DHP?',
    'Luồng nghiệp vụ chính trong dhco hoạt động thế nào?',
    'DHP quản lý những loại dữ liệu gì?',
    'Phân quyền người dùng trong DHP ra sao?',
  ],
  thghub: [
    'Tổng quan các chức năng chính của THG?',
    'Luồng nghiệp vụ chính trong thghub hoạt động thế nào?',
    'THG quản lý đơn hàng / dữ liệu gì?',
    'Phân quyền trong THG ra sao?',
  ],
};
const GENERIC = ['Tổng quan hệ thống này làm gì?', 'Các module chính gồm những gì?', 'Luồng nghiệp vụ chính hoạt động thế nào?', 'Phân quyền người dùng ra sao?'];

export function Empty({ onPick, project }: { onPick: (q: string) => void; project?: Project }) {
  const samples = project ? (SAMPLES[project.key] || GENERIC) : SAMPLES.kientre;
  return (
    <div className="mx-auto flex max-w-2xl flex-col items-center px-4 py-10 text-center sm:py-16">
      <div className="inline-flex h-14 w-14 items-center justify-center rounded-2xl bg-brand text-2xl font-extrabold text-white shadow-cardhover">BA</div>
      <h2 className="mt-4 text-xl font-extrabold text-navy">Hỏi về {project?.label || 'logic source code'}</h2>
      <p className="mt-1.5 max-w-md text-sm text-muted">
        {project?.blurb || 'Trợ lý đọc trực tiếp code, trả lời theo ngôn ngữ nghiệp vụ kèm trích dẫn kỹ thuật.'}
      </p>
      <div className="mt-6 grid w-full gap-2 sm:grid-cols-2">
        {samples.map((q) => (
          <button key={q} onClick={() => onPick(q)}
            className="rounded-xl border border-line bg-surface px-4 py-3 text-left text-sm text-ink shadow-card transition hover:border-brand/50 hover:shadow-cardhover">
            {q}
          </button>
        ))}
      </div>
    </div>
  );
}
