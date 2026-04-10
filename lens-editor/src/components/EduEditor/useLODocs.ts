import { useEffect, useState, useRef } from 'react';
import * as Y from 'yjs';
import type { Section } from '../SectionEditor/parseSections';
import { parseSections } from '../SectionEditor/parseSections';
import { parseFields, parseFrontmatterFields } from '../../lib/parseFields';
import { resolveWikilinkToUuid } from '../../lib/resolveDocPath';
import { useDocConnection } from '../../hooks/useDocConnection';
import { useNavigation } from '../../contexts/NavigationContext';
import { RELAY_ID } from '../../lib/constants';

export interface LODocEntry {
  loPath: string;
  sections: Section[];
  frontmatter: Map<string, string>;
  title: string;
}

export function useLODocs(
  moduleSections: Section[],
  modulePath: string,
): Record<string, LODocEntry> {
  const { getOrConnect } = useDocConnection();
  const { metadata } = useNavigation();
  const [docs, setDocs] = useState<Record<string, LODocEntry>>({});
  const observersRef = useRef<Map<string, { ytext: Y.Text; handler: () => void }>>(new Map());

  // Collect unique uuids referenced by lo-ref sections in the module
  const uuids: string[] = [];
  for (const section of moduleSections) {
    if (section.type !== 'lo-ref') continue;
    const fields = parseFields(section.content);
    const sourceField = fields.get('source');
    if (!sourceField) continue;
    const uuid = resolveWikilinkToUuid(sourceField.trim(), modulePath, metadata);
    if (uuid && !uuids.includes(uuid)) uuids.push(uuid);
  }
  const uuidsKey = uuids.join('|');

  useEffect(() => {
    let cancelled = false;

    async function load() {
      for (const uuid of uuids) {
        if (cancelled) return;
        const compoundId = `${RELAY_ID}-${uuid}`;
        const { doc } = await getOrConnect(compoundId);
        if (cancelled) return;

        const ytext = doc.getText('contents');

        const update = () => {
          const text = ytext.toString();
          const sections = parseSections(text);
          const fmSection = sections.find(s => s.type === 'frontmatter');
          const frontmatter = fmSection
            ? parseFrontmatterFields(fmSection.content)
            : new Map<string, string>();
          const loPath =
            Object.entries(metadata).find(([, m]) => m.id === uuid)?.[0] ?? '';
          const title = titleFromPath(loPath);
          setDocs(prev => ({ ...prev, [uuid]: { loPath, sections, frontmatter, title } }));
        };

        update();
        ytext.observe(update);

        const prev = observersRef.current.get(uuid);
        if (prev) prev.ytext.unobserve(prev.handler);
        observersRef.current.set(uuid, { ytext, handler: update });
      }

      if (cancelled) return;
      const activeSet = new Set(uuids);
      for (const [uuid, { ytext, handler }] of observersRef.current.entries()) {
        if (!activeSet.has(uuid)) {
          ytext.unobserve(handler);
          observersRef.current.delete(uuid);
          setDocs(prev => {
            const next = { ...prev };
            delete next[uuid];
            return next;
          });
        }
      }
    }

    load();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uuidsKey, modulePath]);

  useEffect(() => {
    return () => {
      for (const { ytext, handler } of observersRef.current.values()) {
        ytext.unobserve(handler);
      }
      observersRef.current.clear();
    };
  }, []);

  return docs;
}

function titleFromPath(path: string): string {
  if (!path) return 'Learning Outcome';
  const file = path.split('/').pop() ?? path;
  return file.replace(/\.md$/, '');
}
