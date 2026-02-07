/**
 * Remove code blocks and inline code from markdown.
 * This prevents extracting links from code examples.
 */
function stripCode(markdown: string): string {
  // Remove fenced code blocks (``` or ~~~ with optional language)
  let result = markdown.replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1/gm, '');
  // Fallback: simple fenced blocks without matching
  result = result.replace(/```[\s\S]*?```/g, '');
  result = result.replace(/~~~[\s\S]*?~~~/g, '');
  // Remove inline code (handles empty backticks too)
  result = result.replace(/`[^`]*`/g, '');
  return result;
}

/**
 * Extract wikilink targets from markdown text.
 * Returns the page names only (strips anchors and aliases).
 * Ignores links inside code blocks and inline code.
 */
export function extractWikilinks(markdown: string): string[] {
  const links: string[] = [];
  const cleanedMarkdown = stripCode(markdown);
  const regex = /\[\[([^\]]+)\]\]/g;
  let match;

  while ((match = regex.exec(cleanedMarkdown)) !== null) {
    let content = match[1];
    if (!content.trim()) continue;

    // Strip alias (|) - take only the part before |
    const pipeIndex = content.indexOf('|');
    if (pipeIndex !== -1) {
      content = content.substring(0, pipeIndex);
    }

    // Strip anchor (#) - take only the part before first #
    const anchorIndex = content.indexOf('#');
    if (anchorIndex !== -1) {
      content = content.substring(0, anchorIndex);
    }

    const trimmed = content.trim();
    if (trimmed) {
      links.push(trimmed);
    }
  }

  return links;
}
