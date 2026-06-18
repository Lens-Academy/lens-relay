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
  // Fall back to the reference's own id with the `ref` marker removed.
  const ownId =
    ref.getAttribute("id") || refAnchor(ref)?.getAttribute("id") || "";
  return ownId.replace(/ref/i, "");
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

/** Inline footnote reference wrappers, outermost-only, in document order,
 * excluding back-links. */
function collectReferences(root: Element): Element[] {
  const set = new Set<Element>();
  root
    .querySelectorAll(".footnote-reference, .footnote-ref")
    .forEach((e) => set.add(e));
  root.querySelectorAll("a[data-footnote-ref]").forEach((a) => {
    const sup = a.closest("sup");
    set.add(sup && root.contains(sup) ? sup : a);
  });
  root.querySelectorAll("sup").forEach((sup) => {
    if (sup.querySelector('a[href^="#fn"]')) set.add(sup);
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

function normalizeFootnotes(root: Element): void {
  const doc = root.ownerDocument;
  if (!doc) return;

  const refs = collectReferences(root);

  // targetId -> assigned number, built in document order from the references.
  const numByTarget = new Map<string, string>();
  let maxAssigned = 0;
  const assign = (n: string) => {
    maxAssigned = Math.max(maxAssigned, Number(n) || 0);
    return n;
  };

  for (const ref of refs) {
    const tid = targetId(ref);
    let n: string;
    if (tid && numByTarget.has(tid)) {
      n = numByTarget.get(tid)!;
    } else {
      n = assign(displayNumber(ref) ?? String(maxAssigned + 1));
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
    const n = numByTarget.get(id) ?? String(++maxAssigned);
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
