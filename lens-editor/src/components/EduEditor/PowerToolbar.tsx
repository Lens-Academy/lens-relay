interface PowerToolbarProps {
  lensFileName: string;
}

export function PowerToolbar({ lensFileName }: PowerToolbarProps) {
  return (
    <div className="flex items-center gap-2 mb-6 px-3 py-2 bg-white rounded-lg border border-[#e8e5df] text-xs text-gray-500">
      <span className="px-2.5 py-0.5 rounded-xl bg-gray-900 text-white font-medium">Edit</span>
      <span className="px-2.5 py-0.5 rounded-xl bg-gray-100 font-medium cursor-pointer hover:bg-gray-200">Preview</span>
      <div className="w-px h-4 bg-gray-200" />
      <span className="px-2.5 py-0.5 rounded-xl bg-gray-100 font-medium cursor-pointer hover:bg-gray-200">Feedback</span>
      <span className="px-2.5 py-0.5 rounded-xl bg-gray-100 font-medium cursor-pointer hover:bg-gray-200">Raw</span>
      <span className="ml-auto text-[11px] text-gray-400">{lensFileName}</span>
    </div>
  );
}
