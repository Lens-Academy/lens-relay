/**
 * `![[...]]` embed lines: a line that is only an embed, e.g. a lens's
 * `#### Question` embedding `![[../Questions/<name>]]`. One parser for the
 * editor (preview cards, src/components/Editor/extensions/noteEmbed.ts) and
 * promotion (files travel with the file that embeds them), so both always
 * agree on what is embedded.
 */

const EMBED_LINE = /^[ \t]*!\[\[([^\]\n]+)\]\][ \t]*$/;
const FENCE = /^[ \t]*(```|~~~)/;
const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp|svg|bmp|tiff|avif|heic)$/i;

/** The link target of an embed line (without `#heading` or `|alias`), or null. */
export function embedLineTarget(line: string): string | null {
  const m = EMBED_LINE.exec(line);
  if (!m) return null;
  const target = m[1].split('|')[0].split('#')[0].trim();
  return target || null;
}

export interface EmbedLine {
  /** 0-based index of the line. */
  index: number;
  target: string;
}

/** The embed lines among `lines` that embed a file other than an image,
 *  outside fenced code. */
export function findEmbedLines(lines: readonly string[]): EmbedLine[] {
  const out: EmbedLine[] = [];
  let fence: string | null = null;
  lines.forEach((line, index) => {
    const fenceMatch = FENCE.exec(line);
    if (fenceMatch) {
      if (fence === null) fence = fenceMatch[1];
      else if (fence === fenceMatch[1]) fence = null;
      return;
    }
    if (fence !== null || !line.includes('![[')) return;
    const target = embedLineTarget(line);
    if (target && !IMAGE_EXTENSIONS.test(target)) out.push({ index, target });
  });
  return out;
}
