import * as path from "node:path";

/** Extract every `source::` wikilink target from a relay doc, normalized.
 *  Strips the embed `!` prefix and a `|alias` suffix; returns inner paths,
 *  order-preserving and de-duplicated. */
export function parseSourceTargets(md: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  // `[^\n]*?` (not `\s*`) so a `source::` preceded by inline CriticMarkup on the
  // same line — e.g. `--}source:: [[..]]` — is still captured. `.` excludes
  // newlines, so the match stays line-scoped.
  // Relay content contains both `source:: [[target]]` and the Obsidian
  // property-on-one-line/embed-on-the-next form. Keep the continuation
  // deliberately limited to one line so an unrelated later wikilink is not
  // accidentally treated as an import.
  const re = /^[^\n]*?source::[^\S\r\n]*(?:\r?\n[^\S\r\n]*)?!?\[\[([^\]]+)\]\]/gm;
  for (const m of md.matchAll(re)) {
    const target = m[1].split("|")[0].trim();
    if (target && !seen.has(target)) {
      seen.add(target);
      out.push(target);
    }
  }
  return out;
}

/** Targets of every line that is only a `![[...]]` embed (a lens's
 *  `#### Question` embedding a question file, a widget in an article), outside
 *  fenced code; `|alias` and `#heading` stripped, order-preserving, de-duplicated. */
export function parseEmbedLineTargets(md: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let fence: string | null = null;
  for (const line of md.split(/\r?\n/)) {
    const fenceMatch = /^[ \t]*(```|~~~)/.exec(line);
    if (fenceMatch) {
      if (fence === null) fence = fenceMatch[1];
      else if (fence === fenceMatch[1]) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const m = /^[ \t]*!\[\[([^\]\n]+)\]\][ \t]*$/.exec(line);
    if (!m) continue;
    const target = m[1].split("|")[0].split("#")[0].trim();
    if (target && !seen.has(target)) {
      seen.add(target);
      out.push(target);
    }
  }
  return out;
}

export interface ModuleLink {
  target: string;
  alias: string | null;
}

/** Structured course-module links, retaining aliases for display labels. */
export function parseModuleLinkEntries(md: string): ModuleLink[] {
  const out: ModuleLink[] = [];
  const re = /^#\s*Module:\s*!?\[\[([^\]]+)\]\]/gm;
  for (const match of md.matchAll(re)) {
    const [rawTarget, ...aliasParts] = match[1].split("|");
    const target = rawTarget.trim();
    if (!target) continue;
    const rawAlias = aliasParts.join("|").trim();
    out.push({ target, alias: rawAlias || null });
  }
  return out;
}

/** Module wikilinks from a course doc: `# Module: [[../modules/x]]` lines
 *  (variable spacing). Ignores `# Meeting:` and other headings. */
export function parseModuleLinks(md: string): string[] {
  return parseModuleLinkEntries(md).map(link => link.target);
}

/** Resolves a `../`-relative wikilink target against the folder of the referring doc,
 *  returning a repo-relative path with `.md` appended (unless already present).
 *  @param fromRelayPath - Path to the referring doc (e.g., "modules/x.md")
 *  @param target - Relative wikilink target without extension (e.g., "../articles/foo")
 *  @returns Normalized path with `.md` (e.g., "articles/foo.md")
 */
export function resolveRelayPath(fromRelayPath: string, target: string): string {
  const dir = path.posix.dirname(fromRelayPath);
  const joined = path.posix.normalize(path.posix.join(dir, target));
  return joined.endsWith(".md") ? joined : `${joined}.md`;
}
