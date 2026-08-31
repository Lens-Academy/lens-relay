import { describe, expect, it } from "vitest";
import { revertProtectedEdits } from "./protected-edits";

/* Fixtures: each case is (original article, LLM-edited article) → the correct
 * programmatic correction. Legitimate edits must survive the revert; edits to
 * protected content must be undone verbatim; unrecoverable shapes throw. */

const FRONTMATTER = `---
title: "Old Title"
author:
  - "Old Author"
source_url: "https://example.com/source"
published: 2026-06-16
created: 2026-08-25
accessed: 2026-08-25
description: "Old description"
tags:
  - "article-importer"
---`;

const NOTE_PLACEHOLDER = `%%
Add discussion note here:

...

%%`;

function doc(body: string, frontmatter = FRONTMATTER): string {
  return `${frontmatter}\n\n${body}\n`;
}

describe("revertProtectedEdits — comment blocks", () => {
  it("restores a reworded authored %% block while keeping body edits", () => {
    const original = doc(`${NOTE_PLACEHOLDER}

Intro paragraph with a typoo in it.

%%
Editor: keep the em-dashes as in the source.
%%

Closing paragraph.`);
    const edited = doc(`${NOTE_PLACEHOLDER}

Intro paragraph with a typo in it.

%%
Editor: em-dashes normalized to hyphens.
%%

Closing paragraph.`);
    const result = revertProtectedEdits(original, edited);
    expect(result.markdown).toBe(
      doc(`${NOTE_PLACEHOLDER}

Intro paragraph with a typo in it.

%%
Editor: keep the em-dashes as in the source.
%%

Closing paragraph.`),
    );
    expect(result.reverted).toEqual([
      expect.objectContaining({ kind: "comment-block" }),
    ]);
  });

  it("removes a newly added non-pragma %% block", () => {
    const original = doc(`${NOTE_PLACEHOLDER}

Body text.`);
    const edited = doc(`${NOTE_PLACEHOLDER}

Body text.

%%
Reviewer aside: this section is questionable.
%%`);
    const result = revertProtectedEdits(original, edited);
    expect(result.markdown).toBe(doc(`${NOTE_PLACEHOLDER}\n\nBody text.`));
    expect(result.reverted).toEqual([
      expect.objectContaining({ kind: "comment-block" }),
    ]);
  });

  it("keeps sanctioned edits (filled note, pragmas) while reverting only the illegal one", () => {
    const original = doc(`${NOTE_PLACEHOLDER}

First paragraph.

![](img.png)

![](img.png)

%%
Curator: image order is intentional.
%%

Last paragraph.`);
    const edited = doc(`%%
Add discussion note here:

A useful framing note for site editors.

%%

First paragraph, improved.

%% validator-ignore-next-line --code article.block-repeated-nearby --reason intentional-repeat %%
![](img.png)

%% validator-ignore-next-line --code article.block-repeated-nearby --reason intentional-repeat %%
![](img.png)

%%
Curator note reworded by the reviewer.
%%

Last paragraph.`);
    const result = revertProtectedEdits(original, edited);
    expect(result.markdown).toBe(
      doc(`%%
Add discussion note here:

A useful framing note for site editors.

%%

First paragraph, improved.

%% validator-ignore-next-line --code article.block-repeated-nearby --reason intentional-repeat %%
![](img.png)

%% validator-ignore-next-line --code article.block-repeated-nearby --reason intentional-repeat %%
![](img.png)

%%
Curator: image order is intentional.
%%

Last paragraph.`),
    );
    expect(result.reverted).toEqual([
      expect.objectContaining({ kind: "comment-block" }),
    ]);
  });

  it("reverts only the edited copy when identical blocks repeat", () => {
    const original = doc(`%%
Same note.
%%

Middle.

%%
Same note.
%%

End.`);
    const edited = doc(`%%
Same note.
%%

Middle.

%%
Different note.
%%

End.`);
    const result = revertProtectedEdits(original, edited);
    expect(result.markdown).toBe(original);
    expect(result.reverted).toHaveLength(1);
  });

  it("handles an insertion and a modification in the same document", () => {
    const original = doc(`%%
Block A.
%%

Text.

%%
Block B.
%%`);
    const edited = doc(`%%
Block A modified.
%%

%%
Brand new block.
%%

Text.

%%
Block B.
%%`);
    const result = revertProtectedEdits(original, edited);
    expect(result.markdown).toBe(
      doc(`%%
Block A.
%%

Text.

%%
Block B.
%%`),
    );
    expect(result.reverted).toHaveLength(2);
  });

  it("throws when a protected %% block was deleted (no unambiguous restore point)", () => {
    const original = doc(`%%
Keep me.
%%

Body.`);
    const edited = doc("Body.");
    expect(() => revertProtectedEdits(original, edited)).toThrow(
      "authoring comment",
    );
  });
});

describe("revertProtectedEdits — CriticMarkup comments", () => {
  it("restores a reworded {>>...<<} comment", () => {
    const original = doc(`Body text. {>>TODO: Licensed content<<}

More text.`);
    const edited = doc(`Body text. {>>License cleared per reviewer<<}

More text.`);
    const result = revertProtectedEdits(original, edited);
    expect(result.markdown).toBe(original);
    expect(result.reverted).toEqual([
      expect.objectContaining({ kind: "critic-comment" }),
    ]);
  });

  it("removes an added {>>...<<} comment", () => {
    const original = doc("Plain body.");
    const edited = doc("Plain body. {>>reviewer aside<<}");
    const result = revertProtectedEdits(original, edited);
    expect(result.markdown).toBe(doc("Plain body."));
    expect(result.reverted).toEqual([
      expect.objectContaining({ kind: "critic-comment" }),
    ]);
  });

  it("throws when a CriticMarkup comment was deleted", () => {
    const original = doc("Body. {>>TODO: check quote<<} More.");
    const edited = doc("Body. More.");
    expect(() => revertProtectedEdits(original, edited)).toThrow("CriticMarkup");
  });
});

describe("revertProtectedEdits — frontmatter", () => {
  it("reverts a protected source_url at the meta level and logs it", () => {
    const original = doc("Body.");
    const edited = doc(
      "Body improved.",
      FRONTMATTER.replace(
        'source_url: "https://example.com/source"',
        'source_url: "https://evil.example/"',
      ),
    );
    const result = revertProtectedEdits(original, edited);
    expect(result.meta.source_url).toBe("https://example.com/source");
    expect(result.reverted).toEqual([
      expect.objectContaining({ kind: "frontmatter", detail: expect.stringContaining("source_url") }),
    ]);
    // the legitimate body edit survives
    expect(result.markdown).toContain("Body improved.");
  });

  it("logs changed/added protected fields without failing; editable fields flow through", () => {
    const edited = doc(
      "Body.",
      FRONTMATTER
        .replace('title: "Old Title"', 'title: "Corrected Title"') // editable
        .replace("created: 2026-08-25", "created: 2020-01-01") // protected
        .replace("accessed: 2026-08-25", "accessed: 2026-08-25\nextra_field: sneaky"), // added
    );
    const result = revertProtectedEdits(doc("Body."), edited);
    expect(result.meta.title).toBe("Corrected Title");
    const kinds = result.reverted.map((r) => r.detail).join(" | ");
    expect(kinds).toContain("created");
    expect(kinds).toContain("extra_field");
  });

  it("returns no reverts and the edited markdown for a fully legitimate edit", () => {
    const edited = doc(
      "Body, now with a corrected quote.",
      FRONTMATTER.replace('description: "Old description"', 'description: "Better description"'),
    );
    const result = revertProtectedEdits(doc("Body, now with a corrected qoute."), edited);
    expect(result.reverted).toEqual([]);
    expect(result.markdown).toBe(edited);
    expect(result.meta.description).toBe("Better description");
  });

  it("still enforces non-negotiable shape errors (empty title/body)", () => {
    const edited = doc("Body.", FRONTMATTER.replace('title: "Old Title"', 'title: ""'));
    expect(() => revertProtectedEdits(doc("Body."), edited)).toThrow("title");
  });
});
