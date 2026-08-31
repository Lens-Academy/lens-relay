import fm from "front-matter";
import type { ArticleMeta } from "./types";

/**
 * Protected-content policy for LLM review passes, in one place.
 *
 * A reviewer may edit body prose and the source-derived frontmatter fields;
 * everything else — protected frontmatter, paired %% authoring blocks,
 * {>>...<<} CriticMarkup comments — must survive verbatim, with two sanctioned
 * exceptions (the importer's discussion-note block, and validator-suppression
 * pragmas, which are reviewer-owned).
 *
 * `revertProtectedEdits` is the lenient entry point: instead of discarding a
 * whole review pass over one overreach, it surgically restores the protected
 * content, keeps every other edit, and reports what it undid so the pipeline
 * can log it and ask a follow-up reviewer whether the reverted result is still
 * coherent. It throws only when a revert would be ambiguous (a protected block
 * was deleted outright) or the result violates non-negotiable shape rules.
 *
 * `validateEditedArticle` is the strict wrapper: any revert is an error.
 */

export interface ProtectedRevert {
  kind: "frontmatter" | "comment-block" | "critic-comment";
  /** Human-readable description of what was undone, for report events. */
  detail: string;
  /** The error the strict validator raises for this violation. */
  strictMessage: string;
}

const EDITABLE_FRONTMATTER = new Set(["title", "author", "published", "description"]);

type ReviewFrontmatter = Record<string, unknown>;

function scalar(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number") return String(value);
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  return "";
}

function authors(value: unknown): string[] {
  const values = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  return values
    .filter((author): author is string => typeof author === "string" && !!author.trim())
    .map((author) => author.trim());
}

function comparable(value: unknown): unknown {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
  if (Array.isArray(value)) return value.map(comparable);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, comparable(child)]),
    );
  }
  return value ?? null;
}

function parseFrontmatter(markdown: string): { attributes: ReviewFrontmatter; body: string } {
  if (!fm.test(markdown)) throw new Error("reviewed article has no YAML frontmatter");
  try {
    const parsed = fm<ReviewFrontmatter>(markdown);
    return { attributes: parsed.attributes, body: parsed.body };
  } catch (error) {
    throw new Error(`reviewed article has invalid YAML frontmatter: ${error}`);
  }
}

const PAIRED_COMMENT_RE = /%%[\s\S]*?%%/g;
const CRITIC_COMMENT_RE = /\{>>(?:"(?:\\.|[^"])*"\s*)?[\s\S]*?<<\}/g;

export function isSuppressionPragma(block: string): boolean {
  return /^%%\s*validator-ignore-next-line\s+--code\s+[a-z0-9.-]+\s+--reason\s+[A-Za-z0-9'-]+\s*%%$/.test(
    block.trim(),
  );
}

export function isDiscussionNote(block: string): boolean {
  return /^%%\s*\nAdd discussion note here:/.test(block);
}

interface BlockMatch {
  text: string;
  start: number;
  end: number;
}

function matchBlocks(markdown: string, re: RegExp): BlockMatch[] {
  return [...markdown.matchAll(re)].map((m) => ({
    text: m[0],
    start: m.index!,
    end: m.index! + m[0].length,
  }));
}

type BlockAction = { match: BlockMatch } & (
  | { op: "keep" }
  | { op: "replace"; with: string }
  | { op: "remove" }
);

/**
 * Align the edited document's protected blocks against the original's, in
 * order, and produce the actions that restore the original set: a reworded
 * block is replaced with its original text, an inserted block is removed.
 * Throws when an original block cannot be placed (it was deleted — there is
 * no unambiguous position to restore it to).
 */
function alignBlocks(
  originalBlocks: string[],
  editedMatches: BlockMatch[],
  opts: {
    allowPairEdit?: (original: string, edited: string) => boolean;
    deletionError: string;
  },
): BlockAction[] {
  const actions: BlockAction[] = [];
  let j = 0;
  for (let i = 0; i < editedMatches.length; i++) {
    const match = editedMatches[i];
    const surplus = editedMatches.length - i > originalBlocks.length - j;
    if (j < originalBlocks.length && match.text === originalBlocks[j]) {
      actions.push({ match, op: "keep" });
      j++;
      continue;
    }
    if (j < originalBlocks.length && opts.allowPairEdit?.(originalBlocks[j], match.text)) {
      actions.push({ match, op: "keep" });
      j++;
      continue;
    }
    // Surplus block: decide insertion vs modification by whether the original
    // we are waiting for still appears verbatim later in the edited document.
    if (
      surplus &&
      (j >= originalBlocks.length ||
        editedMatches.slice(i + 1).some((m) => m.text === originalBlocks[j]))
    ) {
      actions.push({ match, op: "remove" });
      continue;
    }
    if (j >= originalBlocks.length) {
      actions.push({ match, op: "remove" });
      continue;
    }
    actions.push({ match, op: "replace", with: originalBlocks[j] });
    j++;
  }
  if (j < originalBlocks.length) throw new Error(opts.deletionError);
  return actions;
}

/** Apply block actions right-to-left so match offsets stay valid. Removals
 *  swallow one adjacent separator so they don't leave doubled blank lines or
 *  a dangling space. */
function applyBlockActions(markdown: string, actions: BlockAction[]): string {
  let result = markdown;
  for (const action of [...actions].reverse()) {
    if (action.op === "keep") continue;
    const { start, end } = action.match;
    if (action.op === "replace") {
      result = result.slice(0, start) + action.with + result.slice(end);
      continue;
    }
    let from = start;
    let to = end;
    if (result.slice(to, to + 2) === "\n\n") to += 2;
    else if (result.slice(from - 2, from) === "\n\n") from -= 2;
    else if (result[from - 1] === " ") from -= 1;
    else if (result[to] === " ") to += 1;
    result = result.slice(0, from) + result.slice(to);
  }
  return result;
}

function summarize(block: string): string {
  const text = block.replace(/\s+/g, " ").trim();
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}

/**
 * Lenient validation of a reviewer's edit: surgically undo edits to protected
 * content, keep everything else, and report what was undone. Throws on
 * unrecoverable shapes (deleted protected blocks, empty title/author/body,
 * invalid date, broken frontmatter).
 */
export function revertProtectedEdits(
  originalMarkdown: string,
  editedMarkdown: string,
): { markdown: string; meta: ArticleMeta; reverted: ProtectedRevert[] } {
  const original = parseFrontmatter(originalMarkdown);
  const edited = parseFrontmatter(editedMarkdown);
  const reverted: ProtectedRevert[] = [];

  // Frontmatter: the pipeline regenerates the draft's frontmatter from `meta`
  // after every pass, so protected-field violations are reverted at the meta
  // level (and logged) rather than by YAML text surgery.
  const originalKeys = Object.keys(original.attributes);
  const editedKeys = Object.keys(edited.attributes);
  for (const key of editedKeys) {
    if (!originalKeys.includes(key)) {
      reverted.push({
        kind: "frontmatter",
        detail: `removed added frontmatter field ${key}`,
        strictMessage: "reviewer added or removed frontmatter fields",
      });
    }
  }
  for (const key of originalKeys) {
    if (!editedKeys.includes(key)) {
      reverted.push({
        kind: "frontmatter",
        detail: `restored removed frontmatter field ${key}`,
        strictMessage: "reviewer added or removed frontmatter fields",
      });
    }
  }
  for (const key of originalKeys) {
    if (EDITABLE_FRONTMATTER.has(key) || !editedKeys.includes(key)) continue;
    if (
      JSON.stringify(comparable(original.attributes[key])) !==
      JSON.stringify(comparable(edited.attributes[key]))
    ) {
      reverted.push({
        kind: "frontmatter",
        detail: `restored protected frontmatter field ${key}`,
        strictMessage: `reviewer changed protected frontmatter field ${key}`,
      });
    }
  }

  // Paired %% blocks (suppression pragmas excluded — reviewer-owned; the
  // discussion-note block may be edited but never deleted).
  const originalPaired = matchBlocks(originalMarkdown, PAIRED_COMMENT_RE)
    .map((m) => m.text)
    .filter((b) => !isSuppressionPragma(b));
  const editedPaired = matchBlocks(editedMarkdown, PAIRED_COMMENT_RE).filter(
    (m) => !isSuppressionPragma(m.text),
  );
  const pairedActions = alignBlocks(originalPaired, editedPaired, {
    allowPairEdit: (o, e) => isDiscussionNote(o) && isDiscussionNote(e),
    deletionError: "reviewer changed a protected authoring comment block",
  });
  for (const action of pairedActions) {
    if (action.op === "keep") continue;
    reverted.push({
      kind: "comment-block",
      detail:
        action.op === "remove"
          ? `removed added authoring comment block: ${summarize(action.match.text)}`
          : `restored authoring comment block: ${summarize(action.with)}`,
      strictMessage: "reviewer changed a protected authoring comment block",
    });
  }
  let markdown = applyBlockActions(editedMarkdown, pairedActions);

  // CriticMarkup comments: no exceptions.
  const originalCritic = matchBlocks(originalMarkdown, CRITIC_COMMENT_RE).map((m) => m.text);
  const editedCritic = matchBlocks(markdown, CRITIC_COMMENT_RE);
  const criticActions = alignBlocks(originalCritic, editedCritic, {
    deletionError: "reviewer changed a protected CriticMarkup comment",
  });
  for (const action of criticActions) {
    if (action.op === "keep") continue;
    reverted.push({
      kind: "critic-comment",
      detail:
        action.op === "remove"
          ? `removed added CriticMarkup comment: ${summarize(action.match.text)}`
          : `restored CriticMarkup comment: ${summarize(action.with)}`,
      strictMessage: "reviewer changed a protected CriticMarkup comment",
    });
  }
  markdown = applyBlockActions(markdown, criticActions);

  // Belt and braces: the corrected document must satisfy the strict invariant.
  const finalPaired = (markdown.match(PAIRED_COMMENT_RE) ?? []).filter(
    (b) => !isSuppressionPragma(b),
  );
  const pairedOk =
    finalPaired.length === originalPaired.length &&
    originalPaired.every(
      (block, i) =>
        block === finalPaired[i] ||
        (isDiscussionNote(block) && isDiscussionNote(finalPaired[i])),
    );
  if (!pairedOk) throw new Error("reviewer changed a protected authoring comment block");
  if (
    JSON.stringify(markdown.match(CRITIC_COMMENT_RE) ?? []) !==
    JSON.stringify(originalCritic)
  ) {
    throw new Error("reviewer changed a protected CriticMarkup comment");
  }

  // Non-negotiable shape rules.
  const meta: ArticleMeta = {
    title: scalar(edited.attributes.title),
    author: authors(edited.attributes.author),
    source_url: scalar(original.attributes.source_url),
    published: scalar(edited.attributes.published),
    description: scalar(edited.attributes.description),
  };
  if (!meta.title) throw new Error("reviewer left title empty");
  if (!meta.author.length) throw new Error("reviewer left author empty");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(meta.published)) {
    throw new Error("reviewer left published as an invalid date");
  }
  if (!parseFrontmatter(markdown).body.replace(/%%[\s\S]*?%%/g, "").trim()) {
    throw new Error("reviewer left article body empty");
  }
  return { markdown, meta, reverted };
}

/** Strict validation: any protected-content violation is an error. */
export function validateEditedArticle(
  originalMarkdown: string,
  editedMarkdown: string,
): { markdown: string; meta: ArticleMeta } {
  const result = revertProtectedEdits(originalMarkdown, editedMarkdown);
  if (result.reverted.length > 0) {
    throw new Error(result.reverted[0].strictMessage);
  }
  return { markdown: result.markdown, meta: result.meta };
}
