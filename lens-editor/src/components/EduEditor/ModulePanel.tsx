import { useState, useCallback } from 'react';
import type { Section } from '../SectionEditor/parseSections';
import { parseSections } from '../SectionEditor/parseSections';
import { parseFields } from '../../lib/parseFields';
import { resolveWikilinkToUuid } from '../../lib/resolveDocPath';
import { useDocConnection } from '../../hooks/useDocConnection';
import { useNavigation } from '../../contexts/NavigationContext';
import { RELAY_ID } from '../../lib/constants';

interface ModulePanelProps {
  sections: Section[];
  sourcePath: string;
  onSelectLens: (compoundDocId: string, lensName: string) => void;
  activeLensDocId: string | null;
}

const BADGE_STYLES: Record<string, string> = {
  frontmatter: 'bg-gray-100 text-gray-500',
  submodule: 'bg-purple-100 text-purple-700',
  page: 'bg-purple-100 text-purple-700',
  text: 'bg-indigo-100 text-indigo-700',
  chat: 'bg-green-100 text-green-700',
  video: 'bg-teal-100 text-teal-700',
  article: 'bg-orange-100 text-orange-700',
  'lo-ref': 'bg-amber-100 text-amber-700',
  'lens-ref': 'bg-blue-100 text-blue-700',
  'test-ref': 'bg-red-100 text-red-700',
  'meeting-ref': 'bg-gray-100 text-gray-600',
  question: 'bg-orange-100 text-orange-700',
  heading: 'bg-gray-100 text-gray-600',
};

function Badge({ type }: { type: string }) {
  const style = BADGE_STYLES[type] ?? 'bg-gray-100 text-gray-600';
  const label = type.replace(/-ref$/, '').replace(/-/g, ' ');
  return (
    <span className={`text-[10px] px-[7px] py-[2px] rounded font-semibold ${style}`}>
      {label}
    </span>
  );
}

function SectionItem({ section }: { section: Section }) {
  return (
    <div className="mb-1.5">
      <div className="px-3 py-2.5 rounded-md border border-gray-200 bg-white cursor-pointer hover:border-blue-300 hover:bg-gray-50 transition-all text-[13px]">
        <Badge type={section.type} />
        <div className="font-medium text-gray-700 mt-1">{section.label}</div>
        {section.type === 'text' && (
          <div className="text-xs text-gray-400 mt-1 line-clamp-2">
            {section.content.slice(0, 200)}
          </div>
        )}
      </div>
    </div>
  );
}

function LensRefCard({
  section,
  loSourcePath,
  onSelectLens,
  activeLensDocId,
}: {
  section: Section;
  loSourcePath: string | null;
  onSelectLens: (docId: string, name: string) => void;
  activeLensDocId: string | null;
}) {
  const { metadata } = useNavigation();
  const lensFields = parseFields(section.content);
  const lensSource = lensFields.get('source');
  const lensUuid = lensSource && loSourcePath
    ? resolveWikilinkToUuid(lensSource.trim(), loSourcePath, metadata)
    : null;
  const lensName = lensSource
    ? lensSource.replace(/^!?\[\[/, '').replace(/\]\]$/, '').split('/').pop()?.split('|')[0] ?? 'Lens'
    : 'Lens';
  const compoundId = lensUuid ? `${RELAY_ID}-${lensUuid}` : null;
  const isActive = compoundId === activeLensDocId;
  const isOptional = lensFields.get('optional') === 'true';

  return (
    <div
      onClick={() => compoundId && onSelectLens(compoundId, lensName)}
      className={`px-2.5 py-1.5 mt-1 rounded border cursor-pointer flex items-center gap-1.5 transition-all ${
        isActive
          ? 'border-blue-500 border-2 bg-blue-100'
          : 'border-blue-200 bg-blue-50 hover:border-blue-400 hover:bg-blue-100'
      }`}
    >
      <Badge type="lens-ref" />
      <span className="text-xs text-blue-700 font-medium">{lensName}</span>
      {isOptional && <span className="text-[10px] text-gray-400">(optional)</span>}
      <span className="text-blue-300 text-sm ml-auto">&rarr;</span>
    </div>
  );
}

function LOBlock({
  section,
  sourcePath,
  onSelectLens,
  activeLensDocId,
}: {
  section: Section;
  sourcePath: string;
  onSelectLens: (docId: string, name: string) => void;
  activeLensDocId: string | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const [loSections, setLoSections] = useState<Section[]>([]);
  const [loSourcePath, setLoSourcePath] = useState<string | null>(null);
  const { getOrConnect } = useDocConnection();
  const { metadata } = useNavigation();

  const handleExpand = useCallback(async () => {
    if (expanded) {
      setExpanded(false);
      return;
    }
    setExpanded(true);

    const fields = parseFields(section.content);
    const sourceField = fields.get('source');
    if (!sourceField) return;

    const uuid = resolveWikilinkToUuid(sourceField.trim(), sourcePath, metadata);
    if (!uuid) return;

    const loPath = Object.entries(metadata).find(([, m]) => m.id === uuid)?.[0] ?? null;
    setLoSourcePath(loPath);

    const compoundId = `${RELAY_ID}-${uuid}`;
    const { doc } = await getOrConnect(compoundId);
    const ytext = doc.getText('contents');

    const update = () => setLoSections(parseSections(ytext.toString()));
    update();
    ytext.observe(update);
  }, [expanded, section, sourcePath, metadata, getOrConnect]);

  const fields = parseFields(section.content);
  const sourceField = fields.get('source');
  const loName = sourceField
    ? sourceField.replace(/^!?\[\[/, '').replace(/\]\]$/, '').split('/').pop()?.split('|')[0] ?? 'Learning Outcome'
    : 'Learning Outcome';

  return (
    <div className={`mb-3 p-2.5 rounded-md border ${expanded ? 'border-amber-400 border-2' : 'border-amber-200'} bg-amber-50/50`}>
      <div className="cursor-pointer" onClick={handleExpand}>
        <div className="text-xs font-semibold text-amber-700 mb-1">Learning Outcome</div>
        <div className="text-xs text-stone-500 italic">{loName}</div>
      </div>

      {expanded && loSections.length > 0 && (
        <div className="mt-2 ml-4 border-l-2 border-amber-200 pl-3">
          {(() => {
            const submoduleChildIndices = new Set<number>();
            for (let idx = 0; idx < loSections.length; idx++) {
              if (loSections[idx].type === 'submodule') {
                for (let j = idx + 1; j < loSections.length; j++) {
                  if (loSections[j].type === 'submodule') break;
                  submoduleChildIndices.add(j);
                }
              }
            }

            return loSections.map((s, i) => {
              if (s.type === 'frontmatter') return null;
              if (submoduleChildIndices.has(i)) return null;

              if (s.type === 'lens-ref') {
                return <LensRefCard key={i} section={s} loSourcePath={loSourcePath}
                  onSelectLens={onSelectLens} activeLensDocId={activeLensDocId} />;
              }

              if (s.type === 'submodule') {
                return (
                  <SubmoduleGroup key={i} section={s} loSections={loSections} startIndex={i}
                    loSourcePath={loSourcePath} onSelectLens={onSelectLens} activeLensDocId={activeLensDocId} />
                );
              }

              if (s.type === 'test-ref') {
                return (
                  <div key={i} className="mb-1">
                    <SectionItem section={s} />
                  </div>
                );
              }

              return null;
            });
          })()}
        </div>
      )}
    </div>
  );
}

function SubmoduleGroup({
  section,
  loSections,
  startIndex,
  loSourcePath,
  onSelectLens,
  activeLensDocId,
}: {
  section: Section;
  loSections: Section[];
  startIndex: number;
  loSourcePath: string | null;
  onSelectLens: (docId: string, name: string) => void;
  activeLensDocId: string | null;
}) {
  const [collapsed, setCollapsed] = useState(true);

  const children: Section[] = [];
  for (let i = startIndex + 1; i < loSections.length; i++) {
    if (loSections[i].type === 'submodule') break;
    children.push(loSections[i]);
  }

  return (
    <div className="mb-2">
      <div
        className="flex items-center gap-1.5 px-2 py-1.5 cursor-pointer text-xs text-purple-700 font-semibold hover:bg-purple-50 rounded"
        onClick={() => setCollapsed(!collapsed)}
      >
        <span className="text-purple-400">{collapsed ? '\u25B8' : '\u25BE'}</span>
        {section.label}
        <span className="text-purple-300 ml-1 font-normal">({children.filter(c => c.type === 'lens-ref').length} lenses)</span>
      </div>

      {!collapsed && (
        <div className="ml-3 mt-1">
          {children.map((s, i) => {
            if (s.type === 'lens-ref') {
              return <LensRefCard key={i} section={s} loSourcePath={loSourcePath}
                onSelectLens={onSelectLens} activeLensDocId={activeLensDocId} />;
            }
            if (s.type === 'test-ref') {
              return <SectionItem key={i} section={s} />;
            }
            return null;
          })}
        </div>
      )}
    </div>
  );
}

export function ModulePanel({ sections, sourcePath, onSelectLens, activeLensDocId }: ModulePanelProps) {
  return (
    <div>
      {sections.map((section, i) => {
        if (section.type === 'frontmatter') {
          return (
            <div key={i} className="mb-1.5 opacity-70">
              <div className="px-3 py-2 rounded-md border border-gray-200 bg-white text-[11px] text-gray-400 font-mono">
                <Badge type="frontmatter" />
                <div className="mt-1">{section.content.slice(4, 80)}...</div>
              </div>
            </div>
          );
        }

        if (section.type === 'lo-ref') {
          return (
            <LOBlock
              key={i}
              section={section}
              sourcePath={sourcePath}
              onSelectLens={onSelectLens}
              activeLensDocId={activeLensDocId}
            />
          );
        }

        if (section.type === 'submodule') {
          return <SectionItem key={i} section={section} />;
        }

        if (section.type === 'page' || section.type === 'text' || section.type === 'heading') {
          return (
            <div key={i} className={section.type === 'text' ? 'ml-4 border-l-2 border-gray-200 pl-3' : ''}>
              <SectionItem section={section} />
            </div>
          );
        }

        if (section.type === 'meeting-ref') {
          return <SectionItem key={i} section={section} />;
        }

        return <SectionItem key={i} section={section} />;
      })}
    </div>
  );
}
