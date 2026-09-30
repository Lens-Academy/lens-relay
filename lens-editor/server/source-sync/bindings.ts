import type { SyncBinding } from "./types";

export const BINDINGS_ENV = "SOURCE_SYNC_BINDINGS";
export const INTERVAL_ENV = "SOURCE_SYNC_INTERVAL_MINUTES";
const DEFAULT_INTERVAL_MINUTES = 10;
const MAX_INTERVAL_MINUTES = 24 * 60;

const KEYS = ["source", "target", "author", "title", "published", "sourceUrl"];

/** The known key a typo was probably meant as ("autor" -> "author"), by edit distance. */
function meant(key: string): string | undefined {
  const distance = (a: string, b: string) => {
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++)
      for (let j = 1; j <= b.length; j++)
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return d[a.length][b.length];
  };
  return KEYS.find((k) => distance(key.toLowerCase(), k.toLowerCase()) <= 2);
}

/** Why a target path cannot be written, or null. */
function targetProblem(target: string): string | null {
  const segments = target.split("/");
  if (segments.length < 2 || !target.endsWith(".md")) return `must be "<Folder>/…/articles/<file>.md"`;
  if (segments.some((s) => !s.trim() || s !== s.trim() || s === "." || s === ".." || s === ".md")) {
    return "has an empty, padded, '.' or '..' segment";
  }
  // Lens only reads a file as an article inside an `articles/` directory.
  const inFolder = segments.slice(1).join("/");
  if (!inFolder.startsWith("articles/") && !inFolder.includes("/articles/")) {
    return "must be inside an articles/ folder, or Lens will not read it as an article";
  }
  return null;
}

function realDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(`${value}T00:00:00Z`).toISOString().startsWith(value);
}

/**
 * Parse SOURCE_SYNC_BINDINGS: a JSON array of
 * `{ "source": "<link>", "target": "<Folder>/articles/<path>.md", "author": [...], ... }`.
 * Each entry stands alone: a malformed one is returned in `problems` (to be
 * reported on every run) and the others still sync. Only a value that is not
 * a JSON array at all throws.
 */
export function parseBindings(raw = process.env[BINDINGS_ENV]): { bindings: SyncBinding[]; problems: string[] } {
  if (!raw?.trim()) return { bindings: [], problems: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${BINDINGS_ENV} is not valid JSON: ${(err as Error).message}`);
  }
  if (!Array.isArray(parsed)) throw new Error(`${BINDINGS_ENV} must be a JSON array`);

  const bindings: SyncBinding[] = [];
  const problems: string[] = [];
  const targets = new Set<string>();
  parsed.forEach((entry, i) => {
    const where = `${BINDINGS_ENV}[${i}]`;
    const fail = (message: string) =>
      problems.push(`${where}${message.startsWith(".") ? "" : " "}${message}; this binding is not synced`);
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return fail("must be an object");
    const e = entry as Record<string, unknown>;

    const unknown = Object.keys(e).filter((k) => !KEYS.includes(k));
    if (unknown.length) {
      return fail(`has unknown key(s) ${unknown.map((k) => `"${k}"${meant(k) ? ` (did you mean "${meant(k)}"?)` : ""}`).join(", ")}`);
    }
    const str = (key: string) => (typeof e[key] === "string" && (e[key] as string).trim() ? (e[key] as string).trim() : undefined);
    const optional = ["title", "published", "sourceUrl"].find((k) => e[k] !== undefined && !str(k));
    if (optional) return fail(`.${optional} must be a non-empty string`);

    const source = str("source");
    if (!source) return fail(".source must be a non-empty string");
    const target = (str("target") ?? "").replace(/^\/+/, "");
    const problem = targetProblem(target);
    if (problem) return fail(`.target "${target}" ${problem}`);
    if (targets.has(target)) return fail(`.target "${target}" is bound twice`);
    const author = e.author;
    if (!Array.isArray(author) || !author.length || !author.every((a) => typeof a === "string" && a.trim())) {
      return fail(".author must be a non-empty list of names (Lens articles require one)");
    }
    const published = str("published");
    if (published && !realDate(published)) return fail(".published must be a real date, YYYY-MM-DD");

    targets.add(target);
    bindings.push({ source, target, author, title: str("title"), published, sourceUrl: str("sourceUrl") });
  });
  return { bindings, problems };
}

/** Minutes between sync runs: SOURCE_SYNC_INTERVAL_MINUTES, default 10, from 1 to 1440 (a day). */
export function intervalMs(raw = process.env[INTERVAL_ENV]): number {
  const minutes = raw?.trim() ? Number(raw) : DEFAULT_INTERVAL_MINUTES;
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > MAX_INTERVAL_MINUTES) {
    throw new Error(`${INTERVAL_ENV} must be a number of minutes from 1 to ${MAX_INTERVAL_MINUTES}`);
  }
  return minutes * 60_000;
}
