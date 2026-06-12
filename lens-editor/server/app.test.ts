import { describe, it, expect, beforeAll } from "vitest";
import type { Hono } from "hono";
import { createApp } from "./app";
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

function addVideoToken() {
  return signShareToken({
    purpose: "add-video",
    role: "edit",
    folder: EDU_FOLDER,
    expiry: Math.floor(Date.now() / 1000) + 3600,
  });
}

describe("production app (createApp)", () => {
  let app: Hono;

  beforeAll(() => {
    app = createApp({ relayUrl: "http://localhost:1", relayServerToken: "test" });
  });

  it("mounts /api/add-article/status behind share-token auth", async () => {
    const resp = await app.request("/api/add-article/status", {
      headers: { Authorization: `Bearer ${shareToken()}` },
    });
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ jobs: [] });
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
      body: JSON.stringify({ urls: ["not-a-url"] }),
    });
    expect(resp.status).toBe(200);
    const data = await resp.json();
    expect(data.results).toEqual([
      { url: "not-a-url", status: "invalid", error: "Not a valid http(s) URL" },
    ]);
  });

  it("mounts /api/add-video/status behind add-video-token auth", async () => {
    const resp = await app.request("/api/add-video/status", {
      headers: { Authorization: `Bearer ${addVideoToken()}` },
    });
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ jobs: [] });
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
});
