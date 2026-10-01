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
export function convertSidenotes(html: string, url: string): string {
  if (!html.includes("data-sidenote-number")) return html;
  const dom = new JSDOM(html, { url });
  const doc = dom.window.document;

  const pairs: { marker: Element; note: Element; n: string }[] = [];
  for (const marker of Array.from(doc.querySelectorAll("label[data-sidenote-number]"))) {
    const n = (marker.getAttribute("data-sidenote-number") || "").trim();
    if (!/^\d+$/.test(n)) continue;
    const note = doc.getElementById(`footnote-${n}`);
    if (note) pairs.push({ marker, note, n });
  }
  if (pairs.length === 0) return html;

  const container = commonAncestor(pairs.map((p) => p.marker));
  const list = doc.createElement("ol");
  for (const { marker, note, n } of pairs) {
    // The checkbox that toggles the note on narrow screens is UI, not text.
    const toggleId = marker.getAttribute("for");
    if (toggleId) doc.getElementById(toggleId)?.remove();

    const sup = doc.createElement("sup");
    sup.className = "footnote-ref";
    const a = doc.createElement("a");
    a.setAttribute("href", `#fn-${n}`);
    a.setAttribute("data-footnote-ref", n);
    a.textContent = n;
    sup.appendChild(a);
    marker.replaceWith(sup);

    // The note opens with its own number ("8."), which the [^N]: label replaces.
    const first = note.firstElementChild;
    if (first?.tagName === "SPAN" && first.textContent?.trim() === `${n}.`) first.remove();
    const li = doc.createElement("li");
    li.id = `fn-${n}`;
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
