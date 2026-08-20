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
