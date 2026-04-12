interface TreeEntryProps {
  badgeText: string;
  badgeClass: string;
  label: string;
  inlineTag?: string;
  active: boolean;
  onClick: () => void;
}

export function TreeEntry({ badgeText, badgeClass, label, inlineTag, active, onClick }: TreeEntryProps) {
  return (
    <div
      onClick={onClick}
      className={`px-2.5 py-1.5 mb-1 rounded border cursor-pointer transition-all flex items-center gap-2 ${
        active
          ? 'border-2 border-blue-500 bg-blue-100'
          : 'border-[#e8e5df] bg-white hover:border-blue-300 hover:bg-blue-50'
      }`}
    >
      <span className={`text-[9px] px-1.5 py-0.5 rounded font-semibold uppercase tracking-wider ${badgeClass}`}>
        {badgeText}
      </span>
      <span className="text-[12px] font-medium text-gray-800 flex-1">{label}</span>
      {inlineTag && <span className="text-[9px] text-gray-400 italic">{inlineTag}</span>}
      <span className="text-blue-300 text-sm">&rarr;</span>
    </div>
  );
}
