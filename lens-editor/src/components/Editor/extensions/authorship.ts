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
  hoverTooltip,
} from '@codemirror/view';
import type { DecorationSet, ViewUpdate } from '@codemirror/view';
import type * as Y from 'yjs';
import { getAuthorshipRuns } from '../../../lib/authorship-runs';
import type { AuthorshipRun } from '../../../lib/authorship-runs';
import { getClientActorMap, getRegisteredAt } from '../../../lib/provenance';

export type AuthorshipMode = 'hidden' | 'gutter' | 'expanded' | 'inline';

export const setAuthorshipMode = StateEffect.define<AuthorshipMode>();
const refreshAuthorship = StateEffect.define<null>();

export const authorshipModeField = StateField.define<AuthorshipMode>({
  create: () => 'gutter',
  update: (value, tr) => {
    for (const e of tr.effects) {
      if (e.is(setAuthorshipMode)) return e.value;
    }
    return value;
  },
});

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
  private labelBlocks: Array<{ from: number; label: string; category: LineCategory }> = [];
  private overlay: HTMLElement | null = null;
  private readonly onMouseMove: (e: MouseEvent) => void;
  private readonly onMouseLeave: () => void;
  private onScroll!: () => void;

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

    // Gutter hover: hovering the strip band previews Expanded mode — the
    // blame-style margin labels appear for the whole viewport and disappear
    // on leave. Pure overlay; never pushes the text.
    this.onMouseMove = (e) => this.handleGutterHover(e);
    this.onMouseLeave = () => this.setHoverExpanded(false);
    view.scrollDOM.addEventListener('mousemove', this.onMouseMove);
    view.scrollDOM.addEventListener('mouseleave', this.onMouseLeave);
    // Keep hover chips glued to their lines while the document scrolls
    // (rAF-deduped; CM only recomputes decorations on larger viewport moves).
    this.onScroll = () => {
      if (this.hoverExpanded) this.scheduleOverlayRender();
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
      update.state.field(authorshipModeField);
    const refreshed = update.transactions.some((tr) =>
      tr.effects.some((e) => e.is(refreshAuthorship))
    );
    if (update.docChanged || update.viewportChanged || modeChanged || refreshed) {
      this.recompute(update);
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

  actorAt(pos: number): { actor: string | undefined; client: number } | null {
    for (const run of this.runs) {
      if (pos >= run.from && pos < run.to) {
        return { actor: this.actorByClient.get(run.client), client: run.client };
      }
    }
    return null;
  }

  private recompute(update?: ViewUpdate) {
    const mode = this.view.state.field(authorshipModeField);
    this.labelBlocks = [];
    if (mode === 'hidden') {
      this.runs = [];
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
      return;
    }

    const ranges: Range<Decoration>[] = [];

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
    this.view.scrollDOM.removeEventListener('mousemove', this.onMouseMove);
    this.view.scrollDOM.removeEventListener('mouseleave', this.onMouseLeave);
    this.view.scrollDOM.removeEventListener('scroll', this.onScroll);
    this.overlay?.remove();
    this.overlay = null;
  }
}

export function authorshipExtension(ytext: Y.Text): Extension {
  const plugin = ViewPlugin.define((view) => new AuthorshipPlugin(view, ytext), {
    decorations: (v) => v.decorations,
  });

  const tooltip = hoverTooltip((view, pos) => {
    const mode = view.state.field(authorshipModeField);
    if (mode === 'hidden') return null;
    const instance = view.plugin(plugin);
    const hit = instance?.actorAt(pos);
    if (!hit) return null;

    const doc = ytext.doc;
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

    return {
      pos,
      create: () => {
        const dom = document.createElement('div');
        dom.className = 'cm-authorship-tooltip';
        dom.textContent = when ? `${who} · ${when}` : who;
        return { dom };
      },
    };
  });

  // Expose the mode on the editor root so CSS can reserve horizontal space
  // for the label column in persistent Expanded mode.
  const modeAttribute = EditorView.editorAttributes.compute(
    [authorshipModeField],
    (state) => ({ 'data-authorship-mode': state.field(authorshipModeField) })
  );

  return [authorshipModeField, plugin, tooltip, modeAttribute];
}
