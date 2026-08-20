import { describe, it, expect } from "vitest";
import { extractVideoInput, isYouTubeUrl } from "./video-url";

describe("isYouTubeUrl", () => {
  it("covers the real YouTube hosts", () => {
    expect(isYouTubeUrl("https://www.youtube.com/watch?v=Nl7-bRFSZBs")).toBe(true);
    expect(isYouTubeUrl("https://youtube.com/watch?v=Nl7-bRFSZBs")).toBe(true);
    expect(isYouTubeUrl("https://m.youtube.com/watch?v=Nl7-bRFSZBs")).toBe(true);
    expect(isYouTubeUrl("https://youtu.be/Nl7-bRFSZBs")).toBe(true);
    expect(isYouTubeUrl("https://www.youtube-nocookie.com/embed/Nl7-bRFSZBs")).toBe(true);
    expect(isYouTubeUrl("https://www.youtube.com/@somechannel")).toBe(true);
  });

  // Prevents: regressing to a fixed-subdomain list narrower than the deleted
  // Rust MCP guard, which let odd-but-real YouTube hosts fall through to the
  // article scraper.
  it("covers arbitrary subdomains and trailing-dot hosts", () => {
    expect(isYouTubeUrl("https://gaming.youtube.com/watch?v=Nl7-bRFSZBs")).toBe(true);
    expect(isYouTubeUrl("https://www.youtube.com./watch?v=Nl7-bRFSZBs")).toBe(true);
    expect(
      extractVideoInput("https://gaming.youtube.com/watch?v=Nl7-bRFSZBs")?.video_id,
    ).toBe("Nl7-bRFSZBs");
    expect(
      extractVideoInput("https://youtu.be./Nl7-bRFSZBs")?.video_id,
    ).toBe("Nl7-bRFSZBs");
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
