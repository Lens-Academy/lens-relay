/**
 * Authorship display: per-character human/AI provenance rendering.
 *
 * Data source: Y.Text item clientIDs resolved through the "users"
 * PermanentUserData map (see src/lib/provenance.ts and docs/plans/
 * 2026-07-18-provenance-design.md). No document content is involved.
 *
 * Modes:
 *  - hidden: no rendering
 *  - gutter: per-line edge strip, majority-wins color (default)
 *  - inline: gutter + per-character background tint
 *
 * Independently of the mode, "Highlight recent changes" overlays direct AI
 * edits from the doc's `activity_v0` log within a time window — surviving
 * inserted text tinted, removed text shown as struck-through ghosts at its
 * anchor (or listed in a tray when the anchor no longer resolves). See
 * src/lib/activity.ts.
 *
 * IMPORTANT: this extension must be registered AFTER yCollab in the editor's
 * extension list — its ViewPlugin reads the Y.Text during update(), and plugin
 * update order follows registration order, so this guarantees the local edit
 * has already been written to the Y.Text when we recompute.
 */
import { StateEffect, StateField } from '@codemirror/state';
import type { Extension, Range } from '@codemirror/state';
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
} from '@codemirror/view';
import type { DecorationSet, ViewUpdate } from '@codemirror/view';
import type * as Y from 'yjs';
import { getAuthorshipRuns } from '../../../lib/authorship-runs';
import type { AuthorshipRun } from '../../../lib/authorship-runs';
import { getClientActorMap, getRegisteredAt } from '../../../lib/provenance';
import {
  ACTIVITY_MAP,
  eventCoversItems,
  formatEventAge,
  readActivityEvents,
  resolveEventPosition,
} from '../../../lib/activity';
import type { DocActivityEvent } from '../../../lib/activity';

export type AuthorshipMode = 'hidden' | 'gutter' | 'expanded' | 'inline';

export const setAuthorshipMode = StateEffect.define<AuthorshipMode>();
const refreshAuthorship = StateEffect.define<null>();
/** Recent-overlay-only refresh (window expiry tick): recomputes but never
 *  pins scroll, since it changes at most a few marks. */
const refreshRecent = StateEffect.define<null>();

export const authorshipModeField = StateField.define<AuthorshipMode>({
  create: () => 'gutter',
  update: (value, tr) => {
    for (const e of tr.effects) {
      if (e.is(setAuthorshipMode)) return e.value;
    }
    return value;
  },
});

/** Time window (ms) for the recent-changes overlay. */
export const RECENT_WINDOW_PRESETS: Array<{ label: string; ms: number }> = [
  { label: '5m', ms: 5 * 60_000 },
  { label: '1h', ms: 3600_000 },
  { label: '24h', ms: 86400_000 },
  { label: '7d', ms: 7 * 86400_000 },
];
export const DEFAULT_RECENT_WINDOW_MS = 3600_000;
const RECENT_WINDOW_STORAGE_KEY = 'lens-recent-window-ms';

export function loadRecentWindow(): number {
  try {
    const raw = localStorage.getItem(RECENT_WINDOW_STORAGE_KEY);
    const ms = raw ? Number(raw) : NaN;
    if (Number.isFinite(ms) && ms > 0) return ms;
  } catch {
    // storage unavailable
  }
  return DEFAULT_RECENT_WINDOW_MS;
}

export function saveRecentWindow(ms: number): void {
  try {
    localStorage.setItem(RECENT_WINDOW_STORAGE_KEY, String(ms));
  } catch {
    // storage unavailable
  }
}

const RECENT_ENABLED_STORAGE_KEY = 'lens-recent-enabled';

export function loadRecentEnabled(): boolean {
  try {
    return localStorage.getItem(RECENT_ENABLED_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function saveRecentEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(RECENT_ENABLED_STORAGE_KEY, enabled ? '1' : '0');
  } catch {
    // storage unavailable
  }
}

export const setRecentEnabled = StateEffect.define<boolean>();

export const recentEnabledField = StateField.define<boolean>({
  create: () => loadRecentEnabled(),
  update: (value, tr) => {
    for (const e of tr.effects) {
      if (e.is(setRecentEnabled)) return e.value;
    }
    return value;
  },
});

export const setRecentWindow = StateEffect.define<number>();

export const recentWindowField = StateField.define<number>({
  create: () => loadRecentWindow(),
  update: (value, tr) => {
    for (const e of tr.effects) {
      if (e.is(setRecentWindow)) return e.value;
    }
    return value;
  },
});

/** Struck-through ghost of text an AI removed (recent-changes overlay). */
class GhostWidget extends WidgetType {
  /** Minute bucket of the event's age, so the "N min ago" title refreshes. */
  private readonly ageBucket: number;
  constructor(private readonly ev: DocActivityEvent) {
    super();
    this.ageBucket = Math.floor((Date.now() - ev.ts) / 60_000);
  }
  toDOM(): HTMLElement {
    const el = document.createElement('span');
    el.className = 'cm-recent-ghost';
    el.textContent = this.ev.old + (this.ev.oldTruncated ? '…' : '');
    el.title = `Removed by ${actorDisplayName(this.ev.actor)} · ${formatEventAge(this.ev.ts)}`;
    el.setAttribute('aria-label', `Removed text: ${this.ev.old}`);
    return el;
  }
  eq(other: GhostWidget): boolean {
    return other.ev.id === this.ev.id && other.ageBucket === this.ageBucket;
  }
  ignoreEvent(): boolean {
    return true;
  }
}

/** Block at the top of the doc listing removals whose place could not be
 *  located safely (anchor gone and context ambiguous). */
class TrayWidget extends WidgetType {
  constructor(private readonly events: DocActivityEvent[]) {
    super();
  }
  toDOM(): HTMLElement {
    const el = document.createElement('div');
    el.className = 'cm-recent-tray';
    const title = document.createElement('div');
    title.className = 'cm-recent-tray-title';
    title.textContent = `Removed text that could not be placed (${this.events.length})`;
    el.appendChild(title);
    for (const ev of this.events) {
      const row = document.createElement('div');
      row.className = 'cm-recent-tray-row';
      const meta = document.createElement('span');
      meta.className = 'cm-recent-tray-meta';
      meta.textContent = `${actorDisplayName(ev.actor)} · ${formatEventAge(ev.ts)}: `;
      const ghost = document.createElement('span');
      ghost.className = 'cm-recent-ghost';
      ghost.textContent = ev.old + (ev.oldTruncated ? '…' : '');
      row.appendChild(meta);
      row.appendChild(ghost);
      el.appendChild(row);
    }
    return el;
  }
  eq(other: TrayWidget): boolean {
    return (
      other.events.length === this.events.length &&
      other.events.every((e, i) => e.id === this.events[i].id)
    );
  }
  ignoreEvent(): boolean {
    return true;
  }
}

type Category = 'human' | 'ai' | 'unknown';

function categoryOf(actor: string | undefined): Category {
  if (actor?.startsWith('human:')) return 'human';
  if (actor?.startsWith('ai:')) return 'ai';
  return 'unknown';
}

/** 'human:Luc' → 'Luc'; 'ai:opus-4.8:luc' → 'opus-4.8 (luc)'; undefined → 'Unknown'. */
export function actorDisplayName(actor: string | undefined): string {
  if (!actor) return 'Unknown';
  if (actor.startsWith('human:')) return actor.slice('human:'.length) || 'Unknown';
  if (actor.startsWith('ai:')) {
    const [, model, behalf] = actor.split(':');
    const name = model && model !== 'unknown' ? model : 'AI';
    return behalf ? `${name} (${behalf})` : name;
  }
  return actor;
}

type LineCategory = Category | 'mixed';

/**
 * Gutter color policy for a line. Majority wins, except when a line is
 * genuinely mixed human/AI (both ≥ MIXED_THRESHOLD of its characters) —
 * then it gets the fixed-pitch two-color stripe. The threshold keeps small
 * touch-ups (fixing a comma in an AI paragraph) from flipping the line to
 * the mixed texture.
 */
export const MIXED_THRESHOLD = 0.25;

export function pickLineCategory(counts: Record<Category, number>): LineCategory | null {
  const total = counts.human + counts.ai + counts.unknown;
  if (total === 0) return null;
  if (counts.human >= total * MIXED_THRESHOLD && counts.ai >= total * MIXED_THRESHOLD) {
    return 'mixed';
  }
  if (counts.human >= counts.ai && counts.human >= counts.unknown) return 'human';
  if (counts.ai >= counts.unknown) return 'ai';
  return 'unknown';
}

const lineDecos: Record<LineCategory, Decoration> = {
  human: Decoration.line({ class: 'cm-authline-human' }),
  ai: Decoration.line({ class: 'cm-authline-ai' }),
  unknown: Decoration.line({ class: 'cm-authline-unknown' }),
  mixed: Decoration.line({ class: 'cm-authline-mixed' }),
};

/**
 * Label for the expanded-gutter mode, git-blame style: the dominant actor's
 * name, plus "+N" when other actors also contributed to the line.
 * `actors` must be sorted by contribution, largest first.
 */
export function expandedLabel(actors: Array<string | undefined>): string {
  if (actors.length === 0) return '';
  const name = actorDisplayName(actors[0]);
  return actors.length > 1 ? `${name} +${actors.length - 1}` : name;
}

const markDecos: Record<Category, Decoration> = {
  human: Decoration.mark({ class: 'cm-auth-human' }),
  ai: Decoration.mark({ class: 'cm-auth-ai' }),
  unknown: Decoration.mark({ class: 'cm-auth-unknown' }),
};

class AuthorshipPlugin {
  decorations: DecorationSet = Decoration.none;
  private runs: AuthorshipRun[] = [];
  private actorByClient = new Map<number, string>();
  private refreshScheduled = false;
  private readonly usersObserver: () => void;
  private readonly users: Y.Map<unknown>;

  private hoverExpanded = false;
  /** Recent overlay: surviving inserted ranges and the event they came from. */
  private recentRanges: Array<{ from: number; to: number; event: DocActivityEvent }> = [];
  private readonly activity: Y.Map<unknown>;
  private readonly activityObserver: () => void;
  /** One-shot timer for the next event to leave the window. */
  private recentTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Parsed `activity_v0` plus each removal's resolved position (CM offset),
   * kept across updates: parsing and anchor resolution are O(events × items)
   * and would otherwise run on every keystroke and scroll. Invalidated when
   * the map changes; positions are mapped through document changes.
   */
  private recentCache: {
    events: DocActivityEvent[];
    ghostPos: Map<string, number | null>;
  } | null = null;
  /** Decorations of the last recent pass, reused on viewport-only updates. */
  private recentDecos: Range<Decoration>[] = [];
  /** Set when a pass bailed out mid-sync, so the next one rebuilds. */
  private recentStale = false;
  /** Test hook: how many times the activity map was parsed. */
  recentParses = 0;
  private tooltipFrame: number | null = null;
  private labelBlocks: Array<{ from: number; label: string; category: LineCategory }> = [];
  private overlay: HTMLElement | null = null;
  private readonly onMouseMove: (e: MouseEvent) => void;
  private readonly onMouseLeave: () => void;
  private onScroll!: () => void;

  /** Hover tooltip (own implementation, see `handleTooltipHover`). */
  private tipEl: HTMLElement | null = null;
  private tipTimer: ReturnType<typeof setTimeout> | null = null;
  private tipRange: { from: number; to: number } | null = null;

  constructor(
    private readonly view: EditorView,
    private readonly ytext: Y.Text
  ) {
    const doc = ytext.doc;
    if (!doc) throw new Error('authorship: Y.Text is not attached to a doc');
    this.users = doc.getMap('users');

    // Mapping changes (someone registered / claimed text) recolor existing
    // text without any CM transaction — nudge the view with an effect.
    this.usersObserver = () => this.scheduleRefresh();
    this.users.observeDeep(this.usersObserver);

    // Recent overlay: new events arrive through sync; the window is relative
    // to "now", so also re-evaluate periodically while the overlay is on.
    this.activity = doc.getMap(ACTIVITY_MAP);
    this.activityObserver = () => {
      this.recentCache = null;
      if (view.state.field(recentEnabledField)) this.scheduleRefresh();
    };
    this.activity.observeDeep(this.activityObserver);

    // Gutter hover: hovering the strip band previews Expanded mode — the
    // blame-style margin labels appear for the whole viewport and disappear
    // on leave. Pure overlay; never pushes the text.
    this.onMouseMove = (e) => {
      this.handleGutterHover(e);
      this.handleTooltipHover(e);
    };
    this.onMouseLeave = () => {
      this.setHoverExpanded(false);
      this.hideTooltip();
    };
    view.scrollDOM.addEventListener('mousemove', this.onMouseMove);
    view.scrollDOM.addEventListener('mouseleave', this.onMouseLeave);
    // Keep hover chips glued to their lines while the document scrolls
    // (rAF-deduped; CM only recomputes decorations on larger viewport moves).
    this.onScroll = () => {
      if (this.hoverExpanded) this.scheduleOverlayRender();
      this.hideTooltip();
    };
    view.scrollDOM.addEventListener('scroll', this.onScroll, { passive: true });

    this.recompute();
  }

  /** The strip's ::before sits at lineLeft-14, 3px wide (see index.css). */
  private static readonly STRIP_OFFSET = 14;

  /** Left edge of the line boxes — the strip is positioned relative to
   *  these, not to contentDOM (which has inner padding). */
  private lineBoxLeft(): number {
    const lineEl = this.view.contentDOM.querySelector('.cm-line');
    return lineEl
      ? lineEl.getBoundingClientRect().left
      : this.view.contentDOM.getBoundingClientRect().left;
  }

  private handleGutterHover(e: MouseEvent) {
    const mode = this.view.state.field(authorshipModeField);
    // Only gutter mode needs the hover preview — expanded/inline already
    // show persistent labels.
    if (mode !== 'gutter') {
      this.setHoverExpanded(false);
      return;
    }
    const lineLeft = this.lineBoxLeft();
    const stripLeft = lineLeft - AuthorshipPlugin.STRIP_OFFSET;
    // Generous band: a few px left of the strip through to just before text.
    const inBand = e.clientX >= stripLeft - 8 && e.clientX <= lineLeft - 2;
    this.setHoverExpanded(inBand);
  }

  private setHoverExpanded(next: boolean) {
    if (this.hoverExpanded === next) return;
    this.hoverExpanded = next;
    // Recompute via the normal update cycle so CM picks up the decorations.
    this.scheduleRefresh();
  }

  private scheduleRefresh() {
    if (this.refreshScheduled) return;
    this.refreshScheduled = true;
    queueMicrotask(() => {
      this.refreshScheduled = false;
      this.view.dispatch({ effects: refreshAuthorship.of(null) });
    });
  }

  update(update: ViewUpdate) {
    const modeChanged =
      update.startState.field(authorshipModeField) !==
        update.state.field(authorshipModeField) ||
      update.startState.field(recentWindowField) !== update.state.field(recentWindowField) ||
      update.startState.field(recentEnabledField) !== update.state.field(recentEnabledField);
    const refreshed = update.transactions.some((tr) =>
      tr.effects.some((e) => e.is(refreshAuthorship))
    );
    const recentTick = update.transactions.some((tr) =>
      tr.effects.some((e) => e.is(refreshRecent))
    );
    if (update.docChanged || update.viewportChanged || modeChanged || refreshed || recentTick) {
      // Recent ranges are doc-absolute: a viewport-only update can reuse
      // the last pass (the authorship labels are viewport-bound and do
      // recompute).
      const recentDirty = update.docChanged || modeChanged || refreshed || recentTick;
      this.recompute(update, recentDirty);
    }

    // Our effect-only updates (mode switch, hover preview, users-map refresh)
    // never change content, but the line redraws they trigger make CM's
    // scroll anchoring re-measure unstable widget heights (e.g. live-preview
    // images) and "compensate" by jumping the scroll position — in a measure
    // pass that runs after this update. Pin the position for a few frames.
    if ((modeChanged || refreshed) && !update.docChanged) {
      this.pinScroll();
    }
  }

  /** Hold the current scroll position through the next few measure cycles. */
  private pinScroll() {
    const scrollDOM = this.view.scrollDOM;
    const target = scrollDOM.scrollTop;
    let frames = 0;
    const enforce = () => {
      if (Math.abs(scrollDOM.scrollTop - target) > 1) {
        scrollDOM.scrollTop = target;
      }
      frames += 1;
      if (frames < 4) requestAnimationFrame(enforce);
    };
    requestAnimationFrame(enforce);
  }

  /** Recent-overlay hit test: the event that inserted the text at `pos`. */
  recentAt(pos: number): DocActivityEvent | null {
    const r = rangeAt(this.recentRanges, pos);
    return r ? r.event : null;
  }

  /**
   * Hover tooltip. CodeMirror's `hoverTooltip` guards on
   * `coordsAtPos(posAtCoords(mouse))`, and `posAtCoords` snaps to the end of
   * the zero-width hidden-syntax spans of pending suggestions, so no text
   * after a `{++…++}` on the same line ever got a tooltip. Resolve the DOM
   * caret position ourselves (exact) and map it with `posAtDOM`.
   */
  private handleTooltipHover(e: MouseEvent) {
    // At most one hit test per animation frame (mousemove fires far more
    // often); the lookups below are then deferred behind the hover delay.
    if (this.tooltipFrame !== null) return;
    this.tooltipFrame = requestAnimationFrame(() => {
      this.tooltipFrame = null;
      this.tooltipHoverNow(e);
    });
  }

  private tooltipHoverNow(e: MouseEvent) {
    const mode = this.view.state.field(authorshipModeField);
    const recentEnabled = this.view.state.field(recentEnabledField);
    if (mode === 'hidden' && !recentEnabled) {
      this.hideTooltip();
      return;
    }
    const target = e.target as Node | null;
    if (!target || !this.view.contentDOM.contains(target)) {
      this.hideTooltip();
      return;
    }
    if ((target as Element).closest?.('.cm-recent-ghost, .cm-recent-tray')) {
      this.hideTooltip(); // ghosts carry their own title
      return;
    }
    const caret = caretFromPoint(e.clientX, e.clientY);
    if (!caret || !this.view.contentDOM.contains(caret.node)) {
      this.hideTooltip();
      return;
    }
    let pos: number;
    try {
      pos = this.view.posAtDOM(caret.node, caret.offset);
    } catch {
      this.hideTooltip();
      return;
    }
    if (this.tipRange && this.tipEl && pos >= this.tipRange.from && pos < this.tipRange.to) {
      return; // still over the same word — keep it
    }
    if (this.tipTimer) clearTimeout(this.tipTimer);
    const { x, y } = { x: e.clientX, y: e.clientY };
    this.tipTimer = setTimeout(() => {
      this.tipTimer = null;
      const info = this.tooltipAt(pos);
      if (!info) {
        this.hideTooltip();
        return;
      }
      this.showTooltip(info.text, x, y);
      this.tipRange = { from: info.from, to: info.to };
    }, 150);
  }

  private tooltipAt(pos: number): { text: string; from: number; to: number } | null {
    const recentEnabled = this.view.state.field(recentEnabledField);
    const hit = this.actorAt(pos);
    const ev = recentEnabled ? this.recentAt(pos) : null;
    if (!hit && !ev) return null;
    const parts: string[] = [];
    if (hit) {
      const doc = this.ytext.doc;
      const registeredAt = doc ? getRegisteredAt(doc, hit.client) : null;
      const who = actorDisplayName(hit.actor);
      // Textual month: we work internationally, so numeric day/month order is ambiguous.
      const when = registeredAt
        ? new Date(registeredAt).toLocaleDateString('en-US', {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
          })
        : null;
      parts.push(when ? `${who} · ${when}` : who);
    }
    if (ev) {
      const old = ev.old.length > 40 ? ev.old.slice(0, 40) + '…' : ev.old;
      parts.push(
        ev.old
          ? `changed ${formatEventAge(ev.ts)} (replaced "${old}")`
          : `added ${formatEventAge(ev.ts)}`
      );
    }
    const word = this.view.state.wordAt(pos);
    let from = word ? word.from : pos;
    let to = word ? word.to : pos + 1;
    if (hit) {
      from = Math.max(from, hit.from);
      to = Math.min(to, hit.to);
    }
    if (to <= from) {
      from = pos;
      to = pos + 1;
    }
    return { text: parts.join(' · '), from, to };
  }

  private showTooltip(text: string, x: number, y: number) {
    if (!this.tipEl) {
      this.tipEl = document.createElement('div');
      this.tipEl.className = 'cm-authorship-tooltip';
      document.body.appendChild(this.tipEl);
    }
    this.tipEl.textContent = text;
    // Above the pointer, kept inside the viewport horizontally.
    const width = this.tipEl.offsetWidth || 200;
    const left = Math.max(4, Math.min(x - width / 2, window.innerWidth - width - 4));
    this.tipEl.style.left = `${left}px`;
    this.tipEl.style.top = `${Math.max(4, y - 34)}px`;
  }

  private hideTooltip() {
    if (this.tipTimer) {
      clearTimeout(this.tipTimer);
      this.tipTimer = null;
    }
    this.tipRange = null;
    this.tipEl?.remove();
    this.tipEl = null;
  }

  actorAt(
    pos: number
  ): { actor: string | undefined; client: number; from: number; to: number } | null {
    const run = rangeAt(this.runs, pos);
    if (!run) return null;
    return {
      actor: this.actorByClient.get(run.client),
      client: run.client,
      from: run.from,
      to: run.to,
    };
  }

  private recompute(update?: ViewUpdate, recentDirty = true) {
    const mode = this.view.state.field(authorshipModeField);
    const recentEnabled = this.view.state.field(recentEnabledField);
    this.labelBlocks = [];
    // Removed-text positions follow the document like any decoration would
    // (right-associated, matching the server's Assoc::After anchors), so
    // the anchors need re-resolving only when the activity map changes.
    if (update?.docChanged && this.recentCache) {
      for (const [id, pos] of this.recentCache.ghostPos) {
        if (pos !== null) this.recentCache.ghostPos.set(id, update.changes.mapPos(pos, 1));
      }
    }
    if (mode === 'hidden' && !recentEnabled) {
      this.runs = [];
      this.recentRanges = [];
      this.recentDecos = [];
      this.clearRecentTimer();
      this.decorations = Decoration.none;
      this.scheduleOverlayRender();
      return;
    }

    const doc = this.ytext.doc;
    if (!doc) return;
    this.runs = getAuthorshipRuns(this.ytext);
    this.actorByClient = getClientActorMap(doc);

    // The CM doc must mirror the Y.Text (this extension sits after yCollab).
    // If lengths ever disagree (mid-sync edge), skip this pass; the next
    // update recomputes. Plugin decorations aren't auto-mapped, so carry the
    // previous set through the change to keep positions inside the doc.
    const cmLength = this.view.state.doc.length;
    const yLength = this.runs.length ? this.runs[this.runs.length - 1].to : 0;
    if (yLength > cmLength) {
      if (update?.docChanged) {
        this.decorations = this.decorations.map(update.changes);
      }
      this.recentStale = true;
      return;
    }
    recentDirty ||= this.recentStale;
    this.recentStale = false;

    const ranges: Range<Decoration>[] = [];
    if (recentEnabled) {
      if (recentDirty) {
        this.recentRanges = [];
        this.recentDecos = [];
        this.collectRecent(doc, this.recentDecos);
      }
      ranges.push(...this.recentDecos);
    } else {
      this.recentRanges = [];
      this.recentDecos = [];
      this.clearRecentTimer();
    }
    if (mode === 'hidden') {
      this.decorations = Decoration.set(ranges, true);
      this.scheduleOverlayRender();
      return;
    }

    for (const { from, to } of this.view.visibleRanges) {
      const firstLine = this.view.state.doc.lineAt(from).number;
      const lastLine = this.view.state.doc.lineAt(to).number;
      // Expanded mode, blame-style: label only the first line of each
      // contiguous same-authors block. Signature resets per visible range.
      let prevSignature: string | null = null;

      for (let n = firstLine; n <= lastLine; n++) {
        const line = this.view.state.doc.line(n);
        if (line.length === 0) {
          prevSignature = null;
          continue;
        }

        // Majority category + per-actor contribution for the line.
        const counts: Record<Category, number> = { human: 0, ai: 0, unknown: 0 };
        const byActor = new Map<string | undefined, number>();
        for (const run of this.runs) {
          const overlap = Math.min(run.to, line.to) - Math.max(run.from, line.from);
          if (overlap <= 0) continue;
          const actor = this.actorByClient.get(run.client);
          counts[categoryOf(actor)] += overlap;
          byActor.set(actor, (byActor.get(actor) ?? 0) + overlap);
        }
        const category = pickLineCategory(counts);
        if (category === null) {
          prevSignature = null;
          continue;
        }

        // Expanded and Inline modes render labels in-flow (space is reserved
        // via data-authorship-mode CSS); the gutter-mode hover preview
        // renders them as a body-level overlay instead, since anything
        // inside the scroller would be clipped at the editor pane's edge.
        const persistentLabels = mode === 'expanded' || mode === 'inline';
        if (persistentLabels || this.hoverExpanded) {
          const actors = [...byActor.entries()]
            .sort((a, b) => b[1] - a[1])
            .map(([actor]) => actor);
          const signature = actors.map((a) => a ?? '?').join('|');
          const label = signature === prevSignature ? null : expandedLabel(actors);
          prevSignature = signature;
          if (label) {
            this.labelBlocks.push({ from: line.from, label, category });
          }
          if (persistentLabels) {
            ranges.push(
              Decoration.line({
                class: `cm-authline-${category}`,
                attributes: label ? { 'data-auth-label': label } : undefined,
              }).range(line.from)
            );
            continue;
          }
        }
        ranges.push(lineDecos[category].range(line.from));
      }

      if (mode === 'inline') {
        for (const run of this.runs) {
          const rFrom = Math.max(run.from, from);
          const rTo = Math.min(run.to, to);
          if (rTo <= rFrom) continue;
          const cat = categoryOf(this.actorByClient.get(run.client));
          ranges.push(markDecos[cat].range(rFrom, rTo));
        }
      }
    }

    this.decorations = Decoration.set(ranges, true);
    this.scheduleOverlayRender();
  }

  /**
   * Recent-changes overlay. Inserted text is matched by (client, clock)
   * against each event's minted range, so only characters that still survive
   * from that edit are tinted; removed text is drawn as a ghost widget where
   * it was. Appends to `ranges` so it composes with any authorship mode.
   */
  private collectRecent(doc: Y.Doc, ranges: Range<Decoration>[]): void {
    const windowMs = this.view.state.field(recentWindowField);
    const now = Date.now();
    if (!this.recentCache) {
      this.recentCache = { events: readActivityEvents(doc), ghostPos: new Map() };
      this.recentParses += 1;
    }
    const cache = this.recentCache;
    const events = cache.events.filter((e) => e.ts >= now - windowMs);
    this.scheduleRecentExpiry(events, windowMs, now);
    if (events.length === 0) return;

    const cmDoc = this.view.state.doc;
    const touchedLines = new Set<number>();

    // Runs are matched against the events of their own client only.
    const byClient = new Map<number, DocActivityEvent[]>();
    for (const ev of events) {
      if (ev.clockTo <= ev.clockFrom) continue;
      const list = byClient.get(ev.client);
      if (list) list.push(ev);
      else byClient.set(ev.client, [ev]);
    }
    for (const run of this.runs) {
      const candidates = byClient.get(run.client);
      if (!candidates) continue;
      const length = run.to - run.from;
      for (const ev of candidates) {
        if (!eventCoversItems(ev, run.client, run.clock, length)) continue;
        // Clip the run to the event's clock range (a run can span two events
        // from the same session when their items are adjacent).
        const from = run.from + Math.max(0, ev.clockFrom - run.clock);
        const to = run.from + Math.min(length, ev.clockTo - run.clock);
        if (to <= from) continue;
        // The server applies a minimal char diff, so a rewrite can keep a
        // stray shared character ("e" in added→rewritten) that was never
        // re-minted. Bridge such tiny gaps so the edit reads as one change.
        const last = this.recentRanges[this.recentRanges.length - 1];
        if (last && last.event === ev && from - last.to <= 2 && from >= last.to) {
          last.to = to;
        } else {
          this.recentRanges.push({ from, to, event: ev });
        }
      }
    }
    for (const r of this.recentRanges) {
      ranges.push(Decoration.mark({ class: 'cm-recent-insert' }).range(r.from, r.to));
      for (let n = cmDoc.lineAt(r.from).number; n <= cmDoc.lineAt(r.to).number; n++) {
        touchedLines.add(n);
      }
    }

    // Removed text: resolve once per event (anchor walk / context search),
    // then follow the doc through mapped positions.
    let text: string | null = null;
    const getText = () => (text ??= this.ytext.toString());
    const unplaced: DocActivityEvent[] = [];
    for (const ev of events) {
      if (!ev.old) continue;
      let pos = cache.ghostPos.get(ev.id);
      if (pos === undefined) {
        pos = resolveEventPosition(doc, this.ytext, ev, getText);
        cache.ghostPos.set(ev.id, pos);
      }
      if (pos === null || pos > cmDoc.length) {
        unplaced.push(ev);
        continue;
      }
      ranges.push(Decoration.widget({ widget: new GhostWidget(ev), side: -1 }).range(pos));
      touchedLines.add(cmDoc.lineAt(pos).number);
    }
    if (unplaced.length > 0) {
      ranges.push(
        Decoration.widget({ widget: new TrayWidget(unplaced), side: -1, block: true }).range(0)
      );
    }
    for (const n of touchedLines) {
      ranges.push(Decoration.line({ class: 'cm-authline-recent' }).range(cmDoc.line(n).from));
    }
  }

  /** Wake up when the oldest visible event leaves the window (or a minute
   *  from now to refresh the ghosts' age labels), instead of polling. */
  private scheduleRecentExpiry(events: DocActivityEvent[], windowMs: number, now: number) {
    this.clearRecentTimer();
    if (events.length === 0) return;
    let next = 60_000;
    for (const ev of events) {
      next = Math.min(next, ev.ts + windowMs - now);
    }
    this.recentTimer = setTimeout(() => {
      this.recentTimer = null;
      if (this.destroyed) return;
      this.view.dispatch({ effects: refreshRecent.of(null) });
    }, Math.max(1_000, next));
  }

  private clearRecentTimer() {
    if (this.recentTimer) {
      clearTimeout(this.recentTimer);
      this.recentTimer = null;
    }
  }

  /** Overlay rendering needs coordsAtPos (a layout read), which is illegal
   *  during CM's update/measure cycle — defer to the next animation frame,
   *  when the view is idle again. */
  private overlayScheduled = false;
  private destroyed = false;

  private scheduleOverlayRender() {
    if (this.overlayScheduled) return;
    this.overlayScheduled = true;
    requestAnimationFrame(() => {
      this.overlayScheduled = false;
      if (!this.destroyed) this.renderOverlay();
    });
  }

  /**
   * Hover-preview labels as fixed-position chips appended to document.body:
   * they escape the scroller's overflow clipping and paint above the file
   * sidebar (white background, high z-index).
   */
  private renderOverlay() {
    const active =
      this.hoverExpanded &&
      this.view.state.field(authorshipModeField) === 'gutter' &&
      this.labelBlocks.length > 0;

    if (!active) {
      this.overlay?.remove();
      this.overlay = null;
      return;
    }

    if (!this.overlay) {
      this.overlay = document.createElement('div');
      this.overlay.className = 'cm-authorship-hover-overlay';
      document.body.appendChild(this.overlay);
    }
    const overlay = this.overlay;
    overlay.textContent = '';

    const lineLeft = this.lineBoxLeft();
    const stripLeft = lineLeft - AuthorshipPlugin.STRIP_OFFSET;
    const right = window.innerWidth - (stripLeft - 4);
    // Clip to the scroller's visible area: CM renders overscan lines beyond
    // it, and coordsAtPos returns positions under the app header / below the
    // pane, where chips must not appear.
    const bounds = this.view.scrollDOM.getBoundingClientRect();

    for (const block of this.labelBlocks) {
      const coords = this.view.coordsAtPos(block.from);
      if (!coords) continue;
      // The chip is ~22px tall and rendered from coords.top - 2; make sure
      // the whole chip fits inside the visible pane, not just the line.
      if (coords.top - 2 < bounds.top || coords.top + 20 > bounds.bottom) continue;
      const chip = document.createElement('div');
      chip.className = `cm-auth-hoverlabel cm-auth-hoverlabel-${block.category}`;
      chip.textContent = block.label;
      chip.style.top = `${coords.top - 2}px`;
      chip.style.right = `${right}px`;
      overlay.appendChild(chip);
    }
  }

  destroy() {
    this.destroyed = true;
    this.users.unobserveDeep(this.usersObserver);
    this.activity.unobserveDeep(this.activityObserver);
    this.clearRecentTimer();
    if (this.tooltipFrame !== null) cancelAnimationFrame(this.tooltipFrame);
    this.view.scrollDOM.removeEventListener('mousemove', this.onMouseMove);
    this.view.scrollDOM.removeEventListener('mouseleave', this.onMouseLeave);
    this.view.scrollDOM.removeEventListener('scroll', this.onScroll);
    this.overlay?.remove();
    this.overlay = null;
    this.hideTooltip();
  }
}

/** Binary search over non-overlapping ranges sorted by `from`. */
function rangeAt<T extends { from: number; to: number }>(ranges: T[], pos: number): T | null {
  let lo = 0;
  let hi = ranges.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ranges[mid].to <= pos) lo = mid + 1;
    else hi = mid;
  }
  const r = ranges[lo];
  return r && pos >= r.from && pos < r.to ? r : null;
}

/** Browser caret position under a point (Chromium / Firefox / WebKit). */
function caretFromPoint(x: number, y: number): { node: Node; offset: number } | null {
  const d = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => globalThis.Range | null;
  };
  if (d.caretPositionFromPoint) {
    const p = d.caretPositionFromPoint(x, y);
    return p ? { node: p.offsetNode, offset: p.offset } : null;
  }
  if (d.caretRangeFromPoint) {
    const r = d.caretRangeFromPoint(x, y);
    return r ? { node: r.startContainer, offset: r.startOffset } : null;
  }
  return null;
}

export function authorshipExtension(ytext: Y.Text): Extension {
  const plugin = ViewPlugin.define((view) => new AuthorshipPlugin(view, ytext), {
    decorations: (v) => v.decorations,
  });

  // Expose the mode on the editor root so CSS can reserve horizontal space
  // for the label column in persistent Expanded mode.
  const modeAttribute = EditorView.editorAttributes.compute(
    [authorshipModeField],
    (state) => ({ 'data-authorship-mode': state.field(authorshipModeField) })
  );

  // The plugin stays at index 1: authorship.test.ts reaches it that way.
  return [authorshipModeField, plugin, modeAttribute, recentWindowField, recentEnabledField];
}
