import type { Section } from '../SectionEditor/parseSections';
import { parseFields, parseFrontmatterFields } from '../../lib/parseFields';
import { resolveWikilinkToUuid, titleFromWikilink } from '../../lib/resolveDocPath';
import { TreeEntry } from './ModuleTreeEditor/TreeEntry';
import { RELAY_ID } from '../../lib/constants';

function extractWikilink(section: Section): string | null {
  const fields = parseFields(section.content);
  const source = fields.get('source');
  if (source) return source.trim();
  const match = section.label.match(/(\[{2}[^\]]+\]{2})/);
  return match ? match[1] : null;
}

interface CourseOverviewProps {
  courseSections: Section[];
  coursePath: string;
  metadata: Record<string, { id: string; [key: string]: unknown }>;
  selectedModuleDocId: string | null;
  onSelectModule: (docId: string, displayName: string) => void;
}

export function CourseOverview({
  courseSections,
  coursePath,
  metadata,
  selectedModuleDocId,
  onSelectModule,
}: CourseOverviewProps) {
  const frontmatter = (() => {
    const fm = courseSections.find(s => s.type === 'frontmatter');
    return fm ? parseFrontmatterFields(fm.content) : new Map<string, string>();
  })();

  const courseTitle = frontmatter.get('title') ?? coursePath.split('/').pop()?.replace(/\.md$/, '') ?? 'Course';

  const moduleEntries = courseSections
    .filter(s => s.type === 'module-ref' && s.level === 1)
    .map(section => {
      const wikilink = extractWikilink(section);
      if (!wikilink) return null;
      const uuid = resolveWikilinkToUuid(wikilink, coursePath, metadata);
      if (!uuid) return null;
      const docId = `${RELAY_ID}-${uuid}`;
      const displayName = titleFromWikilink(wikilink);
      return { docId, displayName };
    })
    .filter((e): e is { docId: string; displayName: string } => e !== null);

  return (
    <div className="mb-2">
      <div className="text-[13px] font-semibold text-gray-700 mb-2">{courseTitle}</div>
      {moduleEntries.map((entry, i) => (
        <TreeEntry
          key={i}
          badgeText="Module"
          badgeClass="bg-purple-100 text-purple-700"
          label={entry.displayName}
          active={entry.docId === selectedModuleDocId}
          showArrow={false}
          onClick={() => onSelectModule(entry.docId, entry.displayName)}
        />
      ))}
    </div>
  );
}
