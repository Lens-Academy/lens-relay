/**
 * The anchor iliad-intensive.org gives a heading. Its site build runs
 * rehype-slug, which takes the heading's text as a reader sees it and hands
 * it to github-slugger. A lens is pinned to "<slug>#<anchor of its first
 * heading>", so this gives the same answer for a heading read from the
 * source (`4. Properties of $V$`) and for the same heading read back out of
 * a lens file (`4. Properties of $$V$$`).
 */

// What github-slugger deletes: every character that is not a letter, a mark,
// a digit, a connector such as `_`, a hyphen or a space. Its own pattern is
// generated from the Unicode tables as "these categories, minus Alphabetic".
const DELETED = /[\p{No}\p{P}\p{S}\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Z}]/u;
const KEPT = /[\p{Alphabetic}\p{Pc} -]/u;

/**
 * The heading as text: maths gone, a link reduced to its words. The site
 * renders a formula to markup before rehype-slug runs, so a formula adds
 * nothing to the anchor, and the spaces around it stay ("Properties of $V$"
 * ends in a hyphen). Emphasis markers and backticks need no handling here:
 * they are punctuation, which the slugger deletes anyway.
 */
function headingText(markdown: string): string {
  return markdown
    .trim()
    .replace(/\$\$[^$]*\$\$|\$[^$]*\$/g, "")
    .replace(/!?\[((?:[^\][]|\[[^\][]*\])*)\]\((?:[^()\s]|\([^()\s]*\))*(?:\s+"[^"]*")?\)/g, "$1")
    // `_emphasis_` is the one marker the slugger would keep.
    .replace(/(?<![\p{L}\p{N}_])_(?=\S)(.*?)(?<=\S)_(?![\p{L}\p{N}_])/gu, "$1");
}

/** The anchor of one heading, before repeats on the page are numbered. */
export function headingAnchor(text: string): string {
  let anchor = "";
  for (const char of headingText(text).toLowerCase()) {
    if (char === " ") anchor += "-";
    else if (KEPT.test(char) || !DELETED.test(char)) anchor += char;
  }
  return anchor;
}

/**
 * Anchors for all of a page's headings, in order. A repeat gets "-1",
 * "-2", ... and a number that is already taken is skipped, as
 * github-slugger does: "a", "a", "a-1" gives "a", "a-1", "a-1-1".
 */
export function uniqueAnchors(texts: string[]): string[] {
  const seen = new Map<string, number>();
  return texts.map((text) => {
    const base = headingAnchor(text);
    let anchor = base;
    while (seen.has(anchor)) {
      const n = seen.get(base)! + 1;
      seen.set(base, n);
      anchor = `${base}-${n}`;
    }
    seen.set(anchor, 0);
    return anchor;
  });
}
