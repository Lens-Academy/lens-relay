import { describe, it, expect, vi, afterEach } from "vitest";

const fetchMock = vi.hoisted(() => vi.fn());
vi.mock("../fetch-timeout", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../fetch-timeout")>()),
  fetchBytesWithTimeout: fetchMock,
}));

import { toJson3Url, pickCaptionTrack, fetchYouTubeVideoMeta } from "./fetch-transcript";

describe("toJson3Url", () => {
  // fmt is not covered by the URL signature (sparams), so rewriting it is the
  // supported way to get json3 from an ANDROID-minted srv3 track URL.
  it("replaces an existing fmt and preserves everything else", () => {
    const url = toJson3Url(
      "https://www.youtube.com/api/timedtext?v=abc&signature=sig&fmt=srv3&lang=en",
    );
    const u = new URL(url);
    expect(u.searchParams.get("fmt")).toBe("json3");
    expect(u.searchParams.get("signature")).toBe("sig");
    expect(u.searchParams.get("lang")).toBe("en");
  });

  it("adds fmt when missing", () => {
    expect(toJson3Url("https://www.youtube.com/api/timedtext?v=abc")).toContain(
      "fmt=json3",
    );
  });
});

describe("pickCaptionTrack", () => {
  it("prefers exact en, then en variants, then the first track", () => {
    expect(
      pickCaptionTrack([
        { languageCode: "tr" },
        { languageCode: "en-GB" },
        { languageCode: "en" },
      ]).languageCode,
    ).toBe("en");
    expect(
      pickCaptionTrack([{ languageCode: "tr" }, { languageCode: "en-GB" }])
        .languageCode,
    ).toBe("en-GB");
    expect(
      pickCaptionTrack([{ languageCode: "tr" }, { languageCode: "de" }])
        .languageCode,
    ).toBe("tr");
  });
});

describe("pickCaptionTrack track kind", () => {
  it("prefers a human track over an auto-generated one in the same language", () => {
    // Rob Miles' channel publishes exactly this pair; matching on language
    // alone picked the asr track and then paid an LLM to repair it.
    expect(
      pickCaptionTrack([
        { languageCode: "en", kind: "asr" },
        { languageCode: "en-GB" },
      ]).languageCode,
    ).toBe("en-GB");
  });

  it("keeps English asr over a human translation into another language", () => {
    expect(
      pickCaptionTrack([
        { languageCode: "fr" },
        { languageCode: "en", kind: "asr" },
      ]).languageCode,
    ).toBe("en");
    expect(
      pickCaptionTrack([
        { languageCode: "es" },
        { languageCode: "de" },
        { languageCode: "en-GB", kind: "asr" },
      ]).languageCode,
    ).toBe("en-GB");
  });

  it("still prefers exact en over en-GB when both are human", () => {
    expect(
      pickCaptionTrack([{ languageCode: "en-GB" }, { languageCode: "en" }])
        .languageCode,
    ).toBe("en");
  });
});

describe("fetchYouTubeVideoMeta", () => {
  afterEach(() => fetchMock.mockReset());
  const input = { video_id: "pYXy-A4siMw", url: "https://youtu.be/pYXy-A4siMw" };
  const reply = (status: number, body: unknown) => ({
    ok: status === 200,
    status,
    bytes: new TextEncoder().encode(JSON.stringify(body)),
  });

  it("reads the title and channel from oEmbed, without the player API", async () => {
    fetchMock.mockResolvedValue(
      reply(200, { title: "Intro to AI Safety, Remastered", author_name: "Robert Miles AI Safety " }),
    );

    await expect(fetchYouTubeVideoMeta(input)).resolves.toEqual({
      title: "Intro to AI Safety, Remastered",
      channel: "Robert Miles AI Safety",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0][0])).toContain(
      "oembed?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DpYXy-A4siMw",
    );
  });

  it("falls back to the player API when oEmbed has no answer", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchMock.mockImplementation(async (url: string) =>
      url.includes("oembed")
        ? reply(401, {})
        : reply(200, {
            playabilityStatus: { status: "OK" },
            videoDetails: { title: "From the player", author: "Channel" },
          }),
    );

    await expect(fetchYouTubeVideoMeta(input)).resolves.toEqual({
      title: "From the player",
      channel: "Channel",
    });
  });
});
