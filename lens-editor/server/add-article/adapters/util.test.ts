import { describe, it, expect } from "vitest";
import { isVideoEmbedUrl, videoEmbedIframe } from "./util";

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

describe("videoEmbedIframe", () => {
  it("emits a normalized absolute-https iframe for a valid embed", () => {
    const html = videoEmbedIframe("//www.youtube.com/embed/abc123");
    expect(html).toContain('src="https://www.youtube.com/embed/abc123"');
    expect(html).toContain("allowfullscreen");
  });

  it("strips quotes / can't break out of the src attribute", () => {
    // A would-be breakout src is normalized through URL(); the emitted href
    // is %-encoded so no raw quote survives to break the attribute.
    const html = videoEmbedIframe('https://www.youtube.com/embed/x"></iframe><script>1</script>');
    expect(html).not.toContain('"></iframe><script>');
    expect(html.match(/<iframe/g)?.length).toBe(1);
  });
});
