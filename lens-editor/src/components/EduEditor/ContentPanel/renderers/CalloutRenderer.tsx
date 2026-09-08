/**
 * The header of a callout box (`#### Callout: Title` with tone::/collapse::)
 * and the closing marker (`#### End Callout`). The sections between them are
 * the box's contents; ContentPanel indents them under this header.
 */

const TONE_CLASSES: Record<string, string> = {
  neutral: "bg-[#faf8f3] border-[#e8e5df]",
  blue: "bg-[#f6f8f9] border-[#b9c7d6]",
  green: "bg-[#f6f8f5] border-[#b9cbbd]",
  amber: "bg-orange-50 border-orange-200",
  red: "bg-[#fbf6f3] border-[#d8b6ad]",
  purple: "bg-[#f8f6f9] border-[#c9bfd2]",
};

interface CalloutRendererProps {
  /** The title after `Callout:`, if any. */
  title?: string;
  tone?: string;
  collapse?: string;
  onStartEdit: () => void;
}

export function CalloutRenderer({
  title,
  tone,
  collapse,
  onStartEdit,
}: CalloutRendererProps) {
  const toneClass = TONE_CLASSES[tone ?? ""] ?? TONE_CLASSES.neutral;
  return (
    <div
      className={`mb-3 px-4 py-2 rounded-lg border ${toneClass} relative group cursor-pointer hover:outline hover:outline-2 hover:outline-blue-300/30 hover:outline-offset-1`}
      onClick={onStartEdit}
    >
      <div className="absolute -top-2 -right-2 bg-blue-500 text-white text-[10px] px-2 py-0.5 rounded font-medium opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
        click to edit
      </div>
      <div className="flex items-center gap-2">
        <span className="text-[11px] font-medium uppercase tracking-[0.16em] text-gray-500">
          Callout
        </span>
        {title && (
          <span className="text-sm font-medium text-gray-800">{title}</span>
        )}
        {collapse && (
          <span className="ml-auto text-[11px] text-gray-500">
            starts {collapse}
          </span>
        )}
      </div>
    </div>
  );
}

export function EndCalloutRenderer({
  onStartEdit,
}: {
  onStartEdit: () => void;
}) {
  return (
    <div
      className="mb-7 -mt-3 text-[11px] uppercase tracking-[0.16em] text-gray-400 cursor-pointer hover:text-gray-600"
      onClick={onStartEdit}
    >
      End callout
    </div>
  );
}
