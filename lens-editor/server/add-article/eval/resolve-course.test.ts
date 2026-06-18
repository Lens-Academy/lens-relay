import { describe, it, expect } from "vitest";
import { resolveCourseArticles } from "./resolve-course";

const DOCS: Record<string, string> = {
  "courses/Navigating Superintelligence.md":
    `# Module: [[../modules/m1]]\n# Meeting: Intro\n# Module:  [[../modules/m2]]`,
  // m1: a direct Lens segment AND a Learning Outcome
  "modules/m1.md":
    `# Lens:\nsource:: [[../Lenses/Direct Lens]]\n# Learning Outcome:\nsource:: [[../Learning Outcomes/LO1]]`,
  // m2: a Learning Outcome only
  "modules/m2.md":
    `# Learning Outcome:\nsource:: ![[../Learning Outcomes/LO2|LO2]]`,
  "Learning Outcomes/LO1.md": `## Lens:\nsource:: ![[../Lenses/Lens A|Lens A]]`,
  "Learning Outcomes/LO2.md": `## Lens:\nsource:: [[../Lenses/Lens B]]`,
  // Direct Lens has 2 article segments
  "Lenses/Direct Lens.md":
    `#### Article\nsource:: [[../articles/aaa]]\n#### Article\nsource:: [[../articles/bbb]]`,
  // Lens A is video-only → no article
  "Lenses/Lens A.md": `#### Video\nsource:: [[../video_transcripts/clip]]`,
  // Lens B has one article
  "Lenses/Lens B.md": `#### Article\nsource:: [[../articles/ccc]]`,
};
const read = (p: string) =>
  p in DOCS ? Promise.resolve(DOCS[p]) : Promise.reject(new Error(`missing ${p}`));

describe("resolveCourseArticles", () => {
  it("collects unique articles across module→LO→lens and module→lens edges", async () => {
    const { articles, report } = await resolveCourseArticles(
      "courses/Navigating Superintelligence.md",
      read,
    );
    expect(articles.sort()).toEqual([
      "articles/aaa.md",
      "articles/bbb.md",
      "articles/ccc.md",
    ]);
    // Lens A had no article → recorded, not crashed
    expect(report.skippedNonArticle).toContain("../video_transcripts/clip");
    expect(report.perModule.find((m) => m.module.endsWith("m1.md"))?.articleCount).toBe(2);
  });
});
