import ReactMarkdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';

function preserveBlankLines(text: string): string {
  return text.replace(/\n{2,}/g, (match) => {
    const extras = match.length - 1;
    return '\n\n' + '\u00A0\n\n'.repeat(extras);
  });
}

interface TutorInstructionsProps {
  title: string;
  instructions: string;
  onEdit?: () => void;
}

export function TutorInstructions({ title, instructions, onEdit }: TutorInstructionsProps) {
  return (
    <div
      className="mb-7 p-4 bg-green-50 border border-green-200 rounded-lg relative group cursor-pointer hover:outline hover:outline-2 hover:outline-blue-300/30 hover:outline-offset-1"
      onClick={onEdit}
    >
      <div className="absolute -top-2 -right-2 bg-blue-500 text-white text-[10px] px-2 py-0.5 rounded font-medium opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
        click to edit
      </div>
      <div className="mb-2.5">
        <div className="flex items-center gap-1.5 text-xs font-semibold text-green-800 uppercase tracking-wider">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          </svg>
          Chat Segment
        </div>
        <div className="text-[10px] text-green-600 mt-0.5 ml-[22px]">AI Tutor Instructions:</div>
      </div>
      <div className="text-[13px] text-gray-700 leading-relaxed prose prose-sm prose-green max-w-none">
        <ReactMarkdown remarkPlugins={[remarkBreaks]}>{preserveBlankLines(instructions)}</ReactMarkdown>
      </div>
    </div>
  );
}
