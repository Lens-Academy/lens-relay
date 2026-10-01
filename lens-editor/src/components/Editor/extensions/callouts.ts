import { WidgetType } from '@codemirror/view';
import { iconNode } from '../../../lib/icons';
import type { IconName } from '../../../lib/icons';

/**
 * Obsidian callouts (`> [!tip] Title`), rendered by livePreview's Blockquote
 * branch. Aliases map onto Obsidian's built-in types; any other type is styled
 * as a note, as Obsidian does. Colours live in index.css (.cm-callout-<type>).
 */
const CALLOUT_ALIASES: Record<string, string> = {
  note: 'note',
  abstract: 'abstract', summary: 'abstract', tldr: 'abstract',
  info: 'info',
  todo: 'todo',
  tip: 'tip', hint: 'tip', important: 'tip',
  success: 'success', check: 'success', done: 'success',
  question: 'question', help: 'question', faq: 'question',
  warning: 'warning', caution: 'warning', attention: 'warning',
  failure: 'failure', fail: 'failure', missing: 'failure',
  danger: 'danger', error: 'danger',
  bug: 'bug',
  example: 'example',
  quote: 'quote', cite: 'quote',
};

// Obsidian's (Lucide) icon per type
const CALLOUT_ICONS: Record<string, IconName> = {
  note: 'pencil',
  abstract: 'clipboard-list',
  info: 'info',
  todo: 'circle-check',
  tip: 'flame',
  success: 'check',
  question: 'circle-help',
  warning: 'triangle-alert',
  failure: 'x',
  danger: 'zap',
  bug: 'triangle-alert',
  example: 'list',
  quote: 'quote',
};

export interface CalloutHeader {
  /** Built-in type the callout is styled as (unknown types become 'note'). */
  type: string;
  /** Offset of `[!` from the blockquote's start. */
  markerFrom: number;
  /** Offset just past `]`, the fold sign and the spaces before the title. */
  markerTo: number;
  /** Title text after the marker ('' when there is none). */
  title: string;
  /** Title to show when there is none: the type as written, capitalised. */
  defaultTitle: string;
}

const CALLOUT_HEADER = /^>\s?\[!([\w-]+)\][+-]?\s*(.*)$/;

/**
 * Parse a blockquote's first line, from its `>` to the end of the line (so a
 * quote that starts inside a list item works too), as a callout header.
 */
export function parseCalloutHeader(text: string): CalloutHeader | null {
  const m = CALLOUT_HEADER.exec(text);
  if (!m) return null;
  const [, rawType, title] = m;
  return {
    type: CALLOUT_ALIASES[rawType.toLowerCase()] ?? 'note',
    markerFrom: text.indexOf('[!'),
    markerTo: text.length - title.length,
    title,
    defaultTitle: rawType.charAt(0).toUpperCase() + rawType.slice(1).toLowerCase(),
  };
}

/**
 * CalloutIconWidget - replaces the `[!type]` marker with the type's icon, plus
 * the default title when the callout has no title of its own.
 */
export class CalloutIconWidget extends WidgetType {
  constructor(private type: string, private defaultTitle: string | null) {
    super();
  }

  toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = 'cm-callout-icon';
    const svg = iconNode(CALLOUT_ICONS[this.type] ?? CALLOUT_ICONS.note);
    svg.setAttribute('width', '16');
    svg.setAttribute('height', '16');
    span.appendChild(svg);
    if (this.defaultTitle) {
      const title = document.createElement('span');
      title.className = 'cm-callout-title';
      title.textContent = this.defaultTitle;
      span.appendChild(title);
    }
    return span;
  }

  eq(other: CalloutIconWidget): boolean {
    return other.type === this.type && other.defaultTitle === this.defaultTitle;
  }
}
