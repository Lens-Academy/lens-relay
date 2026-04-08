import type { Section } from './parseSections';

const DOC_COLORS = [
  { bg: 'bg-blue-50', border: 'border-blue-300', text: 'text-blue-600' },
  { bg: 'bg-green-50', border: 'border-green-300', text: 'text-green-600' },
  { bg: 'bg-amber-50', border: 'border-amber-300', text: 'text-amber-600' },
  { bg: 'bg-rose-50', border: 'border-rose-300', text: 'text-rose-600' },
  { bg: 'bg-purple-50', border: 'border-purple-300', text: 'text-purple-600' },
  { bg: 'bg-cyan-50', border: 'border-cyan-300', text: 'text-cyan-600' },
];

export function getDocColor(docIndex: number) {
  return DOC_COLORS[docIndex % DOC_COLORS.length];
}

const SECTION_COLORS: Record<string, string> = {
  frontmatter: 'bg-gray-50 border-gray-200',
  video: 'bg-purple-50 border-purple-200',
  text: 'bg-blue-50 border-blue-200',
  chat: 'bg-green-50 border-green-200',
  'lens-ref': 'bg-indigo-50 border-indigo-200',
  'test-ref': 'bg-amber-50 border-amber-200',
  'lo-ref': 'bg-rose-50 border-rose-200',
};

interface SectionCardProps {
  section: Section;
  onClick: () => void;
  docLabel?: string;
  docIndex?: number;
}

export function SectionCard({ section, onClick, docLabel, docIndex }: SectionCardProps) {
  const lines = section.content.split('\n');
  const body = (section.type === 'frontmatter' ? lines.slice(1, -2) : lines.slice(1))
    .join('\n').trim();

  const docColor = docIndex != null ? getDocColor(docIndex) : null;

  return (
    <div
      className={`rounded-lg border ${SECTION_COLORS[section.type] || 'bg-white border-gray-200'} cursor-pointer hover:ring-1 hover:ring-blue-300 transition-all`}
      onClick={onClick}
    >
      <div className="flex items-center gap-2 px-4 py-2 border-b border-inherit">
        <span className="font-medium text-sm text-gray-700">{section.label}</span>
        {docLabel && docColor && (
          <span className={`text-xs px-1.5 py-0.5 rounded ${docColor.bg} ${docColor.text}`}>
            {docLabel}
          </span>
        )}
        <span className="text-xs text-gray-400 ml-auto">click to edit</span>
      </div>
      <div className="px-4 py-3 text-xs text-gray-500 whitespace-pre-wrap max-h-40 overflow-hidden">
        {body ? (body.length > 300 ? body.slice(0, 300) + '...' : body) : <em className="text-gray-400">Empty</em>}
      </div>
    </div>
  );
}
