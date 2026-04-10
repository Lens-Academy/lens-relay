import type { Section } from '../SectionEditor/parseSections';

/**
 * Given a flat list of sections and the index of a root section,
 * return [from, toExclusive) covering the root and all descendants —
 * i.e., every following section whose level is strictly greater than
 * the root's level, until the first section with level <= root's level.
 */
export function getSubtreeRange(
  sections: Section[],
  rootIndex: number,
): [number, number] {
  const root = sections[rootIndex];
  const rootLevel = root.level;
  let end = rootIndex + 1;
  while (end < sections.length && sections[end].level > rootLevel) {
    end++;
  }
  return [rootIndex, end];
}
