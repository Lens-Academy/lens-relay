/**
 * Frontmatter Extension for CodeMirror 6
 *
 * The YAML frontmatter shows as Notion's page properties: a row per key, the
 * key as a grey label with an icon for its kind of value, and the value after
 * it, still edited as raw text. Two states:
 * - Shown (default): raw Y.Text with decorations + icon and spacer widgets;
 *   the closing --- is the divider under the properties, with a "Hide
 *   properties" control
 * - Hidden: block-replace widget "› N properties"
 * Hiding is remembered per browser. The `icon:` line is the page icon, shown
 * above the title (DocumentTitle.tsx), so it is not a row.
 *
 * StateField: hidden state (block-replace) and the hidden icon line.
 * ViewPlugin: shown line/mark decorations + widgets.
 * Source mode: lightweight plugin that just neutralizes bold/underline.
 */

import {
  ViewPlugin,
  ViewUpdate,
  EditorView,
  Decoration,
  WidgetType,
  hoverTooltip,
} from '@codemirror/view';
import type { DecorationSet, Tooltip } from '@codemirror/view';
import { StateField, StateEffect, EditorSelection } from '@codemirror/state';
import type { Range, StateCommand } from '@codemirror/state';
import { countPendingEdits } from '../../../lib/criticmarkup-parser';
import { persistedFlag } from '../../../lib/persisted-pref';

// ── Frontmatter detection ─────────────────────────────────────────

interface FrontmatterRange {
  from: number;
  to: number;
  /** Keys shown as rows (not the page icon) */
  keyCount: number;
  /** The `icon:` line, when it sets the page icon and has no suggestion in it */
  iconLine: { from: number; to: number } | null;
  /** Nothing but the page icon: the block isn't shown at all */
  iconOnly: boolean;
}

/** CriticMarkup in a line: it stays visible, so suggestions can be reviewed */
const CRITIC_MARKUP = /\{(\+\+|--|~~|>>|==)/;

function detectFrontmatter(doc: { line(n: number): { from: number; to: number; text: string }; lines: number }): FrontmatterRange | null {
  if (doc.lines === 0) return null;
  const firstLine = doc.line(1);
  if (firstLine.text.trim() !== '---') return null;

  for (let ln = 2; ln <= doc.lines; ln++) {
    const line = doc.line(ln);
    if (line.text.trim() === '---') {
      let keyCount = 0;
      let iconLine: FrontmatterRange['iconLine'] = null;
      let otherLines = 0;
      for (let k = 2; k < ln; k++) {
        const body = doc.line(k);
        const t = body.text;
        if (!iconLine && /^icon\s*:\s*\S/.test(t) && !CRITIC_MARKUP.test(t)) {
          iconLine = { from: body.from, to: body.to };
          continue;
        }
        if (/^\S+\s*:/.test(t) && !/^-\s/.test(t)) keyCount++;
        if (t.trim() !== '') otherLines++;
      }
      return { from: firstLine.from, to: line.to, keyCount, iconLine, iconOnly: iconLine !== null && otherLines === 0 };
    }
  }
  return null;
}

// ── Text measurement ──────────────────────────────────────────────

let measureCtx: CanvasRenderingContext2D | null = null;

/** Properties render at Notion's 14px regardless of the editor's font size. */
const FRONTMATTER_FONT_SIZE = '14px';

/** The canvas font of a property label, from the editor's computed font */
function labelFont(refElement: HTMLElement): string {
  const style = getComputedStyle(refElement);
  return `${style.fontStyle} 400 ${FRONTMATTER_FONT_SIZE} ${style.fontFamily}`;
}

function measureTextWidth(text: string, font: string): number {
  if (!measureCtx) {
    measureCtx = document.createElement('canvas').getContext('2d');
    // jsdom has no canvas — fall back to a rough estimate
    if (!measureCtx) return text.length * 7;
  }
  measureCtx.font = font;
  return measureCtx.measureText(text).width;
}

// ── Property kinds ────────────────────────────────────────────────

type PropertyKind = 'text' | 'title' | 'number' | 'date' | 'checkbox' | 'url' | 'email' | 'list' | 'person' | 'status';

/**
 * The kind of value a property holds, for its icon, as Notion's property
 * types: from the value, or from common key names when it is empty
 */
function propertyKind(key: string, value: string, hasItems: boolean): PropertyKind {
  const k = key.toLowerCase();
  const v = value.trim().replace(/^(["'])(.*)\1$/, '$2');
  if (hasItems || /^\[.*\]$/.test(v) || /^(tags|aliases|categories|keywords)$/.test(k)) return 'list';
  if (/^(title|name)$/.test(k)) return 'title';
  if (/^(status|state|stage)$/.test(k)) return 'status';
  if (/^(authors?|owners?|assignees?|people|person|lead|by)$/.test(k)) return 'person';
  if (/^(true|false|yes|no)$/i.test(v)) return 'checkbox';
  if (/^\d{4}-\d{2}-\d{2}/.test(v) || /(^|[-_])(date|created|updated|modified|due)$/.test(k)) return 'date';
  if (/^-?\d+(\.\d+)?$/.test(v)) return 'number';
  if (/^https?:\/\//.test(v) || /^(url|link|href|website)$/.test(k)) return 'url';
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v) || k === 'email') return 'email';
  return 'text';
}

const DOT = 'fill="currentColor" stroke="none"';

/** Icons for the property kinds, drawn on a 16px grid like Notion's */
const PROPERTY_ICONS: Record<PropertyKind, string> = {
  text: '<path d="M3 4.5h10M3 8h10M3 11.5h6.5"/>',
  title: '<path d="M1.75 12.5 4.75 3.5l3 9M2.85 9.25h3.8M13.5 7.75v4.75"/><circle cx="11.25" cy="10.4" r="2.1"/>',
  number: '<path d="M6.4 2.75 5.2 13.25M10.8 2.75 9.6 13.25M2.75 5.9h10.5M2.25 10.1h10.5"/>',
  date: '<rect x="2.5" y="3.5" width="11" height="10" rx="1.75"/><path d="M2.5 6.75h11M5.5 2v2.75M10.5 2v2.75"/>',
  checkbox: '<rect x="2.5" y="2.5" width="11" height="11" rx="2"/><path d="m5.4 8.2 1.85 1.85L10.7 6.1"/>',
  url: '<path d="M6.9 9.1a2.6 2.6 0 0 0 3.7 0l1.9-1.9a2.6 2.6 0 0 0-3.7-3.7l-.75.75"/><path d="M9.1 6.9a2.6 2.6 0 0 0-3.7 0L3.5 8.8a2.6 2.6 0 0 0 3.7 3.7l.75-.75"/>',
  email: '<circle cx="8" cy="8" r="2.4"/><path d="M10.4 8v.85a1.8 1.8 0 0 0 3.6 0V8a6 6 0 1 0-2.35 4.75"/>',
  list: `<path d="M6.25 4.5h7M6.25 8h7M6.25 11.5h7"/><circle cx="3.25" cy="4.5" r="1" ${DOT}/><circle cx="3.25" cy="8" r="1" ${DOT}/><circle cx="3.25" cy="11.5" r="1" ${DOT}/>`,
  person: '<circle cx="8" cy="5.5" r="2.6"/><path d="M2.9 13.6a5.1 5.1 0 0 1 10.2 0"/>',
  status: `<circle cx="8" cy="8" r="5.5"/><path d="M8 2.5a5.5 5.5 0 0 1 0 11Z" ${DOT}/>`,
};

// ── Layout ────────────────────────────────────────────────────────

/** CodeMirror's line inset: rows start where body text does */
const LINE_INSET_PX = 6;
/** The label icon (16px at Notion's 1.2 scale) and the 6px gap after it */
const ICON_SLOT_PX = 19.2 + 6;
/**
 * Where values start, from the label icon: Notion's 160px label column, less
 * the icon's 6px inset in it, then 8px and the value's own 6px padding
 */
const VALUE_OFFSET_PX = 168;
/** Least space between a long key and its value */
const MIN_KEY_GAP_PX = 8;

// ── Widgets ───────────────────────────────────────────────────────

/** Invisible inline spacer — CM6 accounts for widget width in cursor positioning */
class SpacerWidget extends WidgetType {
  constructor(private widthPx: number) { super(); }

  toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.style.display = 'inline-block';
    span.style.width = `${this.widthPx}px`;
    span.style.height = '1em';
    span.style.verticalAlign = 'text-bottom';
    return span;
  }

  eq(other: SpacerWidget): boolean {
    return this.widthPx === other.widthPx;
  }
}

/** The icon before a property's label */
class PropertyIconWidget extends WidgetType {
  constructor(private kind: PropertyKind) { super(); }

  toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = 'cm-frontmatter-icon';
    span.dataset.kind = this.kind;
    span.innerHTML = '<svg viewBox="0 0 16 16" width="19.2" height="19.2" fill="none" stroke="currentColor" '
      + `stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PROPERTY_ICONS[this.kind]}</svg>`;
    return span;
  }

  eq(other: PropertyIconWidget): boolean {
    return this.kind === other.kind;
  }

  /** A click on it places the cursor, as on the label */
  ignoreEvent(): boolean {
    return false;
  }
}

/** Notion's "Empty" in a property without a value */
class EmptyValueWidget extends WidgetType {
  toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = 'cm-frontmatter-empty';
    span.textContent = 'Empty';
    return span;
  }

  eq(): boolean {
    return true;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

/** Hide or show the properties, and remember it for this browser */
function setPropertiesHidden(view: EditorView, hidden: boolean): void {
  propertiesHiddenPref.save(hidden);
  view.dispatch({ effects: setFrontmatterCollapsed.of(hidden) });
}

/** "Hide properties", on the divider under them while the pointer is over them */
class HidePropertiesWidget extends WidgetType {
  toDOM(view: EditorView): HTMLElement {
    const button = document.createElement('span');
    button.className = 'cm-frontmatter-hide';
    button.setAttribute('role', 'button');
    button.textContent = 'Hide properties';
    button.addEventListener('mousedown', (e) => {
      e.preventDefault();
      setPropertiesHidden(view, true);
    });
    return button;
  }

  eq(): boolean {
    return true;
  }
}

/** The hidden properties: "› N properties", which shows them again */
class FrontmatterBarWidget extends WidgetType {
  constructor(
    private keyCount: number,
    private suggestionCount: number = 0,
  ) { super(); }

  toDOM(view: EditorView): HTMLElement {
    const row = document.createElement('div');
    row.className = 'cm-frontmatter-bar-row';
    const bar = document.createElement('div');
    bar.className = 'cm-frontmatter-bar';
    row.appendChild(bar);

    const chevron = document.createElement('span');
    chevron.className = 'cm-frontmatter-chevron';
    chevron.innerHTML = '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" '
      + 'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 3.5 4.5 4.5L6 12.5"/></svg>';
    bar.appendChild(chevron);

    const label = document.createElement('span');
    label.className = 'cm-frontmatter-label';
    label.textContent = this.keyCount === 1 ? '1 property' : `${this.keyCount} properties`;
    bar.appendChild(label);

    // Pending suggestions are hidden by the collapsed block-replace widget, so
    // the bar itself must announce them or reviewers never know they exist
    if (this.suggestionCount > 0) {
      const badge = document.createElement('span');
      badge.className = 'cm-frontmatter-suggestions-badge';
      badge.textContent = this.suggestionCount === 1
        ? '1 suggested edit'
        : `${this.suggestionCount} suggested edits`;
      bar.appendChild(badge);
    }

    bar.addEventListener('mousedown', (e) => {
      e.preventDefault();
      setPropertiesHidden(view, false);
    });

    return row;
  }

  eq(other: FrontmatterBarWidget): boolean {
    return this.keyCount === other.keyCount
      && this.suggestionCount === other.suggestionCount;
  }
}

// ── State ─────────────────────────────────────────────────────────

/** Hide (true) or show the properties. Exported for tests. */
export const setFrontmatterCollapsed = StateEffect.define<boolean>();
export const setFrontmatterEnabled = StateEffect.define<boolean>();

/** Whether this browser hides properties ("Hide properties"), for new views */
const propertiesHiddenPref = persistedFlag('lens-properties-hidden', false);

interface FrontmatterState {
  collapsed: boolean;
  enabled: boolean;
  range: FrontmatterRange | null;
  /** Pending CriticMarkup edits inside the frontmatter range */
  suggestionCount: number;
}

function frontmatterSuggestionCount(doc: { sliceString(from: number, to: number): string }, range: FrontmatterRange | null): number {
  return range ? countPendingEdits(doc.sliceString(range.from, range.to)) : 0;
}

const frontmatterField = StateField.define<FrontmatterState>({
  create(state) {
    const range = detectFrontmatter(state.doc);
    return {
      collapsed: propertiesHiddenPref.load(),
      enabled: true,
      range,
      suggestionCount: frontmatterSuggestionCount(state.doc, range),
    };
  },

  update(value, tr) {
    let { collapsed, enabled } = value;
    let changed = false;

    for (const e of tr.effects) {
      if (e.is(setFrontmatterCollapsed)) { collapsed = e.value; changed = true; }
      if (e.is(setFrontmatterEnabled)) { enabled = e.value; changed = true; }
    }

    const range = tr.docChanged ? detectFrontmatter(tr.state.doc) : value.range;
    if (changed || tr.docChanged) {
      const suggestionCount = tr.docChanged
        ? frontmatterSuggestionCount(tr.state.doc, range)
        : value.suggestionCount;
      return { collapsed, enabled, range, suggestionCount };
    }
    return value;
  },

  provide: (f) => [
    EditorView.decorations.from(f, (val) => {
      if (!val.range || !val.enabled) return Decoration.none;
      const { range } = val;
      // Only the page icon, which is above the title: nothing to show here
      if (range.iconOnly && val.suggestionCount === 0) {
        return Decoration.set([Decoration.replace({ block: true }).range(range.from, range.to)]);
      }
      if (val.collapsed) {
        return Decoration.set([
          Decoration.replace({
            widget: new FrontmatterBarWidget(range.keyCount, val.suggestionCount),
            block: true,
          }).range(range.from, range.to),
        ]);
      }
      return range.iconLine
        ? Decoration.set([Decoration.replace({ block: true }).range(range.iconLine.from, range.iconLine.to)])
        : Decoration.none;
    }),
    // The page header sits closer to properties than to body text (index.css)
    EditorView.editorAttributes.from(f, (val): Record<string, string> =>
      val.range && val.enabled && !(val.range.iconOnly && val.suggestionCount === 0)
        ? { class: 'cm-has-properties' }
        : {}),
  ],
});

/**
 * Expand a collapsed frontmatter block when `pos` falls inside it, so that
 * navigation targets (e.g. the review page's "Open" link) are not hidden
 * behind the collapsed properties bar. No-op otherwise.
 */
export function revealFrontmatterPos(view: EditorView, pos: number): void {
  const fm = view.state.field(frontmatterField, false);
  if (!fm?.range || !fm.collapsed || !fm.enabled) return;
  if (pos >= fm.range.from && pos <= fm.range.to) {
    view.dispatch({ effects: setFrontmatterCollapsed.of(false) });
  }
}

// ── ViewPlugin (shown properties) ─────────────────────────────────

/** A line under a key: a list item, or more of a multi-line value */
const isContinuation = (text: string) => /^\s/.test(text) || /^-\s/.test(text);

const frontmatterExpandedPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = this.buildDecorations(view);
    }

    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged || update.selectionSet ||
          update.transactions.some(tr => tr.effects.some(e =>
            e.is(setFrontmatterCollapsed) || e.is(setFrontmatterEnabled)))) {
        this.decorations = this.buildDecorations(update.view);
      }
    }

    buildDecorations(view: EditorView): DecorationSet {
      const field = view.state.field(frontmatterField);
      if (field.collapsed || !field.enabled || !field.range) return Decoration.none;

      const doc = view.state.doc;
      const fm = field.range;
      const decos: Range<Decoration>[] = [];
      const startLine = doc.lineAt(fm.from);
      const endLine = doc.lineAt(fm.to);
      const font = labelFont(view.contentDOM);
      const line = (from: number, cls: string, style?: string) => decos.push(
        Decoration.line({ class: `cm-frontmatter-line ${cls}`, attributes: style ? { style } : undefined }).range(from),
      );
      const mark = (from: number, to: number, cls: string) => {
        if (to > from) decos.push(Decoration.mark({ class: cls }).range(from, to));
      };

      // Lines with the cursor or a selection in them show their raw ": ",
      // quotes and list dashes, as live preview shows syntax being edited
      const rawLines = new Set<number>();
      for (const r of view.state.selection.ranges) {
        for (let n = doc.lineAt(r.from).number; n <= doc.lineAt(r.to).number; n++) rawLines.add(n);
      }

      // The opening --- is a sliver above the first row; the closing --- is
      // the divider under the properties
      line(startLine.from, 'cm-frontmatter-open');
      mark(startLine.from, startLine.to, 'cm-frontmatter-delimiter');
      if (endLine.number !== startLine.number) {
        line(endLine.from, 'cm-frontmatter-close');
        mark(endLine.from, endLine.to, 'cm-frontmatter-delimiter');
        decos.push(Decoration.widget({ widget: new HidePropertiesWidget(), side: 1 }).range(endLine.to));
      }

      let valueIndentPx = 0; // the value column of the key above, for its continuation lines
      for (let ln = startLine.number + 1; ln < endLine.number; ln++) {
        const l = doc.line(ln);
        if (fm.iconLine && l.from === fm.iconLine.from) continue; // the page icon (hidden by the field)
        const text = l.text;
        const raw = rawLines.has(ln);
        const nextText = ln + 1 < endLine.number ? doc.line(ln + 1).text : null;
        const keyMatch = text.match(/^(\S+)\s*:\s*/);

        if (isContinuation(text) && valueIndentPx > 0) {
          // List items under the key (Notion's multi-select pills), or more
          // of a multi-line value, in the value column
          const last = nextText === null || !isContinuation(nextText);
          line(l.from, `cm-frontmatter-more${last ? ' cm-frontmatter-more-last' : ''}`, `padding-left: ${valueIndentPx}px !important`);
          const item = /^ {2}- (?=\S)/.exec(text);
          if (/^\s*-\s/.test(text) && !item) {
            // List item with wrong indentation (must be exactly 2 spaces before the dash)
            mark(l.from, l.to, 'cm-frontmatter-bad-indent');
          } else if (item) {
            mark(l.from, l.from + item[0].length, raw ? 'cm-frontmatter-colon' : 'cm-frontmatter-hidden');
            mark(l.from + item[0].length, l.from + text.trimEnd().length, 'cm-frontmatter-pill');
          } else {
            mark(l.from, l.to, 'cm-frontmatter-value-continuation');
          }
        } else if (/^-\s/.test(text)) {
          // A list item at column 0 with no key above it
          line(l.from, 'cm-frontmatter-more', `padding-left: ${LINE_INSET_PX + ICON_SLOT_PX}px !important`);
          mark(l.from, l.to, 'cm-frontmatter-bad-indent');
        } else if (keyMatch) {
          const key = keyMatch[1];
          const colonPos = l.from + key.length;
          const valueFrom = l.from + keyMatch[0].length;
          const value = text.slice(keyMatch[0].length);
          const hasItems = nextText !== null && /^\s*-\s/.test(nextText);
          const keyPx = measureTextWidth(key, font);
          const colonPx = raw ? measureTextWidth(keyMatch[0].slice(key.length), font) : 0;
          const spacerPx = Math.max(MIN_KEY_GAP_PX, VALUE_OFFSET_PX - ICON_SLOT_PX - keyPx - colonPx);
          // Hanging indent: a long value's wrapped rows start under its first
          valueIndentPx = LINE_INSET_PX + ICON_SLOT_PX + keyPx + colonPx + spacerPx;
          line(l.from, `cm-frontmatter-row${hasItems ? ' cm-frontmatter-row-items' : ''}`,
            `padding-left: ${valueIndentPx}px !important; text-indent: -${valueIndentPx - LINE_INSET_PX}px`);
          decos.push(Decoration.widget({ widget: new PropertyIconWidget(propertyKind(key, value, hasItems)), side: -1 }).range(l.from));
          mark(l.from, colonPos, 'cm-frontmatter-key');
          decos.push(Decoration.widget({ widget: new SpacerWidget(spacerPx), side: -1 }).range(colonPos));
          mark(colonPos, valueFrom, raw ? 'cm-frontmatter-colon' : 'cm-frontmatter-hidden');
          const quoted = /^(["']).*\1\s*$/.exec(value);
          if (quoted && !raw) {
            const close = valueFrom + value.trimEnd().length - 1;
            mark(valueFrom, valueFrom + 1, 'cm-frontmatter-hidden');
            mark(close, close + 1, 'cm-frontmatter-hidden');
          }
          if (value.trim() === '' && !hasItems && !raw) {
            decos.push(Decoration.widget({ widget: new EmptyValueWidget(), side: 1 }).range(l.to));
          }
        } else if (text.length > 0) {
          // A key being typed (no colon yet), in line with the labels
          valueIndentPx = 0;
          line(l.from, 'cm-frontmatter-row', `padding-left: ${LINE_INSET_PX + ICON_SLOT_PX}px !important`);
          mark(l.from, l.to, 'cm-frontmatter-key-incomplete');
        } else {
          line(l.from, 'cm-frontmatter-blank');
        }
      }

      return Decoration.set(decos, true);
    }
  },
  { decorations: (v) => v.decorations }
);

// ── Source-mode plugin ────────────────────────────────────────────

const frontmatterSourcePlugin = ViewPlugin.fromClass(
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
      const fm = view.state.field(frontmatterField).range;
      if (!fm) return Decoration.none;

      const doc = view.state.doc;
      const decos: Array<{ from: number; to: number; deco: Decoration }> = [];
      const startLine = doc.lineAt(fm.from);
      const endLine = doc.lineAt(fm.to);

      for (let ln = startLine.number; ln <= endLine.number; ln++) {
        decos.push({
          from: doc.line(ln).from, to: doc.line(ln).from,
          deco: Decoration.line({ class: 'cm-frontmatter-line' }),
        });
      }

      decos.sort((a, b) => a.from - b.from);
      return Decoration.set(decos.map(d => d.deco.range(d.from, d.to)));
    }
  },
  { decorations: (v) => v.decorations }
);

// ── Enter handler for YAML lists ─────────────────────────────────

const frontmatterEnter: StateCommand = ({ state, dispatch }) => {
  const fm = state.field(frontmatterField);
  if (fm.collapsed || !fm.enabled || !fm.range) return false;

  const pos = state.selection.main.head;
  if (pos < fm.range.from || pos > fm.range.to) return false;

  const line = state.doc.lineAt(pos);
  const listMatch = line.text.match(/^(\s+- )/);

  if (listMatch) {
    const prefix = listMatch[1]; // e.g. "  - "

    // Empty list item (just "  - ") — remove marker, exit list
    if (/^\s+-\s*$/.test(line.text)) {
      const prevLineEnd = line.from > 0 ? line.from - 1 : line.from;
      dispatch(state.update({
        changes: { from: prevLineEnd, to: line.to, insert: '\n' },
        selection: EditorSelection.cursor(prevLineEnd + 1),
        scrollIntoView: true,
        userEvent: 'input',
      }));
      return true;
    }

    // Continue list — insert newline + same prefix
    dispatch(state.update({
      changes: { from: pos, insert: '\n' + prefix },
      selection: EditorSelection.cursor(pos + 1 + prefix.length),
      scrollIntoView: true,
      userEvent: 'input',
    }));
    return true;
  }

  // Non-list line inside frontmatter — plain newline
  // (prevents markdown Enter handler from misinterpreting frontmatter content)
  dispatch(state.update({
    changes: { from: pos, insert: '\n' },
    selection: EditorSelection.cursor(pos + 1),
    scrollIntoView: true,
    userEvent: 'input',
  }));
  return true;
};

export const frontmatterKeymap = [
  { key: 'Enter' as const, run: frontmatterEnter },
];

// ── Hover tooltips for frontmatter errors ────────────────────────

const frontmatterHover = hoverTooltip((view, pos): Tooltip | null => {
  const fm = view.state.field(frontmatterField);
  if (fm.collapsed || !fm.enabled || !fm.range) return null;
  if (pos < fm.range.from || pos > fm.range.to) return null;

  const line = view.state.doc.lineAt(pos);

  // Dash at column 0 — misindented list item
  if (/^-\s/.test(line.text)) {
    return {
      pos: line.from,
      end: line.to,
      above: true,
      create: () => {
        const dom = document.createElement('div');
        dom.className = 'cm-frontmatter-tooltip';
        dom.textContent = 'List items must be indented with 2 spaces: "  - value". This can be easier to see in source editing mode';
        return { dom };
      },
    };
  }

  // Indented list item with wrong indentation
  if (/^\s*-\s/.test(line.text) && !/^ {2}- /.test(line.text)) {
    const spaces = line.text.match(/^(\s*)/)?.[1].length ?? 0;
    return {
      pos: line.from,
      end: line.to,
      above: true,
      create: () => {
        const dom = document.createElement('div');
        dom.className = 'cm-frontmatter-tooltip';
        dom.textContent = `List items need exactly 2 spaces before the dash (found ${spaces}). This can be easier to see in source editing mode`;
        return { dom };
      },
    };
  }

  return null;
});

// ── Exports ───────────────────────────────────────────────────────

export { frontmatterField, frontmatterSourcePlugin };
export const frontmatterPlugin = [frontmatterExpandedPlugin, frontmatterHover];
