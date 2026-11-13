import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { hasTopics, ideaGroups } from '../../lib/idea-map-layouts';
import {
  WALK_ORDERS,
  foundationsWalk,
  goalPath,
  goalWalk,
  groupLinks,
  proposeNext,
  readingOrder,
  seenId,
  topicWalk,
  walkEdges,
  type WalkGroup,
  type WalkOrder,
  type WalkStep as Step,
} from '../../lib/idea-map-walk';
import { Confirm } from './Confirm';
import { WalkGoalBox } from './WalkGoalBox';
import { WalkOverview } from './WalkOverview';
import { WalkStep } from './WalkStep';
import { BUTTON, PRIMARY_BUTTON, topicColours, type IdeaViewProps, type PickKeys } from './ideaLook';
import { useWalkOrder, useWalkSeen } from './useWalkStore';

/** How many of the last steps the trail shows, and how many it keeps. */
const TRAIL_SHOWN = 6;
const TRAIL_KEPT = 40;

const PLAIN: PickKeys = { shift: false, toggle: false, byKey: false };

/** Where the walk is. `aside`: the concept shown instead of the walk's own step (a detour by a click; in
 *  "Follow my curiosity" always). `trail`: what was shown before, the latest last. */
type Place = (
  | { kind: 'foundations' }
  | { kind: 'topic'; group: string }
  | { kind: 'goal'; goal: string; helpful: boolean }
  | { kind: 'curiosity' }
) & { at: number; aside: string | null; trail: string[] };

const KIND_LABEL: Record<Place['kind'], string> = {
  foundations: 'Foundations first',
  topic: 'Topic by topic',
  goal: 'Backwards from a goal',
  curiosity: 'Follow my curiosity',
};

export interface IdeaWalkProps extends IdeaViewProps {
  /** The set of concepts shown (a profile or a folder): what was seen is remembered per set. */
  seenSet: string;
}

/**
 * "Walk through": the map one concept at a time. It opens on the topics (in
 * reading order, with how much of each was seen); from there a walk starts,
 * in one of four orders (lib/idea-map-walk). A step shows one concept with
 * what it builds on and what it leads to. Next and Back (the arrow keys
 * right and left) move along the walk; a click on a neighbour is a detour
 * with a way back; the trail of the last steps is clickable. Every concept
 * shown is remembered as seen, in this browser.
 */
export function IdeaWalkView({ graph, selected, chosen, marks, onPick, seenSet }: IdeaWalkProps) {
  const root = useRef<HTMLDivElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const [order, setOrder] = useWalkOrder();
  const { seen, mark, clear } = useWalkSeen(seenSet);
  const [place, setPlace] = useState<Place | null>(null);
  const [goal, setGoal] = useState<string | null>(null);
  const [goalHelpful, setGoalHelpful] = useState(false);
  const [confirming, setConfirming] = useState(false);

  // The groups: the author's topics, or (no concept has one) the clusters the links make
  const byTopic = useMemo(() => hasTopics(graph), [graph]);
  const groups = useMemo<WalkGroup[]>(() => {
    const found = readingOrder(graph, ideaGroups(graph, walkEdges(graph), byTopic ? 'topic' : 'cluster'));
    // A cluster has no colour of its own
    return found.map((group, index) => (group.tone === undefined && !byTopic ? { ...group, tone: index } : group));
  }, [graph, byTopic]);
  const groupByKey = useMemo(() => new Map(groups.map((group) => [group.key, group])), [groups]);
  const groupOfKey = useMemo(() => new Map(groups.flatMap((group) => group.members.map((key) => [key, group] as const))), [groups]);
  const between = useMemo(() => groupLinks(graph, groups), [graph, groups]);
  const foundations = useMemo(() => foundationsWalk(graph, groups), [graph, groups]);
  const seenKeys = useMemo(() => new Set(graph.nodes.filter((node) => seen.has(seenId(node))).map((node) => node.key)), [graph, seen]);
  const total = graph.nodes.length;

  const steps = useMemo<Step[]>(() => {
    if (!place) return [];
    if (place.kind === 'foundations') return foundations;
    if (place.kind === 'topic') {
      const group = groupByKey.get(place.group);
      return group ? topicWalk(graph, group) : [];
    }
    if (place.kind === 'goal') return goalWalk(graph, place.goal, { helpful: place.helpful });
    return [];
  }, [place, foundations, graph, groupByKey]);

  const name = (key: string) => graph.byKey.get(key)?.name ?? key;
  /** The concept on the screen, or null (the overview, or the card at the end of a walk). */
  const shown = (at: Place | null, list: readonly Step[]): string | null => {
    const key = at ? at.aside ?? list[at.at]?.key ?? null : null;
    return key !== null && graph.byKey.has(key) ? key : null;
  };
  const current = shown(place, steps);
  const node = current === null ? undefined : graph.byKey.get(current);
  const onWalk = place !== null && place.aside === null;
  const ordered = place !== null && place.kind !== 'curiosity';
  const trail = place ? place.trail.filter((key) => graph.byKey.has(key)) : [];
  const proposal = place?.kind === 'curiosity' ? proposeNext(graph, current, seenKeys) : null;

  /** Show what `next` shows: remember it as seen, and let an open side panel follow. */
  const go = (next: Place | null, list: readonly Step[] = steps) => {
    setPlace(next);
    const key = shown(next, list);
    if (key === null) return;
    mark(seenId(graph.byKey.get(key)!));
    if (selected !== null && selected !== key && !marks) onPick(key, PLAIN);
  };
  const withTrail = (from: string | null, kept: readonly string[] = trail) => (
    from === null || kept[kept.length - 1] === from ? [...kept] : [...kept, from].slice(-TRAIL_KEPT)
  );

  /** Start a walk at its first step that was not seen yet (at its first step when all were). */
  const start = (next: Place, list: readonly Step[]) => {
    const first = list.findIndex((step) => !seenKeys.has(step.key));
    go({ ...next, at: next.kind === 'goal' || first < 0 ? 0 : first }, list);
  };
  const startFoundations = () => start({ kind: 'foundations', at: 0, aside: null, trail: [] }, foundations);
  const startTopic = (key: string) => {
    const group = groupByKey.get(key);
    if (group) start({ kind: 'topic', group: key, at: 0, aside: null, trail: [] }, topicWalk(graph, group));
  };
  const startGoal = (key: string) => start({ kind: 'goal', goal: key, helpful: goalHelpful, at: 0, aside: null, trail: [] }, goalWalk(graph, key, { helpful: goalHelpful }));
  const startCuriosity = (key: string) => go({ kind: 'curiosity', at: 0, aside: key, trail: [] }, []);

  /** A click on a concept: the step next to this one moves the walk, any other is a detour. */
  const visit = (key: string) => {
    if (!place || key === current || !graph.byKey.has(key)) return;
    const kept = withTrail(current);
    if (ordered && onWalk && steps[place.at + 1]?.key === key) go({ ...place, at: place.at + 1, trail: kept });
    else if (ordered && steps[place.at]?.key === key) go({ ...place, aside: null, trail: kept });
    else go({ ...place, aside: key, trail: kept });
  };
  /** A step of the walk itself (the way from the goal): the walk goes there. */
  const jump = (at: number) => {
    if (place && steps[at]) go({ ...place, at, aside: null, trail: withTrail(current) });
  };
  const canNext = place !== null && (ordered ? !onWalk || place.at < steps.length : proposal !== null);
  const next = () => {
    if (!place || !canNext) return;
    const kept = withTrail(current);
    if (!ordered) go({ ...place, aside: proposal!.key, trail: kept });
    else if (!onWalk) go({ ...place, aside: null, trail: kept });
    else go({ ...place, at: place.at + 1, trail: kept });
  };
  const canBack = place !== null && (ordered && onWalk ? place.at > 0 : trail.length > 0 || ordered);
  const back = () => {
    if (!place || !canBack) return;
    if (ordered && onWalk) {
      const to = steps[place.at - 1]?.key;
      go({ ...place, at: place.at - 1, trail: trail[trail.length - 1] === to ? trail.slice(0, -1) : trail });
      return;
    }
    // Off the walk: the way that led here, backwards
    const to = trail[trail.length - 1];
    const kept = trail.slice(0, -1);
    if (to === undefined || (ordered && steps[place.at]?.key === to)) go({ ...place, aside: null, trail: kept });
    else go({ ...place, aside: to, trail: kept });
  };
  /** A click on the trail: back to that step, and the trail ends there. */
  const rewind = (index: number) => {
    if (!place) return;
    const to = trail[index];
    const kept = trail.slice(0, index);
    if (ordered && steps[place.at]?.key === to) go({ ...place, aside: null, trail: kept });
    else go({ ...place, aside: to, trail: kept });
  };

  // Arrow right and left walk, while the focus is in the view or nowhere
  // (not in a field, the side panel or a form).
  useEffect(() => {
    if (!place) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') || e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      const target = e.target instanceof Element ? e.target : null;
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;
      if (target && target !== document.body && target !== document.documentElement && !root.current?.contains(target)) return;
      e.preventDefault();
      if (e.key === 'ArrowRight') next();
      else back();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // The focus goes to the new step when what held it is gone (the neighbour
  // clicked, the topic chosen), so the keyboard goes on from the concept.
  useEffect(() => {
    const active = document.activeElement;
    if (current !== null && (active === null || active === document.body)) card.current?.focus({ preventScroll: true });
  }, [current]);

  const seenCount = seenKeys.size;
  const progress = (
    <span className="text-xs text-gray-500" data-testid="walk-seen">{seenCount} of {total} seen</span>
  );

  if (!place) {
    const firstNew = foundations.findIndex((step) => !seenKeys.has(step.key));
    const nextTopic = groups.find((group) => group.members.some((key) => !seenKeys.has(key))) ?? groups[0];
    const curious = selected ?? proposeNext(graph, null, seenKeys)?.key ?? foundations[0]?.key ?? null;
    const hint = WALK_ORDERS.find((entry) => entry.key === order)!.hint;
    return (
      // (Its own key: no button of the overview becomes a button of a step, keeping the focus)
      <div key="overview" ref={root} className="flex h-full flex-col" data-testid="idea-walk">
        <div className="border-b border-gray-100 px-6 py-4">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            {order === 'foundations' && (
              <button type="button" className={PRIMARY_BUTTON} onClick={startFoundations} data-testid="walk-start">
                {firstNew <= 0 ? 'Start from the foundations' : `Continue from the foundations (step ${firstNew + 1} of ${foundations.length})`}
              </button>
            )}
            {order === 'topics' && nextTopic && (
              <button type="button" className={PRIMARY_BUTTON} onClick={() => startTopic(nextTopic.key)} data-testid="walk-start">
                {seenCount === 0 ? 'Start with' : 'Go on with'} "{nextTopic.label}"
              </button>
            )}
            {order === 'goal' && (
              <button type="button" className={PRIMARY_BUTTON} disabled={goal === null} onClick={() => goal !== null && startGoal(goal)} data-testid="walk-start">
                {goal === null ? 'Pick a goal first' : `Walk back from "${name(goal)}"`}
              </button>
            )}
            {order === 'curiosity' && curious !== null && (
              <button type="button" className={PRIMARY_BUTTON} onClick={() => startCuriosity(curious)} data-testid="walk-start">
                Start at "{name(curious)}"
              </button>
            )}
            <label className="flex items-center gap-1.5 text-xs text-gray-500">
              Order
              <select
                className="rounded border border-gray-200 bg-white py-1 pl-1.5 pr-1 text-sm text-gray-600 hover:bg-gray-50"
                value={order}
                title={hint}
                data-testid="walk-order"
                onChange={(e) => setOrder(e.target.value as WalkOrder)}
              >
                {WALK_ORDERS.map((entry) => <option key={entry.key} value={entry.key} title={entry.hint}>{entry.label}</option>)}
              </select>
            </label>
            <span className="min-w-0 text-xs text-gray-500">{hint}</span>
            <span className="ml-auto flex items-center gap-3">
              {progress}
              <button type="button" className={BUTTON} disabled={seen.size === 0} onClick={() => setConfirming(true)} title="Forget which concepts were seen">Start over</button>
            </span>
          </div>
          {order === 'goal' && (
            <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 text-xs text-gray-500">
              <WalkGoalBox graph={graph} goal={goal} onGoal={setGoal} />
              {selected !== null && selected !== goal && (
                <button type="button" className={BUTTON} onClick={() => setGoal(selected)}>Use the selected concept ("{name(selected)}")</button>
              )}
              <label className="flex items-center gap-1.5">
                <input type="checkbox" checked={goalHelpful} onChange={(e) => setGoalHelpful(e.target.checked)} />
                Also what is helpful first
              </label>
            </div>
          )}
          {confirming && (
            <div className="max-w-md">
              <Confirm
                label="Start over"
                action="Start over"
                busy={false}
                error={null}
                onCancel={() => setConfirming(false)}
                onConfirm={() => {
                  clear();
                  setConfirming(false);
                }}
              >
                <p>Forget the {seenCount === 1 ? '1 concept' : `${seenCount} concepts`} you have seen in this set?</p>
                <p className="mt-1 text-xs text-gray-600">Only the ticks of the walk go. No concept is changed.</p>
              </Confirm>
            </div>
          )}
          <p className="mt-3 text-xs text-gray-400" data-testid="walk-note">
            {byTopic
              ? `${groups.length} topics, numbered in reading order: a topic comes after the ones it builds on (the small numbers say which). Point at a topic to see everything it is linked to; click it to walk through it.`
              : 'No concept has a topic yet, so these groups are found from the links (each named after its most required concept), numbered in reading order. Click a group to walk through it.'}
          </p>
        </div>
        <WalkOverview graph={graph} groups={groups} between={between} seenKeys={seenKeys} onTopic={startTopic} />
      </div>
    );
  }

  const own = node ? groupOfKey.get(node.key) : undefined;
  const step = onWalk ? steps[place.at] : undefined;
  const inGroup = (key: string) => {
    const group = groupOfKey.get(key);
    if (!group) return '';
    const mine = foundations.filter((other) => groupOfKey.get(other.key) === group);
    return ` (${mine.findIndex((other) => other.key === key) + 1} of ${mine.length})`;
  };
  const doneGroup = !node && place.kind === 'topic' ? groupByKey.get(place.group) : undefined;
  const where = !node ? (doneGroup ? `Topic done: ${doneGroup.label}` : 'The end of the walk')
    : !ordered ? `Following your curiosity${own ? ` · Topic: ${own.label}` : ''}`
    : !onWalk ? `A detour${own ? ` · Topic: ${own.label}` : ''} · the walk waits at step ${Math.min(place.at + 1, steps.length)} of ${steps.length}`
    : place.kind === 'foundations' ? `Step ${place.at + 1} of ${steps.length}${own ? ` · Topic: ${own.label}${inGroup(node.key)}` : ''}`
    : place.kind === 'topic' ? `Step ${place.at + 1} of ${steps.length}${own ? ` · Topic: ${own.label}` : ''}`
    : `Step ${place.at + 1} of ${steps.length} · To understand "${place.kind === 'goal' ? name(place.goal) : ''}"`;

  let note: ReactNode = null;
  if (node && step?.pulledFor !== undefined && own) {
    note = (
      <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800" data-testid="walk-pulled">
        A step ahead, from the later topic "{own.label}": "{name(step.pulledFor)}" needs it first.
      </p>
    );
  } else if (node && place.kind === 'goal' && onWalk && step?.parent) {
    note = (
      <p className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-600" data-testid="walk-needed">
        To understand "{name(step.parent)}" you need this{step.helpful ? ' (helpful first)' : ''}.
      </p>
    );
  }
  const path = node && place.kind === 'goal' && onWalk ? goalPath(steps, node.key) : [];

  // The card at the end of a walk
  let done: ReactNode = null;
  if (!node) {
    const group = place.kind === 'topic' ? groupByKey.get(place.group) : undefined;
    const left = group ? group.members.filter((key) => !seenKeys.has(key)).length : 0;
    const after = group ? groups.indexOf(group) : -1;
    const unfinished = (other: WalkGroup) => other !== group && other.members.some((key) => !seenKeys.has(key));
    const suggested = group ? groups.slice(after + 1).find(unfinished) ?? groups.find(unfinished) : undefined;
    const colours = suggested?.tone === undefined ? null : topicColours(suggested.tone);
    done = (
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto px-6 py-10">
        <div className="w-full max-w-md rounded-2xl border border-gray-200 bg-white px-7 py-6 text-center shadow-sm" data-testid="walk-done">
          <h2 className="text-xl font-semibold text-gray-900">
            {group ? 'Topic done' : place.kind === 'goal' ? 'That is all it needs' : place.kind === 'foundations' ? 'That was the last concept' : 'Nothing to show'}
          </h2>
          <p className="mt-2 text-sm text-gray-600">
            {group ? `You walked through "${group.label}": ${group.members.length === 1 ? 'its one concept' : `its ${group.members.length} concepts`}.${left > 0 ? ` ${left} of them you have not seen yet.` : ''}`
              : place.kind === 'goal' ? `"${name(place.goal)}" and the ${steps.length - 1 === 1 ? 'one concept' : `${Math.max(0, steps.length - 1)} concepts`} it builds on.`
              : place.kind === 'foundations' ? `You have seen ${seenCount} of ${total} concepts.`
              : 'This concept is no longer on the map.'}
          </p>
          {group && (
            <p className="mt-4 text-sm text-gray-600">
              {suggested ? 'Next in reading order:' : 'Every topic is done.'}
            </p>
          )}
          <div className="mt-3 flex flex-col items-center gap-2">
            {suggested && (
              <button
                type="button"
                className="rounded-lg border px-4 py-2 text-sm font-semibold hover:shadow"
                style={colours ? { background: colours.fill, borderColor: colours.edge, color: colours.text } : undefined}
                data-testid="walk-next-topic"
                autoFocus
                onClick={() => startTopic(suggested.key)}
              >
                {suggested.label} →
              </button>
            )}
            <button type="button" className={BUTTON} onClick={() => go(null)}>Back to the topics</button>
          </div>
        </div>
      </div>
    );
  }

  const shownTrail = trail.slice(-TRAIL_SHOWN);
  const firstShown = trail.length - shownTrail.length;
  return (
    <div key="walk" ref={root} className="flex h-full flex-col" data-testid="idea-walk">
      <div className="border-b border-gray-100 px-6 py-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <button type="button" className={BUTTON} onClick={() => go(null)} title="Back to the overview of the topics">← Topics</button>
          <span className="rounded bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600">{KIND_LABEL[place.kind]}</span>
          <span className="min-w-0 text-sm text-gray-700" data-testid="walk-where">{where}</span>
          <span className="ml-auto flex items-center gap-2">
            {progress}
            <button type="button" className={BUTTON} disabled={!canBack} onClick={back} title="Back (arrow left)" aria-keyshortcuts="ArrowLeft">← Back</button>
            <button type="button" className={PRIMARY_BUTTON} disabled={!canNext} onClick={next} title={ordered && !onWalk ? 'Back to the walk (arrow right)' : 'Next (arrow right)'} aria-keyshortcuts="ArrowRight" data-testid="walk-next">
              {ordered && !onWalk ? 'Back to the walk →' : 'Next →'}
            </button>
          </span>
        </div>
        <div className="mt-2 flex min-h-6 flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-gray-500">
          {path.length > 1 ? (
            <span className="flex flex-wrap items-center gap-x-1.5 gap-y-1" data-testid="walk-path" aria-label="The way from the goal">
              {path.map((key, index) => (
                <span key={key} className="flex items-center gap-1.5">
                  {index > 0 && <span className="text-gray-300" aria-hidden="true">←</span>}
                  {key === node?.key
                    ? <span className="font-semibold text-gray-800">{name(key)}</span>
                    : <button type="button" className="rounded px-1 py-0.5 text-blue-600 hover:bg-blue-50 hover:underline" onClick={() => jump(steps.findIndex((other) => other.key === key))}>{name(key)}</button>}
                </span>
              ))}
            </span>
          ) : (
            <nav className="flex flex-wrap items-center gap-x-1.5 gap-y-1" data-testid="walk-trail" aria-label="The last steps">
              {shownTrail.length > 0 && <span className="text-gray-400">Trail</span>}
              {firstShown > 0 && <span className="text-gray-300" aria-hidden="true">…</span>}
              {shownTrail.map((key, index) => (
                <span key={`${firstShown + index}:${key}`} className="flex items-center gap-1.5">
                  <button type="button" className="max-w-52 truncate rounded px-1 py-0.5 text-blue-600 hover:bg-blue-50 hover:underline" title={name(key)} onClick={() => rewind(firstShown + index)}>{name(key)}</button>
                  {(node || index < shownTrail.length - 1) && <span className="text-gray-300" aria-hidden="true">›</span>}
                </span>
              ))}
              {node && shownTrail.length > 0 && <span className="max-w-64 truncate font-semibold text-gray-800">{node.name}</span>}
            </nav>
          )}
          {proposal && (
            <span className="ml-auto min-w-0 text-right" data-testid="walk-proposal">
              Next: <span className="font-medium text-gray-700">{name(proposal.key)}</span> <span className="text-gray-400">({proposal.why})</span>
            </span>
          )}
          {place.kind === 'curiosity' && node && !proposal && <span className="ml-auto text-gray-400" data-testid="walk-proposal">Every concept is seen.</span>}
        </div>
      </div>
      {node ? (
        <WalkStep
          key={node.key}
          node={node}
          graph={graph}
          groupOf={(key) => groupOfKey.get(key)}
          seenKeys={seenKeys}
          marks={marks}
          selected={selected}
          chosen={chosen}
          card={card}
          note={note}
          onVisit={(key, keys) => {
            // While a form is open a click picks, as in every view; Ctrl, Cmd or Shift selects
            if (marks || keys.toggle) onPick(key, keys);
            else visit(key);
          }}
          onOpen={(keys) => onPick(node.key, keys)}
        />
      ) : done}
    </div>
  );
}
