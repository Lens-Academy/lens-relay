import fm from 'front-matter';

export interface DocFrontmatter {
  discussion?: string;
  [key: string]: unknown;
}

/**
 * Extract frontmatter attributes from a markdown string.
 * Returns null if the text has no valid frontmatter delimiters.
 */
export function extractFrontmatter(text: string): DocFrontmatter | null {
  if (!fm.test(text)) return null;
  try {
    const { attributes } = fm<DocFrontmatter>(text);
    return attributes;
  } catch {
    return null;
  }
}

/** A plain YAML value can't start with these, or contain ": " or " #", unquoted. */
const NEEDS_QUOTES = /^[-?:,[\]{}#&*!|>'"%@`\s]|: | #|\s$/;

/**
 * The smallest text change that sets `key: value` in the document's
 * frontmatter, adding a frontmatter block when there is none, or that removes
 * the key when `value` is null. Null when nothing would change.
 */
export function frontmatterFieldChange(
  text: string,
  key: string,
  value: string | null,
): { from: number; to: number; insert: string } | null {
  const line = value === null ? null : `${key}: ${NEEDS_QUOTES.test(value) ? JSON.stringify(value) : value}`;
  const lines = text.split('\n');
  const closing = lines[0]?.trimEnd() === '---' ? lines.findIndex((l, i) => i > 0 && l.trimEnd() === '---') : -1;

  if (closing === -1) {
    return line === null ? null : { from: 0, to: 0, insert: `---\n${line}\n---\n` };
  }

  // Offset of each line's start
  const starts: number[] = [];
  let offset = 0;
  for (const l of lines) {
    starts.push(offset);
    offset += l.length + 1;
  }
  const keyPattern = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:`);
  const at = lines.findIndex((l, i) => i > 0 && i < closing && keyPattern.test(l));
  if (at === -1) {
    return line === null ? null : { from: starts[closing], to: starts[closing], insert: `${line}\n` };
  }
  if (line === null) return { from: starts[at], to: starts[at + 1], insert: '' };
  const current = lines[at].replace(/\r$/, '');
  return current === line ? null : { from: starts[at], to: starts[at] + current.length, insert: line };
}
