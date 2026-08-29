import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  resolveVideoEmbeds,
  transcriptWikilinkTarget,
} from "./video-embeds";
import { checkRelayVideoIds } from "../add-video/relay-docs";
import { fetchYouTubeTranscript } from "../add-video/fetch-transcript";
import { importVideo } from "../add-video/pipeline";

vi.mock("../add-video/relay-docs", () => ({
  checkRelayVideoIds: vi.fn(),
  relayTranscriptFolder: () => "Lens Edu/video_transcripts",
}));
vi.mock("../add-video/fetch-transcript", () => ({
  fetchYouTubeTranscript: vi.fn(),
}));
vi.mock("../add-video/pipeline", () => ({
  importVideo: vi.fn(),
}));

const mockCheck = vi.mocked(checkRelayVideoIds);
const mockFetch = vi.mocked(fetchYouTubeTranscript);
const mockImport = vi.mocked(importVideo);

const OPTS = { jobId: "job1", createdAt: "2026-08-30T00:00:00Z" };

beforeEach(() => {
  vi.clearAllMocks();
  mockCheck.mockResolvedValue({});
});

describe("transcriptWikilinkTarget", () => {
  it("builds the ../video_transcripts target relative to the articles folder", () => {
    expect(
      transcriptWikilinkTarget("Lens Edu/video_transcripts/some-video.md"),
    ).toBe("../video_transcripts/some-video");
  });
});

describe("resolveVideoEmbeds", () => {
  it("returns bodies unchanged when there are no markers", async () => {
    const bodies = ["Just prose.", "More prose."];
    const result = await resolveVideoEmbeds(bodies, OPTS);
    expect(result.bodies).toEqual(bodies);
    expect(result.resolutions).toEqual([]);
    expect(mockCheck).not.toHaveBeenCalled();
  });

  it("links an existing transcript without importing", async () => {
    mockCheck.mockResolvedValue({ abc123XYZ_1: "/video_transcripts/existing-video.md" });
    const result = await resolveVideoEmbeds(
      ["Before\n\n__lensvideo:https://www.youtube.com/embed/abc123XYZ_1__\n\nAfter"],
      OPTS,
    );
    expect(result.bodies[0]).toBe(
      "Before\n\n::video[[../video_transcripts/existing-video]]\n\nAfter",
    );
    expect(result.resolutions).toEqual([
      {
        url: "https://www.youtube.com/embed/abc123XYZ_1",
        outcome: "linked-existing",
        transcriptPath: "Lens Edu/video_transcripts/existing-video.md",
      },
    ]);
    expect(mockImport).not.toHaveBeenCalled();
  });

  it("imports a missing YouTube video, then links it", async () => {
    const payload = { video_id: "abc123XYZ_1" };
    mockFetch.mockResolvedValue(payload as never);
    mockImport.mockResolvedValue({ mdPath: "Lens Edu/video_transcripts/fresh-video.md" });
    const result = await resolveVideoEmbeds(
      ["__lensvideo:https://www.youtube.com/watch?v=abc123XYZ_1__"],
      OPTS,
    );
    expect(result.bodies[0]).toBe("::video[[../video_transcripts/fresh-video]]");
    expect(result.resolutions[0]).toMatchObject({ outcome: "imported" });
    expect(mockImport).toHaveBeenCalledWith(
      "job1-video-abc123XYZ_1",
      payload,
      OPTS.createdAt,
      expect.objectContaining({ createLens: false }),
    );
  });

  it("imports a video shared by both candidates exactly once", async () => {
    mockFetch.mockResolvedValue({ video_id: "abc123XYZ_1" } as never);
    mockImport.mockResolvedValue({ mdPath: "Lens Edu/video_transcripts/shared.md" });
    const marker = "__lensvideo:https://www.youtube.com/watch?v=abc123XYZ_1__";
    // Same video, different URL shapes across candidates.
    const embedMarker = "__lensvideo:https://www.youtube.com/embed/abc123XYZ_1__";
    const result = await resolveVideoEmbeds([marker, embedMarker], OPTS);
    expect(mockImport).toHaveBeenCalledTimes(1);
    expect(result.bodies).toEqual([
      "::video[[../video_transcripts/shared]]",
      "::video[[../video_transcripts/shared]]",
    ]);
  });

  it("degrades a non-YouTube embed to a plain canonical link", async () => {
    const result = await resolveVideoEmbeds(
      ["__lensvideo:https://player.vimeo.com/video/12345__"],
      OPTS,
    );
    expect(result.bodies[0]).toBe("<https://vimeo.com/12345>");
    expect(result.resolutions[0]).toMatchObject({ outcome: "external-link" });
    expect(mockCheck).not.toHaveBeenCalled();
  });

  it("degrades to a watch-URL link when the import fails, without failing", async () => {
    mockFetch.mockRejectedValue(new Error("no captions endpoint"));
    const result = await resolveVideoEmbeds(
      ["__lensvideo:https://www.youtube.com/embed/abc123XYZ_1__"],
      OPTS,
    );
    expect(result.bodies[0]).toBe("<https://www.youtube.com/watch?v=abc123XYZ_1>");
    expect(result.resolutions[0]).toMatchObject({
      outcome: "import-failed",
      error: expect.stringContaining("no captions"),
    });
  });

  it("treats a failed dedupe check as not-found and still imports", async () => {
    mockCheck.mockRejectedValue(new Error("relay down"));
    mockFetch.mockResolvedValue({ video_id: "abc123XYZ_1" } as never);
    mockImport.mockResolvedValue({ mdPath: "Lens Edu/video_transcripts/v.md" });
    const result = await resolveVideoEmbeds(
      ["__lensvideo:https://www.youtube.com/watch?v=abc123XYZ_1__"],
      OPTS,
    );
    expect(result.bodies[0]).toBe("::video[[../video_transcripts/v]]");
  });

  it("keeps a video id containing double underscores intact", async () => {
    mockFetch.mockResolvedValue({ video_id: "ab__c123XYZ" } as never);
    mockImport.mockResolvedValue({ mdPath: "Lens Edu/video_transcripts/u.md" });
    const result = await resolveVideoEmbeds(
      ["__lensvideo:https://www.youtube.com/watch?v=ab__c123XYZ__"],
      OPTS,
    );
    expect(result.bodies[0]).toBe("::video[[../video_transcripts/u]]");
    expect(mockImport).toHaveBeenCalledWith(
      "job1-video-ab__c123XYZ",
      expect.anything(),
      OPTS.createdAt,
      expect.objectContaining({ createLens: false }),
    );
  });

  it("never leaks marker syntax", async () => {
    mockFetch.mockRejectedValue(new Error("x"));
    const bodies = [
      "A __lensvideo:https://www.youtube.com/watch?v=abc123XYZ_1__ B",
      "__lensvideo:not-a-url__",
    ];
    const result = await resolveVideoEmbeds(bodies, OPTS);
    for (const body of result.bodies) expect(body).not.toContain("__lensvideo:");
  });
});
