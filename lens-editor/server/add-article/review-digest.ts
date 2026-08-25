import { createHash } from "node:crypto";

export const REVIEW_FIELDS = [
  "llm_reviewed",
  "llm_review_version",
  "llm_review_model",
  "llm_review_digest",
  "llm_review_source_digest",
  "llm_review_source_fetched",
  "llm_review_source_kind",
] as const;

const REVIEW_BLOCK = "llm-review";

function withoutReviewProvenance(lines: string[]): string[] {
  const kept: string[] = [];
  let inReviewBlock = false;
  for (const line of lines) {
    if (inReviewBlock) {
      if (line === "" || /^[ \t]/.test(line)) continue;
      inReviewBlock = false;
    }
    if (new RegExp(`^${REVIEW_BLOCK}\\s*:`).test(line)) {
      inReviewBlock = true;
      continue;
    }
    if (REVIEW_FIELDS.some((field) => new RegExp(`^${field}\\s*:`).test(line))) continue;
    kept.push(line);
  }
  return kept;
}

/** Resolve the accepted view of the CriticMarkup forms emitted by Relay MCP. */
export function acceptedCriticMarkup(input: string): string {
  return input
    .replace(/\{~~(?:"(?:\\.|[^"])*"\s*)?([\s\S]*?)~>(?:"(?:\\.|[^"])*"\s*)?([\s\S]*?)~~\}/g, "$2")
    .replace(/\{--(?:"(?:\\.|[^"])*"\s*)?([\s\S]*?)--\}/g, "")
    .replace(/\{\+\+(?:"(?:\\.|[^"])*"\s*)?([\s\S]*?)\+\+\}/g, "$1")
    .replace(/\{>>(?:"(?:\\.|[^"])*"\s*)?([\s\S]*?)<<\}/g, "");
}

/** Authoring comments are invisible and deliberately excluded from review identity. */
export function stripAuthoringComments(input: string): string {
  return input.replace(/(^|\n)[ \t]*%%(?:\r?\n)?[\s\S]*?(?:\r?\n)?[ \t]*%%(?=\r?\n|$)/g, "$1");
}

export function canonicalArticleForReview(markdown: string): string {
  let text = acceptedCriticMarkup(markdown).replace(/\r\n?/g, "\n");
  const lines = text.split("\n");
  if (lines[0]?.trim() === "---") {
    const end = lines.slice(1).findIndex((line) => line.trim() === "---");
    if (end >= 0) {
      const stop = end + 1;
      const kept = withoutReviewProvenance(lines.slice(1, stop));
      text = ["---", ...kept, "---", ...lines.slice(stop + 1)].join("\n");
    }
  }
  text = stripAuthoringComments(text)
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
  return `${text}\n`;
}

export function articleReviewDigest(markdown: string): string {
  return `sha256:${createHash("sha256").update(canonicalArticleForReview(markdown)).digest("hex")}`;
}

export function sourceReviewDigest(source: Buffer | string): string {
  return `sha256:${createHash("sha256").update(source).digest("hex")}`;
}
