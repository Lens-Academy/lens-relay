import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
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
});
