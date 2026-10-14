import { describe, expect, it } from "vitest";
import { headingAnchor, uniqueAnchors } from "./anchor";

// Every pair below is a heading of the course and the id iliad-intensive.org gave it on 12 Oct 2026.
describe("headingAnchor", () => {
  it.each([
    ["Prerequisites", "prerequisites"],
    ["0. Properties of Measures", "0-properties-of-measures"],
    ["1.1 Neural networks and parameter–function maps", "11-neural-networks-and-parameterfunction-maps"],
    ["B. The informational cost of steering: the Touchette–Lloyd theorem", "b-the-informational-cost-of-steering-the-touchettelloyd-theorem"],
    ["Deployment 2: building the safety system", "deployment-2-building-the-safety-system"],
    ["Goal-directedness", "goal-directedness"],
  ])("drops punctuation and keeps hyphens: %s", (heading, anchor) => {
    expect(headingAnchor(heading)).toBe(anchor);
  });

  it.each([
    ["4. Properties of $V_{\\xi}$", "4-properties-of-"],
    ["4.4 Theorem: $\\mathbb{Q}$ and $\\mathbb{N}$ have the same cardinality", "44-theorem--and--have-the-same-cardinality"],
    ["7.2 Justification of $K$ as an entropy measure", "72-justification-of--as-an-entropy-measure"],
    ["D. Best choice of $\\hat{\\mu}\\in \\Mc$.", "d-best-choice-of-"],
  ])("leaves a formula out and keeps the spaces around it: %s", (heading, anchor) => {
    expect(headingAnchor(heading)).toBe(anchor);
  });

  it.each([
    [
      "[Sections 9–11](#9-likelihood-ratios-are-martingales): Self-Optimizing Policy (Finite Model Class)",
      "sections-911-self-optimizing-policy-finite-model-class",
    ],
    [
      "5.1.1 [Main] [Transformers represent belief state geometry in their residual stream](https://arxiv.org/pdf/2405.15943)",
      "511-main-transformers-represent-belief-state-geometry-in-their-residual-stream",
    ],
  ])("keeps the words of a link: %s", (heading, anchor) => {
    expect(headingAnchor(heading)).toBe(anchor);
  });

  it("gives a heading read back from a lens the anchor it has in the source", () => {
    // In the lens the formula is `$$...$$` with its macros expanded, and a link within the page is plain words.
    expect(headingAnchor("7. Misspecified models: when $$\\mu \\notin {\\mathcal{M}}$$")).toBe(
      headingAnchor("7. Misspecified models: when $\\mu \\notin \\Mc$"),
    );
    expect(headingAnchor("Sections 9–11: Self-Optimizing Policy (Finite Model Class)")).toBe("sections-911-self-optimizing-policy-finite-model-class");
  });

  it("reads emphasis as its words, and keeps an underscore inside a word", () => {
    expect(headingAnchor("**Some further info:**")).toBe("some-further-info");
    expect(headingAnchor("The _free_ energy of `snake_case`")).toBe("the-free-energy-of-snake_case");
  });

  it("keeps letters and digits of any script", () => {
    expect(headingAnchor("Gödel’s théorème 2½")).toBe("gödels-théorème-2");
  });
});

describe("uniqueAnchors", () => {
  it("numbers a repeat, as the site does for the sessions of A.1", () => {
    expect(uniqueAnchors(["Alignment targets", "Reading guide", "Alignment targets", "Alignment targets"])).toEqual([
      "alignment-targets",
      "reading-guide",
      "alignment-targets-1",
      "alignment-targets-2",
    ]);
  });

  it("skips a number another heading already has", () => {
    expect(uniqueAnchors(["Notes", "Notes 1", "Notes"])).toEqual(["notes", "notes-1", "notes-2"]);
    expect(uniqueAnchors(["A", "A", "A 1"])).toEqual(["a", "a-1", "a-1-1"]);
  });
});
