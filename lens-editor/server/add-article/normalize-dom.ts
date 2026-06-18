/**
 * Pre-turndown DOM normalization. Runs on the article body DOM (with the fetch
 * base URL available) BEFORE the HTML→Markdown conversion in extract.ts. Two
 * deterministic transforms that turndown alone cannot do correctly:
 *
 *  1. Footnote canonicalization. Sites render footnotes in incompatible ways —
 *     ForumMagnum (LessWrong / AlignmentForum / EA Forum) uses content-hash ids
 *     (`fn7menapb2jft`) where the display number lives ONLY in the inline
 *     reference's anchor text, GFM uses numeric `user-content-fn-N`, markdown-it
 *     uses `.footnote-ref`/`.footnote-item`. Numbering a definition therefore
 *     requires linking it to the reference that points at it — cross-node work a
 *     stateless turndown rule can't do. We rewrite every convention into one
 *     canonical numeric form (`<sup class="footnote-ref"><a data-footnote-ref="N"
 *     href="#fn-N">N</a></sup>` markers + `<li id="fn-N">` definitions) so the
 *     existing numeric footnote turndown rules emit `[^N]` / `[^N]:` correctly,
 *     with definitions collected at the bottom of the body.
 *
 *  2. Link absolutization. Resolve relative `<a href>` against the base URL so
 *     library documents keep working links (images are already resolved by the
 *     turndown `lazyImg` rule). In-document `#` anchors and non-http schemes are
 *     left untouched.
 */

// DOCUMENT_POSITION_* bitmask values (avoid depending on a global `Node`).
const FOLLOWING = 4;
const PRECEDING = 2;

function inDocumentOrder(a: Element, b: Element): number {
  const rel = a.compareDocumentPosition(b);
  if (rel & FOLLOWING) return -1;
  if (rel & PRECEDING) return 1;
  return 0;
}

/** The anchor carrying a footnote reference's href (the element itself if it is
 * the `<a>`, else its first descendant `<a>`). */
function refAnchor(ref: Element): Element | null {
  return ref.matches("a") ? ref : ref.querySelector("a");
}

/** A back-reference (definition → marker), NOT an inline marker. Must be tested
 * BEFORE the inclusion test because `"#fnref".startsWith("#fn")` is true. */
function isBackLink(el: Element): boolean {
  if (el.closest(".footnote-back-link")) return true;
  if (el.matches("a[data-footnote-backref]")) return true;
  const a = refAnchor(el);
  return (a?.getAttribute("href") || "").startsWith("#fnref");
}

/** The definition id this reference points at (strip a leading `#`). */
function targetId(ref: Element): string {
  const href = refAnchor(ref)?.getAttribute("href") || "";
  if (href.startsWith("#")) {
    const id = href.slice(1);
    // A non-back-link reference normally points straight at the def id.
    if (id && !id.startsWith("fnref")) return id;
    if (id.startsWith("fnref")) return "fn" + id.slice(5);
  }
  // Fall back to the reference's own id with the `ref` marker removed
  // (`fnref<HASH>` → `fn<HASH>`); anchored to the prefix so we don't mangle an
  // id that merely contains the letters "ref" (e.g. `fn-preface-3`).
  const ownId =
    ref.getAttribute("id") || refAnchor(ref)?.getAttribute("id") || "";
  return ownId.replace(/^fnref/i, "fn");
}

/** The reference's display number, preferring a real number over position so we
 * never silently renumber footnotes that an author cited out of order. Returns
 * null when no number is present (caller assigns a positional fallback). */
function displayNumber(ref: Element): string | null {
  const a = refAnchor(ref);
  const text = (a?.textContent ?? ref.textContent ?? "").replace(/[[\]\s]/g, "");
  if (/^\d+$/.test(text)) return text;
  for (const attr of ["data-footnote-index", "data-footnote-ref"]) {
    const v = a?.getAttribute(attr) || ref.getAttribute(attr) || "";
    if (/^\d+$/.test(v)) return v;
  }
  return null;
}

/** Ids of the footnote definition elements present in the body. */
function footnoteDefIds(root: Element): Set<string> {
  const ids = new Set<string>();
  root
    .querySelectorAll("li.footnote-item, li[id^='fn'], li[id^='user-content-fn']")
    .forEach((li) => {
      const id = li.getAttribute("id");
      if (id) ids.add(id);
    });
  return ids;
}

/** Inline footnote reference wrappers, outermost-only, in document order,
 * excluding back-links. */
function collectReferences(root: Element): Element[] {
  const set = new Set<Element>();
  // Class/attribute-labelled references are unambiguous footnote markers.
  root
    .querySelectorAll(".footnote-reference, .footnote-ref")
    .forEach((e) => set.add(e));
  root.querySelectorAll("a[data-footnote-ref]").forEach((a) => {
    const sup = a.closest("sup");
    set.add(sup && root.contains(sup) ? sup : a);
  });
  // An UNlabelled `<sup>` linking to `#fn…` is only a footnote marker when its
  // text is a number (e.g. "1" / "[1]") OR it targets a real footnote
  // definition — otherwise an ordinary superscript in-page link (e.g.
  // `#fn-section`) would be turned into a phantom `[^N]` marker.
  const defIds = footnoteDefIds(root);
  root.querySelectorAll("sup").forEach((sup) => {
    const a = sup.querySelector('a[href^="#fn"]');
    if (!a) return;
    const text = (a.textContent || "").replace(/[[\]\s]/g, "");
    const target = (a.getAttribute("href") || "").slice(1);
    if (/^\d+$/.test(text) || defIds.has(target)) set.add(sup);
  });

  let refs = [...set].filter((e) => !isBackLink(e));
  // Keep only the outermost of any nested matches (e.g. a `.footnote-reference`
  // span wrapping a matching `<sup>`).
  refs = refs.filter((e) => !refs.some((o) => o !== e && o.contains(e)));
  return refs.sort(inDocumentOrder);
}

function canonicalMarker(doc: Document, n: string): Element {
  const sup = doc.createElement("sup");
  sup.className = "footnote-ref";
  const a = doc.createElement("a");
  a.setAttribute("data-footnote-ref", n);
  a.setAttribute("href", `#fn-${n}`);
  a.textContent = n;
  sup.appendChild(a);
  return sup;
}

/**
 * Some sources render footnotes *inline* at the citation point rather than as a
 * list at the bottom — notably LaTeXML / arXiv HTML (`span.ltx_role_footnote`),
 * where the whole note (marker + text) sits where it was cited. Pull each one
 * out: leave a reference marker in place and append its content to a footnotes
 * list at the end of the body, so the rest of the pipeline collects it as `[^N]:`.
 */
function relocateInlineFootnotes(root: Element): void {
  const doc = root.ownerDocument;
  if (!doc) return;
  const notes = [...root.querySelectorAll(".ltx_role_footnote")];
  if (notes.length === 0) return;

  const list = doc.createElement("ol");
  list.className = "footnotes";

  let counter = 0;
  for (const note of notes) {
    counter += 1;
    const markText = (note.querySelector(".ltx_note_mark")?.textContent || "").trim();
    const n = /^\d+$/.test(markText) ? markText : String(counter);
    const id = note.getAttribute("id") || `ltxfn-${counter}`;

    // Build the definition from the note content, dropping the duplicated
    // mark/tag glyphs LaTeXML repeats inside the content.
    const li = doc.createElement("li");
    li.className = "footnote-item";
    li.setAttribute("id", id);
    const content = note.querySelector(".ltx_note_content");
    if (content) {
      const clone = content.cloneNode(true) as Element;
      clone
        .querySelectorAll(".ltx_note_mark, .ltx_tag, .ltx_tag_note")
        .forEach((e) => e.remove());
      while (clone.firstChild) li.appendChild(clone.firstChild);
    }
    list.appendChild(li);

    // Replace the inline note with a reference marker pointing at the new def.
    const sup = doc.createElement("sup");
    sup.className = "footnote-ref";
    const a = doc.createElement("a");
    a.setAttribute("href", `#${id}`);
    a.textContent = n;
    sup.appendChild(a);
    note.replaceWith(sup);
  }

  root.appendChild(list);
}

function normalizeFootnotes(root: Element): void {
  const doc = root.ownerDocument;
  if (!doc) return;

  // Inline footnotes (arXiv/LaTeXML) become a bottom list first, then the
  // unified numbering below treats them like any other list-based footnotes.
  relocateInlineFootnotes(root);

  const refs = collectReferences(root);

  // Assign each footnote a UNIQUE number. We keep a reference's own display
  // number when it is free (so footnotes cited out of order keep their printed
  // numbers), but allocate the smallest unused number otherwise — so a positional
  // fallback or a second footnote section can never collide into a duplicate
  // `[^N]`. `numByTarget` links definitions back to their reference's number.
  const numByTarget = new Map<string, string>();
  const used = new Set<number>();
  const takeFree = (): string => {
    let i = 1;
    while (used.has(i)) i += 1;
    used.add(i);
    return String(i);
  };
  const take = (preferred: string | null): string => {
    const want = preferred && /^\d+$/.test(preferred) ? Number(preferred) : 0;
    if (want && !used.has(want)) {
      used.add(want);
      return String(want);
    }
    return takeFree();
  };

  for (const ref of refs) {
    const tid = targetId(ref);
    let n: string;
    if (tid && numByTarget.has(tid)) {
      n = numByTarget.get(tid)!;
    } else {
      n = take(displayNumber(ref));
      if (tid) numByTarget.set(tid, n);
    }
    ref.replaceWith(canonicalMarker(doc, n));
  }

  // Definitions. Map each to its number via the reference map; orphans (never
  // referenced — rare, usually a sub-selected body) keep their content and get
  // numbers continuing after the max, so footnote text is never lost.
  const defs = [
    ...root.querySelectorAll(
      "li.footnote-item, li[id^='fn'], li[id^='user-content-fn']",
    ),
  ];
  const numByDef = new Map<Element, number>();
  for (const def of defs) {
    const id = def.getAttribute("id") || "";
    const n = numByTarget.get(id) ?? takeFree();
    def.setAttribute("id", `fn-${n}`);
    def
      .querySelectorAll(
        ".footnote-back-link, a[data-footnote-backref], a[href^='#fnref']",
      )
      .forEach((b) => b.remove());
    numByDef.set(def, Number(n));
  }

  // Reorder definition <li>s by assigned number within each container so output
  // order matches the markers. Only footnote items are moved.
  const containers = new Set<Element>();
  for (const def of defs) if (def.parentElement) containers.add(def.parentElement);
  for (const c of containers) {
    const items = [...c.children]
      .filter((ch) => numByDef.has(ch))
      .sort((a, b) => numByDef.get(a)! - numByDef.get(b)!);
    for (const it of items) c.appendChild(it);
  }
}

const SKIP_HREF = /^(#|mailto:|tel:|data:|javascript:)/i;

function absolutizeLinks(root: Element, baseUrl: string): void {
  root.querySelectorAll("a[href]").forEach((a) => {
    const href = a.getAttribute("href") || "";
    if (!href || SKIP_HREF.test(href)) return;
    try {
      a.setAttribute("href", new URL(href, baseUrl).href);
    } catch {
      /* leave malformed hrefs as-is */
    }
  });
}

/** Normalize an article body DOM subtree in place (footnotes + links). */
export function normalizeArticleDom(root: Element, baseUrl: string): void {
  normalizeFootnotes(root);
  absolutizeLinks(root, baseUrl);
}
