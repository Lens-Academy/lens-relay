import ReactMarkdown from 'react-markdown';

interface TextRendererProps {
  content: string;
  onStartEdit: () => void;
}

export function TextRenderer({ content, onStartEdit }: TextRendererProps) {
  return (
    <div
      className="mb-7 relative group cursor-pointer hover:outline hover:outline-2 hover:outline-blue-300/30 hover:outline-offset-1 rounded-md"
      onClick={onStartEdit}
    >
      <div className="absolute -top-2 -right-2 bg-blue-500 text-white text-[10px] px-2 py-0.5 rounded font-medium opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
        click to edit
      </div>
      <div
        className="text-[15px] leading-[1.75] text-gray-900 prose prose-sm max-w-none"
        style={{ fontFamily: "'DM Sans', sans-serif" }}
      >
        <ReactMarkdown>{content}</ReactMarkdown>
      </div>
    </div>
  );
}
