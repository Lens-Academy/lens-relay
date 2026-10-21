import { beforeEach, describe, expect, it, vi } from "vitest";
import { DuplicateDocumentError } from "./duplicate";

const relayMocks = vi.hoisted(() => ({
  checkRelayArticleUrls: vi.fn(),
  checkRelayDocsExist: vi.fn(),
  createRelayDoc: vi.fn(),
  createRelayAttachment: vi.fn(),
  checkRelayVideoIds: vi.fn(),
  readRelayDocAtPath: vi.fn(),
  relayTranscriptFolder: () => "Lens Edu/video_transcripts",
  editorOpenUrl: (p: string) => `https://editor.lensacademy.org/open/${encodeURI(p)}`,
}));
const videoMocks = vi.hoisted(() => ({
  importVideo: vi.fn(),
  fetchYouTubeTranscript: vi.fn(),
  fetchYouTubeVideoMeta: vi.fn(),
}));

vi.mock("../add-video/relay-docs", () => relayMocks);
vi.mock("../add-video/pipeline", () => ({ importVideo: videoMocks.importVideo }));
vi.mock("../add-video/fetch-transcript", () => ({
  fetchYouTubeTranscript: videoMocks.fetchYouTubeTranscript,
  fetchYouTubeVideoMeta: videoMocks.fetchYouTubeVideoMeta,
}));

import { processArticle } from "./pipeline";
import { extractVideoInput } from "../add-video/video-url";

const url = "https://www.youtube.com/watch?v=oH-txHzE4jA";
const job = (
  replaceExisting?: boolean,
  importMode: "stub" | "article" | "article-and-lens" = "article-and-lens",
) => {
  const now = new Date().toISOString();
  return {
    id: "video",
    url,
    status: "processing" as const,
    importMode,
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
    relayMocks.readRelayDocAtPath.mockResolvedValue(
      '---\ntitle: "Chess clip"\nurl: "https://www.youtube.com/watch?v=oH-txHzE4jA"\n---\n\nTranscript.\n',
    );
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

describe("processArticle video stubs", () => {
  const stub =
    '---\ntitle: "Chess clip"\nchannel: "Chess Channel"\nurl: "https://www.youtube.com/watch?v=oH-txHzE4jA"\n' +
    'tags:\n  - "video-stub"\n  - "validator-ignore"\n---\n\n%%\nA note.\n%%\n';

  beforeEach(() => {
    vi.clearAllMocks();
    videoMocks.fetchYouTubeTranscript.mockResolvedValue({ title: "Chess clip" });
    videoMocks.fetchYouTubeVideoMeta.mockResolvedValue({ title: "Chess clip", channel: "Chess Channel" });
    videoMocks.importVideo.mockResolvedValue({ mdPath: "x" });
    relayMocks.checkRelayDocsExist.mockResolvedValue({});
    relayMocks.createRelayDoc.mockResolvedValue(undefined);
  });

  it("writes a stub with the video's details and a discussion area, without the transcript", async () => {
    relayMocks.checkRelayVideoIds.mockResolvedValue({ "oH-txHzE4jA": null });
    const j = job(false, "stub");

    await processArticle(j);

    expect(videoMocks.fetchYouTubeTranscript).not.toHaveBeenCalled();
    expect(videoMocks.importVideo).not.toHaveBeenCalled();
    const [path, md] = relayMocks.createRelayDoc.mock.calls[0];
    expect(path).toBe("Lens Edu/video_transcripts/chess-channel-chess-clip.md");
    expect(md).toBe(
      '---\ntitle: "Chess clip"\nchannel: "Chess Channel"\nurl: "https://www.youtube.com/watch?v=oH-txHzE4jA"\n' +
        'tags:\n  - "video-stub"\n  - "validator-ignore"\n---\n\n%%\nAdd discussion note here:\n\n...\n\n%%\n',
    );
    expect(j).toMatchObject({
      title: "Chess clip",
      relay_path: path,
      relay_url: `https://editor.lensacademy.org/open/${encodeURI(path)}`,
    });
  });

  it("skips a video that already has a stub", async () => {
    relayMocks.checkRelayVideoIds.mockResolvedValue({ "oH-txHzE4jA": "/video_transcripts/Chess.md" });
    relayMocks.readRelayDocAtPath.mockResolvedValue(stub);

    const err = await processArticle(job(false, "stub")).catch((e) => e);
    expect(err).toBeInstanceOf(DuplicateDocumentError);
    expect(err.message).toMatch(/video stub already exists/);
    expect(relayMocks.createRelayDoc).not.toHaveBeenCalled();
  });

  it("fills an existing stub in instead of skipping the video", async () => {
    relayMocks.checkRelayVideoIds.mockResolvedValue({ "oH-txHzE4jA": "/video_transcripts/Chess.md" });
    relayMocks.readRelayDocAtPath.mockResolvedValue(stub);

    await processArticle(job());
    expect(relayMocks.readRelayDocAtPath).toHaveBeenCalledWith("Lens Edu/video_transcripts/Chess.md", undefined);
    expect(videoMocks.importVideo.mock.calls[0][3]).toMatchObject({
      stubPath: "Lens Edu/video_transcripts/Chess.md",
      replaceExisting: undefined,
    });
  });
});
