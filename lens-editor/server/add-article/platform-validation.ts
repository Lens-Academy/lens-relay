export interface ArticleValidationIssue {
  code?: string;
  severity: "error" | "warning";
  path: string;
  line?: number;
  message: string;
  suggestion?: string;
}

export interface ArticleValidationResult {
  valid: boolean;
  issues: ArticleValidationIssue[];
  truncated: boolean;
  counts: { errors: number; warnings: number };
}

const DEFAULT_TIMEOUT_MS = 45_000;

function isResult(value: unknown): value is ArticleValidationResult {
  if (!value || typeof value !== "object") return false;
  const v = value as Partial<ArticleValidationResult>;
  return (
    typeof v.valid === "boolean" &&
    Array.isArray(v.issues) &&
    typeof v.truncated === "boolean" &&
    !!v.counts &&
    typeof v.counts.errors === "number" &&
    typeof v.counts.warnings === "number"
  );
}

/** Throw the same not-configured error as validateArticleDraft, but before any
 * work is done — batch tools call this up front so a misconfigured environment
 * fails one run, not every claimed item. */
export function assertArticleValidationConfigured(): void {
  if (!process.env.LENS_PLATFORM_URL || !process.env.ADHOC_VALIDATION_SECRET) {
    throw new Error(
      "Article validation is not configured (LENS_PLATFORM_URL and ADHOC_VALIDATION_SECRET are required)",
    );
  }
}

export async function validateArticleDraft(
  logicalPath: string,
  content: string,
  options: {
    platformUrl?: string;
    secret?: string;
    signal?: AbortSignal;
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<ArticleValidationResult> {
  const platformUrl = options.platformUrl ?? process.env.LENS_PLATFORM_URL;
  const secret = options.secret ?? process.env.ADHOC_VALIDATION_SECRET;
  if (!platformUrl || !secret) {
    throw new Error(
      "Article validation is not configured (LENS_PLATFORM_URL and ADHOC_VALIDATION_SECRET are required)",
    );
  }

  // A validation call is cheap to repeat and a whole import dies with it, so
  // transient network failures (connect timeout, reset) get two retries.
  // Non-OK HTTP responses are NOT retried — those are real service answers.
  let response!: Response;
  for (let attempt = 0; ; attempt++) {
    const timeout = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const signal = options.signal
      ? AbortSignal.any([options.signal, timeout])
      : timeout;
    try {
      response = await (options.fetchImpl ?? fetch)(
        `${platformUrl.replace(/\/$/, "")}/api/content/validate-article`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Validation-Key": secret,
          },
          body: JSON.stringify({ path: logicalPath, content }),
          signal,
        },
      );
      break;
    } catch (error) {
      if (options.signal?.aborted || attempt >= 2) throw error;
      await new Promise((resolve) => setTimeout(resolve, 2000 * (attempt + 1)));
    }
  }
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `Article validation service returned ${response.status}: ${text.slice(0, 500)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Article validation service returned malformed JSON");
  }
  if (!isResult(parsed)) {
    throw new Error("Article validation service returned an invalid response shape");
  }
  return parsed;
}

export function assertArticleValid(result: ArticleValidationResult): void {
  if (result.valid) return;
  const sample = result.issues
    .filter((issue) => issue.severity === "error")
    .slice(0, 5)
    .map((issue) => `${issue.code ?? "article.invalid"} at line ${issue.line ?? "?"}: ${issue.message}`)
    .join("; ");
  throw new Error(`Article failed structural validation: ${sample || "unknown error"}`);
}
