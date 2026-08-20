import { describe, it, expect } from "vitest";
import { toJson3Url, pickCaptionTrack } from "./fetch-transcript";

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
