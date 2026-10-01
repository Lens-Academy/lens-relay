import { afterEach, describe, expect, it, vi } from "vitest";
import { isLocalRelay, startSourceSyncFromEnv } from "./index";

afterEach(() => vi.unstubAllEnvs());

describe("isLocalRelay", () => {
  it.each([
    ["http://localhost:8090", true],
    ["http://127.0.0.1:8090", true],
    ["http://[::1]:8090", true],
    ["http://relay.localhost:8090", true],
    ["https://relay.lensacademy.org", false],
    ["http://relay-server:8080", false],
    [undefined, false],
    ["not a url", false],
  ])("%s -> %s", (url, local) => {
    expect(isLocalRelay(url)).toBe(local);
  });
});

describe("startSourceSyncFromEnv", () => {
  const bindings = JSON.stringify([
    { source: "https://docs.google.com/document/d/1hWdq25Nw17538nk5aNG1_a8PxfNUhFKfaa9r0H6fRP4/edit", target: "Lens Edu/articles/x.md", author: ["M"] },
  ]);

  it("does nothing without bindings", () => {
    vi.stubEnv("SOURCE_SYNC_BINDINGS", "");
    expect(startSourceSyncFromEnv({ localRelayOnly: true })).toBeNull();
  });

  it("will not sync from a development server into a relay that is not local", () => {
    vi.stubEnv("SOURCE_SYNC_BINDINGS", bindings);
    vi.stubEnv("RELAY_URL", "https://relay.lensacademy.org");
    const log = { log: vi.fn(), error: vi.fn() };
    expect(startSourceSyncFromEnv({ localRelayOnly: true }, log)).toBeNull();
    expect(log.error).toHaveBeenCalledWith(
      "[source-sync] not started: in development it only syncs into a local relay, and RELAY_URL is https://relay.lensacademy.org",
    );
  });

  it("reports a configuration it cannot use instead of throwing", () => {
    vi.stubEnv("SOURCE_SYNC_BINDINGS", bindings);
    vi.stubEnv("SOURCE_SYNC_INTERVAL_MINUTES", "36000");
    const log = { log: vi.fn(), error: vi.fn() };
    expect(startSourceSyncFromEnv({}, log)).toBeNull();
    expect(log.error).toHaveBeenCalledWith(expect.stringMatching(/not started: SOURCE_SYNC_INTERVAL_MINUTES must be/));
  });
});
