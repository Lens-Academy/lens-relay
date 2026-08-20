import { describe, it, expect } from "vitest";
import {
  extractVideoInput,
  isYouTubeUrl,
  toJson3Url,
  pickCaptionTrack,
} from "./fetch-transcript";

describe("isYouTubeUrl", () => {
  it("covers the real YouTube hosts", () => {
    expect(isYouTubeUrl("https://www.youtube.com/watch?v=Nl7-bRFSZBs")).toBe(true);
    expect(isYouTubeUrl("https://youtube.com/watch?v=Nl7-bRFSZBs")).toBe(true);
    expect(isYouTubeUrl("https://m.youtube.com/watch?v=Nl7-bRFSZBs")).toBe(true);
    expect(isYouTubeUrl("https://youtu.be/Nl7-bRFSZBs")).toBe(true);
    expect(isYouTubeUrl("https://www.youtube-nocookie.com/embed/Nl7-bRFSZBs")).toBe(true);
    expect(isYouTubeUrl("https://www.youtube.com/@somechannel")).toBe(true);
  });

  it("rejects lookalikes and non-URLs", () => {
    expect(isYouTubeUrl("https://notyoutube.com/watch?v=Nl7-bRFSZBs")).toBe(false);
    expect(isYouTubeUrl("https://example.com/youtube.com-article")).toBe(false);
    expect(isYouTubeUrl("not a url")).toBe(false);
  });
});

describe("extractVideoInput", () => {
  it("extracts watch, shorts, embed, live and youtu.be forms", () => {
    expect(
      extractVideoInput("https://www.youtube.com/watch?v=Nl7-bRFSZBs&t=42s"),
    ).toEqual({
      video_id: "Nl7-bRFSZBs",
      url: "https://www.youtube.com/watch?v=Nl7-bRFSZBs",
    });
    expect(extractVideoInput("https://youtu.be/Nl7-bRFSZBs?si=xyz")).toEqual({
      video_id: "Nl7-bRFSZBs",
      url: "https://www.youtube.com/watch?v=Nl7-bRFSZBs",
    });
    expect(
      extractVideoInput("https://www.youtube.com/shorts/Nl7-bRFSZBs"),
    ).toEqual({
      video_id: "Nl7-bRFSZBs",
      url: "https://www.youtube.com/shorts/Nl7-bRFSZBs",
    });
    expect(
      extractVideoInput("https://www.youtube.com/embed/Nl7-bRFSZBs"),
    ).toEqual({
      video_id: "Nl7-bRFSZBs",
      url: "https://www.youtube.com/watch?v=Nl7-bRFSZBs",
    });
    expect(
      extractVideoInput("https://www.youtube.com/live/Nl7-bRFSZBs"),
    ).toEqual({
      video_id: "Nl7-bRFSZBs",
      url: "https://www.youtube.com/watch?v=Nl7-bRFSZBs",
    });
  });

  it("returns null for YouTube URLs that are not a single video", () => {
    expect(extractVideoInput("https://www.youtube.com/@somechannel")).toBeNull();
    expect(
      extractVideoInput("https://www.youtube.com/playlist?list=PLxyz"),
    ).toBeNull();
    expect(extractVideoInput("https://www.youtube.com/results?search_query=ai")).toBeNull();
  });

  it("returns null for non-YouTube URLs even with a v param", () => {
    expect(extractVideoInput("https://example.com/watch?v=Nl7-bRFSZBs")).toBeNull();
  });
});

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
