import { afterEach, describe, it, expect, vi } from "vitest";
import { attachmentPublicUrl, parsePublicUrlMap, publicBaseUrlForFolder } from "./public-url";

afterEach(() => vi.unstubAllEnvs());

describe("attachment public URLs", () => {
  it("defaults Lens Edu to the staging raw URL when unconfigured", () => {
    vi.stubEnv("ATTACHMENT_PUBLIC_URLS", "");
    expect(attachmentPublicUrl("Lens Edu", "/attachments/a.png")).toBe(
      "https://raw.githubusercontent.com/Lens-Academy/lens-edu-staging/staging/attachments/a.png",
    );
    expect(attachmentPublicUrl("Lens", "/attachments/a.png")).toBeNull();
  });

  it("reads folder -> base pairs from the environment", () => {
    vi.stubEnv(
      "ATTACHMENT_PUBLIC_URLS",
      "Lens Edu=https://raw.example/edu/staging/; Lens = https://raw.example/lens/main ;junk",
    );
    expect(publicBaseUrlForFolder("Lens Edu")).toBe("https://raw.example/edu/staging");
    expect(publicBaseUrlForFolder("Lens")).toBe("https://raw.example/lens/main");
    expect(publicBaseUrlForFolder("Other")).toBeNull();
    expect(attachmentPublicUrl("Lens", "/attachments/fig one.png")).toBe(
      "https://raw.example/lens/main/attachments/fig%20one.png",
    );
  });

  it("parsePublicUrlMap ignores malformed entries", () => {
    const m = parsePublicUrlMap("=x;A=;B=https://b");
    expect([...m.entries()]).toEqual([["B", "https://b"]]);
  });
});
