/**
 * Escape every `<` that could open an HTML construct — a tag (`<word`), a
 * closing tag (`</`), a comment/doctype (`<!`), or a processing instruction
 * (`<?`). The platform renders article bodies with rehype-raw (required for
 * video <iframe> embeds), so an unescaped `<word>` in prose — e.g. the
 * placeholder in "train a 'brain embeddings to <behavior>' model" — is parsed
 * as an HTML tag and silently disappears. `\<` is a CommonMark backslash
 * escape and renders as a literal `<`.
 *
 * Comparisons like "P<0.05" or "1 < 2" don't match and are left alone.
 */
export function escapeTagOpeners(text: string): string {
  return text.replace(/<(?=[a-zA-Z/!?])/g, "\\<");
}
