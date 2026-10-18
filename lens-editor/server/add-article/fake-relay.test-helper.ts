import type { Mock } from "vitest";

/**
 * The few relay calls processArticle makes, backed by a Map of full path →
 * markdown, so a test sees the stub the importer writes first and the full
 * article that later replaces it, the way the relay would show them.
 */
export function installFakeRelay(mocks: {
  createRelayDoc: Mock;
  checkRelayDocsExist: Mock;
  checkRelayArticleUrls: Mock;
}): Map<string, string> {
  const files = new Map<string, string>();
  mocks.createRelayDoc.mockImplementation(async (path: string, content: string) => {
    files.set(path, content);
  });
  mocks.checkRelayDocsExist.mockImplementation(async (paths: string[]) =>
    Object.fromEntries(paths.map((path) => [path, files.has(path)])),
  );
  mocks.checkRelayArticleUrls.mockImplementation(async (urls: string[]) => {
    const found: Record<string, string | null> = {};
    const stubs: Record<string, { path: string; content: string } | null> = {};
    for (const url of urls) {
      found[url] = null;
      stubs[url] = null;
      for (const [path, content] of files) {
        if (!path.startsWith("Lens Edu/articles/")) continue;
        const sourceUrl = content.match(/^source_url:\s*"?([^"\n]*)"?\s*$/m)?.[1];
        if (sourceUrl !== url) continue;
        const relPath = path.slice("Lens Edu".length);
        found[url] = relPath;
        if (/^\s*-\s*"?article-stub"?\s*$/m.test(content)) {
          stubs[url] = { path: relPath, content };
        }
        break;
      }
    }
    return { found, stubs };
  });
  return files;
}
