import { describe, expect, it } from "vitest";
import type { FetchBytesResult } from "../../fetch-timeout";
import { iframeChart } from "./definition";
import { chartFetch, fetchSpec, Gone, MAX_CHART_BYTES } from "./fetch";

type Call = { url: string; maxBytes?: number; timeoutMs: number; userAgent?: string };

/** fetchBytesWithTimeout over a table of answers: status, and body or Location. */
function fake(answers: Record<string, [number, string]>) {
  const calls: Call[] = [];
  const fetchBytes = async (url: string, opts: { timeoutMs: number; maxBytes?: number; headers?: Record<string, string> }): Promise<FetchBytesResult> => {
    calls.push({ url, maxBytes: opts.maxBytes, timeoutMs: opts.timeoutMs, userAgent: opts.headers?.["User-Agent"] });
    const [status, body] = answers[url] ?? [404, "not found"];
    const redirect = status >= 300 && status < 400;
    const bytes = new TextEncoder().encode(redirect ? "" : body).buffer as ArrayBuffer;
    return { status, ok: status >= 200 && status < 300, statusText: "", headers: new Headers(redirect ? { location: body } : {}), bytes };
  };
  return { calls, get: chartFetch({ gapMs: 0, fetchBytes: fetchBytes as never }) };
}

describe("chartFetch", () => {
  it("reads https files of the allowed hosts, 30 s and 10 MB at most, with a plain User-Agent", async () => {
    const { calls, get } = fake({ "https://epoch.ai/data/a.csv": [200, "x,y\n"] });
    expect(await get("https://epoch.ai/data/a.csv")).toBe("x,y\n");
    expect(calls).toEqual([{ url: "https://epoch.ai/data/a.csv", maxBytes: MAX_CHART_BYTES, timeoutMs: 30_000, userAgent: expect.stringMatching(/^LensAcademy-atlas-sync\//) }]);
    await expect(get("https://example.org/a.csv")).rejects.toThrow(/not an https link to an allowed host/);
    await expect(get("http://epoch.ai/data/a.csv")).rejects.toThrow(/not an https link/);
    expect(calls).toHaveLength(1);
  });

  it("follows a redirect only to an allowed host, and names the status of a refusal", async () => {
    const { get } = fake({
      "https://ourworldindata.org/grapher/old.csv": [301, "/grapher/new.csv"],
      "https://ourworldindata.org/grapher/new.csv": [200, "ok"],
      "https://ourworldindata.org/grapher/out.csv": [302, "https://example.org/x.csv"],
      "https://ourworldindata.org/grapher/locked.csv": [403, "Forbidden"],
      "https://ourworldindata.org/grapher/old-gone.csv": [301, "/grapher/missing.csv"],
      "https://ourworldindata.org/grapher/broken.csv": [502, "Bad Gateway"],
    });
    expect(await get("https://ourworldindata.org/grapher/old.csv")).toBe("ok");
    await expect(get("https://ourworldindata.org/grapher/out.csv")).rejects.toThrow(/example.org\/x.csv is not an https link/);
    await expect(get("https://ourworldindata.org/grapher/locked.csv")).rejects.toThrow("https://ourworldindata.org/grapher/locked.csv answered 403");
    // 404 and 403, also after a redirect, say the chart is gone; anything else may pass.
    await expect(get("https://ourworldindata.org/grapher/locked.csv")).rejects.toBeInstanceOf(Gone);
    await expect(get("https://ourworldindata.org/grapher/old-gone.csv")).rejects.toBeInstanceOf(Gone);
    await expect(get("https://ourworldindata.org/grapher/broken.csv")).rejects.not.toBeInstanceOf(Gone);
  });

  it("keeps its distance between requests", async () => {
    const get = chartFetch({ gapMs: 50, fetchBytes: (async () => ({ status: 200, ok: true, statusText: "", headers: new Headers(), bytes: new ArrayBuffer(0) })) as never });
    const start = Date.now();
    await get("https://epoch.ai/a.csv");
    await get("https://epoch.ai/b.csv");
    expect(Date.now() - start).toBeGreaterThanOrEqual(45);
  });
});

describe("fetchSpec", () => {
  it("reads an OWID chart's config first, and stops there for a map", async () => {
    const urls: string[] = [];
    const get = async (url: string) => {
      urls.push(url);
      return JSON.stringify({ tab: "map" });
    };
    await expect(fetchSpec(iframeChart("https://ourworldindata.org/grapher/electricity-generation")!, get, "2026-11-13")).rejects.toThrow(/as a map/);
    expect(urls).toEqual(["https://ourworldindata.org/grapher/electricity-generation.config.json"]);
  });
});
