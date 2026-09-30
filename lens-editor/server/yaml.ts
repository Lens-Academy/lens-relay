/**
 * YAML double-quote a frontmatter scalar: escape backslashes and quotes, and
 * collapse control whitespace -- a raw newline inside a double-quoted scalar
 * (e.g. a title with an embedded line break) breaks frontmatter parsing.
 */
export function yamlQuote(s: string): string {
  return '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\r\n\t]+/g, " ") + '"';
}
