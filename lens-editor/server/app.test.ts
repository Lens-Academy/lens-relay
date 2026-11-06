import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Hono } from "hono";
import { createApp, createPromotionRouteService } from "./app";
import type { PromotionMerge, PromotionPrResponse } from "./promotion/types";
import { signShareToken } from "./share-token";

// Prevents: the production server wiring (prod-server.ts → createApp) silently
// diverging from the dev (vite plugin) wiring that local testing exercises.
// These tests hit the REAL production app composition, not a mock mount.

const EDU_FOLDER = "ea4015da-24af-4d9d-ac49-8c902cb17121";

function shareToken() {
  return signShareToken({
    purpose: "share",
    role: "edit",
    folder: EDU_FOLDER,
    expiry: Math.floor(Date.now() / 1000) + 3600,
  });
}

describe("production app (createApp)", () => {
  let app: Hono;
  const originalPromotionEnabled = process.env.PROMOTION_ENABLED;
  const originalContentStatusEnabled = process.env.CONTENT_STATUS_ENABLED;

  beforeAll(() => {
    delete process.env.PROMOTION_ENABLED;
    delete process.env.CONTENT_STATUS_ENABLED;
    app = createApp({ relayUrl: "http://localhost:1", relayServerToken: "test" });
  });

  afterAll(() => {
    if (originalPromotionEnabled === undefined) {
      delete process.env.PROMOTION_ENABLED;
    } else {
      process.env.PROMOTION_ENABLED = originalPromotionEnabled;
    }
    if (originalContentStatusEnabled === undefined) {
      delete process.env.CONTENT_STATUS_ENABLED;
    } else {
      process.env.CONTENT_STATUS_ENABLED = originalContentStatusEnabled;
    }
  });

  it("mounts /api/add-article/status behind share-token auth", async () => {
    const resp = await app.request("/api/add-article/status", {
      headers: { Authorization: `Bearer ${shareToken()}` },
    });
    expect(resp.status).toBe(200);
    expect(await resp.json()).toMatchObject({ jobs: [], queue: { queued: 0, processing: 0 } });
  });

  it("rejects /api/add-article without auth", async () => {
    const resp = await app.request("/api/add-article/status");
    expect(resp.status).toBe(401);
  });

  it("validates add-article submissions through the real route", async () => {
    // Invalid-only URLs: exercises routing + validation without spawning
    // fetches or Claude processes.
    const resp = await app.request("/api/add-article", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${shareToken()}`,
      },
      body: JSON.stringify({ urls: ["not-a-url"], importMode: "article" }),
    });
    expect(resp.status).toBe(200);
    const data = await resp.json();
    expect(data.results).toEqual([
      { url: "not-a-url", status: "invalid", error: "Not a valid http(s) URL" },
    ]);
  });

  it("serves the auth token endpoint", async () => {
    // Bad request shape → handled error, not a routing 404
    const resp = await app.request("/api/auth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(resp.status).not.toBe(404);
  });

  it("returns JSON 404 for the content status route when it is disabled by default", async () => {
    const resp = await app.request("/api/content-status?path=Lenses/X.md");

    expect(resp.status).toBe(404);
    expect(await resp.json()).toEqual({ error: "Content status is disabled", code: "disabled" });
  });

  it("returns JSON 404 for promotion routes when promotion is disabled by default", async () => {
    const resp = await app.request("/api/promotion/changes");

    expect(resp.status).toBe(404);
    expect(resp.headers.get("content-type")).toContain("application/json");
    expect(await resp.json()).toEqual({ error: "Promotion is disabled" });
  });
});

describe("createPromotionRouteService", () => {
  // Fakes for both services: what is under test is the order of the steps.
  function servicesWith(merges: PromotionMerge[]) {
    const events: string[] = [];
    let forgotten = 0;
    let made = 0;
    const git = {
      getChanges: async () => ({
        mainSha: "m",
        generatedAt: "t",
        files: ["a.md", "b.md"].map((path) => ({ path, oldPath: null, status: "modified" as const, additions: 1, deletions: 1, isBinary: false })),
        curriculum: { courses: [], modules: [], memberships: {} },
      }),
      getStatus: async () => null,
      getDiff: async () => null,
      createPromotionBranch: async ({ paths }: { paths: string[] }) => {
        const branch = `branch-${++made}`;
        events.push(`branch ${paths.join(",")}`);
        return { branch, mainSha: "m", sourceStagingSha: "s", headSha: `head-${made}` };
      },
      forgetFetched: () => {
        forgotten += 1;
      },
    };
    const github = {
      createPullRequest: async (input: { branch: string; mainSha: string; headSha: string }): Promise<PromotionPrResponse> => {
        events.push(`pr ${input.branch} start`);
        await new Promise((resolve) => setTimeout(resolve, 20));
        events.push(`pr ${input.branch} end`);
        return { branch: input.branch, prNumber: 1, prUrl: "u", mainSha: input.mainSha, merge: merges.shift()! };
      },
    };
    return { service: createPromotionRouteService(git, github), events, forgotten: () => forgotten };
  }

  it("refuses a second promotion while one is under way, then takes the next", async () => {
    const { service, events } = servicesWith(["merged", "merged"]);

    const first = service.createPromotionPr({ paths: ["a.md"] });
    await expect(service.createPromotionPr({ paths: ["b.md"] })).rejects.toMatchObject({ status: 409, code: "promotion_running" });
    await expect(first).resolves.toMatchObject({ merge: "merged" });
    await expect(service.createPromotionPr({ paths: ["b.md"] })).resolves.toMatchObject({ merge: "merged" });

    expect(events).toEqual(["branch a.md", "pr branch-1 start", "pr branch-1 end", "branch b.md", "pr branch-2 start", "pr branch-2 end"]);
  });

  it("goes on with the next promotion after one fails", async () => {
    const { service } = servicesWith(["merged"]);

    await expect(service.createPromotionPr({ paths: ["not-changed.md"] })).rejects.toMatchObject({ code: "path_not_changed" });
    await expect(service.createPromotionPr({ paths: ["a.md"] })).resolves.toMatchObject({ merge: "merged" });
  });

  it.each([
    ["merged", 1],
    ["auto-merge", 0],
    ["open", 0],
  ] as const)("forgets the fetched branches only after a merge (%s)", async (merge, times) => {
    const { service, forgotten } = servicesWith([merge]);
    await service.createPromotionPr({ paths: ["a.md"] });
    expect(forgotten()).toBe(times);
  });
});
