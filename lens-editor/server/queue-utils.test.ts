import { describe, it, expect } from "vitest";
import { evictFinishedJobs } from "./queue-utils";

describe("evictFinishedJobs", () => {
  // "skipped" was terminal but matched neither done nor failed, so duplicate
  // submissions accumulated forever -- the exact growth this guards against.
  it("evicts every finished status, not just done and failed", () => {
    const old = new Date(Date.now() - 10_000).toISOString();
    const jobs = new Map([
      ["a", { status: "done", updated_at: old }],
      ["b", { status: "failed", updated_at: old }],
      ["c", { status: "skipped", updated_at: old }],
      ["d", { status: "queued", updated_at: old }],
      ["e", { status: "processing", updated_at: old }],
    ]);

    evictFinishedJobs(jobs, 1_000);

    expect([...jobs.keys()]).toEqual(["d", "e"]);
  });

  it("keeps finished jobs that are still within the ttl", () => {
    const jobs = new Map([
      ["a", { status: "done", updated_at: new Date().toISOString() }],
    ]);

    evictFinishedJobs(jobs, 60_000);

    expect(jobs.size).toBe(1);
  });
});
