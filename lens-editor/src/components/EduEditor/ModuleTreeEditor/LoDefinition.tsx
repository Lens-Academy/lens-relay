interface LoDefinitionProps {
  definition: string;
}

export function LoDefinition({ definition }: LoDefinitionProps) {
  return (
    <div className="px-3 py-2 bg-[#fffdf5] border-b border-dashed border-[#f0e0b0]">
      <div className="text-[9px] uppercase tracking-wider text-amber-700 font-semibold mb-1">
        Definition
      </div>
      <div className="text-[11px] text-gray-700 leading-relaxed px-1 py-0.5">
        {definition || <em className="text-gray-400">(no definition)</em>}
      </div>
    </div>
  );
}
