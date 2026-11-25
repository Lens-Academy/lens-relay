import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { IdeaGraph } from '../../lib/idea-map';
import { mostRequired, type GroupLink, type WalkGroup } from '../../lib/idea-map-walk';
import { arrowFocus } from './ideaKeys';
import { topicColours } from './ideaLook';

/** A topic's box, the room between two boxes, and around them all. */
const BOX = { width: 280, height: 178 };
const GAP = { x: 48, y: 56 };
const MARGIN = 40;
/** No more boxes than this in a row, however wide the page. */
const MOST_ACROSS = 5;
/** A topic names the topics it builds on by at least this many links (and always the one it builds on most). */
const STRONG = 3;
/** No more of them than this. */
const MOST_NAMED = 6;
/** Between a box and the end of a line to it. */
const LINE_GAP = 6;

const GREY = { fill: '#fafafa', edge: '#d4d4d8', text: '#3f3f46', mark: '#a1a1aa' };
const coloursOf = (group: WalkGroup) => (group.tone === undefined ? GREY : topicColours(group.tone));

const links = (count: number) => (count === 1 ? '1 link' : `${count} links`);

/** Where the line from the middle of one box to the middle of another leaves the first box. */
function edgeOf(from: { x: number; y: number }, to: { x: number; y: number }): { x: number; y: number } {
  const [dx, dy] = [to.x - from.x, to.y - from.y];
  const [halfWide, halfTall] = [BOX.width / 2 + LINE_GAP, BOX.height / 2 + LINE_GAP];
  const scale = Math.min(dx === 0 ? Infinity : halfWide / Math.abs(dx), dy === 0 ? Infinity : halfTall / Math.abs(dy));
  return Number.isFinite(scale) ? { x: from.x + dx * scale, y: from.y + dy * scale } : from;
}

/**
 * The topics as large boxes, numbered and laid out in reading order (row by
 * row; a topic comes after the ones it builds on). Each says how much of it
 * was seen, the concepts in it that most others require, and (as numbered
 * dots) the topics it builds on most. While a topic has the pointer or the
 * focus, a line joins it to every topic it is linked to, those say how, and
 * the rest fades. A click on a topic walks through it. The arrow keys move
 * the focus between the topics.
 */
export function WalkOverview({ graph, groups, between, seenKeys, onTopic }: {
  graph: IdeaGraph;
  /** In reading order. */
  groups: readonly WalkGroup[];
  /** The links between the groups, a pair once. */
  between: readonly GroupLink[];
  seenKeys: ReadonlySet<string>;
  onTopic: (key: string) => void;
}) {
  const marker = useId().replace(/:/g, '');
  const frame = useRef<HTMLDivElement>(null);
  const [room, setRoom] = useState(0);
  const [active, setActive] = useState<string | null>(null);

  // As many boxes in a row as the page has room for
  useEffect(() => {
    const el = frame.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => setRoom(el.clientWidth));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const across = room === 0 ? MOST_ACROSS : Math.max(1, Math.min(MOST_ACROSS, Math.floor((room - 2 * MARGIN + GAP.x) / (BOX.width + GAP.x))));
  const down = Math.ceil(groups.length / across);
  const width = 2 * MARGIN + across * BOX.width + (across - 1) * GAP.x;
  const height = 2 * MARGIN + down * BOX.height + Math.max(0, down - 1) * GAP.y;
  const place = useMemo(() => new Map(groups.map((group, index) => [group.key, {
    index,
    left: MARGIN + (index % across) * (BOX.width + GAP.x),
    top: MARGIN + Math.floor(index / across) * (BOX.height + GAP.y),
  }])), [groups, across]);
  const byKey = useMemo(() => new Map(groups.map((group) => [group.key, group])), [groups]);

  /** For each topic, the topics it builds on: most links first. */
  const buildsOn = useMemo(() => {
    const found = new Map<string, Array<{ key: string; count: number }>>(groups.map((group) => [group.key, []]));
    for (const link of between) {
      if (link.count > 0) found.get(link.to)?.push({ key: link.from, count: link.count });
      if (link.back > 0) found.get(link.from)?.push({ key: link.to, count: link.back });
    }
    for (const list of found.values()) list.sort((a, b) => b.count - a.count || place.get(a.key)!.index - place.get(b.key)!.index);
    return found;
  }, [groups, between, place]);

  /** The links of the topic that has the pointer or the focus: `forth` lead from it, `back` to it. */
  const ofActive = useMemo(() => {
    const found = new Map<string, { forth: number; back: number }>();
    if (active === null) return found;
    for (const link of between) {
      if (link.from === active) found.set(link.to, { forth: link.count, back: link.back });
      else if (link.to === active) found.set(link.from, { forth: link.back, back: link.count });
    }
    return found;
  }, [active, between]);
  const activeGroup = active === null ? undefined : byKey.get(active);
  const activeColours = activeGroup ? coloursOf(activeGroup) : GREY;
  const middle = (key: string) => {
    const at = place.get(key)!;
    return { x: at.left + BOX.width / 2, y: at.top + BOX.height / 2 };
  };

  return (
    <div ref={frame} className="min-h-0 flex-1 overflow-auto" data-testid="walk-overview" onKeyDown={arrowFocus}>
      <div className="relative mx-auto" style={{ width, height }}>
        <svg className="pointer-events-none absolute inset-0" width={width} height={height} aria-hidden="true">
          <defs>
            <marker id={marker} markerUnits="userSpaceOnUse" markerWidth="11" markerHeight="10" refX="10" refY="5" orient="auto">
              <path d="M0,0 L11,5 L0,10 z" fill={activeColours.text} />
            </marker>
          </defs>
          {active !== null && [...ofActive].flatMap(([other, { forth, back }]) => {
            // One line a pair, pointing the way most of its links go: from what comes first
            const [from, to] = forth >= back ? [active, other] : [other, active];
            const start = edgeOf(middle(from), middle(to));
            const end = edgeOf(middle(to), middle(from));
            return (
              <line
                key={other}
                x1={start.x}
                y1={start.y}
                x2={end.x}
                y2={end.y}
                data-topic-link={`${from} > ${to}`}
                data-count={forth + back}
                stroke={activeColours.text}
                strokeOpacity="0.55"
                strokeWidth={Math.min(6, 1 + (forth + back) / 3)}
                strokeLinecap="round"
                markerEnd={`url(#${marker})`}
              />
            );
          })}
        </svg>
        {groups.map((group, index) => {
          const at = place.get(group.key)!;
          const colours = coloursOf(group);
          const seen = group.members.filter((key) => seenKeys.has(key)).length;
          const total = group.members.length;
          const teaser = mostRequired(graph, group.members).map((node) => node.name);
          const linked = ofActive.get(group.key);
          const dim = active !== null && active !== group.key && !linked;
          const needs = buildsOn.get(group.key) ?? [];
          const named = needs.filter((other, i) => i === 0 || other.count >= STRONG).slice(0, MOST_NAMED);
          return (
            // The box itself stays solid: a line to another topic passes behind it
            <button
              key={group.key}
              type="button"
              data-key={group.key}
              data-topic={group.label}
              className="absolute overflow-hidden rounded-xl bg-white text-left hover:shadow-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
              style={{ left: at.left, top: at.top, width: BOX.width, height: BOX.height }}
              title={`Walk through "${group.label}"`}
              onClick={() => onTopic(group.key)}
              onMouseEnter={() => setActive(group.key)}
              onMouseLeave={() => setActive((now) => (now === group.key ? null : now))}
              onFocus={() => setActive(group.key)}
              onBlur={() => setActive((now) => (now === group.key ? null : now))}
            >
              <span
                className={`flex h-full flex-col rounded-xl border px-4 py-3 transition-opacity ${dim ? 'opacity-35' : ''}`}
                style={{ background: colours.fill, borderColor: active === group.key ? colours.text : colours.edge }}
              >
                <span className="flex items-start gap-2.5">
                  <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold text-white" style={{ background: colours.mark }} data-topic-number>{index + 1}</span>
                  <span className="line-clamp-2 min-w-0 text-[15px] font-semibold leading-snug" style={{ color: colours.text }}>{group.label}</span>
                </span>
                <span className="mt-2 flex items-baseline justify-between gap-2 text-xs text-gray-600">
                  <span>{total} {total === 1 ? 'concept' : 'concepts'}</span>
                  <span data-topic-seen>{seen === total ? 'all seen' : `seen ${seen} of ${total}`}</span>
                </span>
                <span className="mt-1 block h-1 w-full shrink-0 overflow-hidden rounded-full bg-white" style={{ boxShadow: `inset 0 0 0 1px ${colours.edge}` }} aria-hidden="true">
                  <span className="block h-full rounded-full" style={{ width: `${(100 * seen) / Math.max(1, total)}%`, background: colours.mark }} />
                </span>
                <span className="mt-2 line-clamp-2 text-xs leading-snug text-gray-500" data-topic-teaser>{teaser.join(' · ')}</span>
                <span className="mt-auto flex h-5 items-center gap-1 text-[11px] text-gray-500">
                  {linked && activeGroup ? (
                    <span className="truncate font-medium" style={{ color: activeColours.text }} data-topic-linked>
                      {[linked.forth > 0 ? `builds on it: ${links(linked.forth)}` : '', linked.back > 0 ? `it builds on this: ${links(linked.back)}` : ''].filter(Boolean).join(' · ')}
                    </span>
                  ) : named.length === 0 ? (
                    <span data-topic-needs="">Builds on no other topic</span>
                  ) : (
                    <span
                      className="flex items-center gap-1"
                      data-topic-needs={named.map((other) => place.get(other.key)!.index + 1).join(' ')}
                      title={`Builds on ${needs.map((other) => `${byKey.get(other.key)!.label} (${links(other.count)})`).join(', ')}`}
                    >
                      Builds on
                      {named.map((other) => (
                        <span key={other.key} className="flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-semibold leading-none text-white" style={{ background: coloursOf(byKey.get(other.key)!).mark }}>
                          {place.get(other.key)!.index + 1}
                        </span>
                      ))}
                      {needs.length > named.length && <span className="text-gray-400">+{needs.length - named.length}</span>}
                    </span>
                  )}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
