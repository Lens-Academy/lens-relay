import type { NormalizationChange } from "./normalize-article";

/**
 * Deterministic footnote ID typing. Lens renders `[^cite-*]` and `[^note-*]`
 * footnotes differently and its validator rejects every other identifier
 * ("not a typed kebab-case identifier"), yet the extraction pipeline emits
 * numeric `[^N]` footnotes — so every footnote-bearing import used to hand the
 * LLM reviewer a bulk rename job. This pass retypes the ids the pipeline can
 * classify with confidence and leaves the rest loudly unclassified:
 *
 *   - strong bibliographic evidence            → `[^cite-N]`
 *   - no bibliographic evidence at all         → `[^note-N]`
 *   - mixed or unclear evidence                → `[^ambiguous-N]`
 *
 * `ambiguous-N` is deliberately still invalid: the validator keeps flagging it,
 * and the id itself tells the reviewer the pipeline could not decide — the
 * reviewer classifies it against the source and renames it to cite- or note-.
 * The numeric part of the id is preserved so the reviewer and report diffs can
 * still correlate footnotes with the source's printed numbers.
 *
 * Only ids that are pure numbers are touched, and only when the id has exactly
 * one definition and at least one reference — a rename is applied to the whole
 * reference+definition group as one unit or not at all. Anything else (missing
 * definitions, duplicate definitions, exotic ids) stays as-is and visible to
 * the validator. The pass is idempotent: typed and `ambiguous-*` ids are not
 * numeric and are never re-processed.
 */

export type FootnoteClass = "cite" | "note" | "ambiguous";

/** Strip Markdown syntax that would confuse text heuristics: inline links keep
 * their label, images drop entirely, emphasis markers are removed. */
function plainText(markdown: string): string {
  return markdown
    .replace(/!\[[^\]]*\]\(([^)]*)\)/g, "")
    .replace(/\[([^\]]*)\]\(([^)]*)\)/g, "$1")
    .replace(/[*_`]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** All link destinations in the definition (inline links + bare URLs). */
function linkDestinations(markdown: string): string[] {
  const urls: string[] = [];
  for (const m of markdown.matchAll(/\[[^\]]*\]\(([^)\s]+)[^)]*\)/g)) urls.push(m[1]);
  for (const m of markdown.matchAll(/(?<![(\w])(https?:\/\/[^\s)\]]+)/g)) urls.push(m[1]);
  return urls;
}

const DOI_HOST_RE = /^https?:\/\/(?:dx\.)?doi\.org\//i;
const ARXIV_HOST_RE = /^https?:\/\/(?:www\.)?arxiv\.org\//i;
const DOI_TOKEN_RE = /\b10\.\d{4,9}\/[^\s"<>]+/;
const ISBN_RE = /\bISBN(?:-1[03])?[:\s]/i;
const YEAR_PAREN_RE = /\((?:c\.\s*)?(1[5-9]\d\d|20\d\d)[a-z]?\)/;
const JOURNAL_PAGES_RE = /\d+\s*[:(]\s*\d+[^)]{0,20}\)?\s*[,:]?\s*(?:pp?\.\s*)?\d+\s*[–—-]\s*\d+/;
const CITATION_LOCATOR_RE = /\b(?:pp?\.|vol\.|chap?\.|eds?\.|no\.)\s*\d/i;
const QUOTED_TITLE_RE = /[“"][^”"]{8,}[”"]/;
const IBID_RE = /^\s*(?:ibid|op\.\s*cit|loc\.\s*cit)\b/i;

/** Whether the text before the first (year) looks like an author/organization
 * name rather than running prose: short, and essentially all capitalized words
 * (initials, commas, "&"/"and" allowed, at most one lowercase connective). */
function nameLikePrefix(prefix: string): boolean {
  const cleaned = prefix.replace(/[,.&]/g, " ").trim();
  if (cleaned.length > 80) return false;
  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > 10) return false;
  const lowercase = words.filter((w) => /^[a-z]/.test(w) && w !== "and");
  return lowercase.length <= 1;
}

/** Classify one footnote definition's content. Conservative by design: `cite`
 * and `note` ship silently, so they require clear evidence; everything mixed
 * or unclear becomes `ambiguous` and stays visible to the reviewer. */
export function classifyFootnote(definition: string): FootnoteClass {
  const text = plainText(definition);
  if (!text) return "ambiguous";
  const urls = linkDestinations(definition);

  if (urls.some((u) => DOI_HOST_RE.test(u) || ARXIV_HOST_RE.test(u))) return "cite";
  if (DOI_TOKEN_RE.test(definition) || ISBN_RE.test(text)) return "cite";
  if (IBID_RE.test(text)) return "cite";

  // A definition that is nothing but a link is a bare citation; the validator's
  // citation-definition-url-only warning then asks the reviewer to enrich it.
  const withoutUrls = plainText(definition.replace(/\[([^\]]*)\]\(([^)]*)\)/g, "").replace(/https?:\/\/[^\s)\]]+/g, ""));
  if (urls.length > 0 && withoutUrls.split(/\s+/).filter(Boolean).length <= 2) return "cite";

  const yearMatch = YEAR_PAREN_RE.exec(text);
  const citeEvidence =
    yearMatch !== null ||
    JOURNAL_PAGES_RE.test(text) ||
    CITATION_LOCATOR_RE.test(text) ||
    QUOTED_TITLE_RE.test(text) ||
    /\bet al\.?/.test(text);

  if (yearMatch && nameLikePrefix(text.slice(0, yearMatch.index))) return "cite";
  if (citeEvidence) return "ambiguous";
  return "note";
}

const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})/;

/** Line index → whether the line is inside a fenced code block. */
export function fencedLineMask(lines: string[]): boolean[] {
  const mask = new Array<boolean>(lines.length).fill(false);
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const m = FENCE_OPEN_RE.exec(lines[i]);
    if (fence) {
      mask[i] = true;
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length) fence = null;
    } else if (m) {
      fence = m[1];
      mask[i] = true;
    }
  }
  return mask;
}

/** Replace `[^old]` with `[^next]` outside inline code spans on one line. */
function renameOnLine(line: string, from: string, to: string): string {
  // Split on inline code spans (backtick runs) and only rewrite outside them.
  const parts = line.split(/(`+[^`]*`+)/);
  const token = `[^${from}]`;
  const replacement = `[^${to}]`;
  return parts
    .map((part, i) => (i % 2 === 1 ? part : part.split(token).join(replacement)))
    .join("");
}

export interface FootnoteTypingResult {
  body: string;
  changes: NormalizationChange[];
}

const DEF_RE = /^\[\^([^\]\n]+)\]:/;
const REF_RE = /\[\^([^\]\n]+)\](?!:)/g;

/** Retype numeric footnote ids across a Markdown body. See module docs. */
export function retypeFootnotes(body: string): FootnoteTypingResult {
  const lines = body.split("\n");
  const fenced = fencedLineMask(lines);

  // Gather definitions (line index + content incl. indented continuations) and
  // all ids in use, skipping fenced code lines entirely.
  const defLines = new Map<string, number[]>();
  const defContent = new Map<string, string>();
  const allIds = new Set<string>();
  const refIds = new Set<string>();
  for (let i = 0; i < lines.length; i++) {
    if (fenced[i]) continue;
    const def = DEF_RE.exec(lines[i]);
    if (def) {
      const id = def[1];
      allIds.add(id.toLowerCase());
      defLines.set(id, [...(defLines.get(id) ?? []), i]);
      const content: string[] = [lines[i].slice(def[0].length)];
      for (let j = i + 1; j < lines.length && content.length < 12; j++) {
        if (fenced[j]) break;
        if (/^(?: {4,}|\t)/.test(lines[j])) content.push(lines[j].trim());
        else if (lines[j].trim() === "") continue;
        else break;
      }
      defContent.set(id, content.join(" "));
    }
    // Inline-code-masked reference scan. REF_RE's `(?!:)` lookahead already
    // excludes the `[^id]:` definition token itself.
    const outside = lines[i].split(/(`+[^`]*`+)/).filter((_, k) => k % 2 === 0).join(" ");
    for (const m of outside.matchAll(REF_RE)) {
      allIds.add(m[1].toLowerCase());
      refIds.add(m[1]);
    }
  }

  const changes = new Map<FootnoteClass, NormalizationChange>();
  const record = (cls: FootnoteClass, from: string, to: string) => {
    const code =
      cls === "ambiguous" ? "normalize.footnote-ambiguous" : `normalize.footnote-typed-${cls}`;
    const change = changes.get(cls) ?? { code, count: 0, samples: [] };
    change.count += 1;
    if (change.samples.length < 5) change.samples.push({ before: `[^${from}]`, after: `[^${to}]` });
    changes.set(cls, change);
  };

  let out = lines;
  for (const [id, defAt] of defLines) {
    if (!/^\d+$/.test(id)) continue; // only numeric ids; typed/ambiguous/exotic stay
    if (defAt.length !== 1) continue; // duplicate definitions stay visible
    if (!refIds.has(id)) continue; // orphan definitions stay visible
    const cls = classifyFootnote(defContent.get(id) ?? "");
    const label = `${cls}-${id}`;
    if (allIds.has(label)) continue; // never collide with an existing id
    allIds.add(label);
    out = out.map((line, i) => (fenced[i] ? line : renameOnLine(line, id, label)));
    record(cls, id, label);
  }

  return { body: out.join("\n"), changes: [...changes.values()] };
}
