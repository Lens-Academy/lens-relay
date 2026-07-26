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

/**
 * Validate and extract the only content a promotable stub may contain:
 * frontmatter followed by complete Obsidian %% comment blocks and whitespace.
 */
export function parsePromotableArticleStub(
  content: string,
  displayPath: string,
): ParsedArticleStub {
  const opening = content.match(/^---\r?\n/);
  if (!opening) {
    throw new Error(
      `Cannot promote article stub ${displayPath}: it has no YAML frontmatter.`,
    );
  }
  const closingRe = /^---\s*$/gm;
  closingRe.lastIndex = opening[0].length;
  const closing = closingRe.exec(content);
  if (!closing) {
    throw new Error(
      `Cannot promote article stub ${displayPath}: its YAML frontmatter is not closed.`,
    );
  }

  const frontmatter = content.slice(opening[0].length, closing.index);
  const tags = frontmatterTags(frontmatter);
  if (!tags.includes("article-stub")) {
    throw new Error(
      `Cannot promote ${displayPath}: the matched document is not tagged article-stub.`,
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
        `Cannot promote article stub ${displayPath}: found non-comment content outside frontmatter at line ${lineNumberAt(content, cursor)}${preview ? ` (“${preview}”)` : ""}. Open the stub and move that text into a complete %% comment block, or remove it, before importing the full article.`,
      );
    }

    const close = content.indexOf("%%", cursor + 2);
    if (close === -1) {
      throw new Error(
        `Cannot promote article stub ${displayPath}: the %% comment beginning at line ${lineNumberAt(content, cursor)} is not closed. Close it with %% before importing the full article.`,
      );
    }
    blocks.push(content.slice(cursor, close + 2));
    cursor = close + 2;
  }

  const created = frontmatter.match(/^created:\s*["']?([^"'\r\n]+)["']?\s*$/m)?.[1]?.trim();
  const extraTags = tags.filter(
    (tag) =>
      tag !== "article-stub" &&
      tag !== "validator-ignore" &&
      tag !== "article-importer",
  );
  return {
    created,
    discussionBlocks: blocks.join("\n\n"),
    extraTags,
  };
}
