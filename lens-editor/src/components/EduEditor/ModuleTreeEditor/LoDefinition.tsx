import React from 'react';

interface LoDefinitionProps {
  definition: string;
  editing: boolean;
  mountRef: React.RefObject<HTMLDivElement | null>;
  onStartEdit: () => void;
  onDone: () => void;
}

export function LoDefinition({ definition, editing, mountRef, onStartEdit, onDone }: LoDefinitionProps) {
  if (editing) {
    return (
      <div className="px-3 py-2 bg-[#fffdf5] border-b border-dashed border-[#f0e0b0]">
        <div className="flex items-center justify-between mb-1">
          <div className="text-[9px] uppercase tracking-wider text-amber-700 font-semibold">
            Editing definition
          </div>
          <button
            onClick={onDone}
            className="text-[9px] text-gray-500 hover:text-gray-700 px-1.5 py-0.5 rounded border border-gray-200 hover:border-gray-400"
          >
            Done
          </button>
        </div>
        <div ref={mountRef} />
      </div>
    );
  }

  return (
    <div className="px-3 py-2 bg-[#fffdf5] border-b border-dashed border-[#f0e0b0]">
      <div className="text-[9px] uppercase tracking-wider text-amber-700 font-semibold mb-1">
        Definition
      </div>
      <div
        className="text-[11px] text-gray-700 leading-relaxed px-1 py-0.5 cursor-pointer hover:bg-amber-50 rounded"
        onClick={onStartEdit}
      >
        {definition || <em className="text-gray-400">(no definition)</em>}
      </div>
    </div>
  );
}
