import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { createAddArticleRoutes, EDU_FOLDER } from "./routes";
import { signShareToken } from "../share-token";
import type { ShareTokenPayload } from "../share-token";

const OTHER_FOLDER = "fbd5eb54-73cc-41b0-ac28-2b93d3b4244e";

function makeToken(overrides: Partial<ShareTokenPayload> = {}): string {
  return signShareToken({
    purpose: "share",
    role: "edit",
    folder: EDU_FOLDER,
    expiry: Math.floor(Date.now() / 1000) + 3600,
    ...overrides,
  });
}

describe("POST /api/add-article", () => {
  let app: Hono;
  let mockQueue: {
    add: ReturnType<typeof vi.fn>;
    status: ReturnType<typeof vi.fn>;
    findActive: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    let counter = 0;
    mockQueue = {
      add: vi.fn((url: string) => ({
        id: `job${++counter}`,
        url,
        status: "queued",
      })),
      status: vi.fn(() => []),
      findActive: vi.fn(() => undefined),
    };
    app = new Hono();
    app.route("/api/add-article", createAddArticleRoutes(mockQueue as never));
  });

  function post(body: unknown, token = makeToken()) {
    return app.request("/api/add-article", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
  }

  it("queues valid urls and returns job ids", async () => {
    const resp = await post({ urls: ["https://example.com/article"] });
    expect(resp.status).toBe(200);
    const data = await resp.json();
    expect(data.results).toEqual([
      { url: "https://example.com/article", status: "queued", id: "job1" },
    ]);
    // createLens defaults to true.
    expect(mockQueue.add).toHaveBeenCalledWith("https://example.com/article", true);
  });

  it("passes createLens:false through to the queue when the client opts out", async () => {
    await post({ urls: ["https://example.com/article"], createLens: false });
    expect(mockQueue.add).toHaveBeenCalledWith("https://example.com/article", false);
  });

  it("rejects request with no auth header", async () => {
    const resp = await app.request("/api/add-article", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ urls: ["https://example.com"] }),
    });
    expect(resp.status).toBe(401);
  });

  // Prevents: leaked add-video tokens (held by bookmarklets on youtube.com)
  // being usable for server-side fetches of arbitrary URLs
  it("rejects add-video purpose tokens", async () => {
    const resp = await post(
      { urls: ["https://example.com"] },
      makeToken({ purpose: "add-video" }),
    );
    expect(resp.status).toBe(403);
  });

  it("rejects view-role tokens", async () => {
    const resp = await post(
      { urls: ["https://example.com"] },
      makeToken({ role: "view" }),
    );
    expect(resp.status).toBe(403);
  });

  it("rejects tokens scoped to a non-Edu folder", async () => {
    const resp = await post(
      { urls: ["https://example.com"] },
      makeToken({ folder: OTHER_FOLDER }),
    );
    expect(resp.status).toBe(403);
  });

  it("rejects empty body", async () => {
    const resp = await post({ urls: [] });
    expect(resp.status).toBe(400);
  });

  it("rejects more than 20 urls", async () => {
    const urls = Array.from(
      { length: 21 },
      (_, i) => `https://example.com/${i}`,
    );
    const resp = await post({ urls });
    expect(resp.status).toBe(400);
  });

  // Prevents: server-side fetch of file:// or other non-http schemes (SSRF vector)
  it("marks non-http(s) urls invalid without queueing them", async () => {
    const resp = await post({
      urls: ["file:///etc/passwd", "ftp://x", "not a url"],
    });
    expect(resp.status).toBe(200);
    const data = await resp.json();
    expect(
      data.results.every((r: { status: string }) => r.status === "invalid"),
    ).toBe(true);
    expect(mockQueue.add).not.toHaveBeenCalled();
  });

  it("dedupes urls within one request", async () => {
    const resp = await post({
      urls: ["https://example.com/a", "https://example.com/a"],
    });
    const data = await resp.json();
    expect(data.results).toHaveLength(1);
    expect(mockQueue.add).toHaveBeenCalledTimes(1);
  });

  // Prevents: double submits spawning duplicate Claude runs for the same URL
  it("reports already_queued for urls with an active job", async () => {
    mockQueue.findActive.mockReturnValue({
      id: "existing",
      url: "https://example.com/a",
      status: "processing",
    });
    const resp = await post({ urls: ["https://example.com/a"] });
    const data = await resp.json();
    expect(data.results[0]).toEqual({
      url: "https://example.com/a",
      status: "already_queued",
      id: "existing",
    });
    expect(mockQueue.add).not.toHaveBeenCalled();
  });
});

describe("GET /api/add-article/status", () => {
  it("returns jobs for a valid share token", async () => {
    const mockQueue = {
      add: vi.fn(),
      findActive: vi.fn(),
      status: vi.fn(() => [
        { id: "j1", url: "https://example.com", status: "done" },
      ]),
    };
    const app = new Hono();
    app.route("/api/add-article", createAddArticleRoutes(mockQueue as never));

    const resp = await app.request("/api/add-article/status", {
      headers: { Authorization: `Bearer ${makeToken()}` },
    });
    expect(resp.status).toBe(200);
    const data = await resp.json();
    expect(data.jobs).toHaveLength(1);
  });
});

describe("DELETE /api/add-article/:id and POST /:id/retry", () => {
  let app: Hono;
  let mockQueue: {
    add: ReturnType<typeof vi.fn>;
    status: ReturnType<typeof vi.fn>;
    findActive: ReturnType<typeof vi.fn>;
    cancel: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    mockQueue = {
      add: vi.fn((url: string) => ({ id: "new1", url, status: "queued" })),
      status: vi.fn(() => []),
      findActive: vi.fn(() => undefined),
      cancel: vi.fn(() => true),
      get: vi.fn(() => ({
        id: "job1",
        url: "https://example.com/a",
        status: "failed",
        createLens: true,
      })),
    };
    app = new Hono();
    app.route("/api/add-article", createAddArticleRoutes(mockQueue as never));
  });

  const auth = { Authorization: `Bearer ${makeToken()}` };

  it("cancels an active job", async () => {
    const res = await app.request("/api/add-article/job1", {
      method: "DELETE",
      headers: auth,
    });
    expect(res.status).toBe(200);
    expect(mockQueue.cancel).toHaveBeenCalledWith("job1");
  });

  it("404s when the job is unknown or already finished", async () => {
    mockQueue.cancel.mockReturnValueOnce(false);
    const res = await app.request("/api/add-article/nope", {
      method: "DELETE",
      headers: auth,
    });
    expect(res.status).toBe(404);
  });

  it("retries a failed job as a fresh job", async () => {
    const res = await app.request("/api/add-article/job1/retry", {
      method: "POST",
      headers: auth,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe("new1");
    expect(mockQueue.add).toHaveBeenCalledWith("https://example.com/a", true);
  });

  it("refuses to retry a job that is not failed", async () => {
    mockQueue.get.mockReturnValueOnce({
      id: "job1",
      url: "https://example.com/a",
      status: "processing",
    });
    const res = await app.request("/api/add-article/job1/retry", {
      method: "POST",
      headers: auth,
    });
    expect(res.status).toBe(400);
  });

  it("requires auth like every other route", async () => {
    const res = await app.request("/api/add-article/job1", { method: "DELETE" });
    expect(res.status).toBe(401);
  });
});
