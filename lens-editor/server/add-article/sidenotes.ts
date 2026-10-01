import { JSDOM } from "jsdom";

/**
 * Tufte-style sidenotes → standard footnote markup, on the WHOLE page before
 * any content selection. Sites such as ai-2040.com mark each note in the text
 * with an empty `<label data-sidenote-number="N">` (plus a checkbox toggle) and
 * render the note itself as `<div id="footnote-N">` in a margin column outside
 * `<main>`. Defuddle / Readability keep the text and drop that column, so every
 * note was lost. Rewrite the markers into the canonical
 * `<sup class="footnote-ref"><a href="#fn-N">` form and gather the notes into a
 * `<section data-footnotes><ol><li id="fn-N">` after the text that cites them,
 * which the shared footnote handling turns into paired `[^N]` / `[^N]:`.
 *
 * Returns the HTML unchanged when the page has no paired sidenotes.
 */
export function convertSidenotes(html: string): string {
  if (!html.includes("data-sidenote-number")) return html;
  const dom = new JSDOM(html);
  const doc = dom.window.document;

  const pairs: { marker: Element; note: Element; n: string }[] = [];
  for (const marker of Array.from(doc.querySelectorAll("label[data-sidenote-number]"))) {
    const n = (marker.getAttribute("data-sidenote-number") || "").trim();
    if (!/^\d+$/.test(n)) continue;
    const note = doc.getElementById(`footnote-${n}`);
    if (note && isSidenoteBody(note)) pairs.push({ marker, note, n });
  }
  if (pairs.length === 0) return html;

  // A page can also have ordinary footnotes; number the sidenotes after them
  // so no `fn-N` id or marker number is claimed twice.
  const offset = highestFootnoteNumber(doc);
  const container = commonAncestor(pairs.map((p) => p.marker));
  const list = doc.createElement("ol");
  const added = new Set<string>();
  for (const { marker, note, n } of pairs) {
    const num = String(Number(n) + offset);
    // The checkbox that toggles the note on narrow screens is UI, not text.
    const toggleId = marker.getAttribute("for");
    if (toggleId) doc.getElementById(toggleId)?.remove();

    const sup = doc.createElement("sup");
    sup.className = "footnote-ref";
    const a = doc.createElement("a");
    a.setAttribute("href", `#fn-${num}`);
    a.setAttribute("data-footnote-ref", num);
    a.textContent = num;
    sup.appendChild(a);
    marker.replaceWith(sup);

    // A note cited twice is listed once.
    if (added.has(n)) continue;
    added.add(n);
    // The note opens with its own number ("8."), which the [^N]: label replaces.
    const first = note.firstElementChild;
    if (first?.tagName === "SPAN" && first.textContent?.trim() === `${n}.`) first.remove();
    const li = doc.createElement("li");
    li.id = `fn-${num}`;
    li.append(...Array.from(note.childNodes));
    list.appendChild(li);
    note.remove();
  }
  const section = doc.createElement("section");
  section.setAttribute("data-footnotes", "");
  section.className = "footnotes";
  section.appendChild(list);
  container.appendChild(section);

  return dom.serialize();
}

/** A margin note is a block of its own. Other sites reuse the id
 *  `footnote-N` for a link or a span inside ordinary text or footnotes
 *  (Substack puts it on the note's number link). */
function isSidenoteBody(el: Element): boolean {
  return !["A", "SPAN", "SUP", "LI", "P"].includes(el.tagName) && !el.closest("p, li, a");
}

/** The highest number used by the page's ordinary footnotes (0 if none):
 *  numeric definition ids (`fn-3`, `fn:3`, `user-content-fn-3`) and the
 *  numbers shown by `#fn…` reference links. */
function highestFootnoteNumber(doc: Document): number {
  let max = 0;
  const note = (v: string | null | undefined) => {
    const m = (v || "").trim().match(/^\[?(\d+)\]?$/);
    if (m) max = Math.max(max, Number(m[1]));
  };
  for (const el of Array.from(doc.querySelectorAll("[id]"))) {
    note(el.id.match(/^(?:user-content-)?fn[-:]?(\d+)$/i)?.[1]);
  }
  for (const a of Array.from(doc.querySelectorAll('a[href^="#fn"]'))) {
    if (!/^#fn-?ref/i.test(a.getAttribute("href") || "")) note(a.textContent);
  }
  return max;
}

const SECTION_CONTAINERS = new Set(["DIV", "SECTION", "ARTICLE", "MAIN", "BODY"]);

/** The deepest div/section-like element that contains every one of `els`
 *  (never a paragraph or other text element, which cannot hold the list). */
function commonAncestor(els: Element[]): Element {
  let anc: Element = els[0].parentElement ?? els[0];
  while (
    anc.parentElement &&
    (!SECTION_CONTAINERS.has(anc.tagName) || !els.every((el) => anc.contains(el)))
  ) {
    anc = anc.parentElement;
  }
  return anc;
}
