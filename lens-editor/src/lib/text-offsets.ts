/**
 * Convert a UTF-8 byte offset into a UTF-16 code-unit offset for `text`.
 *
 * The relay server scans documents as UTF-8 (Rust `&str`), so suggestion
 * offsets it reports (e.g. the review page's `?pos=` links) are byte offsets.
 * CodeMirror positions are UTF-16 code units. For pure-ASCII text the two are
 * equal, but every non-ASCII character (curly quote, umlaut, emoji) makes the
 * byte offset run ahead — jumping to the raw byte offset lands past the target.
 *
 * Offsets past the end of the text (or mid-codepoint) clamp to the nearest
 * following code-unit boundary.
 */
export function utf8ByteToUtf16Offset(text: string, byteOffset: number): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    if (bytes >= byteOffset) return i;
    const code = text.codePointAt(i)!;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    if (code > 0xffff) i++; // astral codepoint occupies two UTF-16 units
  }
  return text.length;
}
