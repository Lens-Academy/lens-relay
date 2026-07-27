import definitions from "./article-import-modes.json";

export type ArticleImportMode = keyof typeof definitions;

export const ARTICLE_IMPORT_MODE_DEFINITIONS = definitions;

export const ARTICLE_IMPORT_MODES = Object.keys(
  definitions,
) as ArticleImportMode[];

export function isArticleImportMode(value: unknown): value is ArticleImportMode {
  return (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(definitions, value)
  );
}
