import { describe, it, expect } from "vitest";
import { parseSourceTargets, parseModuleLinks } from "./wikilink";

describe("parseSourceTargets", () => {
  it("extracts targets across heading levels, embeds, aliases, and spacing", () => {
    const md = `
# Module:  [[../modules/x]]
# Meeting: Introduction
# Learning Outcome:
source:: [[../Learning Outcomes/An Outcome]]
## Lens:
source:: ![[../Lenses/A Lens|A Lens]]
#### Article
source:: [[../articles/foo-bar]]
#### Video
source:: [[../video_transcripts/clip]]
`;
    expect(parseSourceTargets(md)).toEqual([
      "../Learning Outcomes/An Outcome",
      "../Lenses/A Lens",
      "../articles/foo-bar",
      "../video_transcripts/clip",
    ]);
  });

  it("ignores # Module: links that are NOT on a source:: line but keeps de-dup", () => {
    const md = `source:: [[../articles/dup]]\nsource:: ![[../articles/dup]]`;
    expect(parseSourceTargets(md)).toEqual(["../articles/dup"]);
  });

  it("captures a source:: preceded by inline CriticMarkup on the same line", () => {
    const md = `--}source:: ![[../Lenses/Y]]`;
    expect(parseSourceTargets(md)).toEqual(["../Lenses/Y"]);
  });
});

describe("parseModuleLinks", () => {
  it("reads # Module lines with variable spacing, ignores # Meeting", () => {
    const md = `# Module: [[../modules/a]]\n# Meeting: Intro\n# Module:  [[../modules/b]]`;
    expect(parseModuleLinks(md)).toEqual(["../modules/a", "../modules/b"]);
  });
});
