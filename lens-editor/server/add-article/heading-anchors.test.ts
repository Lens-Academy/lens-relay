import { describe, expect, it } from "vitest";
import { applyHeadingAnchors } from "./heading-anchors";

const codes = (body: string) => applyHeadingAnchors(body).changes.map((c) => c.code).sort();

describe("applyHeadingAnchors — block IDs", () => {
  it("assigns an ID from the heading's first words", () => {
    const { body } = applyHeadingAnchors("## Why we might lose control of AI\n");
    expect(body).toBe("## Why we might lose control of AI ^why-we-might-lose\n");
  });

  it("assigns IDs at every heading level", () => {
    const { body } = applyHeadingAnchors("# One\n\n### Two\n\n###### Three\n");
    expect(body).toBe("# One ^one\n\n### Two ^two\n\n###### Three ^three\n");
  });

  it("preserves an ID that is already present", () => {
    const body = "## Reworded heading ^original-id\n";
    expect(applyHeadingAnchors(body).body).toBe(body);
  });

  it("is idempotent", () => {
    const once = applyHeadingAnchors("## Risks from power-seeking AI\n").body;
    expect(applyHeadingAnchors(once).body).toBe(once);
  });

  it("disambiguates repeated headings with a numeric suffix", () => {
    const { body } = applyHeadingAnchors("## Summary\n\n## Summary\n\n## Summary\n");
    expect(body).toBe("## Summary ^summary\n\n## Summary ^summary-2\n\n## Summary ^summary-3\n");
  });

  it("never generates an ID that collides with an existing one", () => {
    const { body } = applyHeadingAnchors("## Other ^summary\n\n## Summary\n");
    expect(body).toBe("## Other ^summary\n\n## Summary ^summary-2\n");
  });

  it("strips inline markup out of the ID", () => {
    const { body } = applyHeadingAnchors("## The **hard** part of [alignment](https://x.test)\n");
    expect(body).toBe("## The **hard** part of [alignment](https://x.test) ^the-hard-part-of\n");
  });

  it("falls back to a generic ID when the heading has no usable words", () => {
    const { body } = applyHeadingAnchors("## ***\n\n## ???\n");
    expect(body).toBe("## *** ^section\n\n## ??? ^section-2\n");
  });

  it("leaves headings inside fenced code blocks alone", () => {
    const body = "```md\n## Not a heading\n```\n";
    expect(applyHeadingAnchors(body).body).toBe(body);
  });
});

describe("applyHeadingAnchors — link rewriting", () => {
  it("rewrites a heading-slug fragment link to a block-ID link", () => {
    const { body } = applyHeadingAnchors(
      "See [the argument](#the-core-argument).\n\n## The core argument\n",
    );
    expect(body).toBe(
      "See [[#^the-core-argument|the argument]].\n\n## The core argument ^the-core-argument\n",
    );
  });

  it("keeps a label that differs from the heading only in case", () => {
    const { body } = applyHeadingAnchors("See [the core argument](#the-core-argument).\n\n## The core argument\n");
    expect(body).toContain("[[#^the-core-argument|the core argument]]");
  });

  it("drops the label when it exactly repeats the heading text", () => {
    const { body } = applyHeadingAnchors(
      "See [The core argument](#the-core-argument).\n\n## The core argument\n",
    );
    expect(body).toBe("See [[#^the-core-argument]].\n\n## The core argument ^the-core-argument\n");
  });

  it("rewrites a heading-text wikilink", () => {
    const { body } = applyHeadingAnchors("See [[#The core argument]].\n\n## The core argument\n");
    expect(body).toBe("See [[#^the-core-argument]].\n\n## The core argument ^the-core-argument\n");
  });

  it("keeps a custom label on a heading-text wikilink", () => {
    const { body } = applyHeadingAnchors(
      "See [[#The core argument|that section]].\n\n## The core argument\n",
    );
    expect(body).toBe(
      "See [[#^the-core-argument|that section]].\n\n## The core argument ^the-core-argument\n",
    );
  });

  it("resolves a fragment against an ID the heading already carries", () => {
    const { body } = applyHeadingAnchors("See [it](#kept-id).\n\n## Reworded ^kept-id\n");
    expect(body).toBe("See [[#^kept-id|it]].\n\n## Reworded ^kept-id\n");
  });

  it("demotes an empty fragment link to plain text", () => {
    const { body } = applyHeadingAnchors("See [the appendix](#).\n");
    expect(body).toBe("See the appendix.\n");
    expect(codes("See [the appendix](#).\n")).toContain("normalize.empty-fragment-link");
  });

  it("leaves an unresolvable fragment for the reviewer", () => {
    const body = "See [something](#no-such-heading).\n\n## The core argument\n";
    expect(applyHeadingAnchors(body).body).toContain("[something](#no-such-heading)");
  });

  it("leaves an ambiguous fragment alone rather than guessing", () => {
    const { body } = applyHeadingAnchors("See [it](#summary).\n\n## Summary\n\n## Summary\n");
    expect(body).toContain("[it](#summary)");
  });

  it("does not touch links that are already block-ID links", () => {
    const body = "See [[#^the-core-argument]] and [[#^other|a label]].\n";
    expect(applyHeadingAnchors(body).body).toBe(body);
  });

  it("does not touch external links or images", () => {
    const body = "[out](https://x.test/#frag) ![alt](#the-core-argument)\n\n## The core argument\n";
    const { body: out } = applyHeadingAnchors(body);
    expect(out).toContain("[out](https://x.test/#frag)");
    expect(out).toContain("![alt](#the-core-argument)");
  });

  it("does not rewrite inside inline code or fenced blocks", () => {
    const body = "`[x](#the-core-argument)`\n\n```\n[y](#the-core-argument)\n```\n\n## The core argument\n";
    const { body: out } = applyHeadingAnchors(body);
    expect(out).toContain("`[x](#the-core-argument)`");
    expect(out).toContain("[y](#the-core-argument)");
  });

  it("reports what it changed", () => {
    expect(codes("See [x](#the-core-argument).\n\n## The core argument\n")).toEqual([
      "normalize.heading-block-id",
      "normalize.heading-fragment-link",
    ]);
  });
});
