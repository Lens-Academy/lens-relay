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
  const re = /^[^\n]*?source::\s*!?\[\[([^\]]+)\]\]/gm;
  for (const m of md.matchAll(re)) {
    const target = m[1].split("|")[0].trim();
    if (target && !seen.has(target)) {
      seen.add(target);
      out.push(target);
    }
  }
  return out;
}

/** Module wikilinks from a course doc: `# Module: [[../modules/x]]` lines
 *  (variable spacing). Ignores `# Meeting:` and other headings. */
export function parseModuleLinks(md: string): string[] {
  const out: string[] = [];
  const re = /^#\s*Module:\s*!?\[\[([^\]]+)\]\]/gm;
  for (const m of md.matchAll(re)) out.push(m[1].split("|")[0].trim());
  return out;
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
