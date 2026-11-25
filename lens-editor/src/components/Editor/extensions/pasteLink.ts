/**
 * Pasting a link over selected text links that text, as in Google Docs:
 * select "40%", paste https://example.com/report, get
 * [40%](https://example.com/report). A link to a document in this editor
 * becomes a wikilink instead, [[../Reports/Q3|40%]], so backlinks and moves
 * see it.
 *
 * Only the brackets are inserted, around the selection: the selected text
 * keeps its author, and in suggestion mode only the brackets are suggested.
 * Anything else (no selection, several lines, inside code or a link, not a
 * single URL) is left to the normal paste. Replaces lang-markdown's
 * pasteURLAsLink, which makes markdown links only and also links across
 * lines, suggestions and the frontmatter.
 */
import { EditorSelection, Prec, StateEffect, StateField, Transaction } from '@codemirror/state';
import type { EditorState, Extension, TransactionSpec } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import type { FolderMetadata } from '../../../hooks/useFolderMetadata';
import { computeRelativePath, isLinkTarget } from '../../../lib/document-resolver';
import { criticMarkupField } from './criticmarkup';
import { frontmatterField } from './frontmatter';

/** Hosts of the deployed editor; links from the page's own origin count too. */
const EDITOR_HOSTS = new Set(['editor.lensacademy.org']);

/** Syntax a link must not be put in, around or over. */
const NO_LINK_NODES = new Set([
  'Link', 'Image', 'Autolink', 'URL', 'Wikilink',
  'InlineCode', 'FencedCode', 'CodeBlock', 'HTMLBlock', 'HTMLTag', 'CommentBlock',
  'HeaderMark', 'ListMark', 'QuoteMark', 'TaskMarker', 'TableDelimiter',
]);

export interface PasteLinkOptions {
  getMetadata: () => FolderMetadata | null;
  getCurrentFilePath: () => string | null;
}

const setPastedLink = StateEffect.define<{ from: number; to: number }>();

/**
 * The link a paste just made, while the cursor stays right after it. Live
 * preview shows a link's syntax while the cursor touches it, so without this
 * a paste would show [40%](https://…) until the cursor moved away; with it the
 * link shows as a link at once. Any edit or cursor move ends it.
 */
export const pastedLinkField = StateField.define<{ from: number; to: number } | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setPastedLink)) return effect.value;
    }
    if (!value || tr.annotation(Transaction.userEvent)) return null;
    // Others' edits only move it
    const from = tr.changes.mapPos(value.from, 1);
    const to = tr.changes.mapPos(value.to, -1);
    const { main, ranges } = tr.state.selection;
    return ranges.length === 1 && main.empty && main.head === to && from < to ? { from, to } : null;
  },
});

/**
 * The pasted text as a URL, if it is one URL and nothing else: http(s),
 * mailto: or xmpp:, or www. (made https), as lang-markdown takes them.
 */
export function pastedUrl(text: string): string | null {
  let url = text.trim();
  if (!/^(https?:\/\/|mailto:|xmpp:|www\.)\S+$/i.test(url)) return null;
  if (/^www\./i.test(url)) url = 'https://' + url;
  try {
    new URL(url);
  } catch {
    return null;
  }
  return url;
}

/**
 * The document (its metadata path) an editor URL opens, or null. Takes the
 * shapes the editor's routes do: /{uuid prefix}/{decorative path},
 * /edu/{uuid prefix}, /open/{vault path} and /{vault path}.
 */
export function docPathForUrl(
  url: string,
  metadata: FolderMetadata,
  origin: string = window.location.origin,
): string | null {
  let parsed: URL;
  let segments: string[];
  try {
    parsed = new URL(url);
    segments = parsed.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  } catch {
    return null;
  }
  if (parsed.origin !== origin && !EDITOR_HOSTS.has(parsed.hostname)) return null;
  if (segments.length === 0) return null;

  let path: string | null = null;
  if (segments[0] === 'edu' && segments.length > 1) {
    path = pathForUuidPrefix(segments[1], metadata);
  } else if (segments[0] === 'open') {
    path = pathForVaultPath('/' + segments.slice(1).join('/'), metadata);
  } else {
    // As DocumentView reads it: a uuid prefix first, else a vault path
    path = pathForUuidPrefix(segments[0], metadata)
      ?? pathForVaultPath('/' + segments.join('/'), metadata);
  }
  return path && isLinkTarget(path, metadata[path]) ? path : null;
}

function pathForUuidPrefix(prefix: string, metadata: FolderMetadata): string | null {
  if (!/^[0-9a-f-]{8,}$/i.test(prefix)) return null;
  const lower = prefix.toLowerCase();
  const matches = Object.keys(metadata).filter((path) => metadata[path].id.toLowerCase().startsWith(lower));
  return matches.length === 1 ? matches[0] : null;
}

function pathForVaultPath(path: string, metadata: FolderMetadata): string | null {
  for (const candidate of [path, path + '.md']) {
    if (metadata[candidate]) return candidate;
  }
  return null;
}

/** The text a link to `path` names it by, as wikilink autocomplete writes it. */
function wikilinkName(path: string, currentFilePath: string | null): string {
  return currentFilePath
    ? computeRelativePath(currentFilePath, path)
    : path.slice(1).replace(/\.(md|html)$/i, '');
}

/**
 * The markup to put before and after `text` to link it to `url`, or null when
 * the text can't be a link's text (empty, several lines, brackets, a URL).
 * `docName` makes it a wikilink to that name, unless the text has a | (which
 * would end the wikilink's name).
 */
export function linkMarkup(
  text: string,
  url: string,
  docName: string | null = null,
): { before: string; after: string } | null {
  if (!text.trim() || /[\r\n[\]]/.test(text) || pastedUrl(text)) return null;
  if (docName !== null && !text.includes('|')) {
    return { before: `[[${docName}|`, after: ']]' };
  }
  return { before: '[', after: `](${linkDestination(url)})` };
}

/** A URL as a link destination: unbalanced parentheses would end it early. */
function linkDestination(url: string): string {
  let depth = 0;
  for (const ch of url) {
    if (ch === '(') depth++;
    else if (ch === ')' && --depth < 0) break;
  }
  return depth === 0 ? url : url.replace(/\(/g, '%28').replace(/\)/g, '%29');
}

/**
 * Where a link around [from, to) would be, or null when it can't go there:
 * across lines, in the frontmatter, in or over code, links or block marks,
 * over half of other syntax (such as one ** of a bold run) or half of
 * someone's suggestion.
 */
function linkPlace(state: EditorState, from: number, to: number): { inTable: boolean } | null {
  if (state.doc.lineAt(from).number !== state.doc.lineAt(to).number) return null;

  const fm = state.field(frontmatterField, false)?.range;
  if (fm && from < fm.to && to > fm.from) return null;

  let ok = true;
  let inTable = false;
  syntaxTree(state).iterate({
    from,
    to,
    enter: (node) => {
      if (node.to <= from || node.from >= to) return false; // only touches the selection
      const contains = node.from <= from && node.to >= to;
      const inside = node.from >= from && node.to <= to;
      const half = !contains && !inside;
      // One ** of a bold run: the run itself contains the selection
      const parent = node.node.parent;
      const halfMarks = inside && /Mark$/.test(node.name) && !!parent && (parent.from < from || parent.to > to);
      if (half || halfMarks || NO_LINK_NODES.has(node.name)) ok = false;
      if (node.name === 'Table') inTable = true;
      return ok;
    },
  });
  if (!ok) return null;

  // Both ends inside the same suggestion, or both outside every suggestion
  for (const range of state.field(criticMarkupField, false) ?? []) {
    const fromInside = from > range.from && from < range.to;
    const toInside = to > range.from && to < range.to;
    if (fromInside !== toInside) return null;
  }
  return { inTable };
}

/** The transaction that links the selection to the pasted text, or null for a normal paste. */
export function pasteLinkSpec(
  state: EditorState,
  pasted: string,
  metadata: FolderMetadata | null,
  currentFilePath: string | null,
  origin?: string,
): TransactionSpec | null {
  const url = pastedUrl(pasted);
  if (!url || state.selection.ranges.length !== 1) return null;
  let { from, to } = state.selection.main;
  if (from === to) return null;

  // Leave spaces at the selection's edges outside the link
  const selected = state.sliceDoc(from, to);
  const text = selected.trim();
  if (!text) return null;
  from += selected.length - selected.trimStart().length;
  to = from + text.length;

  const place = linkPlace(state, from, to);
  if (!place) return null;
  // In a table row (source mode) a wikilink's | would split the cell
  const docPath = metadata && !place.inTable ? docPathForUrl(url, metadata, origin) : null;
  const markup = linkMarkup(text, url, docPath && wikilinkName(docPath, currentFilePath));
  if (!markup) return null;

  const end = to + markup.before.length + markup.after.length;
  return {
    changes: [
      { from, insert: markup.before },
      { from: to, insert: markup.after },
    ],
    selection: EditorSelection.cursor(end),
    effects: setPastedLink.of({ from, to: end }),
    scrollIntoView: true,
    userEvent: 'input.paste',
  };
}

export function pasteLink({ getMetadata, getCurrentFilePath }: PasteLinkOptions): Extension {
  return [pastedLinkField, Prec.high(EditorView.domEventHandlers({
    paste(event, view) {
      if (view.state.readOnly) return false;
      const pasted = event.clipboardData?.getData('text/plain') ?? '';
      const spec = pasteLinkSpec(view.state, pasted, getMetadata(), getCurrentFilePath());
      if (!spec) return false;
      event.preventDefault();
      view.dispatch(spec);
      return true;
    },
  }))];
}
