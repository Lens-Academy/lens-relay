import { useState, useEffect, useCallback, useRef } from "react";
import type { CSSProperties } from "react";

interface ArticleJob {
  id: string;
  url: string;
  title?: string;
  status: "queued" | "processing" | "done" | "failed";
  /** Pipeline stage while processing (fetching / rendering / quality-check /
   *  uploading-images / writing / creating-lens). */
  stage?: string;
  error?: string;
  relay_url?: string;
  created_at: string;
  updated_at: string;
}

interface SubmitResult {
  url: string;
  status: "queued" | "invalid" | "already_queued";
  id?: string;
  error?: string;
}

export const POLL_INTERVAL_MS = 3000;

const STATUS_COLORS: Record<ArticleJob["status"], string> = {
  queued: "#f0ad4e",
  processing: "#4361ee",
  done: "#4ec96e",
  failed: "#e04e4e",
};

// Remember the lens checkbox across sessions: bulk importers uncheck it once
// and shouldn't have to re-uncheck on every visit (45 orphan starter lenses
// came out of one bulk session that missed it).
const CREATE_LENS_STORAGE_KEY = "lens-editor-add-article-create-lens";

function readStoredCreateLens(): boolean {
  try {
    return localStorage.getItem(CREATE_LENS_STORAGE_KEY) !== "false";
  } catch {
    return true; // no storage (tests, private mode) — default to on
  }
}

export function AddArticlePage({ shareToken }: { shareToken: string }) {
  const [input, setInput] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [invalidResults, setInvalidResults] = useState<SubmitResult[]>([]);
  const [jobs, setJobs] = useState<ArticleJob[]>([]);
  const [createLens, setCreateLensState] = useState(readStoredCreateLens);
  const fetchInFlight = useRef(false);

  const setCreateLens = (value: boolean) => {
    setCreateLensState(value);
    try {
      localStorage.setItem(CREATE_LENS_STORAGE_KEY, String(value));
    } catch {
      /* private mode — the checkbox still works for this session */
    }
  };

  const fetchStatus = useCallback(async () => {
    if (fetchInFlight.current) return;
    fetchInFlight.current = true;
    try {
      const resp = await fetch("/api/add-article/status", {
        headers: { Authorization: `Bearer ${shareToken}` },
      });
      if (!resp.ok) return;
      const data = (await resp.json()) as { jobs: ArticleJob[] };
      setJobs(data.jobs);
      return data.jobs;
    } catch (err) {
      console.warn("[add-article] status poll failed:", err);
      return;
    } finally {
      fetchInFlight.current = false;
    }
  }, [shareToken]);

  // Poll while any job is still in flight. setInterval keyed on the
  // active/idle boolean (not the jobs array) so the cadence is independent of
  // individual fetch outcomes: a failed poll doesn't kill the loop (the bug a
  // state-driven timeout chain had), and a successful one doesn't reset it.
  const anyActive = jobs.some(
    (j) => j.status === "queued" || j.status === "processing",
  );
  useEffect(() => {
    if (!anyActive) return;
    const interval = setInterval(fetchStatus, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [anyActive, fetchStatus]);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  useEffect(() => {
    document.title = "Add Article to Lens";
    return () => {
      document.title = "Editor";
    };
  }, []);

  async function submit() {
    const urls = input
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    if (urls.length === 0) return;

    setSubmitting(true);
    setSubmitError(null);
    setInvalidResults([]);
    try {
      const resp = await fetch("/api/add-article", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${shareToken}`,
        },
        body: JSON.stringify({ urls, createLens }),
      });
      const data = (await resp.json().catch(() => ({}))) as {
        results?: SubmitResult[];
        error?: string;
      };
      if (!resp.ok) {
        throw new Error(data.error || `Submit failed: ${resp.status}`);
      }
      const invalid = (data.results ?? []).filter(
        (r) => r.status === "invalid",
      );
      setInvalidResults(invalid);
      // Keep invalid lines in the textarea so the user can fix them
      setInput(invalid.map((r) => r.url).join("\n"));
      await fetchStatus();
    } catch (e: unknown) {
      setSubmitError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  async function cancelJob(id: string) {
    try {
      await fetch(`/api/add-article/${id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${shareToken}` },
      });
    } catch (err) {
      console.warn("[add-article] cancel failed:", err);
    }
    await fetchStatus();
  }

  async function retryJob(id: string) {
    try {
      await fetch(`/api/add-article/${id}/retry`, {
        method: "POST",
        headers: { Authorization: `Bearer ${shareToken}` },
      });
    } catch (err) {
      console.warn("[add-article] retry failed:", err);
    }
    await fetchStatus();
  }

  const sortedJobs = [...jobs].sort((a, b) =>
    b.created_at.localeCompare(a.created_at),
  );

  const smallButtonStyle: CSSProperties = {
    background: "transparent",
    color: "#9aa4c7",
    border: "1px solid #2a2a4e",
    borderRadius: 6,
    padding: "4px 10px",
    fontSize: 12,
    cursor: "pointer",
    flexShrink: 0,
  };

  return (
    <div
      style={{
        background: "#1a1a2e",
        minHeight: "100%",
        color: "#e0e0e0",
        fontFamily: "system-ui, sans-serif",
        lineHeight: 1.6,
        overflowY: "auto",
        height: "100%",
      }}
    >
      <div style={{ maxWidth: 700, margin: "0 auto", padding: "60px 20px" }}>
        <h1 style={{ color: "#fff" }}>Add Article to Lens</h1>
        <p>
          Import web articles into the Lens library. Paste one or more article
          URLs (one per line). The server fetches each page, extracts the
          article, cleans it up, and saves it to{" "}
          <code
            style={{
              background: "#0f0f23",
              padding: "2px 6px",
              borderRadius: 4,
              fontSize: 13,
            }}
          >
            Lens Edu/articles
          </code>
          .
        </p>

        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={
            "https://example.com/article-one\nhttps://example.com/article-two"
          }
          rows={5}
          spellCheck={false}
          style={{
            width: "100%",
            boxSizing: "border-box",
            background: "#0f0f23",
            color: "#e0e0e0",
            border: "1px solid #2a2a4e",
            borderRadius: 8,
            padding: 12,
            fontSize: 14,
            fontFamily: "ui-monospace, monospace",
            resize: "vertical",
            margin: "12px 0",
          }}
        />

        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            margin: "0 0 12px",
            fontSize: 14,
            cursor: "pointer",
          }}
        >
          <input
            type="checkbox"
            checked={createLens}
            onChange={(e) => setCreateLens(e.target.checked)}
          />
          Also create a lens for each article
        </label>

        <button
          onClick={submit}
          disabled={submitting || input.trim() === ""}
          style={{
            background: submitting ? "#3a3a5e" : "#4361ee",
            color: "white",
            border: "none",
            padding: "12px 24px",
            borderRadius: 8,
            fontSize: 16,
            fontWeight: 500,
            cursor: submitting ? "wait" : "pointer",
          }}
        >
          {submitting ? "Submitting…" : "Import Articles"}
        </button>

        {submitError && (
          <div
            style={{
              background: "#2a0e0e",
              borderLeft: "3px solid #e04e4e",
              padding: 12,
              borderRadius: 4,
              margin: "16px 0",
              fontSize: 13,
            }}
          >
            Error: {submitError}
          </div>
        )}

        {invalidResults.length > 0 && (
          <div
            style={{
              background: "#2a1a0e",
              borderLeft: "3px solid #f0ad4e",
              padding: 12,
              borderRadius: 4,
              margin: "16px 0",
              fontSize: 13,
            }}
          >
            {invalidResults.length} URL
            {invalidResults.length > 1 ? "s were" : " was"} not valid and{" "}
            {invalidResults.length > 1 ? "were" : "was"} left in the box above.
          </div>
        )}

        <h2 style={{ color: "#fff", marginTop: 40 }}>Imports</h2>
        {sortedJobs.length === 0 ? (
          <p style={{ color: "#888" }}>No imports yet this session.</p>
        ) : (
          sortedJobs.map((job) => (
            <div
              key={job.id}
              style={{
                background: "#16213e",
                borderRadius: 8,
                padding: "12px 16px",
                margin: "10px 0",
                display: "flex",
                alignItems: "baseline",
                gap: 12,
              }}
            >
              <span
                style={{
                  color: STATUS_COLORS[job.status],
                  fontSize: 12,
                  fontWeight: 600,
                  textTransform: "uppercase",
                  minWidth: 80,
                }}
              >
                {job.status}
                {job.status === "processing" && job.stage && (
                  <span
                    style={{
                      display: "block",
                      color: "#9aa4c7",
                      fontWeight: 400,
                      textTransform: "none",
                    }}
                  >
                    {job.stage}
                  </span>
                )}
              </span>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div
                  style={{
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {job.relay_url ? (
                    <a
                      href={job.relay_url}
                      target="_blank"
                      rel="noreferrer"
                      style={{ color: "#7ea2ff" }}
                    >
                      {job.title || job.url}
                    </a>
                  ) : (
                    job.title || job.url
                  )}
                </div>
                <div
                  style={{
                    fontSize: 12,
                    color: "#888",
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {job.url}
                </div>
                {job.error && (
                  <div style={{ fontSize: 12, color: "#e04e4e" }}>
                    {job.error}
                  </div>
                )}
              </div>
              {(job.status === "queued" || job.status === "processing") && (
                <button
                  onClick={() => cancelJob(job.id)}
                  title="Cancel this import"
                  style={smallButtonStyle}
                >
                  Cancel
                </button>
              )}
              {job.status === "failed" && (
                <button
                  onClick={() => retryJob(job.id)}
                  title="Queue this URL again"
                  style={smallButtonStyle}
                >
                  Retry
                </button>
              )}
            </div>
          ))
        )}

        <div
          style={{
            background: "#2a1a0e",
            borderLeft: "3px solid #f0ad4e",
            padding: 12,
            borderRadius: 4,
            margin: "24px 0",
            fontSize: 13,
          }}
        >
          Each article takes seconds to a few minutes depending on whether a
          quality-check pass is needed; the finished document is written only
          when processing completes (nothing is written on failure). The job
          list resets when the server restarts — the imported documents
          themselves are safe in the relay.
        </div>
      </div>
    </div>
  );
}
