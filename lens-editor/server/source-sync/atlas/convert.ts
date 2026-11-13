/**
 * One Atlas section -> its article's Markdown: the section description and a
 * rule, the section's content, then the footnotes it references. The
 * section's own heading is left out (the lens title shows it); headings 2-6
 * inside the section keep their level.
 */

import { convertSlice } from "../google-docs/to-markdown";
import { isSectionDescription } from "./sections";
import type { ChapterCounters, ChapterSource, ConvertedSection, Section } from "./types";

/** `counters` is shared by the sections of one chapter, converted in order. */
export function convertSection(section: Section, source: ChapterSource, imageUrl: (inlineObjectId: string) => string | null, counters: ChapterCounters): ConvertedSection {
  const { content } = section;
  // The description leads wherever the Doc put it; the converter writes it as a
  // paragraph and a rule. Only the first one counts, as in sections.ts.
  const descriptions = content.filter(isSectionDescription);
  const ordered = [...descriptions.slice(0, 1), ...content.filter((el) => !descriptions.includes(el))];
  const { body, warnings } = convertSlice(source.tab, ordered, {
    imageUrl,
    chapterNumber: section.chapter.number || null,
    counters,
    numberDefinitions: true,
  });
  const where = `Section ${section.chapter.number}.${section.number} (${section.title})`;
  return { markdown: body, warnings: warnings.map((warning) => `${where}: ${warning}`) };
}
