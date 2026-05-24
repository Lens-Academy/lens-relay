import { parse } from '../../lib/criticmarkup-parser';
import { getFieldValueRange } from '../../lib/parseFields';
import type { Section } from '../SectionEditor/parseSections';

/**
 * Map from section type to the list of field names that the corresponding
 * renderer paints with inline criticmarkup. Comments that fall inside one of
 * these field's value range will already have an inline DOM anchor; comments
 * that fall outside need a separate orphan anchor.
 */
const RENDERED_FIELDS_BY_TYPE: Record<string, string[]> = {
  text: ['content'],
  chat: ['instructions'],
  question: ['content', 'assessment-instructions'],
};

export interface OrphanComment {
  /** Absolute Y.Text offset of the comment's opening `{` marker. */
  absFrom: number;
  /** Index into the `sections` array — the section this comment belongs to. */
  sectionIndex: number;
}

/**
 * Find comments in `yTextString` that are NOT inside any renderer-painted
 * field value. These need a separate invisible anchor element so that
 * `resolveAnchorYFromDOM` can place a card for them.
 */
export function findOrphanCommentOffsets(
  yTextString: string,
  sections: Section[],
): OrphanComment[] {
  const orphans: OrphanComment[] = [];
  const comments = parse(yTextString).filter((r) => r.type === 'comment');

  for (const comment of comments) {
    const sectionIndex = sections.findIndex(
      (s) => comment.from >= s.from && comment.from < s.to,
    );
    if (sectionIndex === -1) continue;
    const section = sections[sectionIndex];

    const fields = RENDERED_FIELDS_BY_TYPE[section.type] ?? [];
    const inCoveredField = fields.some((name) => {
      const [from, to] = getFieldValueRange(section.content, section.from, name);
      return comment.from >= from && comment.from < to;
    });

    if (!inCoveredField) {
      orphans.push({ absFrom: comment.from, sectionIndex });
    }
  }

  return orphans;
}
