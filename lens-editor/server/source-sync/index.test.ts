import { afterEach, describe, expect, it, vi } from "vitest";
import { startCourseSync } from "./iliad/sync";
import { isLocalRelay, startIliadSyncFromEnv, startSourceSyncFromEnv } from "./index";

// The real loop starts a run at once, which reads iliad-intensive.org.
vi.mock("./iliad/sync", () => ({ startCourseSync: vi.fn(() => () => {}) }));

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

describe("startIliadSyncFromEnv", () => {
  const COURSE = "Lens Edu/courses/user-facing/iliad-intensive.md";

  it("does nothing while ILIAD_SYNC_COURSE is unset", () => {
    vi.stubEnv("ILIAD_SYNC_COURSE", "");
    expect(startIliadSyncFromEnv()).toBeNull();
    expect(startCourseSync).not.toHaveBeenCalled();
  });

  it("syncs the course it is given, into folders beside it, with no model and no approval unless set", () => {
    vi.stubEnv("ILIAD_SYNC_COURSE", COURSE);
    vi.stubEnv("SOURCE_SYNC_INTERVAL_MINUTES", "15");
    expect(startIliadSyncFromEnv()).toBeTypeOf("function");
    const [options, interval] = vi.mocked(startCourseSync).mock.calls.at(-1)!;
    expect(interval).toBe(15 * 60_000);
    expect(options.layout).toMatchObject({ course: COURSE, moduleDir: "Lens Edu/modules/Iliad" });
    expect(options.ask).toBeUndefined();
    expect(options.approvedRetirement).toBeUndefined();
  });

  it("passes on the approved commit and the model when they are set", () => {
    vi.stubEnv("ILIAD_SYNC_COURSE", COURSE);
    vi.stubEnv("ILIAD_SYNC_SUMMARIES", "1");
    vi.stubEnv("ILIAD_SYNC_APPROVE_RETIREMENT", " d5fec17 ");
    startIliadSyncFromEnv();
    const [options] = vi.mocked(startCourseSync).mock.calls.at(-1)!;
    expect(options.ask).toBeTypeOf("function");
    expect(options.approvedRetirement).toBe("d5fec17");
  });

  it("reports a course path it cannot use instead of throwing", () => {
    vi.stubEnv("ILIAD_SYNC_COURSE", "iliad-intensive-demo");
    const log = { log: vi.fn(), error: vi.fn() };
    expect(startIliadSyncFromEnv(log)).toBeNull();
    expect(log.error).toHaveBeenCalledWith(expect.stringMatching(/not started: ILIAD_SYNC_COURSE must be/));
  });
});
