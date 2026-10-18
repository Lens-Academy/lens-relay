export interface ParsedArticleStub {
  created?: string;
  discussionBlocks: string;
  extraTags: string[];
}

function frontmatterTags(frontmatter: string): string[] {
  const lines = frontmatter.split(/\r?\n/);
  const tags: string[] = [];
  let inTags = false;

  for (const line of lines) {
    const topLevel = !/^\s/.test(line);
    if (topLevel) {
      inTags = false;
      const match = line.match(/^tags:\s*(.*)$/);
      if (!match) continue;
      inTags = true;
      const inline = match[1].trim();
      if (inline) {
        for (const part of inline.replace(/^\[|\]$/g, "").split(",")) {
          const tag = part.trim().replace(/^["']|["']$/g, "");
          if (tag) tags.push(tag);
        }
      }
      continue;
    }
    if (inTags) {
      const match = line.match(/^\s*-\s*(.*?)\s*$/);
      if (match) {
        const tag = match[1].replace(/^["']|["']$/g, "");
        if (tag) tags.push(tag);
      }
    }
  }
  return tags;
}

function lineNumberAt(text: string, index: number): number {
  return text.slice(0, index).split(/\r?\n/).length;
}

/** What a stub of one kind is called in its tag and in messages. */
export interface StubKind {
  tag: "article-stub" | "video-stub";
  /** "article stub" / "video stub" */
  noun: string;
  /** What the full import adds: "the full article" / "the transcript" */
  fullImport: string;
}

export const ARTICLE_STUB: StubKind = {
  tag: "article-stub",
  noun: "article stub",
  fullImport: "the full article",
};

export const VIDEO_STUB: StubKind = {
  tag: "video-stub",
  noun: "video stub",
  fullImport: "the transcript",
};

/** Tags the importer writes itself; a promoted file gets its own set. */
const IMPORTER_TAGS = new Set([
  "article-stub",
  "video-stub",
  "validator-ignore",
  "article-importer",
]);

/**
 * Validate and extract the only content a promotable stub may contain:
 * frontmatter followed by complete Obsidian %% comment blocks and whitespace.
 */
export function parsePromotableArticleStub(
  content: string,
  displayPath: string,
): ParsedArticleStub {
  return parsePromotableStub(content, displayPath, ARTICLE_STUB);
}

export function parsePromotableStub(
  content: string,
  displayPath: string,
  kind: StubKind,
): ParsedArticleStub {
  const { noun, fullImport } = kind;
  const opening = content.match(/^---\r?\n/);
  if (!opening) {
    throw new Error(
      `Cannot promote ${noun} ${displayPath}: it has no YAML frontmatter.`,
    );
  }
  const closingRe = /^---\s*$/gm;
  closingRe.lastIndex = opening[0].length;
  const closing = closingRe.exec(content);
  if (!closing) {
    throw new Error(
      `Cannot promote ${noun} ${displayPath}: its YAML frontmatter is not closed.`,
    );
  }

  const frontmatter = content.slice(opening[0].length, closing.index);
  const tags = frontmatterTags(frontmatter);
  if (!tags.includes(kind.tag)) {
    throw new Error(
      `Cannot promote ${displayPath}: the matched document is not tagged ${kind.tag}.`,
    );
  }

  const remainderStart = closing.index + closing[0].length;
  const blocks: string[] = [];
  let cursor = remainderStart;
  while (cursor < content.length) {
    const whitespace = content.slice(cursor).match(/^\s*/)?.[0] ?? "";
    cursor += whitespace.length;
    if (cursor >= content.length) break;

    if (!content.startsWith("%%", cursor)) {
      const end = content.indexOf("\n", cursor);
      const preview = content
        .slice(cursor, end === -1 ? undefined : end)
        .trim()
        .slice(0, 100);
      throw new Error(
        `Cannot promote ${noun} ${displayPath}: found non-comment content outside frontmatter at line ${lineNumberAt(content, cursor)}${preview ? ` (“${preview}”)` : ""}. Open the stub and move that text into a complete %% comment block, or remove it, before importing ${fullImport}.`,
      );
    }

    const close = content.indexOf("%%", cursor + 2);
    if (close === -1) {
      throw new Error(
        `Cannot promote ${noun} ${displayPath}: the %% comment beginning at line ${lineNumberAt(content, cursor)} is not closed. Close it with %% before importing ${fullImport}.`,
      );
    }
    blocks.push(content.slice(cursor, close + 2));
    cursor = close + 2;
  }

  const created = frontmatter.match(/^created:\s*["']?([^"'\r\n]+)["']?\s*$/m)?.[1]?.trim();
  const extraTags = tags.filter((tag) => !IMPORTER_TAGS.has(tag));
  return {
    created,
    discussionBlocks: blocks.join("\n\n"),
    extraTags,
  };
}

/** Whether the file's frontmatter tags it as a stub of this kind. */
export function isStub(content: string, kind: StubKind): boolean {
  const match = content.match(/^---\r?\n([\s\S]*?)^---\s*$/m);
  return match?.index === 0 && frontmatterTags(match[1]).includes(kind.tag);
}

/**
 * Split an imported file into its head (frontmatter plus the %% comment
 * blocks right after it, where people write their notes) and its body (the
 * imported text). Null when the file has no closed frontmatter.
 *
 * A background pass that rewrites the body after people could already edit
 * the file uses this to keep their head: it replaces the body only while the
 * body is still exactly what the importer wrote.
 */
export function splitImportedDoc(
  content: string,
): { head: string; body: string; hasComments: boolean } | null {
  const opening = content.match(/^---\r?\n/);
  if (!opening) return null;
  const closingRe = /^---[ \t]*$/gm;
  closingRe.lastIndex = opening[0].length;
  const closing = closingRe.exec(content);
  if (!closing) return null;

  let headEnd = closing.index + closing[0].length;
  let hasComments = false;
  for (;;) {
    const whitespace = content.slice(headEnd).match(/^\s*/)?.[0] ?? "";
    const start = headEnd + whitespace.length;
    if (!content.startsWith("%%", start)) break;
    const close = content.indexOf("%%", start + 2);
    if (close === -1) break;
    headEnd = close + 2;
    hasComments = true;
  }
  return {
    head: content.slice(0, headEnd),
    body: content.slice(headEnd).trim(),
    hasComments,
  };
}
