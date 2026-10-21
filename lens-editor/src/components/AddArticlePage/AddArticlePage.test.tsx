import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";
import { AddArticlePage, POLL_INTERVAL_MS } from "./AddArticlePage";

const POLL_MS = POLL_INTERVAL_MS;

function jobsResponse(status: string) {
  return {
    ok: true,
    json: async () => ({
      jobs: [
        {
          id: "j1",
          url: "https://example.com/a",
          title: "Article A",
          status,
          created_at: "2026-06-12T08:00:00.000Z",
          updated_at: "2026-06-12T08:00:00.000Z",
        },
      ],
    }),
  };
}

function advance(ms: number) {
  return act(() => vi.advanceTimersByTimeAsync(ms));
}

describe("AddArticlePage status polling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  // Prevents: one failed poll permanently stopping status updates — the page
  // froze on "processing" in production after a single fetch hiccup, because
  // the old timeout chain was only rescheduled by a successful state update.
  it("keeps polling through a failed poll and shows the final status", async () => {
    const fetchMock = vi
      .fn()
      // initial mount fetch: job is processing
      .mockResolvedValueOnce(jobsResponse("processing"))
      // first poll: transient failure (e.g. 502 through the tunnel)
      .mockResolvedValueOnce({ ok: false, json: async () => ({}) })
      // subsequent polls: job finished
      .mockResolvedValue(jobsResponse("done"));
    vi.stubGlobal("fetch", fetchMock);

    render(<AddArticlePage shareToken="test-token" />);

    // Initial fetch on mount
    await advance(0);
    expect(screen.getByText("processing")).toBeInTheDocument();

    // First poll fails — page must not freeze
    await advance(POLL_MS);
    expect(screen.getByText("processing")).toBeInTheDocument();

    // Next poll succeeds and the UI catches up
    await advance(POLL_MS);
    expect(screen.getByText("done")).toBeInTheDocument();
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it("stops polling once no job is active", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jobsResponse("done"));
    vi.stubGlobal("fetch", fetchMock);

    render(<AddArticlePage shareToken="test-token" />);
    await advance(0);
    expect(screen.getByText("done")).toBeInTheDocument();

    const callsAfterMount = fetchMock.mock.calls.length;
    await advance(POLL_MS * 3);
    expect(fetchMock.mock.calls.length).toBe(callsAfterMount);
  });

  it("defaults to full article + lens and submits the selected import mode", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        return {
          ok: true,
          json: async () => ({ results: [] }),
        };
      }
      return { ok: true, json: async () => ({ jobs: [] }) };
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<AddArticlePage shareToken="test-token" />);
    await advance(0);

    expect(
      screen.getByRole("radio", { name: "Full text + lens" }),
    ).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByRole("radio", { name: "Stub only" }));
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "https://example.com/article" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Import Sources" }));
    await advance(0);

    const post = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({
      urls: ["https://example.com/article"],
      importMode: "stub",
    });
  });

  // A skipped video can be re-imported, but only after a warning that hand
  // edits are lost; an article (no video) never gets the button.
  it("re-imports a skipped video only after the warning is confirmed", async () => {
    const skipped = (id: string, url: string, video?: object) => ({
      id,
      url,
      title: id,
      status: "skipped",
      error: "already imported",
      importMode: "article-and-lens",
      ...(video ? { video } : {}),
      created_at: "2026-06-12T08:00:00.000Z",
      updated_at: "2026-06-12T08:00:00.000Z",
    });
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") return { ok: true, json: async () => ({ results: [{ status: "queued" }] }) };
      return {
        ok: true,
        json: async () => ({
          jobs: [
            skipped("Video", "https://www.youtube.com/watch?v=oH-txHzE4jA", { video_id: "oH-txHzE4jA" }),
            skipped("Article", "https://example.com/a"),
          ],
        }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<AddArticlePage shareToken="test-token" />);
    await advance(0);

    const buttons = screen.getAllByRole("button", { name: "Re-import" });
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0]);
    expect(screen.getByRole("alert")).toHaveTextContent("Any hand edits to that transcript are lost");
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Keep it" }));
    expect(screen.queryByRole("alert")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Re-import" }));
    fireEvent.click(screen.getByRole("button", { name: "Replace transcript" }));
    await advance(0);
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({
      urls: ["https://www.youtube.com/watch?v=oH-txHzE4jA"],
      importMode: "article-and-lens",
      replaceExisting: true,
    });
  });

  it("explains what stub-only imports do", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ jobs: [] }) }),
    );
    render(<AddArticlePage shareToken="test-token" />);
    await advance(0);

    const stubOption = screen.getByRole("radio", { name: "Stub only" });
    const infoButton = screen.getByRole("button", {
      name: "About stub-only imports",
    });
    expect(stubOption.parentElement).toContainElement(infoButton);
    fireEvent.mouseEnter(infoButton);
    expect(screen.getByRole("tooltip")).toHaveTextContent(
      /only create the file with its discussion area/i,
    );
  });

  function withJobs(jobs: object[]) {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          jobs: jobs.map((job, i) => ({
            id: `j${i}`,
            importMode: "article",
            created_at: `2026-06-12T08:0${i}:00.000Z`,
            updated_at: "2026-06-12T08:00:00.000Z",
            ...job,
          })),
        }),
      }),
    );
  }

  it("says the file is ready for notes while an article import runs, and that it stays after a failure", async () => {
    withJobs([
      { url: "https://example.com/a", title: "A", status: "processing", stage: "source-review", relay_url: "https://e/open/a" },
      { url: "https://example.com/b", title: "B", status: "failed", error: "boom", relay_url: "https://e/open/b" },
    ]);
    render(<AddArticlePage shareToken="test-token" />);
    await advance(0);

    expect(screen.getByRole("link", { name: "A" })).toHaveAttribute("href", "https://e/open/a");
    expect(screen.getByText(/The file is ready: open it to add notes/)).toBeInTheDocument();
    expect(screen.getByText(/The file stays, with any notes you added/)).toBeInTheDocument();
  });

  it("speaks of the transcript for videos, only once it is written, and promises no retry fill-in", async () => {
    const video = { video_id: "abc", url: "https://youtu.be/abc" };
    withJobs([
      { url: "https://youtu.be/abc", title: "V1", status: "processing", stage: "preparing", relay_url: "https://e/open/v1", video },
      { url: "https://youtu.be/def", title: "V2", status: "processing", stage: "polishing", relay_url: "https://e/open/v2", video },
      { url: "https://youtu.be/ghi", title: "V3", status: "failed", error: "boom", relay_url: "https://e/open/v3", video },
    ]);
    render(<AddArticlePage shareToken="test-token" />);
    await advance(0);

    expect(screen.getAllByText(/The transcript is in: open it to add notes/)).toHaveLength(1);
    expect(screen.queryByText(/The file is ready/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Retry fills the text in/)).not.toBeInTheDocument();
  });
});
