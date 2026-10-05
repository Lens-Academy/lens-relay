import { parseFields } from './parseFields';

/**
 * A question file (`Questions/<name>.md`): one `#### Question` segment, the
 * same syntax as a question written inline in a lens. Lenses embed it with
 *
 *     #### Question
 *     ![[../Questions/<name>]]
 *     force-feedback:: first      (optional per-lens settings)
 */
export interface QuestionFile {
  /** The type after `Question:` (`Open`, `Choice`, ...); `Open` when bare. */
  type: string;
  fields: Map<string, string>;
}

const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/;
const QUESTION_HEADER = /^#{4,6}[ \t]+Question\b[ \t]*(?::[ \t]*(.*?))?[ \t]*$/m;
const NEXT_SEGMENT = /^#{1,6}[ \t]+\S/m;

export function stripFrontmatter(text: string): string {
  return text.replace(FRONTMATTER, '');
}

/** The question in `text`, or null when it has no `#### Question` segment. */
export function parseQuestionFile(text: string): QuestionFile | null {
  const body = stripFrontmatter(text);
  const header = QUESTION_HEADER.exec(body);
  if (!header) return null;
  const rest = body.slice(header.index + header[0].length);
  const next = NEXT_SEGMENT.exec(rest);
  const segment = next ? rest.slice(0, next.index) : rest;
  return { type: header[1]?.trim() || 'Open', fields: parseFields(segment) };
}

/** A line that is only an embed: `![[target]]`, `![[target|alias]]`. */
export const EMBED_LINE = /^[ \t]*!\[\[([^\]\n]+)\]\][ \t]*$/;

/** The link target of an embed line (without `#heading` or `|alias`), or null. */
export function embedLineTarget(line: string): string | null {
  const m = EMBED_LINE.exec(line);
  if (!m) return null;
  const target = m[1].split('|')[0].split('#')[0].trim();
  return target || null;
}
