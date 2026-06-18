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
