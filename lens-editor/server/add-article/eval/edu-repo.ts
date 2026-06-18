import * as fs from "node:fs/promises";
import * as path from "node:path";

export function eduRepoRoot(): string {
  return process.env.LENS_EDU_REPO || "/home/penguin/code/lens-edu-relay";
}

export async function readEduDoc(
  repoRelPath: string,
  root: string = eduRepoRoot(),
): Promise<string> {
  const full = path.join(root, repoRelPath);
  try {
    return await fs.readFile(full, "utf-8");
  } catch {
    throw new Error(
      `Edu-repo doc not found: "${repoRelPath}" under ${root} (set LENS_EDU_REPO / check the checkout)`,
    );
  }
}

/** Minimal frontmatter split. Scalars become strings; an `author:` block of
 *  `- ` items becomes a JSON-encoded string array under `author`. */
export function splitFrontmatter(md: string): {
  frontmatter: Record<string, string>;
  body: string;
} {
  const m = md.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return { frontmatter: {}, body: md.trim() };
  const fm: Record<string, string> = {};
  const lines = m[1].split("\n");
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^([A-Za-z0-9_.-]+):\s*(.*)$/);
    if (!kv) continue;
    const [, key, rawVal] = kv;
    if (rawVal.trim() === "") {
      // possible list block
      const items: string[] = [];
      while (i + 1 < lines.length && /^\s*-\s+/.test(lines[i + 1])) {
        items.push(lines[++i].replace(/^\s*-\s+/, "").replace(/^["']|["']$/g, "").trim());
      }
      fm[key] = items.length ? JSON.stringify(items) : "";
    } else {
      fm[key] = rawVal.replace(/^["']|["']$/g, "").trim();
    }
  }
  return { frontmatter: fm, body: md.slice(m[0].length).trim() };
}

/** Tolerant author parsing — list-form arrives as a JSON-array string, scalar
 *  form as plain text. Never JSON.parse a scalar (it throws). */
export function parseFrontmatterAuthor(v?: string): string[] {
  if (!v || !v.trim()) return [];
  if (v.trim().startsWith("[")) {
    try { return JSON.parse(v); } catch { /* fall through to scalar */ }
  }
  return v.split(/,| and |;/).map((s) => s.replace(/^["']|["']$/g, "").trim()).filter(Boolean);
}
