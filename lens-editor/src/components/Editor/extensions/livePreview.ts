/**
 * Live Preview Extension for CodeMirror 6
 *
 * Implements Obsidian-style inline rendering where markdown syntax hides
 * when cursor moves away and reveals when editing.
 *
 * Key features:
 * - Headings (H1-H6) display with progressively smaller font sizes
 * - # markers hidden when cursor not on heading line
 * - Bold/italic text shows formatted when cursor moves away
 * - Asterisks/underscores hidden when cursor not on that text
 * - Links render as clickable underlined text, web links with an external-link icon
 * - Inline code shows with distinct background styling
 * - Bullet list markers replaced with dot (•) widget
 * - Checklists rendered as interactive checkboxes with toggle
 * - Completed tasks shown with strikethrough
 * - Horizontal rules (---, ***, ___) drawn as a divider line; the characters
 *   hidden when cursor not on that line
 */

import {
  ViewPlugin,
  ViewUpdate,
  EditorView,
  Decoration,
  drawSelection,
  WidgetType,
  keymap,
} from '@codemirror/view';
import { criticMarkupCompartment, criticMarkupLivePreview, criticMarkupSourcePlugin, criticMarkupField, canAcceptRejectFacet } from './criticmarkup';
import { markdownTableCompartment, markdownTableExtension } from './markdownTable';
import { createLinkElement } from './linkElement';
import { createWikilinkElement, getWikilinkContext, inEmbedCard, linksCreate, setWikilinkContext, splitWikilink } from './wikilinkElement';
import type { WikilinkContext } from './wikilinkElement';
import { pastedLinkField } from './pasteLink';
import { frontmatterPlugin, frontmatterField, frontmatterSourcePlugin, setFrontmatterEnabled } from './frontmatter';
import { listHangingIndent } from './listHangingIndent';
import type { DecorationSet } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import type { SyntaxNode } from '@lezer/common';
import { RangeSetBuilder, Compartment, EditorSelection, StateField, Prec } from '@codemirror/state';
import type { EditorState } from '@codemirror/state';
import type { FolderMetadata } from '../../../hooks/useFolderMetadata';
import { wikilinkMetadataChanged } from './wikilinkEffects';
import { noteEmbeds } from './noteEmbed';
import { isImageEmbedTarget } from '../../../../shared/embeds';
import { parseCalloutHeader, CalloutIconWidget } from './callouts';
import { syntaxReveal } from './syntaxReveal';

const USE_LOCAL_RELAY = import.meta.env.VITE_LOCAL_RELAY === 'true';
const USE_LOCAL_R2 = USE_LOCAL_RELAY && import.meta.env.VITE_LOCAL_R2 === 'true';

// CSS classes for heading sizes
const HEADING_CLASSES: Record<string, string> = {
  ATXHeading1: 'cm-heading-1',
  ATXHeading2: 'cm-heading-2',
  ATXHeading3: 'cm-heading-3',
  ATXHeading4: 'cm-heading-4',
  ATXHeading5: 'cm-heading-5',
  ATXHeading6: 'cm-heading-6',
};

// Hidden syntax class
const HIDDEN_CLASS = 'cm-hidden-syntax';

// Emphasis/strong classes
const EMPHASIS_CLASS = 'cm-emphasis';
const STRONG_CLASS = 'cm-strong';

// Inline code class
const INLINE_CODE_CLASS = 'cm-inline-code';

// Hashtags are presentation-only: they remain ordinary document text and do
// not acquire navigation or indexing behavior.
const HASHTAG_CLASS = 'cm-hashtag';
const HASHTAG_PATTERN = /(^|[\s([{])#(?=[\p{L}_-])[\p{L}\p{N}_-]+(?:\/[\p{L}\p{N}_-]+)*/gu;
const HASHTAG_EXCLUDED_NODES = new Set([
  'ATXHeading1',
  'ATXHeading2',
  'ATXHeading3',
  'ATXHeading4',
  'ATXHeading5',
  'ATXHeading6',
  'Autolink',
  'CodeBlock',
  'CommentBlock',
  'FencedCode',
  'HTMLBlock',
  'InlineCode',
  'Link',
  'SetextHeading1',
  'SetextHeading2',
  'URL',
]);

export type { WikilinkContext } from './wikilinkElement';

/**
 * Context for resolving ![[image]] embeds — set via updateImageEmbedContext()
 */
export interface ImageEmbedContext {
  metadata: FolderMetadata;
  relayId: string;
  /** Prefixed path of the currently-open document, e.g. "/Relay Folder 1/Welcome.md" */
  currentFilePath?: string;
}

let imageEmbedContext: ImageEmbedContext | null = null;

export function updateImageEmbedContext(context: ImageEmbedContext | undefined) {
  imageEmbedContext = context ?? null;
}

export { wikilinkMetadataChanged } from './wikilinkEffects';

/**
 * WikilinkWidget - Renders wikilinks as clickable internal links
 * Uses module-scoped wikilinkContext for navigation and resolution checking
 */
class WikilinkWidget extends WidgetType {
  pageName: string;
  displayText: string;
  resolved: boolean;

  constructor(pageName: string, displayText: string, resolved: boolean) {
    super();
    this.pageName = pageName;
    this.displayText = displayText;
    this.resolved = resolved;
  }

  toDOM(view: EditorView): HTMLElement {
    return createWikilinkElement(this.pageName, this.displayText, this.resolved, () => linksCreate(view));
  }

  eq(other: WikilinkWidget): boolean {
    return this.pageName === other.pageName && this.displayText === other.displayText && this.resolved === other.resolved;
  }
}

/**
 * LinkWidget - Renders links as clickable underlined text, with an external-link
 * icon after links to the web (linkElement.ts)
 */
class LinkWidget extends WidgetType {
  private text: string;
  private url: string;

  constructor(text: string, url: string) {
    super();
    this.text = text;
    this.url = url;
  }

  toDOM(): HTMLElement {
    return createLinkElement(this.text, this.url);
  }

  eq(other: LinkWidget): boolean {
    return this.text === other.text && this.url === other.url;
  }
}

/**
 * ImageWidget - Renders ![alt](url) as an inline image preview
 */
class ImageWidget extends WidgetType {
  private alt: string;
  private url: string;
  private view: EditorView;

  constructor(alt: string, url: string, view: EditorView) {
    super();
    this.alt = alt;
    this.url = url;
    this.view = view;
  }

  get estimatedHeight(): number {
    return 150;
  }

  toDOM(): HTMLElement {
    const container = document.createElement('span');
    container.className = 'cm-image-widget';

    // Security: only allow http/https URLs and trusted same-origin relay blob endpoints
    const isTrustedUrl = /^https?:\/\//i.test(this.url)
      || this.url.startsWith('/api/relay/')
      || this.url.startsWith('/api/blob');
    if (!isTrustedUrl) {
      container.classList.add('cm-image-error');
      const fallback = document.createElement('span');
      fallback.className = 'cm-image-fallback';
      fallback.textContent = this.alt || this.url;
      container.appendChild(fallback);
      return container;
    }

    const img = document.createElement('img');
    img.alt = this.alt;
    img.className = 'cm-image-preview';
    img.src = this.url;

    // Loading: hide img until loaded, show placeholder
    img.style.display = 'none';
    const placeholder = document.createElement('span');
    placeholder.className = 'cm-image-loading';
    placeholder.textContent = this.alt || 'Loading image…';
    container.appendChild(placeholder);

    img.onload = () => {
      placeholder.remove();
      img.style.display = '';
      this.view.requestMeasure();
    };
    img.onerror = () => {
      placeholder.remove();
      img.remove();
      container.classList.add('cm-image-error');
      const fallback = document.createElement('span');
      fallback.className = 'cm-image-fallback';
      fallback.textContent = `Image not found: ${this.alt || this.url}`;
      container.appendChild(fallback);
      this.view.requestMeasure();
    };

    container.appendChild(img);
    return container;
  }

  eq(other: ImageWidget): boolean {
    return this.alt === other.alt && this.url === other.url;
  }
}

/**
 * ImageEmbedWidget - Renders ![[path]] wikilink embeds as inline image previews.
 * Resolves path against imageEmbedContext metadata, then fetches the blob URL.
 */
class ImageEmbedWidget extends WidgetType {
  private readonly embedPath: string;
  private readonly docId: string | undefined;
  private readonly hash: string | undefined;
  private readonly view: EditorView;

  constructor(embedPath: string, docId: string | undefined, hash: string | undefined, view: EditorView) {
    super();
    this.embedPath = embedPath;
    this.docId = docId;
    this.hash = hash;
    this.view = view;
  }

  get estimatedHeight(): number { return 150; }

  toDOM(): HTMLElement {
    const container = document.createElement('span');
    container.className = 'cm-image-widget';

    const filename = this.embedPath.split('/').pop() || this.embedPath;
    const placeholder = document.createElement('span');
    placeholder.className = 'cm-image-loading';
    placeholder.textContent = filename;
    container.appendChild(placeholder);

    if (!this.docId || !this.hash) {
      placeholder.className = 'cm-image-fallback';
      container.classList.add('cm-image-error');
      return container;
    }

    this.loadImage(container, placeholder, filename).catch(() => { /* errors handled inside */ });
    return container;
  }

  private async loadImage(container: HTMLElement, placeholder: HTMLElement, filename: string): Promise<void> {
    let blobUrl: string;
    try {
      blobUrl = await this.resolveBlobUrl();
    } catch {
      placeholder.remove();
      container.classList.add('cm-image-error');
      const fallback = document.createElement('span');
      fallback.className = 'cm-image-fallback';
      fallback.textContent = `Failed to load: ${filename}`;
      container.appendChild(fallback);
      this.view.requestMeasure();
      return;
    }

    const img = document.createElement('img');
    img.className = 'cm-image-preview';
    img.alt = filename;
    img.style.display = 'none';

    img.onload = () => {
      placeholder.remove();
      img.style.display = '';
      this.view.requestMeasure();
    };
    img.onerror = () => {
      placeholder.remove();
      img.remove();
      container.classList.add('cm-image-error');
      const fallback = document.createElement('span');
      fallback.className = 'cm-image-fallback';
      fallback.textContent = `Image not found: ${filename}`;
      container.appendChild(fallback);
      this.view.requestMeasure();
    };

    container.appendChild(img);
    img.src = blobUrl;
  }

  private async resolveBlobUrl(): Promise<string> {
    const relayId = imageEmbedContext?.relayId ?? '';
    const compoundDocId = `${relayId}-${this.docId}`;

    if (USE_LOCAL_RELAY && !USE_LOCAL_R2) {
      // /api/blob/ is served by the blobServePlugin directly from the filesystem store
      // without auth — can be used as img.src unlike /api/relay/blob/ which requires X-Share-Token.
      return `/api/blob/${compoundDocId}/${this.hash}`;
    }

    const shareToken = localStorage.getItem('lens-share-token') ?? '';
    const dlRes = await fetch(`/api/relay/f/${compoundDocId}/download-url?hash=${this.hash}`, {
      headers: { 'X-Share-Token': shareToken },
    });
    if (!dlRes.ok) throw new Error(`Download URL failed: ${dlRes.status}`);
    const { downloadUrl } = await dlRes.json() as { downloadUrl: string };
    return `/api/blob-fetch?url=${encodeURIComponent(downloadUrl)}`;
  }

  eq(other: ImageEmbedWidget): boolean {
    return this.embedPath === other.embedPath && this.hash === other.hash;
  }
}

/** Display names for common code fence languages; others show as written. */
const CODE_LANGUAGE_NAMES: Record<string, string> = {
  ts: 'TypeScript', typescript: 'TypeScript', tsx: 'TSX', js: 'JavaScript', javascript: 'JavaScript', jsx: 'JSX',
  py: 'Python', python: 'Python', rs: 'Rust', rust: 'Rust', go: 'Go', java: 'Java', rb: 'Ruby', ruby: 'Ruby',
  sh: 'Shell', bash: 'Bash', shell: 'Shell', zsh: 'Shell', ps1: 'PowerShell', powershell: 'PowerShell',
  json: 'JSON', yaml: 'YAML', yml: 'YAML', toml: 'TOML', xml: 'XML', html: 'HTML', css: 'CSS', scss: 'SCSS',
  sql: 'SQL', md: 'Markdown', markdown: 'Markdown', c: 'C', cpp: 'C++', cs: 'C#', csharp: 'C#',
  kotlin: 'Kotlin', swift: 'Swift', php: 'PHP', r: 'R', diff: 'Diff', text: 'Plain text', txt: 'Plain text',
};

function codeLanguageName(info: string): string | null {
  const lang = info.trim().split(/\s+/)[0];
  if (!lang) return null;
  return CODE_LANGUAGE_NAMES[lang.toLowerCase()] ?? lang;
}

/** The language label at the top of a code box (on its hidden opening fence line). */
class CodeLanguageWidget extends WidgetType {
  constructor(private readonly name: string) {
    super();
  }

  toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = 'cm-code-language';
    span.textContent = this.name;
    return span;
  }

  eq(other: CodeLanguageWidget): boolean {
    return this.name === other.name;
  }
}

/** Bullet glyphs by nesting depth, as in Notion: disc, circle, square, repeating. */
const BULLET_GLYPHS = ['\u2022', '\u25e6', '\u25aa'];

/**
 * BulletWidget - Renders bullet list markers as a dot character
 */
class BulletWidget extends WidgetType {
  constructor(private readonly depth: number) {
    super();
  }

  toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = 'cm-bullet';
    span.textContent = BULLET_GLYPHS[this.depth % BULLET_GLYPHS.length];
    return span;
  }

  eq(other: BulletWidget): boolean {
    return this.depth === other.depth;
  }
}

/** How many lists (bulleted or numbered) contain this list: 0 at the top level. */
function listDepth(list: SyntaxNode): number {
  let depth = 0;
  for (let node = list.parent; node; node = node.parent) {
    if (node.name === 'BulletList' || node.name === 'OrderedList') depth++;
  }
  return depth;
}

/**
 * CheckboxWidget - Renders checklist markers as interactive checkboxes.
 * Clicking toggles [ ] <-> [x] in the document.
 */
class CheckboxWidget extends WidgetType {
  private checked: boolean;
  private from: number;
  private to: number;
  private onToggle: () => void;

  constructor(checked: boolean, from: number, to: number, onToggle: () => void) {
    super();
    this.checked = checked;
    this.from = from;
    this.to = to;
    this.onToggle = onToggle;
  }

  toDOM(): HTMLElement {
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.className = 'cm-checkbox';
    input.checked = this.checked;
    input.onclick = (e) => {
      e.preventDefault();
      this.onToggle();
    };
    return input;
  }

  eq(other: CheckboxWidget): boolean {
    return this.checked === other.checked && this.from === other.from && this.to === other.to;
  }
}

/**
 * Check if any selection range intersects with the given range
 */
function selectionIntersects(
  selection: EditorSelection,
  from: number,
  to: number
): boolean {
  return selection.ranges.some((range) => range.to >= from && range.from <= to);
}

/**
 * Check if cursor is on the same line as the given position
 */
function cursorOnLine(view: EditorView, pos: number): boolean {
  const cursorLine = view.state.doc.lineAt(view.state.selection.main.head).number;
  const targetLine = view.state.doc.lineAt(pos).number;
  return cursorLine === targetLine;
}

function rangeSpansLineBreak(view: EditorView, from: number, to: number): boolean {
  return to > view.state.doc.lineAt(from).to;
}

interface TextRange {
  from: number;
  to: number;
}

function findObsidianCommentRanges(text: string): TextRange[] {
  return Array.from(text.matchAll(/%%[\s\S]*?%%/g), (match) => ({
    from: match.index,
    to: match.index + match[0].length,
  }));
}

/**
 * The start of the empty line Enter has just made, while the cursor stays on
 * it and it stays empty: drawn as the line of text it is about to be, even
 * with text under it (pendingLine in buildDecorations)
 */
const newLineField = StateField.define<number | null>({
  create: () => null,
  update(value, tr) {
    const { main } = tr.state.selection;
    const line = tr.state.doc.lineAt(main.head);
    if (!main.empty || line.text.trim() !== '') return null;
    if (tr.docChanged && tr.isUserEvent('input')) {
      let newline = false;
      tr.changes.iterChanges((_fromA, _toA, _fromB, _toB, text) => {
        if (text.lines > 1) newline = true;
      });
      if (newline) return line.from;
    }
    if (value === null) return null;
    return (tr.docChanged ? tr.changes.mapPos(value) : value) === line.from ? line.from : null;
  },
});

const obsidianCommentRangesField = StateField.define<readonly TextRange[]>({
  create(state) {
    return findObsidianCommentRanges(state.doc.toString());
  },
  update(ranges, transaction) {
    return transaction.docChanged
      ? findObsidianCommentRanges(transaction.newDoc.toString())
      : ranges;
  },
});

/** Markdown blocks that YAML in the frontmatter can look like, left unstyled there */
const FRONTMATTER_SKIPPED_NODES = new Set([
  'ATXHeading1', 'ATXHeading2', 'ATXHeading3', 'ATXHeading4', 'ATXHeading5', 'ATXHeading6',
  'SetextHeading1', 'SetextHeading2', 'HeaderMark', 'HorizontalRule', 'Blockquote', 'QuoteMark',
  'BulletList', 'OrderedList', 'ListItem', 'ListMark', 'Task', 'TaskMarker',
]);

/**
 * Check if pos is inside the leading --- frontmatter block (rendered by frontmatter.ts)
 */
function inFrontmatter(view: EditorView, pos: number): boolean {
  const { enabled, range } = view.state.field(frontmatterField);
  return enabled && range !== null && pos >= range.from && pos <= range.to;
}

function isHashtagContextExcluded(
  view: EditorView,
  pos: number,
  obsidianCommentRanges: readonly TextRange[]
): boolean {
  if (inFrontmatter(view, pos)) return true;
  if (obsidianCommentRanges.some((range) => pos >= range.from && pos < range.to)) {
    return true;
  }
  for (let node = syntaxTree(view.state).resolveInner(pos, 1); node; node = node.parent!) {
    if (HASHTAG_EXCLUDED_NODES.has(node.name)) return true;
    if (!node.parent) break;
  }
  return false;
}

/**
 * True when the parser got further since the last update. Long documents are
 * parsed in the background after load and after edits; an update that only
 * carries the longer tree must rebuild, or the text past the old parse end
 * keeps its raw look until the next click or keystroke restyles it all at
 * once and the page jumps.
 */
function treeChanged(update: ViewUpdate): boolean {
  return syntaxTree(update.startState) !== syntaxTree(update.state);
}

/**
 * ViewPlugin that builds decorations based on cursor position
 */
const livePreviewPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = this.buildDecorations(view);
    }

    update(update: ViewUpdate) {
      const metadataChanged = update.transactions.some(
        tr => tr.effects.some(e => e.is(wikilinkMetadataChanged))
      );

      if (
        update.docChanged ||
        update.viewportChanged ||
        update.selectionSet ||
        metadataChanged ||
        treeChanged(update)
      ) {
        this.decorations = this.buildDecorations(update.view);
      }
    }

    buildDecorations(view: EditorView): DecorationSet {
      const builder = new RangeSetBuilder<Decoration>();
      const selection = view.state.selection;
      // A link shows its syntax while the cursor touches it, except one a paste
      // just made, which shows as a link until the cursor moves
      const pasted = view.state.field(pastedLinkField, false);
      const showLinkSyntax = (from: number, to: number) =>
        selectionIntersects(selection, from, to) && !(pasted?.from === from && pasted.to === to);

      // Track decorations to sort them (required for RangeSetBuilder)
      let decorations: Array<{ from: number; to: number; deco: Decoration }> =
        [];
      const obsidianCommentRanges = view.state.field(obsidianCommentRangesField);
      // Line numbers of horizontal rules, which the bullet validation below skips
      const hrLines = new Set<number>();
      // Line numbers inside fenced code, whose blank lines keep their height
      const codeLines = new Set<number>();
      const doc = view.state.doc;
      // The empty line the cursor is on, just made by Enter or with no text
      // under it: drawn as the line of text it is about to be (full height, a
      // heading above it spaced as from text), so nothing moves when typing
      // starts. Not a blank line between paragraphs the cursor only passes,
      // which keeps its 16px.
      const pendingLine = (() => {
        const { main } = selection;
        if (!main.empty) return -1;
        const line = doc.lineAt(main.head);
        if (line.text.trim() !== '') return -1;
        const justMade = view.state.field(newLineField, false) === line.from;
        if (!justMade && line.number < doc.lines && doc.line(line.number + 1).text.trim() !== '') return -1;
        if (inFrontmatter(view, line.from)) return -1;
        for (let node: SyntaxNode | null = syntaxTree(view.state).resolveInner(line.from, 1); node; node = node.parent) {
          if (node.name === 'FencedCode' || node.name === 'CodeBlock') return -1;
        }
        return line.number;
      })();
      /** Whether line `n` exists and has text: a block boundary without a blank line. */
      const hasText = (n: number) =>
        n === pendingLine || (n >= 1 && n <= doc.lines && doc.line(n).text.trim() !== '');
      // Text that isn't a heading, whose own padding spaces it from a list
      const hasProse = (n: number) => hasText(n) && !/^ {0,3}#{1,6}(\s|$)/.test(doc.line(n).text);

      // Iterate syntax tree within visible ranges only (performance)
      for (const { from, to } of view.visibleRanges) {
        // Scan prose text for hashtag tokens. Include one character before the
        // visible range so a clipped viewport cannot manufacture a boundary.
        const scanFrom = Math.max(0, from - 1);
        const text = view.state.doc.sliceString(scanFrom, to);
        HASHTAG_PATTERN.lastIndex = 0;
        for (const match of text.matchAll(HASHTAG_PATTERN)) {
          const boundaryLength = match[1].length;
          const tagFrom = scanFrom + match.index + boundaryLength;
          const tagTo = scanFrom + match.index + match[0].length;
          if (tagFrom < from || isHashtagContextExcluded(view, tagFrom, obsidianCommentRanges)) continue;
          decorations.push({
            from: tagFrom,
            to: tagTo,
            deco: Decoration.mark({ class: HASHTAG_CLASS }),
          });
        }

        syntaxTree(view.state).iterate({
          from,
          to,
          enter(node) {
            // The frontmatter is the page's properties (frontmatter.ts): its
            // YAML lines are not markdown headings, lists, rules or quotes,
            // though links in them still render
            if (FRONTMATTER_SKIPPED_NODES.has(node.name) && inFrontmatter(view, node.from)) return;

            // Headings: ALWAYS apply heading class for font sizing
            // # markers are hidden separately based on cursor position (HeaderMark below)
            if (node.name in HEADING_CLASSES) {
              decorations.push({
                from: node.from,
                to: node.to,
                // inclusiveEnd: a widget replacing the heading's end (a wikilink
                // that ends it, e.g. `### [[x]]`) is otherwise left outside the
                // mark and renders at body size.
                deco: Decoration.mark({ class: HEADING_CLASSES[node.name], inclusiveEnd: true }),
              });
              // Add line decoration for heading top spacing (margin-top doesn't work on inline spans).
              // Notion keeps 16px between blocks, which a blank line gives; where a
              // heading touches text above or below, its own padding gives it
              // (index.css). Under another heading it keeps its usual space
              // above, and that heading none below.
              const headingLine = view.state.doc.lineAt(node.from);
              let headingCls = `cm-heading-line ${HEADING_CLASSES[node.name]}-line`;
              if (hasProse(headingLine.number - 1)) headingCls += ' cm-heading-after-text';
              if (hasProse(headingLine.number + 1)) headingCls += ' cm-heading-before-text';
              decorations.push({
                from: headingLine.from,
                to: headingLine.from,
                deco: Decoration.line({ class: headingCls }),
              });
            }

            // HeaderMark (# characters): hide when cursor not on line, and
            // shown, quiet (index.css)
            if (node.name === 'HeaderMark') {
              if (!cursorOnLine(view, node.from)) {
                const line = view.state.doc.lineAt(node.from);
                // Hide # and trailing space
                const end = Math.min(node.to + 1, line.to);
                decorations.push({
                  from: node.from,
                  to: end,
                  deco: Decoration.mark({ class: HIDDEN_CLASS }),
                });
              } else {
                decorations.push({
                  from: node.from,
                  to: node.to,
                  deco: Decoration.mark({ class: 'cm-header-mark' }),
                });
              }
            }

            // HorizontalRule (---, ***, ___): divider line when cursor not on line.
            // The line class draws the rule (index.css) and the characters are
            // hidden. The leading --- of frontmatter is left to frontmatter.ts.
            if (node.name === 'HorizontalRule') {
              const hrLine = view.state.doc.lineAt(node.from);
              hrLines.add(hrLine.number);
              if (!cursorOnLine(view, node.from) && !inFrontmatter(view, node.from)) {
                decorations.push({
                  from: hrLine.from,
                  to: hrLine.from,
                  deco: Decoration.line({ class: 'cm-hr-line' }),
                });
                decorations.push({
                  from: node.from,
                  to: node.to,
                  deco: Decoration.mark({ class: HIDDEN_CLASS }),
                });
              }
            }

            // Emphasis (italic): element-based reveal
            if (node.name === 'Emphasis') {
              if (!selectionIntersects(selection, node.from, node.to)) {
                decorations.push({
                  from: node.from,
                  to: node.to,
                  deco: Decoration.mark({ class: EMPHASIS_CLASS }),
                });
              }
            }

            // StrongEmphasis (bold): element-based reveal
            if (node.name === 'StrongEmphasis') {
              if (!selectionIntersects(selection, node.from, node.to)) {
                decorations.push({
                  from: node.from,
                  to: node.to,
                  deco: Decoration.mark({ class: STRONG_CLASS }),
                });
              }
            }

            // StrikethroughMark (~~): hide when cursor not on the struck-through
            // text, as for * and _ (the highlighter draws the line itself)
            if (node.name === 'StrikethroughMark') {
              const parent = node.node.parent;
              if (parent && !selectionIntersects(selection, parent.from, parent.to)) {
                decorations.push({
                  from: node.from,
                  to: node.to,
                  deco: Decoration.mark({ class: HIDDEN_CLASS }),
                });
              }
            }

            // EmphasisMark (* or _ characters): hide when cursor not on element
            if (node.name === 'EmphasisMark') {
              // Get the parent node to check if cursor intersects the whole emphasis element
              const parent = node.node.parent;
              if (parent) {
                if (!selectionIntersects(selection, parent.from, parent.to)) {
                  decorations.push({
                    from: node.from,
                    to: node.to,
                    deco: Decoration.mark({ class: HIDDEN_CLASS }),
                  });
                }
              }
            }

            // Link: replace with clickable widget when cursor not on link
            // Link node contains: LinkMark `[`, link text, LinkMark `]`, LinkMark `(`, URL, LinkMark `)`
            if (node.name === 'Link') {
              if (!showLinkSyntax(node.from, node.to) && !rangeSpansLineBreak(view, node.from, node.to)) {
                // Extract link text and URL from the Link node's content
                const content = view.state.doc.sliceString(node.from, node.to);
                const textMatch = content.match(/^\[([^\]]*)\]/);
                const urlMatch = content.match(/\]\(([^)]*)\)$/);

                if (textMatch && urlMatch) {
                  const linkText = textMatch[1];
                  const linkUrl = urlMatch[1];

                  // Replace entire link with widget
                  decorations.push({
                    from: node.from,
                    to: node.to,
                    deco: Decoration.replace({
                      widget: new LinkWidget(linkText, linkUrl),
                    }),
                  });
                }
              }
            }

            // Image: replace ![alt](url) with inline preview when cursor not on it
            if (node.name === 'Image') {
              if (node.node.parent?.name === 'Link') return;
              if (!selectionIntersects(selection, node.from, node.to) && !rangeSpansLineBreak(view, node.from, node.to)) {
                const content = view.state.doc.sliceString(node.from, node.to);
                const match = content.match(/^!\[([^\]]*)\]\(([^\s)]+)(?:\s+"[^"]*")?\)$/);
                if (match) {
                  decorations.push({
                    from: node.from,
                    to: node.to,
                    deco: Decoration.replace({
                      widget: new ImageWidget(match[1], match[2], view),
                    }),
                  });
                }
              }
            }

            // Autolink (<url> syntax) and bare URL (https://... GFM autolink)
            if (node.name === 'Autolink' || (node.name === 'URL' && node.node.parent?.name !== 'Autolink' && node.node.parent?.name !== 'Link')) {
              if (!selectionIntersects(selection, node.from, node.to) && !rangeSpansLineBreak(view, node.from, node.to)) {
                // For Autolink, extract URL from child; for bare URL, use node directly
                const urlFrom = node.name === 'Autolink'
                  ? node.node.getChild('URL')?.from ?? node.from
                  : node.from;
                const urlTo = node.name === 'Autolink'
                  ? node.node.getChild('URL')?.to ?? node.to
                  : node.to;
                const url = view.state.doc.sliceString(urlFrom, urlTo);
                decorations.push({
                  from: node.from,
                  to: node.to,
                  deco: Decoration.replace({
                    widget: new LinkWidget(url, url),
                  }),
                });
              }
            }

            // Wikilink: replace with clickable widget when cursor not on link
            if (node.name === 'Wikilink') {
              if (!showLinkSyntax(node.from, node.to) && !rangeSpansLineBreak(view, node.from, node.to)) {
                // Extract page name from WikilinkContent child (works for both [[page]] and ![[page]])
                const contentNode = node.node.getChild('WikilinkContent');
                if (!contentNode) return;
                const raw = view.state.doc.sliceString(contentNode.from, contentNode.to);
                // [[target|alias]] shows the alias; a blank alias falls back to the target
                const { target: content, alias } = splitWikilink(raw);

                // Detect ![[...]] image embed: leading '!' plus an image file extension.
                // Without an image extension, fall through to render as a regular wikilink
                // (the editor doesn't support note transclusion).
                const hasImagePrefix = view.state.doc.sliceString(node.from, node.from + 1) === '!';
                const isImageEmbed = hasImagePrefix && isImageEmbedTarget(content);
                if (isImageEmbed) {
                  const normalizedPath = content.startsWith('/') ? content : `/${content}`;
                  // metadata uses folder-prefixed paths (e.g. "/Relay Folder 1/attachments/img.png").
                  // Derive the folder prefix from currentFilePath and prepend it.
                  const folderName = imageEmbedContext?.currentFilePath?.split('/').filter(Boolean)[0];
                  const lookupPath = folderName ? `/${folderName}${normalizedPath}` : normalizedPath;
                  let meta = imageEmbedContext?.metadata[lookupPath];
                  // Fallback: if currentFilePath wasn't populated yet (race on initial
                  // doc load) the folder-prefixed lookup misses. Scan metadata keys
                  // for any entry whose suffix matches the embed path.
                  if (!meta && !folderName && imageEmbedContext) {
                    const suffix = normalizedPath;
                    for (const key in imageEmbedContext.metadata) {
                      if (key.endsWith(suffix)) {
                        meta = imageEmbedContext.metadata[key];
                        break;
                      }
                    }
                  }
                  const docId = meta?.type === 'image' ? meta.id : undefined;
                  const hash = meta?.type === 'image' ? meta.hash : undefined;
                  decorations.push({
                    from: node.from,
                    to: node.to,
                    deco: Decoration.replace({
                      widget: new ImageEmbedWidget(content, docId, hash, view),
                    }),
                  });
                  return false;
                }

                const wikilinkContext = getWikilinkContext();
                const resolved = wikilinkContext ? wikilinkContext.isResolved(content) : true;
                decorations.push({
                  from: node.from,
                  to: node.to,
                  deco: Decoration.replace({
                    widget: new WikilinkWidget(content, alias.trim() ? alias : content, resolved),
                  }),
                });
                // Skip children (WikilinkMark) - replaced by widget
                return false;
              }
            }

            // FencedCode: line decorations for background + hide fences when cursor outside
            if (node.name === 'FencedCode') {
              const cursorInside = selectionIntersects(selection, node.from, node.to);

              // Add cm-code-block line class to every line in the fenced code
              // range, and -first / -last for the box's round corners
              const startLine = view.state.doc.lineAt(node.from).number;
              const endLine = view.state.doc.lineAt(node.to).number;
              for (let ln = startLine; ln <= endLine; ln++) {
                const line = view.state.doc.line(ln);
                codeLines.add(ln);
                let cls = 'cm-code-block';
                if (ln === startLine) cls += ' cm-code-block-first';
                if (ln === endLine) cls += ' cm-code-block-last';
                decorations.push({
                  from: line.from,
                  to: line.from,
                  deco: Decoration.line({ class: cls }),
                });
              }

              // Hide fence markers and language info when cursor is outside
              if (!cursorInside) {
                // Hide opening fence line content (``` + optional language)
                const openLine = view.state.doc.lineAt(node.from);
                if (openLine.from < openLine.to) {
                  decorations.push({
                    from: openLine.from,
                    to: openLine.to,
                    deco: Decoration.mark({ class: HIDDEN_CLASS }),
                  });
                }
                // The language, as Notion labels its code boxes
                const info = node.node.getChild('CodeInfo');
                const language = info ? codeLanguageName(view.state.doc.sliceString(info.from, info.to)) : null;
                if (language) {
                  decorations.push({
                    from: openLine.from,
                    to: openLine.from,
                    deco: Decoration.widget({ widget: new CodeLanguageWidget(language), side: -1 }),
                  });
                }

                // Hide closing fence line content (```)
                const closeLine = view.state.doc.lineAt(node.to);
                if (closeLine.from < closeLine.to && closeLine.number !== openLine.number) {
                  decorations.push({
                    from: closeLine.from,
                    to: closeLine.to,
                    deco: Decoration.mark({ class: HIDDEN_CLASS }),
                  });
                }

              }

              // Skip child iteration (CodeMark/CodeInfo/CodeText handled above)
              return false;
            }

            // InlineCode: always style, hide backticks only when cursor outside
            if (node.name === 'InlineCode') {
              decorations.push({
                from: node.from,
                to: node.to,
                deco: Decoration.mark({ class: INLINE_CODE_CLASS }),
              });
            }

            // CodeMark (backtick characters): hide when cursor not on inline code
            if (node.name === 'CodeMark') {
              // Get the parent node (InlineCode) to check if cursor intersects
              const parent = node.node.parent;
              if (parent) {
                if (!selectionIntersects(selection, parent.from, parent.to)) {
                  decorations.push({
                    from: node.from,
                    to: node.to,
                    deco: Decoration.mark({ class: HIDDEN_CLASS }),
                  });
                }
              }
            }

            // Numbers of numbered lists sit in a column, as Notion's do, so their
            // text lines up with bulleted lists' (index.css)
            if (node.name === 'ListMark' && node.node.parent?.parent?.name === 'OrderedList') {
              decorations.push({ from: node.from, to: node.to, deco: Decoration.mark({ class: 'cm-list-number' }) });
            }

            // ListMark in bullet lists: replace with dot widget when cursor not touching
            if (node.name === 'ListMark') {
              // Only handle bullet lists, not ordered lists
              const parent = node.node.parent; // ListItem
              const grandparent = parent?.parent; // BulletList or OrderedList
              if (grandparent && grandparent.name === 'BulletList') {
                // Skip if this is a task list item (has Task child — handled by checklist code)
                const listItem = parent;
                let isTask = false;
                if (listItem) {
                  for (let child = listItem.firstChild; child; child = child.nextSibling) {
                    if (child.name === 'Task') { isTask = true; break; }
                  }
                }
                if (!isTask && !selectionIntersects(selection, node.from, node.to)) {
                  decorations.push({
                    from: node.from,
                    to: node.to,
                    deco: Decoration.replace({
                      widget: new BulletWidget(listDepth(grandparent)),
                    }),
                  });
                }
              }
            }

            // Blockquote: add line decoration for left border styling.
            // A top-level blockquote starting `> [!type] Title` is an Obsidian
            // callout: its lines get callout classes, and the marker becomes
            // the type's icon while the cursor is outside it.
            if (node.name === 'Blockquote') {
              const firstLine = view.state.doc.lineAt(node.from);
              const startLine = firstLine.number;
              const endLine = view.state.doc.lineAt(node.to).number;
              const callout = node.node.parent?.name === 'Blockquote'
                ? null
                : parseCalloutHeader(view.state.doc.sliceString(node.from, firstLine.to));
              for (let ln = startLine; ln <= endLine; ln++) {
                const line = view.state.doc.line(ln);
                let cls = 'cm-blockquote';
                if (callout) {
                  cls += ` cm-callout cm-callout-${callout.type}`;
                  if (ln === startLine) cls += ' cm-callout-first';
                  if (ln === endLine) cls += ' cm-callout-last';
                }
                decorations.push({
                  from: line.from,
                  to: line.from,
                  deco: Decoration.line({ class: cls }),
                });
              }
              if (callout) {
                if (!selectionIntersects(selection, node.from, node.to)) {
                  decorations.push({
                    from: node.from + callout.markerFrom,
                    to: node.from + callout.markerTo,
                    deco: Decoration.replace({
                      widget: new CalloutIconWidget(callout.type, callout.title ? null : callout.defaultTitle),
                    }),
                  });
                }
                if (callout.title) {
                  decorations.push({
                    from: node.from + callout.markerTo,
                    to: firstLine.to,
                    deco: Decoration.mark({ class: 'cm-callout-title' }),
                  });
                }
              }
            }

            // QuoteMark: hide the > character when cursor is outside the blockquote
            if (node.name === 'QuoteMark') {
              const blockquote = node.node.parent;
              if (blockquote && !selectionIntersects(selection, blockquote.from, blockquote.to)) {
                // Hide > and trailing space
                const lineObj = view.state.doc.lineAt(node.from);
                const afterMark = node.to;
                const hideTo = afterMark < lineObj.to && view.state.doc.sliceString(afterMark, afterMark + 1) === ' '
                  ? afterMark + 1 : afterMark;
                decorations.push({
                  from: node.from,
                  to: hideTo,
                  deco: Decoration.mark({ class: HIDDEN_CLASS }),
                });
              }
            }

            // TaskMarker: replace list marker + task marker with checkbox widget
            if (node.name === 'TaskMarker') {
              // Find the ListMark sibling (the `- ` part)
              const task = node.node.parent; // Task node
              const listItem = task?.parent; // ListItem node
              let listMark: { from: number; to: number } | null = null;
              if (listItem) {
                for (let child = listItem.firstChild; child; child = child.nextSibling) {
                  if (child.name === 'ListMark') {
                    listMark = { from: child.from, to: child.to };
                    break;
                  }
                }
              }

              const replaceFrom = listMark ? listMark.from : node.from;
              // Include trailing space after ] in the replacement range
              const replaceTo = Math.min(node.to + 1, view.state.doc.lineAt(node.from).to);

              // Cursor proximity: reveal raw when cursor touches the marker chars.
              // node.to is the position right after ], which counts as "touching".
              // The trailing space (node.to + 1) does NOT trigger reveal.
              if (!selectionIntersects(selection, replaceFrom, node.to)) {
                const markerText = view.state.doc.sliceString(node.from, node.to);
                const isChecked = markerText !== '[ ]';
                const capturedFrom = node.from;
                const capturedTo = node.to;

                decorations.push({
                  from: replaceFrom,
                  to: replaceTo,
                  deco: Decoration.replace({
                    widget: new CheckboxWidget(isChecked, capturedFrom, capturedTo, () => {
                      const newText = isChecked ? '[ ]' : '[x]';
                      view.dispatch({
                        changes: { from: capturedFrom, to: capturedTo, insert: newText },
                      });
                    }),
                  }),
                });

                // Strikethrough for completed tasks
                if (isChecked) {
                  const lineEnd = view.state.doc.lineAt(node.from).to;
                  if (replaceTo < lineEnd) {
                    decorations.push({
                      from: replaceTo,
                      to: lineEnd,
                      deco: Decoration.mark({ class: 'cm-task-completed' }),
                    });
                  }
                }
              }
            }
          },
        });
      }

      // Blank lines are the space between paragraphs, 16px rather than a full
      // row (index.css), except inside code and frontmatter, and the cursor's
      // new line (pendingLine)
      for (const { from, to } of view.visibleRanges) {
        for (let pos = from; pos <= to; ) {
          const line = doc.lineAt(pos);
          pos = line.to + 1;
          if (line.text.trim() === '' && line.number !== pendingLine && !codeLines.has(line.number) && !inFrontmatter(view, line.from)) {
            decorations.push({ from: line.from, to: line.from, deco: Decoration.line({ class: 'cm-blank-line' }) });
          }
        }
      }

      // Obsidian-compatible bullet validation.
      // Lezer's list parser doesn't match Obsidian's rules: it may render bullets
      // that Obsidian wouldn't (e.g. indented `- ` after blank line + non-bullet text)
      // and miss bullets Obsidian would render (indent jumps from a valid bullet).
      //
      // Obsidian rules:
      // - Indent 0: always starts a new bullet list
      // - Indent > 0: only valid if the previous non-blank line is a bullet
      // - Max indent jump of +1 from the previous bullet's indent
      // - Blank lines are ignored; non-blank non-bullet lines reset context
      const lezerBulletDecos = new Map<number, number>();
      decorations.forEach((d, idx) => {
        if ('widget' in (d.deco as any).spec && (d.deco as any).spec.widget instanceof BulletWidget) {
          lezerBulletDecos.set(view.state.doc.lineAt(d.from).number, idx);
        }
      });

      const removeDeco = new Set<number>();

      for (const { from, to } of view.visibleRanges) {
        for (let pos = from; pos <= to; ) {
          const line = doc.lineAt(pos);
          pos = line.to + 1;

          const match = line.text.match(/^(\t*)- /);
          if (!match) continue;

          // Skip horizontal rules such as `- - -` (handled above), and YAML
          // list items in the frontmatter
          if (hrLines.has(line.number) || inFrontmatter(view, line.from)) continue;

          // Skip task list items (handled by checklist code)
          if (/^(\t*)- \[[ x]\] /i.test(line.text)) continue;

          const indent = match[1].length;
          const hasLezerBullet = lezerBulletDecos.has(line.number);

          // Indent 0: always valid
          if (indent === 0) {
            if (!hasLezerBullet && !selectionIntersects(selection, line.from, line.from + 2)) {
              decorations.push({ from: line.from, to: line.from + 2,
                deco: Decoration.replace({ widget: new BulletWidget(0) }) });
            }
            continue;
          }

          // Indent > 0: find previous non-blank line, check if it's a bullet
          let valid = false;
          const minLookback = Math.max(1, line.number - 100);
          for (let prev = line.number - 1; prev >= minLookback; prev--) {
            const prevLine = doc.line(prev);
            if (prevLine.text.trim() === '') continue;
            const prevMatch = prevLine.text.match(/^(\t*)- /);
            if (!prevMatch) break; // non-bullet non-blank → invalid
            valid = indent <= prevMatch[1].length + 1;
            break;
          }

          if (valid) {
            if (!hasLezerBullet) {
              const dashFrom = line.from + indent;
              if (!selectionIntersects(selection, dashFrom, dashFrom + 2)) {
                // Its depth is its indent: one tab per level
                decorations.push({ from: dashFrom, to: dashFrom + 2,
                  deco: Decoration.replace({ widget: new BulletWidget(indent) }) });
              }
            }
          } else if (hasLezerBullet) {
            removeDeco.add(lezerBulletDecos.get(line.number)!);
          }
        }
      }

      if (removeDeco.size > 0) {
        decorations = decorations.filter((_, i) => !removeDeco.has(i));
      }

      // Sort decorations by position (required for RangeSetBuilder)
      decorations.sort((a, b) => a.from - b.from || a.to - b.to);

      // Add to builder in sorted order
      for (const d of decorations) {
        builder.add(d.from, d.to, d.deco);
      }

      return builder.finish();
    }
  },
  {
    decorations: (v) => v.decorations,
  }
);

/**
 * Compartment for toggling live preview on/off (source mode toggle)
 */
export const livePreviewCompartment = new Compartment();

/**
 * Compartment for making the editor read-only when source mode + suggestion mode are both active
 */
export const sourceReadOnlyCompartment = new Compartment();

/**
 * Theme for live preview (empty since styles are in index.css,
 * but kept as a placeholder for consistency with the compartment pattern)
 */
const livePreviewTheme = EditorView.theme({});

/**
 * The target of the [[wikilink]] at pos (without its |alias), or null. For a
 * cursor, a position right after `]]` is on the link; for a click (`clicked`),
 * only the character after pos counts.
 */
export function wikilinkTargetAt(state: EditorState, pos: number, clicked = false): string | null {
  for (const side of clicked ? [1] as const : [1, -1] as const) {
    for (let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, side); node; node = node.parent) {
      if (node.name !== 'Wikilink') continue;
      const content = node.getChild('WikilinkContent');
      if (!content) return null;
      return splitWikilink(state.doc.sliceString(content.from, content.to)).target;
    }
  }
  return null;
}

/**
 * Following a wikilink shown as its raw text (the cursor is in it, or source
 * mode), where the widget's click handlers are not: Mod-Enter on it and
 * Mod-click open it in a new tab, creating the file if it doesn't exist.
 */
const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform);

const wikilinkFollow = [
  Prec.high(keymap.of([{
    key: 'Mod-Enter',
    run: (view) => {
      const head = view.state.selection.main.head;
      const target = wikilinkTargetAt(view.state, head);
      const wikilinkContext = getWikilinkContext();
      if (!target || !wikilinkContext?.onOpenNewTab) return false;
      // On a suggestion a reviewer may accept, Mod-Enter accepts it (criticMarkupKeymap)
      const { from, to } = view.state.selection.main;
      if (view.state.facet(canAcceptRejectFacet)
        && view.state.field(criticMarkupField, false)?.some((r) => from <= r.to && to >= r.from)) return false;
      wikilinkContext.onOpenNewTab(target, linksCreate(view));
      return true;
    },
  }])),
  EditorView.domEventHandlers({
    mousedown: (e, view) => {
      // Mod as in keymaps: on a Mac Ctrl-click is the context menu
      const wikilinkContext = getWikilinkContext();
      if (e.button !== 0 || !(IS_MAC ? e.metaKey : e.ctrlKey) || !wikilinkContext?.onOpenNewTab) return false;
      const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
      const target = pos === null ? null : wikilinkTargetAt(view.state, pos, true);
      if (!target) return false;
      // Not a second cursor (Mod-click's default): follow the link
      e.preventDefault();
      wikilinkContext.onOpenNewTab(target, linksCreate(view));
      return true;
    },
  }),
];

/**
 * Live preview extension with all necessary components
 *
 * Includes:
 * - drawSelection() for proper cursor rendering with hidden content
 * - ViewPlugin for selection-aware decorations
 *
 * @param context - Optional WikilinkContext for navigation callbacks
 */
export function livePreview(context?: WikilinkContext, { embeds = true }: { embeds?: boolean } = {}) {
  if (context) {
    setWikilinkContext(context);
  }
  return [
    drawSelection(), // Required for proper cursor with hidden content
    frontmatterField, // StateField outside compartment (survives source mode toggle)
    obsidianCommentRangesField,
    newLineField,
    listHangingIndent, // wrapped list rows align with the item text in both modes
    wikilinkFollow, // in both modes
    inEmbedCard.of(!embeds),
    // embeds: false inside an embed card, which never nests another
    livePreviewCompartment.of([livePreviewPlugin, syntaxReveal, ...(embeds ? [noteEmbeds] : []), obsidianCommentPlugin, frontmatterPlugin, livePreviewTheme]),
  ];
}

/**
 * Update the wikilink context without recreating the extension.
 * Call this when metadata changes to update navigation and resolution.
 */
export function updateWikilinkContext(context: WikilinkContext | undefined) {
  setWikilinkContext(context ?? null);
}

/**
 * Obsidian %%comment%% plugin — greys out %%...%% ranges (single and multi-line).
 * Uses regex scanning since %% syntax is not in the Lezer markdown grammar.
 */
const obsidianCommentPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = this.buildDecorations(view);
    }

    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = this.buildDecorations(update.view);
      }
    }

    buildDecorations(view: EditorView): DecorationSet {
      const builder = new RangeSetBuilder<Decoration>();
      const deco = Decoration.mark({ class: 'cm-obsidian-comment' });
      const matches = view.state.field(obsidianCommentRangesField).filter((match) =>
        view.visibleRanges.some(({ from, to }) => match.from < to && match.to > from)
      );

      matches.sort((a, b) => a.from - b.from);
      for (const { from, to } of matches) {
        builder.add(from, to, deco);
      }
      return builder.finish();
    }
  },
  {
    decorations: (v) => v.decorations,
  }
);

/**
 * Source-mode heading plugin — applies heading size classes
 * but keeps # markers visible (no hidden-syntax decorations).
 */
const sourceHeadingPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = this.buildDecorations(view);
    }

    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged || treeChanged(update)) {
        this.decorations = this.buildDecorations(update.view);
      }
    }

    buildDecorations(view: EditorView): DecorationSet {
      const builder = new RangeSetBuilder<Decoration>();
      const decorations: Array<{ from: number; to: number; deco: Decoration }> = [];

      for (const { from, to } of view.visibleRanges) {
        syntaxTree(view.state).iterate({
          from,
          to,
          enter(node) {
            if (node.name in HEADING_CLASSES) {
              decorations.push({
                from: node.from,
                to: node.to,
                deco: Decoration.mark({ class: HEADING_CLASSES[node.name] }),
              });
            }
          },
        });
      }

      decorations.sort((a, b) => a.from - b.from || a.to - b.to);
      for (const d of decorations) {
        builder.add(d.from, d.to, d.deco);
      }
      return builder.finish();
    }
  },
  {
    decorations: (v) => v.decorations,
  }
);

/**
 * Toggle between live preview mode and source mode
 * @param view - The EditorView instance
 * @param sourceMode - true to show source (raw markdown), false for live preview
 */
export function toggleSourceMode(view: EditorView, sourceMode: boolean) {
  view.dispatch({
    effects: [
      livePreviewCompartment.reconfigure(
        sourceMode ? [sourceHeadingPlugin, obsidianCommentPlugin, frontmatterSourcePlugin, livePreviewTheme] : [livePreviewPlugin, syntaxReveal, noteEmbeds, obsidianCommentPlugin, frontmatterPlugin, livePreviewTheme]
      ),
      criticMarkupCompartment.reconfigure(
        sourceMode ? criticMarkupSourcePlugin : criticMarkupLivePreview
      ),
      markdownTableCompartment.reconfigure(
        sourceMode ? [] : markdownTableExtension()
      ),
      setFrontmatterEnabled.of(!sourceMode),
    ],
  });
}
