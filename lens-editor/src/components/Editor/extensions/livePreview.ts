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
 * - Links render as clickable text with external link icon
 * - Inline code shows with distinct background styling
 * - Bullet list markers replaced with dot (•) widget
 * - Checklists rendered as interactive checkboxes with toggle
 * - Completed tasks shown with strikethrough
 */

import {
  ViewPlugin,
  ViewUpdate,
  EditorView,
  Decoration,
  drawSelection,
  WidgetType,
} from '@codemirror/view';
import { criticMarkupCompartment, criticMarkupPlugin, criticMarkupSourcePlugin } from './criticmarkup';
import { markdownTableCompartment, markdownTableExtension } from './markdownTable';
import { frontmatterPlugin, frontmatterField, frontmatterSourcePlugin, setFrontmatterEnabled } from './frontmatter';
import type { DecorationSet } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import { RangeSetBuilder, Compartment, EditorSelection, StateEffect, StateField } from '@codemirror/state';
import type { FolderMetadata } from '../../../hooks/useFolderMetadata';
import { isImageEmbedTarget } from '../../../lib/isImageEmbedTarget';

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

/**
 * WikilinkContext for navigation callbacks
 * Set via livePreview() function parameter
 */
export interface WikilinkContext {
  onClick: (pageName: string) => void;
  onOpenNewTab?: (pageName: string) => void;
  isResolved: (pageName: string) => boolean;
}

// Module-scoped context (set by livePreview factory)
let wikilinkContext: WikilinkContext | null = null;

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

/**
 * StateEffect dispatched when wikilink metadata changes (e.g., file renames).
 * Triggers decoration rebuild so widget resolution state updates.
 */
export const wikilinkMetadataChanged = StateEffect.define<void>();

/**
 * WikilinkWidget - Renders wikilinks as clickable internal links
 * Uses module-scoped wikilinkContext for navigation and resolution checking
 */
class WikilinkWidget extends WidgetType {
  pageName: string;
  resolved: boolean;

  constructor(pageName: string, resolved: boolean) {
    super();
    this.pageName = pageName;
    this.resolved = resolved;
  }

  toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = 'cm-wikilink-widget';

    // Add unresolved class if document doesn't exist
    if (!this.resolved) {
      span.classList.add('unresolved');
    }

    span.textContent = this.pageName;
    span.style.cursor = 'pointer';
    span.onclick = (e) => {
      e.preventDefault();
      if (!wikilinkContext) return;
      if (e.ctrlKey || e.metaKey) {
        wikilinkContext.onOpenNewTab?.(this.pageName);
      } else {
        wikilinkContext.onClick(this.pageName);
      }
    };
    span.onmousedown = (e) => { if (e.button === 1) e.preventDefault(); };
    span.onauxclick = (e) => {
      if (e.button === 1) {
        e.preventDefault();
        wikilinkContext?.onOpenNewTab?.(this.pageName);
      }
    };
    return span;
  }

  eq(other: WikilinkWidget): boolean {
    return this.pageName === other.pageName && this.resolved === other.resolved;
  }
}

/**
 * LinkWidget - Renders links as clickable text with external link icon
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
    const span = document.createElement('span');
    span.className = 'cm-link-widget';
    span.textContent = this.text;

    const icon = document.createElement('span');
    icon.className = 'cm-link-icon';
    span.appendChild(icon);

    span.style.cursor = 'pointer';
    span.onclick = (e) => {
      e.preventDefault();
      // Prepend https:// if URL doesn't have a protocol
      let url = this.url;
      if (!/^https?:\/\//i.test(url)) {
        url = 'https://' + url;
      }
      window.open(url, '_blank');
    };

    return span;
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

/**
 * BulletWidget - Renders bullet list markers as a dot character
 */
class BulletWidget extends WidgetType {
  toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = 'cm-bullet';
    span.textContent = '\u2022';
    return span;
  }

  eq(_other: BulletWidget): boolean {
    return true;
  }
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

function isHashtagContextExcluded(
  view: EditorView,
  pos: number,
  obsidianCommentRanges: readonly TextRange[]
): boolean {
  const frontmatter = view.state.field(frontmatterField);
  if (frontmatter.enabled && frontmatter.range &&
      pos >= frontmatter.range.from && pos <= frontmatter.range.to) {
    return true;
  }
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
        metadataChanged
      ) {
        this.decorations = this.buildDecorations(update.view);
      }
    }

    buildDecorations(view: EditorView): DecorationSet {
      const builder = new RangeSetBuilder<Decoration>();
      const selection = view.state.selection;

      // Track decorations to sort them (required for RangeSetBuilder)
      let decorations: Array<{ from: number; to: number; deco: Decoration }> =
        [];
      const obsidianCommentRanges = view.state.field(obsidianCommentRangesField);

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
            // Headings: ALWAYS apply heading class for font sizing
            // # markers are hidden separately based on cursor position (HeaderMark below)
            if (node.name in HEADING_CLASSES) {
              decorations.push({
                from: node.from,
                to: node.to,
                deco: Decoration.mark({ class: HEADING_CLASSES[node.name] }),
              });
              // Add line decoration for heading top spacing (margin-top doesn't work on inline spans)
              const headingLine = view.state.doc.lineAt(node.from);
              decorations.push({
                from: headingLine.from,
                to: headingLine.from,
                deco: Decoration.line({ class: `cm-heading-line ${HEADING_CLASSES[node.name]}-line` }),
              });
            }

            // HeaderMark (# characters): hide when cursor not on line
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
              if (!selectionIntersects(selection, node.from, node.to) && !rangeSpansLineBreak(view, node.from, node.to)) {
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
              if (!selectionIntersects(selection, node.from, node.to) && !rangeSpansLineBreak(view, node.from, node.to)) {
                // Extract page name from WikilinkContent child (works for both [[page]] and ![[page]])
                const contentNode = node.node.getChild('WikilinkContent');
                if (!contentNode) return;
                const raw = view.state.doc.sliceString(contentNode.from, contentNode.to);
                const pipeIndex = raw.indexOf('|');
                const content = pipeIndex !== -1 ? raw.substring(0, pipeIndex) : raw;

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

                const resolved = wikilinkContext ? wikilinkContext.isResolved(content) : true;
                decorations.push({
                  from: node.from,
                  to: node.to,
                  deco: Decoration.replace({
                    widget: new WikilinkWidget(content, resolved),
                  }),
                });
                // Skip children (WikilinkMark) - replaced by widget
                return false;
              }
            }

            // FencedCode: line decorations for background + hide fences when cursor outside
            if (node.name === 'FencedCode') {
              const cursorInside = selectionIntersects(selection, node.from, node.to);

              // Add cm-code-block line class to every line in the fenced code range
              const startLine = view.state.doc.lineAt(node.from).number;
              const endLine = view.state.doc.lineAt(node.to).number;
              for (let ln = startLine; ln <= endLine; ln++) {
                const line = view.state.doc.line(ln);
                decorations.push({
                  from: line.from,
                  to: line.from,
                  deco: Decoration.line({ class: 'cm-code-block' }),
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
                      widget: new BulletWidget(),
                    }),
                  });
                }
              }
            }

            // Blockquote: add line decoration for left border styling
            if (node.name === 'Blockquote') {
              const startLine = view.state.doc.lineAt(node.from).number;
              const endLine = view.state.doc.lineAt(node.to).number;
              for (let ln = startLine; ln <= endLine; ln++) {
                const line = view.state.doc.line(ln);
                decorations.push({
                  from: line.from,
                  to: line.from,
                  deco: Decoration.line({ class: 'cm-blockquote' }),
                });
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

      const doc = view.state.doc;
      const removeDeco = new Set<number>();

      for (const { from, to } of view.visibleRanges) {
        for (let pos = from; pos <= to; ) {
          const line = doc.lineAt(pos);
          pos = line.to + 1;

          const match = line.text.match(/^(\t*)- /);
          if (!match) continue;

          // Skip task list items (handled by checklist code)
          if (/^(\t*)- \[[ x]\] /i.test(line.text)) continue;

          const indent = match[1].length;
          const hasLezerBullet = lezerBulletDecos.has(line.number);

          // Indent 0: always valid
          if (indent === 0) {
            if (!hasLezerBullet && !selectionIntersects(selection, line.from, line.from + 2)) {
              decorations.push({ from: line.from, to: line.from + 2,
                deco: Decoration.replace({ widget: new BulletWidget() }) });
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
                decorations.push({ from: dashFrom, to: dashFrom + 2,
                  deco: Decoration.replace({ widget: new BulletWidget() }) });
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
 * Live preview extension with all necessary components
 *
 * Includes:
 * - drawSelection() for proper cursor rendering with hidden content
 * - ViewPlugin for selection-aware decorations
 *
 * @param context - Optional WikilinkContext for navigation callbacks
 */
export function livePreview(context?: WikilinkContext) {
  if (context) {
    wikilinkContext = context;
  }
  return [
    drawSelection(), // Required for proper cursor with hidden content
    frontmatterField, // StateField outside compartment (survives source mode toggle)
    obsidianCommentRangesField,
    livePreviewCompartment.of([livePreviewPlugin, obsidianCommentPlugin, frontmatterPlugin, livePreviewTheme]),
  ];
}

/**
 * Update the wikilink context without recreating the extension.
 * Call this when metadata changes to update navigation and resolution.
 */
export function updateWikilinkContext(context: WikilinkContext | undefined) {
  wikilinkContext = context ?? null;
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
      if (update.docChanged || update.viewportChanged) {
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
        sourceMode ? [sourceHeadingPlugin, obsidianCommentPlugin, frontmatterSourcePlugin, livePreviewTheme] : [livePreviewPlugin, obsidianCommentPlugin, frontmatterPlugin, livePreviewTheme]
      ),
      criticMarkupCompartment.reconfigure(
        sourceMode ? criticMarkupSourcePlugin : criticMarkupPlugin
      ),
      markdownTableCompartment.reconfigure(
        sourceMode ? [] : markdownTableExtension()
      ),
      setFrontmatterEnabled.of(!sourceMode),
    ],
  });
}
