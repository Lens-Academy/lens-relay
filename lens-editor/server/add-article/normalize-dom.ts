/**
 * Pre-turndown DOM normalization. Runs on the article body DOM (with the fetch
 * base URL available) BEFORE the HTML→Markdown conversion in extract.ts.
 * Deterministic transforms that turndown alone cannot do correctly — footnote
 * definition rescue from the full page (see rescueDroppedFootnotes), plus:
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

/** A back-reference href: legacy `#fnref…` (any suffix — hash ids included) or
 * 80000hours' dashed-numeric `#fn-ref-N`. The dashed form REQUIRES trailing
 * digits so named definition ids like `fn-reform` / `fn-refugees` are never
 * misread as back-links. */
function isBackLinkHref(href: string): boolean {
  return href.startsWith("#fnref") || /^#fn-ref-\d+$/i.test(href);
}

/** A back-reference (definition → marker), NOT an inline marker. Must be tested
 * BEFORE the inclusion test because `"#fnref".startsWith("#fn")` is true.
 * Covers the `.fn-return` class 80k puts on its "back to content" arrows. */
function isBackLink(el: Element): boolean {
  if (el.closest(".footnote-back-link")) return true;
  if (el.matches("a[data-footnote-backref], a.fn-return, a.footnote-return"))
    return true;
  const a = refAnchor(el);
  return isBackLinkHref(a?.getAttribute("href") || "");
}

/** The definition id this reference points at (strip a leading `#`). */
function targetId(ref: Element): string {
  const href = refAnchor(ref)?.getAttribute("href") || "";
  if (href.startsWith("#")) {
    const id = href.slice(1);
    // A non-back-link reference normally points straight at the def id.
    // Named ids like `fn-reform` are real targets, not back-links.
    if (id && !isBackLinkHref(`#${id}`)) return id;
    if (id.startsWith("fnref")) return "fn" + id.slice(5);
    if (/^fn-ref-\d+$/i.test(id)) return id.replace(/^fn-ref-/i, "fn-");
  }
  // Fall back to the reference's own id with the `ref` marker removed
  // (`fnref<HASH>` → `fn<HASH>`, `fn-ref-3` → `fn-3`); anchored to the prefix
  // so we don't mangle an id that merely contains "ref" (e.g. `fn-preface-3`).
  const ownId =
    ref.getAttribute("id") || refAnchor(ref)?.getAttribute("id") || "";
  if (/^fn-ref-\d+$/i.test(ownId)) return ownId.replace(/^fn-ref-/i, "fn-");
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

/**
 * Whether an <li> is genuinely a footnote definition. `li[id^='fn']` alone is
 * far too loose — a legitimate list item with id "fnord"/"finally" would be
 * hijacked into a phantom footnote and vanish from its list. Numeric ids
 * (`fn-3`, `user-content-fn-2`) always count; hash-style ids (LessWrong's
 * `fn7menapb2jft`) only count inside a footnotes container.
 */
function isFootnoteDefLi(li: Element): boolean {
  if (li.classList?.contains("footnote-item")) return true;
  const id = li.getAttribute("id") || "";
  if (/^(user-content-)?fn[-:]?\d+$/i.test(id)) return true;
  if (/^fn[-:]?[a-z0-9]+$/i.test(id)) {
    return !!li.closest(
      ".footnotes, .footnotes-list, .footnote-section, [data-footnotes], #footnotes, [role='doc-endnotes']",
    );
  }
  return false;
}

const FOOTNOTE_LI_SELECTOR =
  "li.footnote-item, li[id^='fn'], li[id^='user-content-fn']";

/** Ids of the footnote definition elements present in the body. */
function footnoteDefIds(root: Element): Set<string> {
  const ids = new Set<string>();
  [...root.querySelectorAll(FOOTNOTE_LI_SELECTOR)]
    .filter(isFootnoteDefLi)
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
  // Anchor-style references (80000hours and other WordPress footnote
  // renderers): the ANCHOR wraps its own <sup> marker (`<a rel="footnote"
  // href="#fn-1"><sup>1</sup></a>`) — the inverse nesting of the sup-based
  // branch below, which can't see them. The label alone is NOT enough: the
  // anchor must also be marker-SHAPED (same-document `#` target, and a <sup>
  // child or short marker text) — otherwise a prose link that happens to carry
  // the class/rel (`<a class="footnote-link" href="/notes#3">my longer note on
  // decision theory</a>`) would have its text and URL destroyed.
  root.querySelectorAll('a[rel~="footnote"], a.footnote-link').forEach((a) => {
    const href = a.getAttribute("href") || "";
    if (!href.startsWith("#")) return;
    const text = (a.textContent || "").replace(/[[\]\s]/g, "");
    if (a.querySelector("sup") || /^[\d*†‡§]{1,4}$/.test(text)) set.add(a);
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
  // Same guard for the unlabelled inverse nesting: `<a href="#fn…"><sup>…</sup></a>`.
  root.querySelectorAll('a[href^="#fn"]').forEach((a) => {
    if (!a.querySelector("sup")) return;
    const text = (a.textContent || "").replace(/[[\]\s]/g, "");
    const target = (a.getAttribute("href") || "").slice(1);
    if (/^\d+$/.test(text) || defIds.has(target)) set.add(a);
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
  const defs = [...root.querySelectorAll(FOOTNOTE_LI_SELECTOR)].filter(
    isFootnoteDefLi,
  );
  const numByDef = new Map<Element, number>();
  // A duplicate definition id (malformed page) must not produce two `[^N]:`
  // entries with the same number — the first occurrence keeps the reference's
  // number, later ones are renumbered as orphans so their content survives.
  const claimed = new Set<string>();
  for (const def of defs) {
    const id = def.getAttribute("id") || "";
    const n =
      numByTarget.has(id) && !claimed.has(id)
        ? numByTarget.get(id)!
        : takeFree();
    claimed.add(id);
    def.setAttribute("id", `fn-${n}`);
    def
      .querySelectorAll(
        ".footnote-back-link, a[data-footnote-backref], a.fn-return, a.footnote-return",
      )
      .forEach((b) => b.remove());
    // Back-reference LINKS are removed by exact href shape only — a bare CSS
    // prefix (`a[href^='#fn-ref']`) would also delete legitimate cross-links
    // to named definitions like `#fn-reform`, text and all.
    def.querySelectorAll("a[href]").forEach((b) => {
      if (isBackLinkHref(b.getAttribute("href") || "")) b.remove();
    });
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

/**
 * Footnote-definition rescue. The generic extractors (Readability/Defuddle)
 * pick ONE content container — on sites that render the footnote list in a
 * sibling container (80000hours' `.wrap-footnotes`), every definition is
 * silently dropped while the inline markers survive, so the imported article
 * loses all footnote content. For each in-body reference whose target id is
 * missing from the body, recover the definition from the FULL page document
 * when available; failing that, synthesize it from the reference's `title`
 * attribute (80k stuffs the complete footnote HTML there for hover previews).
 * Runs BEFORE normalizeFootnotes so rescued definitions are numbered and
 * ordered exactly like natively-present ones.
 */
/** Active/embedded elements have no place inside a footnote definition —
 * especially one synthesized from a title attribute, where a second decode
 * level can turn previously-inert text into live markup (the videoEmbed rule
 * passes YouTube/Vimeo iframes through as raw HTML). */
function sanitizeDef(li: Element): void {
  li.querySelectorAll(
    "script, style, iframe, frame, object, embed, form, link, meta, video, audio",
  ).forEach((e) => e.remove());
}

const NORM_WS = (s: string) => s.replace(/\s+/g, " ").trim();

function rescueDroppedFootnotes(
  root: Element,
  getFullDoc?: () => Document | null,
): void {
  const doc = root.ownerDocument;
  if (!doc) return;

  let fullDoc: Document | null | undefined;
  let list: Element | null = null;
  const appendDef = (li: Element) => {
    if (!list) {
      list = doc.createElement("ol");
      list.className = "footnotes";
      root.appendChild(list);
    }
    list.appendChild(li);
  };

  /** Resolve a missing definition from the full page, refusing candidates that
   * are not note-shaped: cloning a section-sized container (a `#fn-methods`
   * div holding headings and 30 paragraphs, or a whole `#footnotes` section)
   * would inline an entire excluded region as one flattened "footnote". */
  const resolveFromFullPage = (tid: string): Element | null => {
    if (fullDoc === undefined) fullDoc = getFullDoc?.() ?? null;
    const src = fullDoc?.getElementById(tid);
    if (!src) return null;
    const el = src.closest("li") ?? src;
    const text = NORM_WS(el.textContent || "");
    if (el.nodeName === "LI") {
      // A list item is structurally a note — but not one that CONTAINS other
      // footnote definitions (a mis-targeted wrapper), and not unbounded.
      if ([...el.querySelectorAll("li")].some(isFootnoteDefLi)) return null;
      if (text.length > 8000) return null;
    } else {
      if (el.querySelector("h1, h2, h3, h4, h5, h6")) return null;
      if (el.querySelectorAll("ol li, ul li").length >= 2) return null;
      if (text.length > 4000) return null;
    }
    return el;
  };

  // Iterate to a fixpoint (bounded): a rescued definition may itself contain
  // footnote references (cross-referencing notes) whose definitions must be
  // rescued too, or the marker would render as a dangling literal `[^N]`.
  const attempted = new Set<string>();
  for (let pass = 0; pass < 4; pass++) {
    const missing: { tid: string; ref: Element }[] = [];
    for (const ref of collectReferences(root)) {
      const tid = targetId(ref);
      if (!tid || attempted.has(tid)) continue;
      attempted.add(tid);
      // The htmlToMarkdown wrapper document contains ONLY the body fragment,
      // so getElementById is scoped to the article body here.
      if (doc.getElementById(tid)) continue;
      missing.push({ tid, ref });
    }
    if (missing.length === 0) return;

    // Extractors sometimes UNWRAP a definition's id-bearing wrapper while
    // keeping its text in the body — the id then looks missing although the
    // content is present, and rescuing it would duplicate the text. Compare
    // against the body's normalized text (recomputed per pass; the body grows).
    const bodyText = NORM_WS(root.textContent || "");

    let added = 0;
    for (const { tid, ref } of missing) {
      const src = resolveFromFullPage(tid);
      let li: Element | null = null;
      if (src) {
        const probe = NORM_WS(src.textContent || "").slice(0, 160);
        if (probe.length >= 24 && bodyText.includes(probe)) continue;
        li = doc.createElement("li");
        li.className = "footnote-item";
        li.setAttribute("id", tid);
        // Import the definition's CONTENT (the source element may be an <li>
        // or any id-bearing wrapper) into a fresh <li> so normalizeFootnotes
        // always sees its canonical shape.
        const clone = doc.importNode(src, true) as Element;
        while (clone.firstChild) li.appendChild(clone.firstChild);
      } else {
        // Fallback: hover-preview title (80k stuffs the full footnote HTML
        // there). Two guards against fabricating scholarship out of UI text:
        // a length floor for short labels ("Footnote 1"), and a requirement
        // that the value actually parses into markup — a plain-text tooltip
        // ("Jump to the footnote content at the bottom of this page") is not
        // a definition.
        const title =
          refAnchor(ref)?.getAttribute("title") ||
          ref.getAttribute("title") ||
          "";
        if (title.trim().length < 40) continue;
        li = doc.createElement("li");
        li.className = "footnote-item";
        li.setAttribute("id", tid);
        li.innerHTML = title; // attribute value is decoded — parses as HTML
        if (!li.querySelector("p, a, em, strong, i, b, ul, ol, blockquote, code")) {
          continue;
        }
      }
      sanitizeDef(li);
      appendDef(li);
      added += 1;
    }
    if (added === 0) return;
  }
}

/** Parse a srcset into {url, width} candidates. Candidates are separated by
 * commas, but URLs themselves may contain commas (fetch-CDN parameter lists
 * like substack's `$s_!X!,w_424,c_limit,…`) — a naive split(",") shreds them
 * into fragments. A comma FOLLOWED BY WHITESPACE is an unambiguous separator;
 * for space-less lists, fall back to url+descriptor pair extraction. */
export function parseSrcset(
  srcset: string | null,
): { url: string; width: number }[] {
  if (!srcset) return [];
  const out: { url: string; width: number }[] = [];
  for (const part of srcset.split(/,(?=\s)/)) {
    const m = part.trim().match(/^(\S+)(?:\s+(\d+(?:\.\d+)?)[wx])?$/i);
    if (m) {
      out.push({ url: m[1], width: m[2] ? parseFloat(m[2]) : 0 });
      continue;
    }
    for (const mm of part.matchAll(/(\S+?)\s+(\d+(?:\.\d+)?)[wx](?=,|$)/gi)) {
      out.push({ url: mm[1].replace(/^,/, ""), width: parseFloat(mm[2]) });
    }
  }
  return out;
}

/** Largest candidate in a srcset by width/density descriptor. width=0 when no
 * candidate carries an explicit descriptor. Exported for the lazyImg rule. */
export function largestSrcsetCandidate(
  srcset: string | null,
): { url: string; width: number } | null {
  let best: { url: string; width: number } | null = null;
  for (const c of parseSrcset(srcset)) {
    if (!best || c.width > best.width) best = c;
  }
  return best;
}

/** Width a fetch-CDN rendition URL advertises via its `w_N` parameter (0 if none). */
function urlRenditionWidth(url: string): number {
  const m = url.match(/[,/]w_(\d+)[,/]/);
  return m ? parseInt(m[1], 10) : 0;
}

/** The percent-encoded source URL embedded in a fetch-CDN rendition path
 * (substackcdn.com/image/fetch/w_424,…/https%3A%2F%2F…%2Fpic.png) — a unique
 * per-figure key that is stable across renditions. "" for ordinary URLs. */
function encodedSourceKey(url: string): string {
  const m = url.match(/\/(https?%3A[^/?#]+)/i);
  return m ? m[1] : "";
}

/**
 * Restore full-size image renditions. Defuddle rewrites <img src> to the
 * FIRST srcset candidate — the smallest — and collapses the srcset, so
 * Substack slide images came out at w_424 instead of the element's original
 * w_1456 (text-dense slides, materially less legible). For fetch-CDN images
 * the encoded source key identifies the figure across renditions: look it up
 * in the FULL page and adopt the largest rendition offered there (src plus
 * every srcset candidate of the img and its <picture> sources). Images
 * without an encoded key are left untouched.
 */
function restoreImageRenditions(
  root: Element,
  getFullDoc?: () => Document | null,
): void {
  if (!getFullDoc) return;
  const bodyImgs = [...root.querySelectorAll("img")].filter((img) =>
    encodedSourceKey(img.getAttribute("src") || ""),
  );
  if (bodyImgs.length === 0) return;

  const fullDoc = getFullDoc();
  if (!fullDoc) return;
  // key → best rendition URL seen anywhere on the full page.
  const bestByKey = new Map<string, { url: string; width: number }>();
  const consider = (url: string, descriptorWidth: number) => {
    const key = encodedSourceKey(url);
    if (!key) return;
    const width = Math.max(descriptorWidth, urlRenditionWidth(url));
    const cur = bestByKey.get(key);
    if (!cur || width > cur.width) bestByKey.set(key, { url, width });
  };
  fullDoc.querySelectorAll("img, source").forEach((el) => {
    const src = el.getAttribute("src");
    if (src) consider(src, 0);
    for (const attr of ["srcset", "data-srcset"]) {
      for (const c of parseSrcset(el.getAttribute(attr))) {
        consider(c.url, c.width);
      }
    }
  });

  for (const img of bodyImgs) {
    const src = img.getAttribute("src") || "";
    const best = bestByKey.get(encodedSourceKey(src));
    if (!best || best.url === src) continue;
    if (best.width <= urlRenditionWidth(src)) continue;
    img.setAttribute("src", best.url);
    // The collapsed small-rendition srcset would win over src in the lazyImg
    // preference order — drop it so the restored src is what converts.
    img.removeAttribute("srcset");
    img.removeAttribute("data-srcset");
    img.removeAttribute("data-src");
  }
}

/**
 * Restore heading hierarchy flattened by Defuddle. Defuddle demotes content
 * <h1>s to <h2> (title dedup), so an article using h1 sections with h2
 * subsections (Substack posts) comes out as one flat run of h2s — "Camp 1"
 * loses its subordination to "ToVs in AI Safety". Detect the collapse by
 * matching body-h2 texts against the FULL page's heading levels (skipping the
 * page-title h1) and re-open the gap: h2s that were h2 in the source drop to
 * h3. Conservative: only fires when the body has NO h1, and both original
 * levels are represented by unambiguous text matches.
 */
function restoreHeadingLevels(
  root: Element,
  getFullDoc?: () => Document | null,
): void {
  if (!getFullDoc) return;
  if (root.querySelector("h1")) return;
  const bodyH2s = [...root.querySelectorAll("h2")];
  if (bodyH2s.length < 2) return;

  const fullDoc = getFullDoc();
  if (!fullDoc) return;
  const fullHs = [...fullDoc.querySelectorAll("h1, h2")];
  const firstH1 = fullHs.find((h) => h.nodeName === "H1");
  // Map heading text → source level; texts seen at more than one level are
  // ambiguous and dropped from the map.
  const levelByText = new Map<string, number | null>();
  for (const h of fullHs) {
    if (h === firstH1) continue; // the page title, not a section
    const key = NORM_WS(h.textContent || "").toLowerCase();
    if (!key) continue;
    const level = h.nodeName === "H1" ? 1 : 2;
    if (levelByText.has(key) && levelByText.get(key) !== level) {
      levelByText.set(key, null);
    } else if (!levelByText.has(key)) {
      levelByText.set(key, level);
    }
  }

  const matched = bodyH2s.map((h) => ({
    h,
    level: levelByText.get(NORM_WS(h.textContent || "").toLowerCase()) ?? null,
  }));
  const sawH1 = matched.some((m) => m.level === 1);
  const sawH2 = matched.some((m) => m.level === 2);
  if (!sawH1 || !sawH2) return; // source really was flat — nothing to restore

  const doc = root.ownerDocument;
  if (!doc) return;
  for (const { h, level } of matched) {
    if (level !== 2) continue;
    const h3 = doc.createElement("h3");
    while (h.firstChild) h3.appendChild(h.firstChild);
    for (const attr of [...h.attributes]) h3.setAttribute(attr.name, attr.value);
    h.replaceWith(h3);
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

/** Normalize an article body DOM subtree in place (footnotes + links).
 *  `getFullDoc` (optional, lazy) provides the FULL page document so footnote
 *  definitions the extractor's container selection dropped can be rescued. */
export function normalizeArticleDom(
  root: Element,
  baseUrl: string,
  getFullDoc?: () => Document | null,
): void {
  rescueDroppedFootnotes(root, getFullDoc);
  restoreHeadingLevels(root, getFullDoc);
  restoreImageRenditions(root, getFullDoc);
  normalizeFootnotes(root);
  absolutizeLinks(root, baseUrl);
}
