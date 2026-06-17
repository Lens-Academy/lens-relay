# Article-Scraper Eval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a hermetic eval that scores the deterministic `extractArticle` scraper against ~50 verified-good fixtures drawn from the Navigating Superintelligence course.

**Architecture:** Three phases — (1) a **resolver** that walks the course→article graph (from a local cache of relay docs) and emits a stratified manifest; (2) a **builder** that freezes each manifest entry into a hermetic fixture (rendered HTML + gold body + optional `.md` export + meta); (3) a **deterministic scorer** that re-runs `extractArticle` offline and compares output to gold. Pure logic (parsing, normalization, scoring) is unit-tested with realistic inline fixtures and zero network; network/relay live only in thin runner CLIs.

**Tech Stack:** TypeScript (ESM, run via `npx tsx`), Vitest, the existing `add-article` modules (`extractArticle`, `jaccard`, `fetch*`, `resolveFetchUrls`). No new runtime deps.

## Global Constraints

- Working dir for all commands: `lens-editor/`. Run tests with `npx vitest run <path>`.
- **Precondition:** run `npm install` in `lens-editor/` before any task. The repo's deps (notably `jsdom`, which `extract.ts` imports) may not be present in a fresh checkout; without it the Task 9 e2e (and the existing `extract.test.ts`) fail on `Failed to resolve import "jsdom"` — an environment error, not a code error. Tasks 1-8 don't import `extract`, so they pass regardless, but install up front.
- The **scorer** must perform **zero network I/O**. All fetching happens in the builder. Enforce by injecting `opts.fetchText` into `extractArticle` from frozen files; the stub throws on any unexpected URL.
- Reproduce the pipeline exactly: fetch via `resolveFetchUrls(adapterContext(source_url, "")) → fetchFirstHtml`; score via `extractArticle(html, resolved_fetch_url, { sourceUrl, fetchText })`.
- Gold bodies + the course graph are read from the local **`lens-edu-relay`** checkout (env `LENS_EDU_REPO`, default `/home/penguin/code/lens-edu-relay`), which mirrors the relay "Lens Edu" folder at its root — so corpus paths are **repo-root-relative** (`articles/foo.md`, `courses/…md`; **no** `Lens Edu/` prefix). Read-only: **NEVER** write or push to that repo (per AGENTS.md — relay-git-sync owns it). It may lag the live relay; refresh read-only with `git -C $LENS_EDU_REPO fetch && git -C $LENS_EDU_REPO checkout origin/staging` if current gold is needed.
- Never add test-only methods to production modules. The offline `fetchText` stub lives in eval/test utilities. `extract.ts` already exposes `opts.fetchText` — inject, don't modify it.
- Unit tests use **complete, realistic** fixture strings (real relay grammar / real adapter HTML shapes), never partial mocks. Mock only the network boundary (`fetchRenderedHtml`/`fetchFirstHtml`), never `extractArticle`.
- `--llm` scoring stage is **out of scope** for this plan (separate later plan).

Key existing signatures (verified):
- `extractArticle(html: string, url: string, opts?: { sourceUrl?: string; fetchText?: (u: string) => Promise<string> }): Promise<ExtractResult>` where `ExtractResult = { body: string; meta: ArticleMeta; siteName: string; via: string; linkedOut: boolean; assessment: Assessment }` and `ArticleMeta = { title: string; author: string[]; source_url: string; published: string; description: string }`. (`server/add-article/extract.ts`)
- `jaccard(a: string, b: string): number` (`server/add-article/confidence.ts`)
- `resolveFetchUrls(ctx): string[]`, `adapterContext(url, html)` (`server/add-article/adapters/index.ts`)
- `fetchFirstHtml(urls: string[]): Promise<{ html: string; url: string }>`, `fetchRenderedHtml(url): Promise<string>` (`server/add-article/fetch.ts`)

---

## Phase 1 — Resolver

### Task 1: Wikilink + segment parser

**Files:**
- Create: `server/add-article/eval/wikilink.ts`
- Test: `server/add-article/eval/wikilink.test.ts`

**Interfaces:**
- Produces: `parseSourceTargets(md: string): string[]` — every `source::` wikilink target in a doc, with embed `!` and `|alias` stripped, returned as the raw inner path (e.g. `../articles/foo`, `../Lenses/Bar`, `../video_transcripts/baz`). Order-preserving, de-duplicated.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from "vitest";
import { parseSourceTargets } from "./wikilink";

describe("parseSourceTargets", () => {
  it("extracts targets across heading levels, embeds, aliases, and spacing", () => {
    const md = `
# Module:  [[../modules/x]]
# Meeting: Introduction
# Learning Outcome:
source:: [[../Learning Outcomes/An Outcome]]
## Lens:
source:: ![[../Lenses/A Lens|A Lens]]
#### Article
source:: [[../articles/foo-bar]]
#### Video
source:: [[../video_transcripts/clip]]
`;
    expect(parseSourceTargets(md)).toEqual([
      "../Learning Outcomes/An Outcome",
      "../Lenses/A Lens",
      "../articles/foo-bar",
      "../video_transcripts/clip",
    ]);
  });

  it("ignores # Module: links that are NOT on a source:: line but keeps de-dup", () => {
    const md = `source:: [[../articles/dup]]\nsource:: ![[../articles/dup]]`;
    expect(parseSourceTargets(md)).toEqual(["../articles/dup"]);
  });

  it("captures a source:: preceded by inline CriticMarkup on the same line", () => {
    const md = `--}source:: ![[../Lenses/Y]]`;
    expect(parseSourceTargets(md)).toEqual(["../Lenses/Y"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/add-article/eval/wikilink.test.ts`
Expected: FAIL ("parseSourceTargets is not a function").

- [ ] **Step 3: Write minimal implementation**

```typescript
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
```

Note: the `# Module:` link in the course doc is NOT on a `source::` line — it is `# Module: [[..]]`. Handle that separately in Task 2 (course parser), since the course uses inline module links while modules/LOs/lenses use `source::`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/add-article/eval/wikilink.test.ts`
Expected: PASS (both tests).

- [ ] **Step 5: Add a course-module parser to the same file**

Append to `wikilink.ts`:

```typescript
/** Module wikilinks from a course doc: `# Module: [[../modules/x]]` lines
 *  (variable spacing). Ignores `# Meeting:` and other headings. */
export function parseModuleLinks(md: string): string[] {
  const out: string[] = [];
  const re = /^#\s*Module:\s*!?\[\[([^\]]+)\]\]/gm;
  for (const m of md.matchAll(re)) out.push(m[1].split("|")[0].trim());
  return out;
}
```

- [ ] **Step 6: Test the module parser**

Append to `wikilink.test.ts`:

```typescript
import { parseModuleLinks } from "./wikilink";

describe("parseModuleLinks", () => {
  it("reads # Module lines with variable spacing, ignores # Meeting", () => {
    const md = `# Module: [[../modules/a]]\n# Meeting: Intro\n# Module:  [[../modules/b]]`;
    expect(parseModuleLinks(md)).toEqual(["../modules/a", "../modules/b"]);
  });
});
```

- [ ] **Step 7: Run and commit**

Run: `npx vitest run server/add-article/eval/wikilink.test.ts` → PASS.
```bash
jj describe -m "feat(eval): relay wikilink + module-link parser"
```
(Working copy auto-snapshots; one change per task. Start the next task with `jj new`.)

---

### Task 2: Path resolution for relative wikilinks

**Files:**
- Modify: `server/add-article/eval/wikilink.ts`
- Test: `server/add-article/eval/wikilink.test.ts`

**Interfaces:**
- Produces: `resolveRelayPath(fromRelayPath: string, target: string): string` — resolves a `../`-relative wikilink target (no extension) against the folder of the referring doc, returning a repo-relative path **with `.md`** (e.g. `resolveRelayPath("modules/x.md", "../articles/foo")` → `"articles/foo.md"`). Prefix-agnostic (pure relative resolution).

- [ ] **Step 1: Write the failing test**

```typescript
import { resolveRelayPath } from "./wikilink";

describe("resolveRelayPath", () => {
  it("resolves ../ targets against the referring doc's folder and adds .md", () => {
    expect(
      resolveRelayPath("modules/what-even-is-ai.md", "../articles/foo-bar"),
    ).toBe("articles/foo-bar.md");
    expect(
      resolveRelayPath("Learning Outcomes/An Outcome.md", "../Lenses/A Lens"),
    ).toBe("Lenses/A Lens.md");
  });
  it("does not double-append .md", () => {
    expect(resolveRelayPath("modules/x.md", "../articles/y.md")).toBe(
      "articles/y.md",
    );
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run server/add-article/eval/wikilink.test.ts` → FAIL.

- [ ] **Step 3: Implement**

```typescript
import * as path from "node:path";

export function resolveRelayPath(fromRelayPath: string, target: string): string {
  const dir = path.posix.dirname(fromRelayPath);
  const joined = path.posix.normalize(path.posix.join(dir, target));
  return joined.endsWith(".md") ? joined : `${joined}.md`;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run server/add-article/eval/wikilink.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
jj new && jj describe -m "feat(eval): resolve relative relay wikilink paths"
```

---

### Task 3: Edu-repo doc reader

**Files:**
- Create: `server/add-article/eval/edu-repo.ts`
- Test: `server/add-article/eval/edu-repo.test.ts`

**Interfaces:**
- Produces: `eduRepoRoot(): string` — returns `process.env.LENS_EDU_REPO || "/home/penguin/code/lens-edu-relay"`.
- Produces: `readEduDoc(repoRelPath: string, root?: string): Promise<string>` — reads `<root>/<repoRelPath>` from the lens-edu-relay checkout; throws a clear error naming the missing path. `root` defaults to `eduRepoRoot()`.
- Produces: `splitFrontmatter(md: string): { frontmatter: Record<string,string>; body: string }` — splits a leading `---`-delimited YAML block from the body; tolerant minimal parse (string scalars + simple `- ` lists for `author`).
- Produces: `parseFrontmatterAuthor(v?: string): string[]` — turns the raw `author` frontmatter value into a string array, tolerant of BOTH forms: a JSON-array string (from the list form, e.g. `["Jane Doe"]`) AND a plain scalar (e.g. `Scott Alexander`, or `Luke Muehlhauser, Anna Salamon`). Centralizes author parsing so the builder never calls `JSON.parse` on a scalar (which throws).

- [ ] **Step 1: Write the failing test** (uses a temp dir as a stand-in repo root — real file I/O, not mocked)

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { readEduDoc, splitFrontmatter, parseFrontmatterAuthor } from "./edu-repo";

let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "edu-")); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

describe("readEduDoc", () => {
  it("reads a doc by repo-relative path from the repo root", async () => {
    await fs.mkdir(path.join(dir, "articles"), { recursive: true });
    await fs.writeFile(path.join(dir, "articles/foo.md"), "hello");
    expect(await readEduDoc("articles/foo.md", dir)).toBe("hello");
  });
  it("throws naming the missing path", async () => {
    await expect(readEduDoc("articles/missing.md", dir)).rejects.toThrow(/missing\.md/);
  });
});

describe("splitFrontmatter", () => {
  it("splits YAML frontmatter and parses author list + scalars", () => {
    const md = `---\ntitle: "A Title"\nsource_url: https://x.com\nauthor:\n  - "Jane Doe"\n  - "John Roe"\npublished: 2021-04-28\n---\n\nBody text here.`;
    const { frontmatter, body } = splitFrontmatter(md);
    expect(frontmatter.title).toBe("A Title");
    expect(frontmatter.source_url).toBe("https://x.com");
    expect(JSON.parse(frontmatter.author)).toEqual(["Jane Doe", "John Roe"]);
    expect(frontmatter.published).toBe("2021-04-28");
    expect(body).toBe("Body text here.");
  });
});

describe("parseFrontmatterAuthor", () => {
  it("handles list-form (JSON array string), scalar, comma scalar, and empty", () => {
    expect(parseFrontmatterAuthor(JSON.stringify(["Jane Doe"]))).toEqual(["Jane Doe"]);
    expect(parseFrontmatterAuthor("Scott Alexander")).toEqual(["Scott Alexander"]);
    expect(parseFrontmatterAuthor("Luke Muehlhauser, Anna Salamon")).toEqual([
      "Luke Muehlhauser",
      "Anna Salamon",
    ]);
    expect(parseFrontmatterAuthor(undefined)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run server/add-article/eval/edu-repo.test.ts` → FAIL.

- [ ] **Step 3: Implement**

```typescript
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
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run server/add-article/eval/edu-repo.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
jj new && jj describe -m "feat(eval): edu-repo doc reader + frontmatter split"
```

---

### Task 4: Course-graph traversal

**Files:**
- Create: `server/add-article/eval/resolve-course.ts`
- Test: `server/add-article/eval/resolve-course.test.ts`

**Interfaces:**
- Consumes: `parseModuleLinks`, `parseSourceTargets`, `resolveRelayPath` (Task 1-2), `readEduDoc` (Task 3).
- Produces: `resolveCourseArticles(coursePath: string, read: (p: string) => Promise<string>): Promise<{ articles: string[]; report: TraversalReport }>` where `articles` is the de-duplicated list of repo-relative `articles/*.md` paths reachable from the course, and `TraversalReport = { perModule: { module: string; articleCount: number }[]; visitedLenses: number; skippedNonArticle: string[] }`. `read` is injected so the test passes an in-memory map (no disk).

- [ ] **Step 1: Write the failing test** (complete, realistic graph — no partial mocks)

```typescript
import { describe, it, expect } from "vitest";
import { resolveCourseArticles } from "./resolve-course";

const DOCS: Record<string, string> = {
  "courses/Navigating Superintelligence.md":
    `# Module: [[../modules/m1]]\n# Meeting: Intro\n# Module:  [[../modules/m2]]`,
  // m1: a direct Lens segment AND a Learning Outcome
  "modules/m1.md":
    `# Lens:\nsource:: [[../Lenses/Direct Lens]]\n# Learning Outcome:\nsource:: [[../Learning Outcomes/LO1]]`,
  // m2: a Learning Outcome only
  "modules/m2.md":
    `# Learning Outcome:\nsource:: ![[../Learning Outcomes/LO2|LO2]]`,
  "Learning Outcomes/LO1.md": `## Lens:\nsource:: ![[../Lenses/Lens A|Lens A]]`,
  "Learning Outcomes/LO2.md": `## Lens:\nsource:: [[../Lenses/Lens B]]`,
  // Direct Lens has 2 article segments
  "Lenses/Direct Lens.md":
    `#### Article\nsource:: [[../articles/aaa]]\n#### Article\nsource:: [[../articles/bbb]]`,
  // Lens A is video-only → no article
  "Lenses/Lens A.md": `#### Video\nsource:: [[../video_transcripts/clip]]`,
  // Lens B has one article
  "Lenses/Lens B.md": `#### Article\nsource:: [[../articles/ccc]]`,
};
const read = (p: string) =>
  p in DOCS ? Promise.resolve(DOCS[p]) : Promise.reject(new Error(`missing ${p}`));

describe("resolveCourseArticles", () => {
  it("collects unique articles across module→LO→lens and module→lens edges", async () => {
    const { articles, report } = await resolveCourseArticles(
      "courses/Navigating Superintelligence.md",
      read,
    );
    expect(articles.sort()).toEqual([
      "articles/aaa.md",
      "articles/bbb.md",
      "articles/ccc.md",
    ]);
    // Lens A had no article → recorded, not crashed
    expect(report.skippedNonArticle).toContain("../video_transcripts/clip");
    expect(report.perModule.find((m) => m.module.endsWith("m1.md"))?.articleCount).toBe(2);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run server/add-article/eval/resolve-course.test.ts` → FAIL.

- [ ] **Step 3: Implement**

```typescript
import { parseModuleLinks, parseSourceTargets, resolveRelayPath } from "./wikilink";

export interface TraversalReport {
  perModule: { module: string; articleCount: number }[];
  visitedLenses: number;
  skippedNonArticle: string[];
}

// Repo-relative paths have no leading slash (e.g. "articles/x.md"), so anchor
// the segment match with (^|/) — a bare `.includes("/articles/")` would miss them.
const inFolder = (p: string, folder: string) =>
  new RegExp(`(^|/)${folder}/`).test(p);
const isArticle = (p: string) => inFolder(p, "articles");

export async function resolveCourseArticles(
  coursePath: string,
  read: (p: string) => Promise<string>,
): Promise<{ articles: string[]; report: TraversalReport }> {
  const articles = new Set<string>();
  const skipped = new Set<string>();
  const visitedLenses = new Set<string>();
  const perModule: { module: string; articleCount: number }[] = [];

  const courseMd = await read(coursePath);
  const modulePaths = parseModuleLinks(courseMd).map((t) =>
    resolveRelayPath(coursePath, t),
  );

  for (const modulePath of modulePaths) {
    const before = articles.size;
    let moduleMd: string;
    try {
      moduleMd = await read(modulePath);
    } catch {
      perModule.push({ module: modulePath, articleCount: 0 });
      continue;
    }
    // A module references Lenses directly and/or Learning Outcomes.
    const targets = parseSourceTargets(moduleMd).map((t) =>
      resolveRelayPath(modulePath, t),
    );
    for (const t of targets) {
      if (inFolder(t, "Lenses")) {
        await collectLens(t);
      } else if (inFolder(t, "Learning Outcomes")) {
        let loMd: string;
        try { loMd = await read(t); } catch { continue; }
        const lensTargets = parseSourceTargets(loMd)
          .map((x) => resolveRelayPath(t, x))
          .filter((x) => inFolder(x, "Lenses"));
        for (const lp of lensTargets) await collectLens(lp);
      }
    }
    perModule.push({ module: modulePath, articleCount: articles.size - before });
  }

  async function collectLens(lensPath: string): Promise<void> {
    if (visitedLenses.has(lensPath)) return;
    visitedLenses.add(lensPath);
    let lensMd: string;
    try { lensMd = await read(lensPath); } catch { return; }
    for (const target of parseSourceTargets(lensMd)) {
      const resolved = resolveRelayPath(lensPath, target);
      if (isArticle(resolved)) articles.add(resolved);
      else skipped.add(target);
    }
  }

  return {
    articles: [...articles],
    report: { perModule, visitedLenses: visitedLenses.size, skippedNonArticle: [...skipped] },
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run server/add-article/eval/resolve-course.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
jj new && jj describe -m "feat(eval): course-graph traversal to article set"
```

---

### Task 5: Stratify + manifest runner

**Files:**
- Create: `scripts/build-eval-manifest.ts`
- Create: `server/add-article/eval/manifest.ts`
- Test: `server/add-article/eval/manifest.test.ts`

**Interfaces:**
- Consumes: `resolveCourseArticles` (Task 4), `readEduDoc`/`splitFrontmatter` (Task 3), `adapterContext`/`resolveFetchUrls` (`server/add-article/adapters`).
- Produces: `classifyVia(sourceUrl: string): string` → expected adapter id (`forum-adapter`/`wikipedia`/`ai-safety-atlas`/`arxiv`/`generic`); `stratifiedSelect(entries: ManifestEntry[], target: number): ManifestEntry[]`; `ManifestEntry` type (the schema from the spec). The runner script writes `server/add-article/eval/fixtures.manifest.json`.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from "vitest";
import { classifyVia, stratifiedSelect, type ManifestEntry } from "./manifest";

describe("classifyVia", () => {
  it("maps hosts to expected extraction path", () => {
    expect(classifyVia("https://www.lesswrong.com/posts/x")).toBe("forum-adapter");
    expect(classifyVia("https://en.wikipedia.org/wiki/X")).toBe("wikipedia");
    expect(classifyVia("https://ai-safety-atlas.com/chapters/v1/x")).toBe("ai-safety-atlas");
    expect(classifyVia("https://arxiv.org/abs/1805.00899")).toBe("arxiv");
    expect(classifyVia("https://cold-takes.com/x")).toBe("generic");
  });
});

describe("stratifiedSelect", () => {
  it("spreads selection across vias and caps at target", () => {
    const mk = (i: number, via: string): ManifestEntry => ({
      slug: `s${i}`, relay_path: `p${i}`, source_url: `u${i}`, resolved_fetch_url: `u${i}`,
      host: "h", expected_via: via, needs_body_markdown: false, status: "ok",
    });
    const entries = [
      ...Array.from({ length: 10 }, (_, i) => mk(i, "forum-adapter")),
      ...Array.from({ length: 2 }, (_, i) => mk(100 + i, "wikipedia")),
    ];
    const picked = stratifiedSelect(entries, 6);
    expect(picked.length).toBe(6);
    // both wikipedia entries kept (scarce class not starved)
    expect(picked.filter((e) => e.expected_via === "wikipedia").length).toBe(2);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run server/add-article/eval/manifest.test.ts` → FAIL.

- [ ] **Step 3: Implement `manifest.ts`**

```typescript
export interface ManifestEntry {
  slug: string;
  relay_path: string;
  source_url: string;
  resolved_fetch_url: string;
  host: string;
  expected_via: string;
  needs_body_markdown: boolean;
  status: "ok" | "skipped:404" | "skipped:blocked" | "excluded:link-out";
}

export function classifyVia(sourceUrl: string): string {
  let host = "";
  try { host = new URL(sourceUrl).hostname.replace(/^www\./, "").toLowerCase(); } catch { return "generic"; }
  if (/(^|\.)(lesswrong\.com|alignmentforum\.org|greaterwrong\.com)$/.test(host) ||
      host === "forum.effectivealtruism.org") return "forum-adapter";
  if (/(^|\.)wikipedia\.org$/.test(host)) return "wikipedia";
  if (host === "ai-safety-atlas.com") return "ai-safety-atlas";
  if (host === "arxiv.org" || host.endsWith("ar5iv.org") || host === "ar5iv.labs.arxiv.org") return "arxiv";
  return "generic";
}

/** Round-robin by `expected_via` so scarce classes aren't starved. */
export function stratifiedSelect(entries: ManifestEntry[], target: number): ManifestEntry[] {
  const byVia = new Map<string, ManifestEntry[]>();
  for (const e of entries) {
    let arr = byVia.get(e.expected_via);
    if (!arr) byVia.set(e.expected_via, (arr = []));
    arr.push(e);
  }
  const queues = [...byVia.values()];
  const out: ManifestEntry[] = [];
  let progress = true;
  while (out.length < target && progress) {
    progress = false;
    for (const q of queues) {
      if (out.length >= target) break;
      const next = q.shift();
      if (next) { out.push(next); progress = true; }
    }
  }
  return out;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run server/add-article/eval/manifest.test.ts` → PASS.

- [ ] **Step 5: Write the runner CLI `scripts/build-eval-manifest.ts`** (no unit test — thin orchestration; exercised manually)

```typescript
/**
 * Resolve the Navigating Superintelligence course → article pool → stratified
 * manifest. Reads the course graph + article frontmatter from the local
 * lens-edu-relay checkout ($LENS_EDU_REPO). Read-only; never writes to it.
 * Usage: npx tsx scripts/build-eval-manifest.ts [--target 50]
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { resolveCourseArticles } from "../server/add-article/eval/resolve-course";
import { readEduDoc, splitFrontmatter } from "../server/add-article/eval/edu-repo";
import { classifyVia, stratifiedSelect, type ManifestEntry } from "../server/add-article/eval/manifest";
import { adapterContext, resolveFetchUrls } from "../server/add-article/adapters";

const COURSE = "courses/Navigating Superintelligence.md";
const OUT = path.join(__dirname, "../server/add-article/eval/fixtures.manifest.json");

function slugFor(relayPath: string): string {
  return path.posix.basename(relayPath).replace(/\.md$/i, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

async function main() {
  const target = Number(process.argv[process.argv.indexOf("--target") + 1]) || 50;
  const { articles, report } = await resolveCourseArticles(COURSE, (p) => readEduDoc(p));
  console.log(`Resolved ${articles.length} course articles.`);
  for (const m of report.perModule) console.log(`  ${m.module}: ${m.articleCount}`);

  const entries: ManifestEntry[] = [];
  for (const relay_path of articles) {
    const { frontmatter } = splitFrontmatter(await readEduDoc(relay_path));
    const source_url = frontmatter.source_url;
    if (!source_url) { console.warn(`no source_url: ${relay_path}`); continue; }
    const via = classifyVia(source_url);
    const resolved = resolveFetchUrls(adapterContext(source_url, ""));
    entries.push({
      slug: slugFor(relay_path), relay_path, source_url,
      resolved_fetch_url: resolved[0] ?? source_url,
      host: new URL(source_url).hostname, expected_via: via,
      needs_body_markdown: via === "ai-safety-atlas", status: "ok",
    });
  }
  const picked = stratifiedSelect(entries, target);
  await fs.writeFile(OUT, JSON.stringify(picked, null, 2) + "\n");
  console.log(`Wrote ${picked.length} entries → ${OUT}`);
}
main();
```

- [ ] **Step 6: Commit**

```bash
jj new && jj describe -m "feat(eval): stratified manifest builder + runner"
```

- [ ] **Step 7: PHASE-1 SIGN-OFF GATE**

Ensure `LENS_EDU_REPO` points at the local lens-edu-relay checkout (optionally `git fetch && git checkout origin/staging` for current gold — read-only), run `npx tsx scripts/build-eval-manifest.ts`, and present the generated `fixtures.manifest.json` to the user for sign-off **before** building fixtures. Explicitly flag the known coverage gaps in the summary (verified against the current corpus): **no `ai-safety-atlas.com` article exists**, so the `bodyMarkdown`/`needs_body_markdown` path is exercised only by unit tests, never a real fixture; and **arXiv is thin (~1 article)**, so that stratum is small. These are documented, not papered over.

---

## Phase 2 — Builder

### Task 6: Fixture I/O helpers

**Files:**
- Create: `server/add-article/eval/fixture-io.ts`
- Test: `server/add-article/eval/fixture-io.test.ts`

**Interfaces:**
- Produces: `fixtureDir(slug: string): string`; `writeFixture(slug, files: { renderedSourceHtml: string; expectedMd: string; meta: object; bodyMarkdown?: string })`; `readFixture(slug): Promise<{ html: string; expectedMd: string; meta: ManifestEntry & { title: string; author: string[]; published: string; reviewed: boolean; reviewed_note?: string }; bodyMarkdown?: string }>`; `makeOfflineFetchText(expectedUrl: string, bodyMarkdown: string): (u: string) => Promise<string>`. Gzip any html >1MB transparently (`renderedSource.html.gz`).

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { writeFixture, readFixture, makeOfflineFetchText } from "./fixture-io";

let root: string;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), "fx-")); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

describe("fixture round-trip", () => {
  it("writes and reads back html, body, meta, and optional bodyMarkdown", async () => {
    await writeFixture("foo", {
      renderedSourceHtml: "<html>hi</html>",
      expectedMd: "Gold body.",
      meta: { slug: "foo", title: "T", author: ["A"], published: "2021-01-01" },
      bodyMarkdown: "# native md",
    }, root);
    const fx = await readFixture("foo", root);
    expect(fx.html).toBe("<html>hi</html>");
    expect(fx.expectedMd).toBe("Gold body.");
    expect(fx.meta.title).toBe("T");
    expect(fx.bodyMarkdown).toBe("# native md");
  });
});

describe("makeOfflineFetchText", () => {
  it("returns the frozen md for the expected url and throws otherwise", async () => {
    const f = makeOfflineFetchText("https://x.com/a.md", "native");
    expect(await f("https://x.com/a.md")).toBe("native");
    await expect(f("https://other.com/y")).rejects.toThrow(/unexpected url/i);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run server/add-article/eval/fixture-io.test.ts` → FAIL.

- [ ] **Step 3: Implement** (gzip via `node:zlib` promisified; threshold 1MB)

```typescript
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { promisify } from "node:util";

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);
const GZIP_THRESHOLD = 1024 * 1024;
const FIXTURES_ROOT = path.join(__dirname, "fixtures");

export function fixtureDir(slug: string, root: string = FIXTURES_ROOT): string {
  return path.join(root, slug);
}

export async function writeFixture(
  slug: string,
  files: { renderedSourceHtml: string; expectedMd: string; meta: object; bodyMarkdown?: string },
  root: string = FIXTURES_ROOT,
): Promise<void> {
  const dir = fixtureDir(slug, root);
  await fs.mkdir(dir, { recursive: true });
  const htmlBuf = Buffer.from(files.renderedSourceHtml, "utf-8");
  if (htmlBuf.byteLength > GZIP_THRESHOLD) {
    await fs.writeFile(path.join(dir, "renderedSource.html.gz"), await gzip(htmlBuf));
  } else {
    await fs.writeFile(path.join(dir, "renderedSource.html"), htmlBuf);
  }
  await fs.writeFile(path.join(dir, "expected.md"), files.expectedMd);
  await fs.writeFile(path.join(dir, "meta.json"), JSON.stringify(files.meta, null, 2));
  if (files.bodyMarkdown != null) {
    await fs.writeFile(path.join(dir, "bodyMarkdown.txt"), files.bodyMarkdown);
  }
}

async function readMaybeGz(dir: string): Promise<string> {
  try { return await fs.readFile(path.join(dir, "renderedSource.html"), "utf-8"); }
  catch { return (await gunzip(await fs.readFile(path.join(dir, "renderedSource.html.gz")))).toString("utf-8"); }
}

export async function readFixture(slug: string, root: string = FIXTURES_ROOT) {
  const dir = fixtureDir(slug, root);
  const [html, expectedMd, metaRaw] = await Promise.all([
    readMaybeGz(dir),
    fs.readFile(path.join(dir, "expected.md"), "utf-8"),
    fs.readFile(path.join(dir, "meta.json"), "utf-8"),
  ]);
  let bodyMarkdown: string | undefined;
  try { bodyMarkdown = await fs.readFile(path.join(dir, "bodyMarkdown.txt"), "utf-8"); } catch { /* none */ }
  return { html, expectedMd, meta: JSON.parse(metaRaw), bodyMarkdown };
}

export function makeOfflineFetchText(expectedUrl: string, bodyMarkdown: string) {
  return async (u: string): Promise<string> => {
    if (u === expectedUrl) return bodyMarkdown;
    throw new Error(`offline fetchText: unexpected url ${u}`);
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run server/add-article/eval/fixture-io.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
jj new && jj describe -m "feat(eval): fixture I/O (gzip, round-trip, offline fetchText)"
```

---

### Task 7: Builder runner

**Files:**
- Create: `scripts/build-eval-fixtures.ts`
- Create: `server/add-article/eval/atlas-md-url.ts`
- Create: `server/add-article/eval/criticmarkup.ts`
- Test: `server/add-article/eval/atlas-md-url.test.ts`
- Test: `server/add-article/eval/criticmarkup.test.ts`

**Interfaces:**
- Consumes: `writeFixture`/`readFixture` (Task 6), `readEduDoc`/`splitFrontmatter`/`parseFrontmatterAuthor` (Task 3), `resolveFetchUrls`/`adapterContext` + `fetchFirstHtml`/`fetchRenderedHtml`.
- Produces: `atlasMarkdownUrl(pageUrl: string): string` — replicates the Atlas adapter's `bodyMarkdownUrl` derivation so the builder can freeze the `.md` export (`<url stripped of #?/>` + `.md`).
- Produces: `hasCriticMarkup(md: string): boolean` — detects any CriticMarkup form (`{>>..<<}`/`{++ ++}`/`{-- --}`/`{~~ ~~}`). Used **only** to flag dirty gold for curation; nothing is ever stripped, and the scorer never imports it.

- [ ] **Step 1: Write the failing test for the only non-trivial pure bit**

```typescript
import { describe, it, expect } from "vitest";
import { atlasMarkdownUrl } from "./atlas-md-url";

describe("atlasMarkdownUrl", () => {
  it("mirrors the adapter: strip query/hash/trailing slash, append .md", () => {
    expect(atlasMarkdownUrl("https://ai-safety-atlas.com/chapters/v1/x/")).toBe(
      "https://ai-safety-atlas.com/chapters/v1/x.md",
    );
    expect(atlasMarkdownUrl("https://ai-safety-atlas.com/chapters/v1/x?a=1#h")).toBe(
      "https://ai-safety-atlas.com/chapters/v1/x.md",
    );
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run server/add-article/eval/atlas-md-url.test.ts` → FAIL.

- [ ] **Step 3: Implement** (must match `adapters/ai-safety-atlas.ts`)

```typescript
/** Mirror the Atlas adapter's bodyMarkdownUrl derivation (keep in sync). */
export function atlasMarkdownUrl(pageUrl: string): string {
  return pageUrl.replace(/[#?].*$/, "").replace(/\/$/, "") + ".md";
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run server/add-article/eval/atlas-md-url.test.ts` → PASS.

- [ ] **Step 4b: CriticMarkup detector (flag dirty gold — never strip)**

The gold is compared raw; we only *detect* CriticMarkup so the builder can flag
a fixture's gold as needing curation. The scorer never imports this. Test:

```typescript
import { describe, it, expect } from "vitest";
import { hasCriticMarkup } from "./criticmarkup";

describe("hasCriticMarkup", () => {
  it("detects every CriticMarkup form, ignores plain text", () => {
    expect(hasCriticMarkup("x {>>note<<}")).toBe(true);
    expect(hasCriticMarkup("x {++ins++}")).toBe(true);
    expect(hasCriticMarkup("x {--del--}")).toBe(true);
    expect(hasCriticMarkup("x {~~a~>b~~}")).toBe(true);
    expect(hasCriticMarkup("just prose, no markup")).toBe(false);
  });
});
```

Implement `criticmarkup.ts`:

```typescript
/** Detect CriticMarkup so the builder can flag dirty gold for curation.
 *  Nothing is ever stripped — the eval compares gold to output as-is. */
export function hasCriticMarkup(md: string): boolean {
  return /\{>>[\s\S]*?<<\}|\{\+\+[\s\S]*?\+\+\}|\{--[\s\S]*?--\}|\{~~[\s\S]*?~>[\s\S]*?~~\}/.test(md);
}
```

Run: `npx vitest run server/add-article/eval/criticmarkup.test.ts` → PASS.

- [ ] **Step 5: Write the runner `scripts/build-eval-fixtures.ts`** (live network — run manually, not in CI)

```typescript
/**
 * Freeze each manifest entry into a hermetic fixture. Live network + relay
 * cache. Usage: npx tsx scripts/build-eval-fixtures.ts [--only <slug>]
 */
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { readEduDoc, splitFrontmatter, parseFrontmatterAuthor } from "../server/add-article/eval/edu-repo";
import { writeFixture, readFixture } from "../server/add-article/eval/fixture-io";
import { hasCriticMarkup } from "../server/add-article/eval/criticmarkup";
import { atlasMarkdownUrl } from "../server/add-article/eval/atlas-md-url";
import { fetchFirstHtml, fetchRenderedHtml, fetchRawHtml } from "../server/add-article/fetch";
import { resolveFetchUrls, adapterContext } from "../server/add-article/adapters";
import type { ManifestEntry } from "../server/add-article/eval/manifest";

const MANIFEST = path.join(__dirname, "../server/add-article/eval/fixtures.manifest.json");

async function build(entry: ManifestEntry) {
  const { frontmatter, body } = splitFrontmatter(await readEduDoc(entry.relay_path));
  // Gold = relay body verbatim (no stripping — the scorer compares as-is). We
  // only flag dirty gold (leftover editorial markup) so it gets curated during
  // review, not silently trusted.
  const expectedMd = body;
  const dirtyGold = hasCriticMarkup(expectedMd);
  // Mirror pipeline fetch: resolve redirects, then take the first that works.
  const urls = resolveFetchUrls(adapterContext(entry.source_url, ""));
  let html: string, used: string;
  try {
    ({ html, url: used } = await fetchFirstHtml(urls));
  } catch {
    html = await fetchRenderedHtml(entry.source_url); used = entry.source_url;
  }
  let bodyMarkdown: string | undefined;
  if (entry.needs_body_markdown) {
    bodyMarkdown = await fetchRawHtml(atlasMarkdownUrl(used)); // .md export
  }
  // Preserve a prior human review unless the gold body actually changed.
  let reviewed = false;
  try {
    const prev = await readFixture(entry.slug);
    if (prev.expectedMd === expectedMd) reviewed = prev.meta.reviewed ?? false;
  } catch { /* new fixture — stays unreviewed */ }
  await writeFixture(entry.slug, {
    renderedSourceHtml: html, expectedMd, bodyMarkdown,
    meta: {
      ...entry, resolved_fetch_url: used,
      title: frontmatter.title ?? "",
      author: parseFrontmatterAuthor(frontmatter.author),
      published: frontmatter.published ?? "",
      reviewed,
      ...(dirtyGold ? { reviewed_note: "gold contains editorial markup — clean to website-identical" } : {}),
    },
  });
  console.log(`✓ ${entry.slug} (${html.length} bytes${bodyMarkdown ? " + md" : ""})${reviewed ? " [reviewed]" : dirtyGold ? " [dirty-gold]" : ""}`);
}

async function main() {
  const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1] : null;
  const manifest: ManifestEntry[] = JSON.parse(await fs.readFile(MANIFEST, "utf-8"));
  for (const e of manifest.filter((x) => x.status === "ok" && (!only || x.slug === only))) {
    try { await build(e); }
    catch (err) { console.error(`✗ ${e.slug}: ${err}`); }
  }
}
main();
```

- [ ] **Step 6: Commit**

```bash
jj new && jj describe -m "feat(eval): fixture builder runner + Atlas md-url helper"
```

---

## Phase 3 — Deterministic scorer

### Task 8: Scoring metrics

**Files:**
- Create: `server/add-article/eval/score.ts`
- Test: `server/add-article/eval/score.test.ts`

**Interfaces:**
- Consumes: `jaccard` (`server/add-article/confidence`).
- Produces: `scoreBody(output: string, gold: string): { recall: number; precision: number; jaccard: number }` (recall/precision over **raw** line-shingles — trimmed only for line tokenization, nothing masked); `structureCounts(md: string): { headings: number; footnoteRefs: number; footnoteDefs: number; tables: number; code: number; math: number; images: number; links: number }`. No normalization module: the eval compares as-is (see Spec → "No normalization that masks differences").

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from "vitest";
import { scoreBody, structureCounts } from "./score";

describe("scoreBody", () => {
  it("recall=1 when output covers all gold lines; precision<1 when output adds lines", () => {
    const gold = "Line one.\nLine two.\nLine three.";
    const output = "Line one.\nLine two.\nLine three.\nExtra added line.";
    const s = scoreBody(output, gold);
    expect(s.recall).toBeCloseTo(1, 5);
    expect(s.precision).toBeLessThan(1);
  });
  it("recall<1 when output drops a gold line", () => {
    const s = scoreBody("Line one.\nLine three.", "Line one.\nLine two.\nLine three.");
    expect(s.recall).toBeLessThan(1);
  });
});

describe("structureCounts", () => {
  it("counts headings, footnotes, code, math, images", () => {
    const md = "## H\n\ntext[^1]\n\n[^1]: def\n\n```\ncode\n```\n\n$$x$$\n\n![a](u)";
    const c = structureCounts(md);
    expect(c.headings).toBe(1);
    expect(c.footnoteRefs).toBe(1);
    expect(c.footnoteDefs).toBe(1);
    expect(c.code).toBe(1);
    expect(c.math).toBe(1);
    expect(c.images).toBe(1);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run server/add-article/eval/score.test.ts` → FAIL.

- [ ] **Step 3: Implement**

```typescript
import { jaccard } from "../confidence";

function shingles(md: string): Set<string> {
  // Trim only for line tokenization; no content is masked (raw compare).
  return new Set(
    md.split("\n").map((l) => l.trim()).filter((l) => l.length >= 12),
  );
}

export function scoreBody(output: string, gold: string): { recall: number; precision: number; jaccard: number } {
  const o = shingles(output), g = shingles(gold);
  const inBoth = (a: Set<string>, b: Set<string>) => [...a].filter((x) => b.has(x)).length;
  const recall = g.size ? inBoth(g, o) / g.size : 1;
  const precision = o.size ? inBoth(o, g) / o.size : 1;
  return { recall, precision, jaccard: jaccard(output, gold) };
}

export function structureCounts(md: string) {
  const count = (re: RegExp) => (md.match(re) || []).length;
  return {
    headings: count(/^#{1,6}\s/gm),
    footnoteRefs: count(/\[\^[^\]]+\](?!:)/g),
    footnoteDefs: count(/^\[\^[^\]]+\]:/gm),
    tables: count(/^\|.+\|$/gm),
    code: count(/^```/gm) / 2 | 0,
    math: count(/\$\$[^$]+\$\$/g) + count(/(?<!\$)\$(?!\$)[^$\n]+\$/g),
    images: count(/!\[[^\]]*\]\([^)]*\)/g),
    links: count(/(?<!!)\[[^\]]*\]\([^)]*\)/g),
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run server/add-article/eval/score.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
jj new && jj describe -m "feat(eval): body recall/precision + structure-count metrics"
```

---

### Task 9: Scorer runner + end-to-end fixture test

**Files:**
- Create: `scripts/eval-fixtures.ts`
- Test: `server/add-article/eval/scorer.e2e.test.ts`

**Interfaces:**
- Consumes: `readFixture`/`makeOfflineFetchText` (Task 6), `scoreBody`/`structureCounts` (Task 8), `extractArticle` (`server/add-article/extract`).
- Produces: `scoreFixture(slug, root?): Promise<FixtureScore>` (re-runs `extractArticle` offline, compares to gold) — exported from `scripts/eval-fixtures.ts` for the e2e test; the script's `main()` iterates all fixtures and prints the report.

- [ ] **Step 1: Write the failing e2e test** (writes a REAL fixture, runs the REAL `extractArticle` — no mocking of the unit under test)

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { writeFixture } from "../server/add-article/eval/fixture-io";
import { scoreFixture } from "../scripts/eval-fixtures";

let root: string;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), "score-")); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

describe("scoreFixture (hermetic, real extractArticle)", () => {
  it("scores a generic-path fixture against gold with high recall", async () => {
    const html = `<!doctype html><html><head><title>Post</title></head><body><article>
      <h1>Post</h1><p>${"This is the real article body sentence that should survive extraction cleanly. ".repeat(20)}</p>
      </article></body></html>`;
    const gold = `${"This is the real article body sentence that should survive extraction cleanly. ".repeat(20)}`;
    await writeFixture("generic-fix", {
      renderedSourceHtml: html, expectedMd: gold,
      meta: { slug: "generic-fix", source_url: "https://example.com/post",
              resolved_fetch_url: "https://example.com/post", expected_via: "generic",
              needs_body_markdown: false, title: "Post", author: [], published: "" },
    }, root);

    const s = await scoreFixture("generic-fix", root);
    expect(s.body.recall).toBeGreaterThan(0.8);
    expect(["defuddle", "readability"]).toContain(s.via); // generic set
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run server/add-article/eval/scorer.e2e.test.ts` → FAIL ("scoreFixture is not exported").

- [ ] **Step 3: Implement `scripts/eval-fixtures.ts`**

```typescript
/**
 * Score the deterministic scraper against committed fixtures. Fully offline.
 * Usage: npx tsx scripts/eval-fixtures.ts [--only <slug>]
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { readFixture, makeOfflineFetchText, fixtureDir } from "../server/add-article/eval/fixture-io";
import { scoreBody, structureCounts } from "../server/add-article/eval/score";
import { atlasMarkdownUrl } from "../server/add-article/eval/atlas-md-url";
import { extractArticle } from "../server/add-article/extract";

export interface FixtureScore {
  slug: string;
  via: string;
  viaMatch: boolean;
  reviewed: boolean;
  body: { recall: number; precision: number; jaccard: number };
  structureDelta: Record<string, number>;
}

export async function scoreFixture(slug: string, root?: string, emitDiffDir?: string): Promise<FixtureScore> {
  const fx = await readFixture(slug, root);
  const fetchText = fx.bodyMarkdown != null
    ? makeOfflineFetchText(atlasMarkdownUrl(fx.meta.resolved_fetch_url), fx.bodyMarkdown)
    : async (u: string) => { throw new Error(`offline: unexpected fetch ${u}`); };
  const ex = await extractArticle(fx.html, fx.meta.resolved_fetch_url, { sourceUrl: fx.meta.source_url, fetchText });

  const body = scoreBody(ex.body, fx.expectedMd);
  const og = structureCounts(ex.body), gd = structureCounts(fx.expectedMd);
  const structureDelta: Record<string, number> = {};
  for (const k of Object.keys(og) as (keyof typeof og)[]) structureDelta[k] = og[k] - gd[k];
  const viaMatch = fx.meta.expected_via === "generic"
    ? ["defuddle", "readability"].includes(ex.via)
    : ex.via === fx.meta.expected_via;
  // Emit gold + output side-by-side so a human can diff and decide which is
  // right (the review workflow); skipped when emitDiffDir is unset (e2e test).
  if (emitDiffDir) {
    const dir = path.join(emitDiffDir, slug);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "output.md"), ex.body);
    await fs.writeFile(path.join(dir, "expected.md"), fx.expectedMd);
  }
  return { slug, via: ex.via, viaMatch, reviewed: fx.meta.reviewed ?? false, body, structureDelta };
}

async function main() {
  const root = path.join(__dirname, "../server/add-article/eval/fixtures");
  const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1] : null;
  const slugs = (await fs.readdir(root, { withFileTypes: true }))
    .filter((d) => d.isDirectory() && (!only || d.name === only)).map((d) => d.name);
  const scores: FixtureScore[] = [];
  const diffRoot = "/tmp/article-eval";
  for (const slug of slugs) {
    try { scores.push(await scoreFixture(slug, undefined, diffRoot)); }
    catch (err) { console.error(`✗ ${slug}: ${err}`); }
  }
  scores.sort((a, b) => a.body.recall - b.body.recall);
  for (const s of scores) {
    const tag = s.reviewed ? "reviewed" : "UNREVIEWED";
    console.log(`${s.body.recall.toFixed(2)} recall ${s.body.precision.toFixed(2)} prec  ${s.viaMatch ? "via✓" : `via✗(${s.via})`}  [${tag}]  ${s.slug}`);
  }
  const mean = (f: (s: FixtureScore) => number) => scores.reduce((a, s) => a + f(s), 0) / (scores.length || 1);
  const unreviewed = scores.filter((s) => !s.reviewed);
  console.log(`\nmean recall ${mean((s) => s.body.recall).toFixed(3)}  mean precision ${mean((s) => s.body.precision).toFixed(3)}  routing mismatches ${scores.filter((s) => !s.viaMatch).length}  unreviewed ${unreviewed.length}/${scores.length}`);
  if (unreviewed.length) {
    console.log(`\n⚠ ${unreviewed.length} fixture(s) not yet manually reviewed — for these a low score may mean the GOLD is wrong, not the scraper. Diff gold vs output in ${diffRoot}/<slug>/ and set reviewed:true in meta.json (re-freeze gold first if the scraper was right).`);
  }
  void fixtureDir;
}
if (process.argv[1]?.endsWith("eval-fixtures.ts")) main();
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run server/add-article/eval/scorer.e2e.test.ts` → PASS.

- [ ] **Step 5: Full suite + commit**

Run: `npx vitest run server/add-article/eval` → all PASS.
```bash
jj new && jj describe -m "feat(eval): hermetic fixture scorer runner + e2e test"
```

- [ ] **Step 6: PHASE-3 acceptance**

After fixtures are built (Phase 2 sign-off), run `npx tsx scripts/eval-fixtures.ts` and review the report with the user: confirm routing matches, inspect the worst-recall fixtures' diffs in `/tmp/article-eval/<slug>/` (`output.md` vs `expected.md`), and for each disagreement decide which side is right — a **scraper** regression vs a **gold** that needs re-freezing website-identical. Mark confirmed fixtures `reviewed: true` in `meta.json` (re-freeze gold first if the scraper was right). Unreviewed low-scorers are explicitly *not* assumed to be scraper bugs.

---

## Deferred (separate plan)

- **`--llm` diff-classification stage:** direct Anthropic API (temp 0, pinned model, structured JSON, no tools), advisory-only. Its own spec/plan; it has the most open questions and least first-pass leverage.

## Self-Review notes

- Spec coverage: resolver (Tasks 1-5), edu-repo read mechanism (Task 3), hermetic fetchText + bodyMarkdown (Tasks 6,7,9), arXiv resolved-fetch (Tasks 5,7,9 via `resolveFetchUrls`/`resolved_fetch_url`), **raw compare — no masking normalization**; CriticMarkup only *detected* to flag dirty gold (Task 7, `criticmarkup.ts`), never stripped; manual-review flag (`reviewed` in `meta.json`, preserve-on-refresh in Task 7, surfaced in Task 9) + gold-vs-output diff artifacts to `/tmp/article-eval/<slug>/` (Task 9), recall/precision + jaccard tripwire + structure deltas + `expected_via` routing check (Tasks 8-9), gzip size budget (Task 6), manifest schema (Task 5), link-out exclusion (manifest `status: excluded:link-out`, set during Phase-1 review), `--llm` deferred. ✓
- Type consistency: `ManifestEntry` defined in Task 5 and consumed verbatim in Tasks 7,9; `scoreBody`/`structureCounts` signatures consistent across Tasks 8-9; `extractArticle` opts match the verified signature. ✓
