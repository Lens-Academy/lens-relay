import definitions from "./article-import-modes.json";

export type ArticleImportMode = keyof typeof definitions;

export const ARTICLE_IMPORT_MODE_DEFINITIONS = definitions;

export const ARTICLE_IMPORT_MODES = Object.keys(
  definitions,
) as ArticleImportMode[];

export function isArticleImportMode(
  value: unknown,
): value is ArticleImportMode {
  return (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(definitions, value)
  );
}

/**
 * Lifecycle of one import job.
 *
 * Shared so the server and the job list cannot drift: "skipped" in particular
 * must not be rendered as a failure.
 */
export type ArticleJobStatus =
  | "queued"
  | "processing"
  | "done"
  /** Resolved to a document that already exists -- not an error, nothing to retry. */
  | "skipped"
  | "failed";
