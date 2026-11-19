import { useCallback, useEffect, useId, useLayoutEffect, useRef, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import type { IdeaGraph, IdeaNode } from '../../lib/idea-map';
import type { WalkGroup } from '../../lib/idea-map-walk';
import { nextBox } from './ideaKeys';
import { BUTTON, CHOSEN_LOOK, PRIORITY_LABEL, PRIORITY_LOOK, pickByEnter, pickKeys, pickWord, topicColours, type PickKeys, type PickMarks } from './ideaLook';

/** More neighbours than this on one side are joined to the concept by one line (a bracket around them), and
 *  stand in two columns where the page has the room. */
const ONE_COLUMN = 8;
/** A neighbour is never narrower than this: with less room the two columns become one. */
const NARROWEST = '13.5rem';
/** Between two line ends on the side of the concept's card, at most. */
const PORT_GAP = 16;
/** From a block of two columns to its bracket. */
const BRACKET = 14;

type Side = 'before' | 'after';
interface Section { id: string; title: string; side: Side; helpful: boolean; keys: string[] }

const LINE = { requires: '#6b7280', helpful: '#9ca3af' };

function Tick() {
  return (
    <svg className="h-3.5 w-3.5 shrink-0 text-emerald-600" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" role="img" aria-label="Seen">
      <path d="M3 8.5l3.2 3.2L13 5" />
    </svg>
  );
}

/**
 * One step of the walk: the concept in the middle, what it builds on to its
 * left (Requires solid, Helpful first dashed) and what it leads to on its
 * right, a line for each. Nothing else of the map is shown. A click on a
 * neighbour goes there. Arrow up and down move the focus between the
 * neighbours (left and right belong to the walk).
 */
export function WalkStep({ node, graph, groupOf, seenKeys, marks, selected, chosen, card, note, onVisit, onOpen }: {
  node: IdeaNode;
  graph: IdeaGraph;
  groupOf: (key: string) => WalkGroup | undefined;
  seenKeys: ReadonlySet<string>;
  marks: PickMarks | null;
  selected: string | null;
  chosen: ReadonlySet<string>;
  /** The card of the concept, for the view to put the focus on. */
  card: RefObject<HTMLDivElement | null>;
  /** What the walk says about this step, above the card. */
  note?: ReactNode;
  /** A click on a neighbour. */
  onVisit: (key: string, keys: PickKeys) => void;
  /** "Open": the side panel. */
  onOpen: (keys: PickKeys) => void;
}) {
  const marker = useId().replace(/:/g, '');
  const wrap = useRef<HTMLDivElement>(null);
  const idea = node.idea;
  const own = groupOf(node.key);
  const colours = own?.tone === undefined ? null : topicColours(own.tone);
  const known = (keys: string[]) => [...new Set(keys)].filter((key) => key !== node.key && graph.byKey.has(key));
  const requires = known(node.requires);
  const neededFor = known(node.neededFor);
  const sections: Section[] = [
    { id: 'requires', title: 'Requires', side: 'before', helpful: false, keys: requires },
    { id: 'helpful', title: 'Helpful first', side: 'before', helpful: true, keys: known(node.helpful).filter((key) => !requires.includes(key)) },
    { id: 'neededFor', title: 'Needed for', side: 'after', helpful: false, keys: neededFor },
    { id: 'helpfulFor', title: 'Helpful for', side: 'after', helpful: true, keys: known(node.helpfulFor).filter((key) => !neededFor.includes(key)) },
  ].filter((section): section is Section => section.keys.length > 0);
  const count = (side: Side) => sections.filter((section) => section.side === side).reduce((sum, section) => sum + section.keys.length, 0);
  const wide = { before: count('before') > ONE_COLUMN, after: count('after') > ONE_COLUMN };

  // The lines are drawn from where the browser put the boxes: a box is as
  // tall as its name needs. Again whenever the room changes.
  const draw = useCallback(() => {
    const root = wrap.current;
    const middle = root?.querySelector<HTMLElement>('[data-walk-card]');
    if (!root || !middle) return;
    const base = root.getBoundingClientRect();
    const mid = middle.getBoundingClientRect();
    for (const side of ['before', 'after'] as const) {
      const ends = [...root.querySelectorAll<HTMLElement>(`[data-port="${side}"]`)]
        .map((el) => ({ el, box: el.getBoundingClientRect() }))
        .sort((a, b) => a.box.top + a.box.bottom - b.box.top - b.box.bottom);
      const gap = Math.min(PORT_GAP, (mid.height * 0.7) / Math.max(1, ends.length));
      ends.forEach(({ el, box }, index) => {
        const line = root.querySelector<SVGPathElement>(`[data-line="${el.dataset.portLine}"]`);
        if (!line) return;
        const bracket = root.querySelector<SVGPathElement>(`[data-bracket="${el.dataset.portLine}"]`);
        const y = (box.top + box.bottom) / 2 - base.top;
        const atCard = mid.top + mid.height / 2 + (index - (ends.length - 1) / 2) * gap - base.top;
        const out = bracket ? BRACKET : 0;
        // From what comes first to what needs it: the arrowhead is at the far end
        const [x1, y1, x2, y2] = side === 'before'
          ? [box.right - base.left + out, y, mid.left - base.left - 3, atCard]
          : [mid.right - base.left, atCard, box.left - base.left - out - 3, y];
        const reach = Math.max(12, (x2 - x1) / 2);
        line.setAttribute('d', `M${x1},${y1} C${x1 + reach},${y1} ${x2 - reach},${y2} ${x2},${y2}`);
        if (bracket) {
          const x = side === 'before' ? box.right - base.left + out : box.left - base.left - out;
          const turn = side === 'before' ? -8 : 8;
          const [top, bottom] = [box.top - base.top, box.bottom - base.top];
          bracket.setAttribute('d', `M${x + turn},${top} Q${x},${top} ${x},${top + 8} L${x},${bottom - 8} Q${x},${bottom} ${x + turn},${bottom}`);
        }
      });
    }
  }, []);
  useLayoutEffect(draw);
  useEffect(() => {
    const root = wrap.current;
    if (!root || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(draw);
    observer.observe(root);
    for (const el of root.querySelectorAll('[data-walk-card], [data-port]')) observer.observe(el);
    return () => observer.disconnect();
  }, [draw, node]);

  /** Arrow up and down: between the neighbours and "Open". */
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if ((e.key !== 'ArrowUp' && e.key !== 'ArrowDown') || e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const from = e.target instanceof Element ? e.target.closest<HTMLElement>('[data-key]') : null;
    if (!from) return;
    const boxes = [...e.currentTarget.querySelectorAll<HTMLElement>('[data-key]')];
    const next = boxes[nextBox(boxes.map((box) => box.getBoundingClientRect()), boxes.indexOf(from), e.key === 'ArrowUp' ? 'up' : 'down')];
    if (!next) return;
    e.preventDefault();
    next.focus();
  };

  const neighbour = (key: string) => {
    const other = graph.byKey.get(key)!;
    const group = groupOf(key);
    const tone = group?.tone === undefined ? null : topicColours(group.tone);
    const seen = seenKeys.has(key);
    const word = pickWord(marks, key);
    const inSet = chosen.has(key);
    const ring = word ? 'ring-2 ring-indigo-500' : key === selected ? 'ring-2 ring-blue-600' : '';
    return (
      <button
        key={key}
        type="button"
        data-key={key}
        data-idea={other.name}
        data-seen={seen}
        data-chosen={inSet || undefined}
        aria-pressed={marks ? word !== null : undefined}
        title={`${other.name}${group ? ` · ${group.label}` : ''}${other.written ? '' : ' · Not written yet'} · ${seen ? 'seen' : 'not seen yet'}`}
        className={`relative w-full overflow-hidden rounded-lg border py-2 pl-4 pr-3 text-left text-sm leading-snug hover:shadow focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-blue-600 ${other.written ? '' : 'border-dashed'} ${seen ? 'bg-white text-gray-500' : 'font-medium text-gray-900'} ${ring} ${inSet ? CHOSEN_LOOK : ''}`}
        style={{ borderColor: tone?.edge ?? '#d4d4d8', background: seen ? undefined : tone?.fill ?? '#fafafa' }}
        onClick={(e) => onVisit(key, pickKeys(e))}
        onKeyDown={(e) => pickByEnter(e, (keys) => onVisit(key, keys))}
      >
        <span className="absolute inset-y-0 left-0 w-1" style={{ background: tone?.mark ?? '#a1a1aa' }} aria-hidden="true" />
        <span className="flex items-start gap-2">
          <span className="min-w-0 flex-1 break-words">{other.name}</span>
          {seen ? <Tick /> : <span className="mt-px shrink-0 rounded-full bg-blue-600 px-1.5 py-px text-[10px] font-semibold leading-tight text-white">new</span>}
        </span>
        {group && group.key !== own?.key && (
          <span className="mt-0.5 block truncate text-xs font-normal" style={{ color: tone?.text ?? '#52525b' }} data-other-topic>{group.label}</span>
        )}
        {word && <span className="mt-1 inline-block rounded bg-indigo-600 px-1 py-px text-[9px] font-medium leading-none text-white">{word}</span>}
      </button>
    );
  };

  const column = (side: Side, heading: string, none: string) => {
    const mine = sections.filter((section) => section.side === side);
    const two = wide[side];
    return (
      <div className={`flex min-w-0 flex-col gap-7 ${side === 'before' ? 'items-end' : 'items-start'}`} data-walk-side={side}>
        <h3 className={`w-full text-xs font-semibold uppercase tracking-wide text-gray-400 ${two ? 'max-w-[31rem]' : 'max-w-[17rem]'}`}>{heading}</h3>
        {mine.length === 0 && (
          <p className="w-full max-w-[17rem] rounded-lg border border-dashed border-gray-200 px-4 py-3 text-sm text-gray-400" data-walk-none={side}>{none}</p>
        )}
        {mine.map((section) => (
          <section key={section.id} className={`w-full ${two ? 'max-w-[31rem]' : 'max-w-[17rem]'}`} data-walk-list={section.id} aria-label={section.title}>
            <h4 className="mb-2 flex items-center gap-2 text-xs text-gray-500">
              <svg width="26" height="6" aria-hidden="true"><line x1="0" y1="3" x2="26" y2="3" stroke={section.helpful ? LINE.helpful : LINE.requires} strokeWidth="1.5" strokeDasharray={section.helpful ? '4 3' : undefined} /></svg>
              {section.title}
              <span className="text-gray-400">{section.keys.length}</span>
            </h4>
            <div
              className={two ? 'grid gap-x-3 gap-y-2.5' : 'flex flex-col gap-2.5'}
              {...(two ? { 'data-port': side, 'data-port-line': section.id, style: { gridTemplateColumns: `repeat(auto-fill, minmax(${NARROWEST}, 1fr))` } } : {})}
            >
              {section.keys.map((key) => (two ? neighbour(key) : (
                <div key={key} data-port={side} data-port-line={`${section.id}:${key}`}>{neighbour(key)}</div>
              )))}
            </div>
          </section>
        ))}
      </div>
    );
  };

  const lines = sections.flatMap((section) => (wide[section.side]
    ? [{ id: section.id, helpful: section.helpful, bracket: true }]
    : section.keys.map((key) => ({ id: `${section.id}:${key}`, helpful: section.helpful, bracket: false }))));

  return (
    <div className="min-h-0 flex-1 overflow-auto" data-testid="walk-step" onKeyDown={onKeyDown} onScroll={draw}>
      <div
        ref={wrap}
        className="relative mx-auto grid min-h-full max-w-[100rem] items-center gap-x-24 px-8 py-10"
        // A side with many neighbours gets more of the room
        style={{ gridTemplateColumns: `minmax(${NARROWEST}, ${wide.before ? 1.8 : 1}fr) minmax(20rem, 30rem) minmax(${NARROWEST}, ${wide.after ? 1.8 : 1}fr)` }}
      >
        <svg className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden="true">
          <defs>
            {(['requires', 'helpful'] as const).map((kind) => (
              <marker key={kind} id={`${marker}-${kind}`} markerUnits="userSpaceOnUse" markerWidth="9" markerHeight="8" refX="8" refY="4" orient="auto">
                <path d="M0,0 L9,4 L0,8 z" fill={LINE[kind]} />
              </marker>
            ))}
          </defs>
          {lines.map((line) => {
            const kind = line.helpful ? 'helpful' : 'requires';
            return (
              <g key={line.id} fill="none" stroke={LINE[kind]} strokeWidth="1.5">
                {line.bracket && <path data-bracket={line.id} />}
                <path data-line={line.id} data-edge={kind} strokeDasharray={line.helpful ? '5 4' : undefined} markerEnd={`url(#${marker}-${kind})`} />
              </g>
            );
          })}
        </svg>

        {column('before', 'Builds on', 'Requires nothing first: a place to start.')}

        {/* A side taller than the page: the concept stays in sight while the page scrolls */}
        <div className="sticky bottom-10 top-10 flex min-w-0 flex-col gap-3">
          {note}
          <div
            ref={card}
            tabIndex={-1}
            role="group"
            aria-label={`Step: ${node.name}`}
            data-walk-card
            data-idea={node.name}
            className={`rounded-2xl border-2 bg-white px-7 py-6 shadow-sm outline-none focus-visible:shadow-md ${node.written ? '' : 'border-dashed'} ${node.inCycle ? '!border-red-500' : ''}`}
            style={{ borderColor: colours?.edge ?? '#d4d4d8' }}
          >
            <div className="flex flex-wrap items-center gap-2 text-xs">
              {own && (
                <span className="rounded-full border px-2 py-0.5 font-medium" style={colours ? { background: colours.fill, borderColor: colours.edge, color: colours.text } : undefined} data-testid="walk-topic">{own.label}</span>
              )}
              {idea && <span className={`rounded border px-1.5 py-0.5 ${PRIORITY_LOOK[idea.priority]}`}>{PRIORITY_LABEL[idea.priority]} priority</span>}
              {!node.written && <span className="rounded border border-dashed border-gray-400 px-1.5 py-0.5 text-gray-500">Not written yet</span>}
              {node.inCycle && <span className="rounded border border-red-300 bg-red-50 px-1.5 py-0.5 text-red-700">In a circle of requirements</span>}
            </div>
            <h2 className="mt-3 break-words text-2xl font-semibold leading-tight text-gray-900">{node.name}</h2>
            {idea?.outcome && <p className="mt-4 whitespace-pre-wrap text-[15px] leading-relaxed text-gray-800" data-testid="walk-outcome">{idea.outcome}</p>}
            {idea?.why && (
              <>
                <h3 className="mt-5 text-xs font-semibold uppercase tracking-wide text-gray-400">Why it matters</h3>
                <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-gray-600">{idea.why}</p>
              </>
            )}
            {!node.written && <p className="mt-4 text-sm text-gray-500">Other concepts name this one, but it has no file yet.</p>}
            <div className="mt-5 flex items-center gap-3">
              <button
                type="button"
                className={BUTTON}
                data-key={node.key}
                title="Open this concept in the side panel: its lenses, questions and the ways to edit it"
                onClick={(e) => onOpen(pickKeys(e))}
              >
                Open
              </button>
            </div>
          </div>
        </div>

        {column('after', 'Leads to', 'Nothing builds on this one yet: an end point.')}
      </div>
    </div>
  );
}
