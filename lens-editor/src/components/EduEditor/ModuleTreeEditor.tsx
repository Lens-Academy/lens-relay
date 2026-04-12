import { useState } from 'react';
import * as Y from 'yjs';
import type { Section } from '../SectionEditor/parseSections';
import { parseSections } from '../SectionEditor/parseSections';
import { parseFields, parseFrontmatterFields } from '../../lib/parseFields';
import { resolveWikilinkToUuid } from '../../lib/resolveDocPath';
import { useNavigation } from '../../contexts/NavigationContext';
import { ModuleHeader } from './ModuleTreeEditor/ModuleHeader';
import { TreeEntry } from './ModuleTreeEditor/TreeEntry';
import { LoCard } from './ModuleTreeEditor/LoCard';
import { useLODocs } from './useLODocs';
import { useSectionEditor } from '../../hooks/useSectionEditor';
import { useDocConnection } from '../../hooks/useDocConnection';
import { RELAY_ID } from '../../lib/constants';
import { openDocInNewTab, docUuidFromCompoundId } from '../../lib/url-utils';
import type { ContentScope } from './ContentPanel';

/** Find the Y.Text range of a YAML frontmatter field's value. */
function getFmFieldRange(
  sectionContent: string,
  sectionFrom: number,
  fieldName: string,
): [number, number] | null {
  const pattern = new RegExp(`^${fieldName}:\\s*(.*)$`, 'm');
  const match = pattern.exec(sectionContent);
  if (!match) return null;
  let valueStr = match[1];
  let valueStart = match.index + match[0].length - valueStr.length;
  if (valueStr.startsWith('"') && valueStr.endsWith('"')) {
    valueStart += 1;
    valueStr = valueStr.slice(1, -1);
  }
  return [sectionFrom + valueStart, sectionFrom + valueStart + valueStr.length];
}

interface ModuleTreeEditorProps {
  moduleSections: Section[];
  modulePath: string;
  moduleDocId?: string;
  activeSelection: { docId: string; rootIndex?: number } | null;
  onSelect: (scope: ContentScope) => void;
}

export function ModuleTreeEditor({
  moduleSections,
  modulePath,
  moduleDocId,
  activeSelection,
  onSelect,
}: ModuleTreeEditorProps) {
  const { metadata } = useNavigation();
  const loDocs = useLODocs(moduleSections, modulePath);
  const { getOrConnect } = useDocConnection();

  const [editingDefUuid, setEditingDefUuid] = useState<string | null>(null);
  const [editingYtext, setEditingYtext] = useState<Y.Text | null>(null);
  const [editingRange, setEditingRange] = useState<[number, number]>([0, 0]);

  const { mountRef: definitionMountRef } = useSectionEditor({
    ytext: editingYtext,
    sectionFrom: editingRange[0],
    sectionTo: editingRange[1],
    active: editingDefUuid !== null,
  });

  async function startEditingDefinition(uuid: string) {
    const loEntry = loDocs[uuid];
    if (!loEntry) return;
    const docId = `${RELAY_ID}-${uuid}`;
    const { doc } = await getOrConnect(docId);
    const ytext = doc.getText('contents');
    const text = ytext.toString();
    const sections = parseSections(text);
    const fm = sections.find(s => s.type === 'frontmatter');
    if (!fm) return;

    // Narrow to just the learning-outcome field value
    const fieldRange = getFmFieldRange(fm.content, fm.from, 'learning-outcome');
    setEditingYtext(ytext);
    setEditingRange(fieldRange ?? [fm.from, fm.to]);
    setEditingDefUuid(uuid);
  }

  function stopEditingDefinition() {
    setEditingDefUuid(null);
    setEditingYtext(null);
    setEditingRange([0, 0]);
  }

  const frontmatter = (() => {
    const fm = moduleSections.find(s => s.type === 'frontmatter');
    return fm ? parseFrontmatterFields(fm.content) : new Map<string, string>();
  })();

  const moduleTitle = frontmatter.get('title') ?? modulePath.split('/').pop()?.replace(/\.md$/, '') ?? 'Module';
  const slug = frontmatter.get('slug');
  const tags = frontmatter.get('tags');

  return (
    <div>
      <ModuleHeader
        title={moduleTitle}
        slug={slug}
        tags={tags}
        onOpenInEditor={moduleDocId ? () => openDocInNewTab(RELAY_ID, docUuidFromCompoundId(moduleDocId), metadata) : undefined}
      />

      {moduleSections.map((section, i) => {
        if (section.type === 'frontmatter') return null;

        // Top-level # Lens: entries
        if (section.type === 'lens-ref' && section.level === 1) {
          const fields = parseFields(section.content);
          const sourceField = fields.get('source');
          // section.label is e.g. "Lens: Welcome" — extract the part after "Lens:"
          const rawLabel = section.label || '';
          const colonIdx = rawLabel.indexOf(':');
          const label = colonIdx !== -1 ? rawLabel.slice(colonIdx + 1).trim() || 'Lens' : rawLabel || 'Lens';

          if (sourceField) {
            // Referenced lens — open the external lens doc
            const uuid = resolveWikilinkToUuid(sourceField.trim(), modulePath, metadata);
            const lensDocId = uuid ? `${RELAY_ID}-${uuid}` : null;
            const isActive = lensDocId !== null && activeSelection?.docId === lensDocId;
            return (
              <TreeEntry
                key={i}
                badgeText="Lens"
                badgeClass="bg-blue-100 text-blue-700"
                label={label}
                active={isActive}
                onClick={() => {
                  if (!lensDocId) return;
                  onSelect({
                    kind: 'full-doc',
                    docId: lensDocId,
                    docName: label,
                    docPath: modulePath,
                  });
                }}
              />
            );
          }

          // Inline lens — subtree of the module doc
          const isActive =
            moduleDocId !== undefined &&
            activeSelection?.docId === moduleDocId &&
            activeSelection?.rootIndex === i;
          return (
            <TreeEntry
              key={i}
              badgeText="Lens"
              badgeClass="bg-blue-100 text-blue-700"
              label={label}
              inlineTag="inline"
              active={isActive}
              onClick={() => {
                if (!moduleDocId) return;
                onSelect({
                  kind: 'subtree',
                  docId: moduleDocId,
                  docName: label,
                  docPath: modulePath,
                  rootSectionIndex: i,
                  breadcrumb: `inside ${modulePath}`,
                });
              }}
            />
          );
        }

        // Generic heading or submodule at module level
        if (section.type === 'heading' || section.type === 'submodule') {
          return (
            <TreeEntry
              key={i}
              badgeText={section.type}
              badgeClass="bg-gray-100 text-gray-600"
              label={section.label}
              active={false}
              onClick={() => {
                if (!moduleDocId) return;
                onSelect({
                  kind: 'subtree',
                  docId: moduleDocId,
                  docName: section.label,
                  docPath: modulePath,
                  rootSectionIndex: i,
                  breadcrumb: `inside ${modulePath}`,
                });
              }}
            />
          );
        }

        // LO ref — render an LoCard using fetched LO data
        if (section.type === 'lo-ref' && section.level === 1) {
          const fields = parseFields(section.content);
          const sourceField = fields.get('source');
          if (!sourceField) return null;
          const uuid = resolveWikilinkToUuid(sourceField.trim(), modulePath, metadata);
          if (!uuid) return null;
          const loEntry = loDocs[uuid];
          if (!loEntry) {
            return (
              <div key={i} className="px-3 py-2 mb-2 text-[11px] text-gray-400 italic border border-dashed border-gray-200 rounded">
                Loading LO...
              </div>
            );
          }

          return (
            <LoCard
              key={i}
              loDocId={`${RELAY_ID}-${uuid}`}
              title={loEntry.title}
              definition={loEntry.frontmatter.get('learning-outcome') ?? ''}
              sections={loEntry.sections}
              loPath={loEntry.loPath}
              activeSelection={activeSelection}
              onSelect={onSelect}
              editingDefinition={editingDefUuid === uuid}
              definitionMountRef={definitionMountRef}
              onEditDefinition={() => startEditingDefinition(uuid)}
              onDoneEditingDefinition={stopEditingDefinition}
            />
          );
        }

        // Skip child sections (level > 1 that belong to other parent sections)
        return null;
      })}
    </div>
  );
}
