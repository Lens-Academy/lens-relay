import { describe, expect, it, vi } from "vitest";
import { publishedOf } from "./article";
import { logOutcome, startSourceSync, syncBinding } from "./runner";
import type { HostImage, SourceAdapter, SourceContent, SyncBinding, SyncFiles } from "./types";

const DOC = "https://docs.google.com/document/d/abc/edit";

function fakeAdapter(content: Partial<SourceContent> = {}): SourceAdapter & { body: string } {
  const adapter = {
    kind: "google-doc",
    body: "# One\n\nText.",
    matches: (url: string) => url.startsWith("https://docs.google.com/"),
    pull: vi.fn(async (_binding: SyncBinding, hostImage: HostImage) => {
      await hostImage(new Uint8Array([1]));
      return {
        editUrl: DOC,
        title: "Chapter 1 - Capabilities",
        description: "What AI can do.",
        body: adapter.body,
        warnings: [],
        ...content,
      };
    }),
  };
  return adapter;
}

function memoryFiles(initial: Record<string, string> = {}): SyncFiles & { files: Record<string, string>; writes: number } {
  const store = {
    files: { ...initial },
    writes: 0,
    read: async (path: string) => store.files[path] ?? null,
    write: async (path: string, content: string) => {
      store.files[path] = content;
      store.writes++;
    },
    hostImage: async (target: string) => `https://img.test/${target.length}`,
  };
  return store;
}

const binding: SyncBinding = { source: DOC, target: "Lens Edu/Atlas/Chapter 1.md", author: ["Markov Grey"] };

describe("syncBinding", () => {
  it("writes a Lens article carrying the sync marker", async () => {
    const files = memoryFiles();
    const outcome = await syncBinding(binding, { adapters: [fakeAdapter()], files, today: () => "2026-09-28" });
    expect(outcome).toEqual({ target: binding.target, status: "written", warnings: [] });
    expect(files.files[binding.target]).toBe(
      [
        "---",
        'title: "Chapter 1 - Capabilities"',
        "author:",
        '  - "Markov Grey"',
        `source_url: "${DOC}"`,
        "published: 2026-09-28",
        'description: "What AI can do."',
        "tags:",
        '  - "source-sync"',
        "synced_from:",
        '  source: "google-doc"',
        `  url: "${DOC}"`,
        "---",
        "",
        "# One",
        "",
        "Text.",
        "",
      ].join("\n"),
    );
  });

  it("leaves an up-to-date file alone and keeps its published date on later changes", async () => {
    const files = memoryFiles();
    const adapter = fakeAdapter();
    await syncBinding(binding, { adapters: [adapter], files, today: () => "2026-09-28" });

    const again = await syncBinding(binding, { adapters: [adapter], files, today: () => "2026-10-02" });
    expect(again.status).toBe("unchanged");
    expect(files.writes).toBe(1);

    adapter.body = "# One\n\nNew text.";
    const changed = await syncBinding(binding, { adapters: [adapter], files, today: () => "2026-10-02" });
    expect(changed.status).toBe("written");
    expect(publishedOf(files.files[binding.target])).toBe("2026-09-28");
  });

  it("overwrites edits made to the synced copy", async () => {
    const files = memoryFiles();
    const adapter = fakeAdapter();
    await syncBinding(binding, { adapters: [adapter], files, today: () => "2026-09-28" });
    const synced = files.files[binding.target];
    files.files[binding.target] = synced.replace("Text.", "Edited in the editor.");

    expect((await syncBinding(binding, { adapters: [adapter], files })).status).toBe("written");
    expect(files.files[binding.target]).toBe(synced);
  });

  it("uses the binding's title, dates and source_url over the source's", async () => {
    const files = memoryFiles();
    const b = { ...binding, title: "Capabilities", published: "2025-03-01", sourceUrl: "https://ai-safety-atlas.com/chapters/v1/capabilities" };
    await syncBinding(b, { adapters: [fakeAdapter()], files });
    const md = files.files[b.target];
    expect(md).toContain('title: "Capabilities"');
    expect(md).toContain("published: 2025-03-01");
    expect(md).toContain('source_url: "https://ai-safety-atlas.com/chapters/v1/capabilities"');
    expect(md).toContain(`  url: "${DOC}"`);
  });

  it("fails one binding without throwing", async () => {
    const adapter = fakeAdapter();
    adapter.pull.mockRejectedValueOnce(new Error("Google Doc abc is not readable (403)"));
    expect(await syncBinding(binding, { adapters: [adapter], files: memoryFiles() })).toEqual({
      target: binding.target,
      status: "failed",
      warnings: [],
      error: "Google Doc abc is not readable (403)",
    });
    expect(await syncBinding({ ...binding, source: "https://notion.so/x" }, { adapters: [adapter], files: memoryFiles() })).toMatchObject({
      status: "failed",
      error: "no adapter reads https://notion.so/x",
    });
  });
});

describe("startSourceSync", () => {
  it("runs every binding, then again after the interval, until stopped", async () => {
    vi.useFakeTimers();
    try {
      const adapter = fakeAdapter();
      const log = { log: vi.fn(), error: vi.fn() };
      const second = { ...binding, target: "Lens Edu/Atlas/Chapter 2.md" };
      const stop = startSourceSync([binding, second], 60_000, { adapters: [adapter], files: memoryFiles() }, log, ["bad entry"]);

      await vi.advanceTimersByTimeAsync(0);
      expect(adapter.pull).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(adapter.pull).toHaveBeenCalledTimes(4);

      stop();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(adapter.pull).toHaveBeenCalledTimes(4);
      expect(log.log).toHaveBeenCalledWith("[source-sync] Lens Edu/Atlas/Chapter 2.md: written");
      // Bindings that failed validation are reported on every run, not once at boot.
      expect(log.error.mock.calls.filter(([m]) => m === "[source-sync] bad entry")).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("logOutcome", () => {
  it("logs failures as errors and lists warnings", () => {
    const log = { log: vi.fn(), error: vi.fn() };
    logOutcome({ target: "A/b.md", status: "written", warnings: ["w1"] }, log);
    logOutcome({ target: "A/c.md", status: "failed", warnings: [], error: "boom" }, log);
    expect(log.log.mock.calls).toEqual([["[source-sync] A/b.md: written (1 warning(s))"], ["[source-sync]   w1"]]);
    expect(log.error).toHaveBeenCalledWith("[source-sync] A/c.md: failed -- boom");
  });
});
