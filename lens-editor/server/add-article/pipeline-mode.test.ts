import { describe, expect, it } from "vitest";
import {
  ARTICLE_IMPORT_MODES,
  type ArticleImportMode,
} from "../../shared/article-import-contract";
import { articleImportBehavior } from "./pipeline";

describe("articleImportBehavior", () => {
  it.each([
    ["stub", { stubOnly: true, createLens: false }],
    ["article", { stubOnly: false, createLens: false }],
    ["article-and-lens", { stubOnly: false, createLens: true }],
  ] satisfies Array<[ArticleImportMode, ReturnType<typeof articleImportBehavior>]>)(
    "maps %s to its pipeline behavior",
    (mode, expected) => {
      expect(articleImportBehavior(mode)).toEqual(expected);
    },
  );

  it("covers every mode in the shared contract", () => {
    expect(ARTICLE_IMPORT_MODES).toHaveLength(3);
    for (const mode of ARTICLE_IMPORT_MODES) {
      expect(() => articleImportBehavior(mode)).not.toThrow();
    }
  });
});
