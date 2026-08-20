import { useState, useEffect, useCallback, useRef } from "react";
import type { CSSProperties } from "react";
import {
  ARTICLE_IMPORT_MODE_DEFINITIONS,
  ARTICLE_IMPORT_MODES,
  type ArticleImportMode,
} from "../../../shared/article-import-contract";

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
  importMode: ArticleImportMode;
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

export function AddArticlePage({ shareToken }: { shareToken: string }) {
  const [input, setInput] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [invalidResults, setInvalidResults] = useState<SubmitResult[]>([]);
  const [jobs, setJobs] = useState<ArticleJob[]>([]);
  const [importMode, setImportMode] =
    useState<ArticleImportMode>("article-and-lens");
  const [showModeInfo, setShowModeInfo] = useState(false);
  const fetchInFlight = useRef(false);

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
    const timer = window.setTimeout(() => void fetchStatus(), 0);
    return () => window.clearTimeout(timer);
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
        body: JSON.stringify({ urls, importMode }),
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
          Import web articles and YouTube videos into the Lens library. Paste
          one or more URLs (one per line). The server fetches each page,
          extracts the article, cleans it up, and saves it to{" "}
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
          . YouTube links import the video&apos;s transcript (with timestamps)
          to{" "}
          <code
            style={{
              background: "#0f0f23",
              padding: "2px 6px",
              borderRadius: 4,
              fontSize: 13,
            }}
          >
            Lens Edu/video_transcripts
          </code>{" "}
          instead — those take a few minutes.
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

        <div
          style={{
            margin: "0 0 18px",
            fontSize: 14,
          }}
        >
          <div style={{ marginBottom: 8 }}>
            <span style={{ color: "#c9cee2", fontWeight: 600 }}>Import mode</span>
          </div>
          <div
            role="radiogroup"
            aria-label="Import mode"
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
              padding: 3,
              border: "1px solid #303858",
              borderRadius: 9,
              background: "#101327",
            }}
          >
            {ARTICLE_IMPORT_MODES.map((value) => {
              const definition = ARTICLE_IMPORT_MODE_DEFINITIONS[value];
              const selected = importMode === value;
              return (
                <div
                  key={value}
                  style={{
                    position: "relative",
                  }}
                >
                  <button
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    onClick={() => setImportMode(value)}
                    style={{
                      width: "100%",
                      height: "100%",
                      border: selected ? "1px solid #6578d8" : "1px solid transparent",
                      borderRadius: 6,
                      padding: value === "stub" ? "8px 32px 8px 9px" : "8px 9px",
                      background: selected ? "#293466" : "transparent",
                      color: selected ? "#fff" : "#9fa8c9",
                      boxShadow: selected ? "0 2px 8px rgba(0,0,0,.22)" : "none",
                      fontSize: 13,
                      fontWeight: selected ? 650 : 500,
                      cursor: "pointer",
                    }}
                  >
                    {definition.label}
                  </button>
                  {value === "stub" && (
                    <>
                      <button
                        type="button"
                        aria-label="About stub-only imports"
                        aria-expanded={showModeInfo}
                        onMouseEnter={() => setShowModeInfo(true)}
                        onMouseLeave={() => setShowModeInfo(false)}
                        onFocus={() => setShowModeInfo(true)}
                        onBlur={() => setShowModeInfo(false)}
                        style={{
                          position: "absolute",
                          right: 9,
                          top: "50%",
                          transform: "translateY(-50%)",
                          width: 18,
                          height: 18,
                          borderRadius: "50%",
                          border: selected ? "1px solid #9ba9ed" : "1px solid #58628a",
                          background: selected ? "#35437f" : "#171b33",
                          color: selected ? "#fff" : "#aeb8dc",
                          fontSize: 11,
                          fontWeight: 700,
                          lineHeight: "16px",
                          padding: 0,
                          cursor: "help",
                        }}
                      >
                        i
                      </button>
                      {showModeInfo && (
                        <span
                          role="tooltip"
                          style={{
                            position: "absolute",
                            zIndex: 10,
                            left: 8,
                            top: 43,
                            width: 310,
                            padding: "10px 12px",
                            border: "1px solid #3d466d",
                            borderRadius: 7,
                            background: "#101327",
                            boxShadow: "0 10px 30px rgba(0,0,0,.35)",
                            color: "#d9dded",
                            fontSize: 12,
                            lineHeight: 1.45,
                          }}
                        >
                          {definition.description}
                        </span>
                      )}
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </div>

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
