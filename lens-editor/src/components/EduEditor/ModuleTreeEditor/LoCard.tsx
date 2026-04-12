import React from 'react';
import type { Section } from '../../SectionEditor/parseSections';
import { parseFields } from '../../../lib/parseFields';
import { resolveWikilinkToUuid } from '../../../lib/resolveDocPath';
import { useNavigation } from '../../../contexts/NavigationContext';
import { RELAY_ID } from '../../../lib/constants';
import type { ContentScope } from '../ContentPanel';
import { LoDefinition } from './LoDefinition';

interface LoCardProps {
  loDocId: string;
  title: string;
  definition: string;
  sections: Section[];
  loPath: string;
  activeSelection: { docId: string; rootIndex?: number } | null;
  onSelect: (scope: ContentScope) => void;
  editingDefinition: boolean;
  definitionMountRef: React.RefObject<HTMLDivElement | null>;
  onEditDefinition: () => void;
  onDoneEditingDefinition: () => void;
}

export function LoCard({
  loDocId,
  title,
  definition,
  sections,
  loPath,
  activeSelection,
  onSelect,
  editingDefinition,
  definitionMountRef,
  onEditDefinition,
  onDoneEditingDefinition,
}: LoCardProps) {
  const { metadata } = useNavigation();

  return (
    <div className="mb-2 bg-white border-[1.5px] border-[#f0c96a] rounded-md overflow-hidden">
      {/* Header */}
      <div className="px-3 py-2 border-b border-dashed border-[#f0e0b0]">
        <span className="text-[9px] bg-[#fff0cc] text-[#7a5a15] px-1.5 py-0.5 rounded font-bold uppercase tracking-wider">
          Learning Outcome
        </span>
        <div className="font-semibold text-[12px] text-gray-800 mt-1">{title}</div>
      </div>

      {/* Definition */}
      <LoDefinition
        definition={definition}
        editing={editingDefinition}
        mountRef={definitionMountRef}
        onStartEdit={onEditDefinition}
        onDone={onDoneEditingDefinition}
      />

      {/* Children */}
      <div className="px-3 py-2">
        {sections.map((s, i) => {
          // Skip frontmatter
          if (s.type === 'frontmatter') return null;

          // Submodule headers
          if (s.type === 'submodule') {
            return (
              <div
                key={i}
                className="text-[9px] font-bold text-purple-700 uppercase tracking-wider px-1 pt-2 pb-0.5"
              >
                {s.label}
              </div>
            );
          }

          // Lens refs (## Lens:)
          if (s.type === 'lens-ref' && s.level === 2) {
            const fields = parseFields(s.content);
            const sourceField = fields.get('source');
            const optional = fields.get('optional') === 'true';
            const lensLabel = sourceField
              ? sourceField.replace(/^!?\[\[/, '').replace(/\]\]$/, '').split('/').pop()?.split('|')[0] ?? 'Lens'
              : s.label || 'Lens';
            const lensUuid = sourceField
              ? resolveWikilinkToUuid(sourceField.trim(), loPath, metadata)
              : null;
            const lensDocId = lensUuid ? `${RELAY_ID}-${lensUuid}` : null;
            const isActive = lensDocId !== null && activeSelection?.docId === lensDocId;

            return (
              <div
                key={i}
                onClick={() => {
                  if (!lensDocId) return;
                  onSelect({
                    kind: 'full-doc',
                    docId: lensDocId,
                    docName: lensLabel,
                    docPath: loPath,
                  });
                }}
                className={`px-2 py-1 my-0.5 rounded border flex items-center gap-1.5 cursor-pointer ${
                  isActive
                    ? 'border-2 border-blue-500 bg-blue-100 font-bold'
                    : 'border-transparent hover:bg-blue-50'
                }`}
              >
                <span className="text-[8px] bg-blue-100 text-blue-700 px-1 py-0.5 rounded font-bold uppercase">
                  Lens
                </span>
                <span className="text-[11px] text-blue-700 flex-1">{lensLabel}</span>
                {optional && <span className="text-[9px] text-gray-400 italic">optional</span>}
              </div>
            );
          }

          // Test refs (## Test:)
          if (s.type === 'test-ref' && s.level === 2) {
            let questionCount = 0;
            for (let j = i + 1; j < sections.length; j++) {
              if (sections[j].level <= 2) break;
              if (sections[j].type === 'question') questionCount++;
            }
            const label = questionCount > 0 ? `Test (${questionCount} questions)` : 'Test (empty)';
            const isActive =
              activeSelection?.docId === loDocId && activeSelection?.rootIndex === i;
            return (
              <div
                key={i}
                onClick={() =>
                  onSelect({
                    kind: 'subtree',
                    docId: loDocId,
                    docName: 'Test',
                    docPath: loPath,
                    rootSectionIndex: i,
                    breadcrumb: `inside ${title}.md`,
                  })
                }
                className={`px-2 py-1 my-0.5 rounded border flex items-center gap-1.5 cursor-pointer ${
                  isActive
                    ? 'border-2 border-blue-500 bg-blue-100 font-bold'
                    : 'border-transparent hover:bg-red-50'
                }`}
              >
                <span className="text-[8px] bg-red-100 text-red-700 px-1 py-0.5 rounded font-bold uppercase">
                  Test
                </span>
                <span className="text-[11px] text-red-700 italic flex-1">{label}</span>
              </div>
            );
          }

          return null;
        })}
      </div>
    </div>
  );
}
