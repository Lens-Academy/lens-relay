import { parse as parseYaml } from "yaml";

/**
 * YAML double-quote a frontmatter scalar: escape backslashes and quotes, and
 * collapse control whitespace -- a raw newline inside a double-quoted scalar
 * (e.g. a title with an embedded line break) breaks frontmatter parsing.
 */
export function yamlQuote(s: string): string {
  return '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\r\n\t]+/g, " ") + '"';
}

/** Text as it stands before review: pending suggestions and comments are
 *  written inline, and {"author":…}@@ may lead any of them. */
function withoutPendingChanges(text: string): string {
  return text
    .replace(/\{>>[\s\S]*?<<\}/g, "")
    .replace(/\{\+\+[\s\S]*?\+\+\}/g, "")
    .replace(/\{--(?:\{[^}]+\}@@)?([\s\S]*?)--\}/g, "$1")
    .replace(/\{~~(?:\{[^}]+\}@@)?([\s\S]*?)~>[\s\S]*?~~\}/g, "$1")
    .replace(/\{==(?:\{[^}]+\}@@)?([\s\S]*?)==\}/g, "$1");
}

/**
 * The fields of a leading `---` block, given a whole document or just the block
 * (with or without its closing fence). Null when there is no block or it does
 * not parse to a mapping. Pending changes are read past, not parsed: a comment
 * left on a frontmatter line is not YAML, and in the library it is the usual
 * reason a block fails to parse.
 */
export function parseFrontmatter(text: string): Record<string, unknown> | null {
  const open = /^---[ \t]*\r?\n/.exec(text);
  if (!open) return null;
  const rest = text.slice(open[0].length);
  const close = /^---[ \t]*$/m.exec(rest);
  try {
    const block = close ? rest.slice(0, close.index) : rest;
    const fields: unknown = parseYaml(withoutPendingChanges(block), {
      logLevel: "error",
      uniqueKeys: false,
    });
    return fields && typeof fields === "object" && !Array.isArray(fields)
      ? (fields as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** A frontmatter value as text, or undefined when it holds none. */
export function frontmatterText(value: unknown): string | undefined {
  if (typeof value === "number") return String(value);
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
