import { describe, it, expect } from "vitest";
import { isVideoEmbedUrl, videoEmbedMarker } from "./util";

describe("isVideoEmbedUrl — exact hostname allow-list", () => {
  it("accepts real YouTube / Vimeo embeds", () => {
    for (const ok of [
      "https://www.youtube-nocookie.com/embed/kK3NmQT241w",
      "https://www.youtube.com/embed/abc123",
      "https://youtube.com/embed/abc123",
      "https://youtu.be/abc123",
      "https://player.vimeo.com/video/123456",
      "https://vimeo.com/123456",
      "//www.youtube.com/embed/x", // protocol-relative resolves to https
    ]) {
      expect(isVideoEmbedUrl(ok)).toBe(true);
    }
  });

  it("rejects look-alike hosts and injection vectors that a substring match would pass", () => {
    const bad: (string | null | undefined)[] = [
      "https://vimeo.com.evil.com/pwn", // allow-listed string as a label prefix
      "https://youtube.com.attacker.net/x",
      "https://notyoutube.com/embed/x", // "youtube.com" is a substring
      "https://evil.com/x?youtube.com", // in the query string
      "https://attacker.net/youtu.be/x", // in the path
      "javascript:alert(1)//youtube.com", // non-http scheme
      "data:text/html,<b>youtube.com</b>",
      "embed/x", // relative → throwaway base host
      "",
      null,
      undefined,
    ];
    for (const b of bad) {
      expect(isVideoEmbedUrl(b)).toBe(false);
    }
  });
});

describe("videoEmbedMarker", () => {
  it("emits a marker with the normalized absolute-https URL", () => {
    expect(videoEmbedMarker("//www.youtube.com/embed/abc123")).toBe(
      "__lensvideo:https://www.youtube.com/embed/abc123__",
    );
  });

  it("normalizes hostile srcs through URL() so no raw quotes survive", () => {
    const marker = videoEmbedMarker('https://www.youtube.com/embed/x"><script>1</script>');
    expect(marker).not.toContain('"');
    expect(marker).toMatch(/^__lensvideo:https:\/\/www\.youtube\.com\/\S+__$/);
  });

  it("emits nothing for an unparseable src", () => {
    expect(videoEmbedMarker("javascript:alert(1)")).toBe("");
  });
});
