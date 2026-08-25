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
