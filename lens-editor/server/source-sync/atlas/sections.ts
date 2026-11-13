/**
 * One chapter tab -> its chapter facts and sections, by the rules of the
 * Atlas's own site (src/textbook-loader/transformer.ts in its repository):
 *   - the TITLE "Chapter <N> - <Title>" gives the chapter; anything else
 *     before the first section is left out;
 *   - a section starts at each Heading 1 with text and runs to the next
 *     one; an empty Heading 1 (common in the Docs) neither starts nor ends
 *     one;
 *   - slugs are the site's, so a section keeps its address there.
 * Two of the site's bugs are not copied, since the Doc is the source: a
 * table straight after a section's heading is kept, and a manual line break
 * separates words rather than joining them.
 */

import type { StructuralElement } from "../google-docs/docs-types";
import { atlasComponent, parseChapterTitle, plainText } from "../google-docs/to-markdown";
import type { ChapterFacts, ChapterSource, Section } from "./types";

/** The Atlas site's slugify, unchanged: ASCII `\w`, so "Généralisation" gives "gnralisation". */
export const atlasSlug = (text: string): string =>
  text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");

/** "Appendix: …": a section a module may mark optional. */
export const isAppendix = (title: string): boolean => /^appendix\b/i.test(title);

const style = (el: StructuralElement) => el.paragraph?.paragraphStyle?.namedStyleType ?? "";

/** A top-level `section-description` table: the section's summary. */
export function isSectionDescription(el: StructuralElement): boolean {
  return !!el.table && atlasComponent(el.table).type === "section-description";
}

/** The component rows a reader reads, as the site counts reading time (the description is not counted). */
const READ_ROWS: Record<string, string[]> = {
  figure: ["caption"],
  video: ["caption"],
  iframe: ["caption"],
  quote: ["content", "source-url"],
  definition: ["content", "source"],
  notebox: ["content"],
  callout: ["content"],
  "section-description": [],
};

/** Words read in these elements: paragraphs and list items, component text, plain tables; not headings. */
function words(elements: StructuralElement[]): number {
  let n = 0;
  for (const el of elements) {
    if (el.paragraph && !style(el).startsWith("HEADING_")) {
      n += plainText([el]).split(" ").filter(Boolean).length;
    } else if (el.table) {
      const { type, attrs } = atlasComponent(el.table);
      const cells = type
        ? READ_ROWS[type].map((key) => attrs.get(key) ?? [])
        : (el.table.tableRows ?? []).flatMap((row) => (row.tableCells ?? []).map((cell) => cell.content ?? []));
      for (const cell of cells) n += words(cell);
    }
  }
  return n;
}

/** Whether an element before the first section held anything a reader would see. */
function visible(el: StructuralElement): boolean {
  if (el.table) return true;
  return !!el.paragraph && (!!plainText([el]) || !!el.paragraph.elements?.some((pe) => pe.inlineObjectElement));
}

export function splitChapter(source: ChapterSource): { facts: ChapterFacts; sections: Section[]; warnings: string[] } {
  const warnings: string[] = [];
  let title: string | null = null;
  let leftOut = 0;
  const found: { title: string; headingId: string | null; content: StructuralElement[] }[] = [];

  for (const el of source.tab.body?.content ?? []) {
    const text = el.paragraph ? plainText([el]) : "";
    if (style(el) === "HEADING_1" && text) found.push({ title: text, headingId: el.paragraph?.paragraphStyle?.headingId ?? null, content: [] });
    else if (found.length) found[found.length - 1].content.push(el);
    else if (style(el) === "TITLE" && title === null) title = text;
    else if (style(el) !== "SUBTITLE" && visible(el)) leftOut++;
  }

  // An unreadable TITLE gives chapter 0, as on the site; the sync must not take it for a real chapter.
  const parsed = title === null ? null : parseChapterTitle(title);
  if (!parsed?.title) {
    warnings.push(
      title === null
        ? `the tab has no TITLE paragraph "Chapter <number> - <title>"`
        : `the TITLE "${title}" does not read "Chapter <number> - <title>"`,
    );
  }
  const chapterTitle = parsed?.title || title || "Untitled";
  const number = parsed?.title ? parsed.number : 0;
  // A title in another script has no ASCII slug; its files and module still need an address of their own.
  const facts: ChapterFacts = { number, title: chapterTitle, slug: atlasSlug(chapterTitle) || `chapter-${number}` };
  const where = `Chapter ${facts.number} (${facts.title})`;
  if (leftOut) warnings.push(`${where}: ${leftOut} element(s) before the first section were left out`);
  if (!found.length) warnings.push(`${where}: no Heading 1 with text, so the chapter has no sections`);

  const seen = new Set<string>();
  const sections = found.map(({ title, headingId, content }, i): Section => {
    const slug = atlasSlug(title);
    if (!slug) warnings.push(`${where}: section "${title}" has no slug (no ASCII letters or digits)`);
    else if (seen.has(slug)) warnings.push(`${where}: two sections have the slug "${slug}"`);
    seen.add(slug);
    const descriptions = content.filter(isSectionDescription);
    if (descriptions.length > 1) {
      warnings.push(`${where}: section "${title}" has ${descriptions.length} section-description tables; the first is used`);
    }
    const description = descriptions.length ? plainText(atlasComponent(descriptions[0].table!).attrs.get("content")) : "";
    return {
      chapter: facts,
      number: i + 1,
      title,
      slug,
      headingId,
      appendix: isAppendix(title),
      description: description || null,
      content,
      words: words(content),
    };
  });
  return { facts, sections, warnings };
}
