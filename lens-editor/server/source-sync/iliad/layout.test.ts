import { describe, expect, it } from "vitest";
import { inert, LAYOUT, layoutFor, lensFileName, linkTarget, linkTargets, linkTo, plainTitle, relink, safeName, sourceLink, withFullLinks } from "./layout";

describe("layout", () => {
  it("gives the Iliad files folders of their own, under the names Lens reads", () => {
    expect(LAYOUT.course).toBe("Lens Edu/courses/in-development/iliad-intensive-demo.md");
    expect(LAYOUT.lensDir({ dayCode: "B.3", dayTitle: "Singular Learning Theory" })).toBe("Lens Edu/Lenses/Iliad/B.3 Singular Learning Theory");
    expect(LAYOUT.lensDir({ dayCode: "E.2", dayTitle: 'Steganography & "Backdoors": part 1/2' })).toBe("Lens Edu/Lenses/Iliad/E.2 Steganography & Backdoors - part 1 2");
    expect(LAYOUT.moduleDir).toBe("Lens Edu/modules/Iliad");
  });

  it("puts every folder in the Relay folder of the course file it is given", () => {
    const layout = layoutFor("Lens Edu Staging/courses/iliad.md");
    expect(layout.course).toBe("Lens Edu Staging/courses/iliad.md");
    expect(layout.moduleDir).toBe("Lens Edu Staging/modules/Iliad");
    expect(layout.lensDir({ dayCode: "A.1", dayTitle: "Intro" })).toBe("Lens Edu Staging/Lenses/Iliad/A.1 Intro");
  });
});

// Text from the source site, written into files whose markup Lens reads.
describe("names made from source text", () => {
  it("cannot open or close a comment or a suggestion, which Lens strips across lines", () => {
    expect(inert("Results so far %% draft")).toBe("Results so far % draft");
    expect(inert("a %%%% b")).toBe("a % b");
    expect(inert("{++added++} {--cut--} {~~old~>new~~} {==marked==} {>>note<<}")).toBe("{ ++added++ } { --cut-- } { ~~old~>new~~ } { ==marked== } { >>note<< }");
    expect(inert("50% of {x} is fine")).toBe("50% of {x} is fine");
  });

  it("is one line", () => {
    expect(inert("a\nb\r\n\tc d\u0000e")).toBe("a b c d e");
    expect(inert("%\n%")).toBe("% %");
  });

  it("as a title has no wikilink, field or heading syntax, and no underscore", () => {
    expect(plainTitle("# Lens: [[../x|y]] source:: z")).toBe("Lens: ../x y source: z");
    expect(plainTitle("snake_case and a | pipe")).toBe("snake case and a pipe");
    expect(plainTitle("%|% and {[++")).toBe("% % and { ++");
    expect(plainTitle("  ##  ")).toBe("");
    expect(plainTitle("Session 1: Alignment targets (bonus) = fun?")).toBe("Session 1: Alignment targets (bonus) = fun?");
  });

  it("as a file or folder name is one a path and a wikilink can hold", () => {
    expect(safeName("A.1.1 Session 1: Alignment targets")).toBe("A.1.1 Session 1 - Alignment targets");
    expect(safeName("What is [x|y]#z^? ")).toBe("What is x y z");
    expect(safeName("Ends with dots...")).toBe("Ends with dots");
    expect(safeName("Open problems %% end")).toBe("Open problems % end");
    expect(safeName("../../etc/passwd")).toBe("etc passwd");
    expect(safeName("..")).toBe("untitled");
    expect(safeName("x".repeat(300))).toHaveLength(120);
  });

  it("names a lens file as the hand import did", () => {
    expect(lensFileName("B.3.5 A definition of degeneracy")).toBe("Iliad B.3.5 - A definition of degeneracy");
    expect(lensFileName("A.1.1 Session 1: Alignment targets")).toBe("Iliad A.1.1 - Session 1 - Alignment targets");
    expect(lensFileName("B.4.6 Stochastic implicit bias (bonus)")).toBe("Iliad B.4.6 - Stochastic implicit bias (bonus)");
    expect(lensFileName("E.1.5 Debate = PSPACE?")).toBe("Iliad E.1.5 - Debate = PSPACE");
  });
});

describe("links", () => {
  it("resolves a wikilink target from the file that holds it", () => {
    expect(linkTarget("Lens Edu/modules/M.md", "../Lenses/Iliad A.1 - X")).toBe("Lens Edu/Lenses/Iliad A.1 - X.md");
    expect(linkTarget("Lens Edu/courses/in-development/c.md", "../../modules/M.md")).toBe("Lens Edu/modules/M.md");
    expect(linkTarget("Lens Edu/Lenses/Iliad/B.3 T/x.md", "../../../video_transcripts/v")).toBe("Lens Edu/video_transcripts/v.md");
  });

  it("writes a link as a relative path, never a bare name", () => {
    expect(linkTo("Lens Edu/modules/M.md", "Lens Edu/Lenses/Iliad/B.3 T/x.md")).toBe("../Lenses/Iliad/B.3 T/x");
    expect(linkTo("Lens Edu/Lenses/Iliad/B.3 T/x.md", "Lens Edu/Lenses/cev.md")).toBe("../../cev");
    expect(linkTo("Lens Edu/Lenses/x.md", "Lens Edu/Lenses/cev.md")).toBe("../Lenses/cev"); // as the hand import wrote its cards
  });

  const text = "source:: [[../Lenses/a]]\n::card[[../Lenses/b|B, the reading]]\nSee [[Some note]] and ![[../attachments/x.png]].";
  const moved = new Map([["Lens Edu/Lenses/a.md", "Lens Edu/Lenses/Iliad/A.1 T/a.md"]]);

  it("rewrites a link only when one of its ends moved", () => {
    expect(relink(text, "Lens Edu/modules/M.md", "Lens Edu/modules/M.md", new Map())).toBe(text);
    expect(relink(text, "Lens Edu/modules/M.md", "Lens Edu/modules/M.md", moved)).toBe(text.replace("../Lenses/a", "../Lenses/Iliad/A.1 T/a"));
    expect(relink(text, "Lens Edu/modules/M.md", "Lens Edu/modules/Iliad/M.md", moved)).toBe(
      "source:: [[../../Lenses/Iliad/A.1 T/a]]\n::card[[../../Lenses/b|B, the reading]]\nSee [[../Some note]] and ![[../../attachments/x.png]].",
    );
  });

  // Seen on a relay: a lens moved back into Lenses/ had its cards respelled "[[cev|CEV]]".
  it("takes a bare name for a file in the same folder, as Lens does and as the relay writes it", () => {
    const card = "::card[[cev|CEV]]";
    expect(linkTargets(card, "Lens Edu/Lenses/x.md")).toEqual(["Lens Edu/Lenses/cev.md"]);
    expect(relink(card, "Lens Edu/Lenses/x.md", "Lens Edu/Lenses/x.md", new Map())).toBe(card);
    expect(relink(card, "Lens Edu/Lenses/x.md", "Lens Edu/Lenses/Iliad/A.1 T/x.md", new Map())).toBe("::card[[../../cev|CEV]]");
    expect(withFullLinks(card, "Lens Edu/Lenses/x.md", new Map())).toBe(withFullLinks("::card[[../Lenses/cev|CEV]]", "Lens Edu/Lenses/x.md", new Map()));
  });

  it("tells a link spelled another way from an edit", () => {
    const from = "Lens Edu/modules/M.md";
    const respelled = text.replace("../Lenses/a", "../Lenses/Iliad/A.1 T/a"); // what the relay writes when it moves a.md
    expect(withFullLinks(respelled, from, moved)).toBe(withFullLinks(text, from, moved));
    expect(withFullLinks(text.replace("[[../Lenses/b|", "[[../Lenses/c|"), from, moved)).not.toBe(withFullLinks(text, from, moved));
    expect(withFullLinks(`${text}\nA line a person added.`, from, moved)).not.toBe(withFullLinks(text, from, moved));
  });

  it("lists what a text links to by path, and reads a source:: field", () => {
    expect(linkTargets("::card[[../Lenses/b|B]] and [[note]] and [[../articles/c]]", "Lens Edu/Lenses/x.md")).toEqual(["Lens Edu/Lenses/b.md", "Lens Edu/Lenses/note.md", "Lens Edu/articles/c.md"]);
    expect(sourceLink("# Lens: X\nsource:: [[../Lenses/x|The x]]\noptional:: true\n")).toBe("../Lenses/x");
    expect(sourceLink("#### Video\nsource:: ![[../video_transcripts/v]]\n")).toBe("../video_transcripts/v");
    expect(sourceLink("# Lens: written here\nid:: abc\n")).toBeNull();
  });
});
