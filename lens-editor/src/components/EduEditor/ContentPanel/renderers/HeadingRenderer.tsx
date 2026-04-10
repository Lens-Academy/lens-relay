interface HeadingRendererProps {
  label: string;
  /** Font size in px. Defaults to 18. Use 22 for page-level headings. */
  fontSize?: number;
  onStartEdit: () => void;
}

export function HeadingRenderer({ label, fontSize = 18, onStartEdit }: HeadingRendererProps) {
  return (
    <div
      className="mb-4 relative group cursor-pointer hover:outline hover:outline-2 hover:outline-blue-300/30 hover:outline-offset-1 rounded"
      onClick={onStartEdit}
    >
      <div className="absolute -top-2 -right-2 bg-blue-500 text-white text-[10px] px-2 py-0.5 rounded font-medium opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
        click to edit
      </div>
      <div style={{ fontFamily: "'Newsreader', serif", fontSize: `${fontSize}px`, fontWeight: 600, color: '#1a1a1a' }}>
        {label}
      </div>
    </div>
  );
}
