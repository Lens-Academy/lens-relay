import { beforeEach, describe, expect, it, vi } from "vitest";
import { DuplicateDocumentError } from "./duplicate";

const relayMocks = vi.hoisted(() => ({
  checkRelayArticleUrls: vi.fn(),
  checkRelayDocsExist: vi.fn(),
  createRelayDoc: vi.fn(),
  createRelayAttachment: vi.fn(),
  checkRelayVideoIds: vi.fn(),
  relayTranscriptFolder: () => "Lens Edu/video_transcripts",
  editorOpenUrl: (p: string) => `https://editor.lensacademy.org/open/${encodeURI(p)}`,
}));
const videoMocks = vi.hoisted(() => ({
  importVideo: vi.fn(),
  fetchYouTubeTranscript: vi.fn(),
}));

vi.mock("../add-video/relay-docs", () => relayMocks);
vi.mock("../add-video/pipeline", () => ({ importVideo: videoMocks.importVideo }));
vi.mock("../add-video/fetch-transcript", () => ({
  fetchYouTubeTranscript: videoMocks.fetchYouTubeTranscript,
}));

import { processArticle } from "./pipeline";
import { extractVideoInput } from "../add-video/video-url";

const url = "https://www.youtube.com/watch?v=oH-txHzE4jA";
const job = (replaceExisting?: boolean) => {
  const now = new Date().toISOString();
  return {
    id: "video",
    url,
    status: "processing" as const,
    importMode: "article-and-lens" as const,
    video: extractVideoInput(url) ?? undefined,
    ...(replaceExisting ? { replaceExisting } : {}),
    created_at: now,
    updated_at: now,
  };
};

describe("processArticle video re-import", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    videoMocks.fetchYouTubeTranscript.mockResolvedValue({ title: "Chess clip" });
    videoMocks.importVideo.mockResolvedValue({ mdPath: "x" });
  });

  it("still skips an already-imported video without the flag", async () => {
    relayMocks.checkRelayVideoIds.mockResolvedValue({ "oH-txHzE4jA": "/video_transcripts/Chess.md" });

    const err = await processArticle(job()).catch((e) => e);
    expect(err).toBeInstanceOf(DuplicateDocumentError);
    expect(videoMocks.importVideo).not.toHaveBeenCalled();
  });

  it("re-imports over the existing transcript's path with the flag", async () => {
    relayMocks.checkRelayVideoIds.mockResolvedValue({ "oH-txHzE4jA": "/video_transcripts/Chess.md" });

    await processArticle(job(true));
    expect(videoMocks.importVideo).toHaveBeenCalledOnce();
    expect(videoMocks.importVideo.mock.calls[0][3]).toMatchObject({
      createLens: true,
      replaceExisting: { mdPath: "Lens Edu/video_transcripts/Chess.md" },
    });
  });

  it("imports normally when the flag is set but the video is not in the library yet", async () => {
    relayMocks.checkRelayVideoIds.mockResolvedValue({ "oH-txHzE4jA": null });

    await processArticle(job(true));
    expect(videoMocks.importVideo.mock.calls[0][3].replaceExisting).toBeUndefined();
  });

  it("refuses to re-import when the existing transcript cannot be looked up", async () => {
    relayMocks.checkRelayVideoIds.mockRejectedValue(new Error("relay down"));

    await expect(processArticle(job(true))).rejects.toThrow(/nothing was re-imported/);
    expect(videoMocks.importVideo).not.toHaveBeenCalled();
  });
});
