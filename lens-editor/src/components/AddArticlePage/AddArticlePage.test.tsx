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
      /only create an article stub without the article body/i,
    );
  });
});
