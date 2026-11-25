import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FocusEvent as ReactFocusEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { flushSync } from 'react-dom';
import { wrappedLines, type MapEdge, type MapSizes } from '../../lib/idea-map-layout';
import { GROUPED_LAYOUTS, hasTopics, layoutFor, topicKey, topicsOf } from '../../lib/idea-map-layouts';
import { chainOf, impliedLinks, inChain, shownLinks } from '../../lib/idea-map-links';
import { ChosenTick } from './ChosenTick';
import { MapBundles, MapFrames, MapLayoutSwitch } from './MapLayoutSwitch';
import { arrowFocus } from './ideaKeys';
import { BUTTON, CHOSEN_LOOK, PRIORITY_LABEL, PRIORITY_LOOK, UNWRITTEN_LOOK, ideaLook, ideaTitle, pickByEnter, pickKeys, pickWord, topicColours, type IdeaViewProps } from './ideaLook';
import { clampZoom, wholeView, type MapView as View } from './mapView';
import { useMapLayoutChoice } from './useMapLayoutChoice';

// Every box is as wide as the others and as tall as its name needs: a long
// name wraps onto more lines. Columns stand close enough that 150 ideas
// (about ten columns) stay readable on one screen width or two.
const NODE_W = 176;
/** The least height of a box: a name of two lines. */
const NODE_H = 36;
const LINE_H = 14;
const SIZES: MapSizes = { nodeWidth: NODE_W, gapX: 40, gapY: 12, margin: 16 };
/** The zoom below which names are too small to read. */
const READABLE_ZOOM = 0.75;
/** About how many letters fit on a line of a box, until the box is measured. */
const LETTERS_PER_LINE = 24;

/** The height a box is given before it is measured. */
const guessedHeight = (name: string) => Math.max(NODE_H, wrappedLines(name, LETTERS_PER_LINE) * LINE_H + 10);

/** The room a box that took the focus keeps to the edge of the frame. */
const FOCUS_EDGE = 24;

/** The focus came by the keyboard, not by a press of the pointer. */
function focusByKeys(el: Element): boolean {
  try {
    return el.matches(':focus-visible');
  } catch {
    return false;
  }
}


function Legend({ topics }: { topics: boolean }) {
  const swatch = 'inline-block h-3 w-5 rounded-sm border';
  return (
    <div className="absolute bottom-3 left-3 flex max-w-[calc(100%-1.5rem)] flex-wrap items-center gap-x-3 gap-y-1 rounded border border-gray-200 bg-white/90 px-2.5 py-1.5 text-xs text-gray-600" data-testid="idea-map-legend">
      <span className="text-gray-400">Priority</span>
      {(['high', 'medium', 'low'] as const).map((priority) => (
        <span key={priority} className="flex items-center gap-1">
          <span className={`${swatch} ${PRIORITY_LOOK[priority]}`} />
          {PRIORITY_LABEL[priority]}
        </span>
      ))}
      <span className="flex items-center gap-1">
        <span className={`${swatch} ${UNWRITTEN_LOOK}`} />
        Not written yet
      </span>
      <span className="flex items-center gap-1">
        <svg width="22" height="8" aria-hidden="true"><line x1="0" y1="4" x2="22" y2="4" className="stroke-gray-500" strokeWidth="1.5" /></svg>
        Requires
      </span>
      <span className="flex items-center gap-1">
        <svg width="22" height="8" aria-hidden="true"><line x1="0" y1="4" x2="22" y2="4" className="stroke-gray-500" strokeWidth="1.5" strokeDasharray="4 3" /></svg>
        Helpful first
      </span>
      {topics && (
        <span className="flex items-center gap-1" title="The colour on the left edge of a box is its topic, the same colour in every layout">
          <span className={`${swatch} relative overflow-hidden border-gray-300 bg-white`}><span className="absolute inset-y-0 left-0 w-1" style={{ background: topicColours(0).mark }} /></span>
          Topic
        </span>
      )}
    </div>
  );
}

/** `view` with the map in the middle of the frame along each side it fits in. */
function centred(view: View, el: HTMLElement, width: number, height: number): View {
  const x = width * view.k <= el.clientWidth ? (el.clientWidth - width * view.k) / 2 : view.x;
  const y = height * view.k <= el.clientHeight ? (el.clientHeight - height * view.k) / 2 : view.y;
  return x === view.x && y === view.y ? view : { ...view, x, y };
}

/**
 * The drawn map: ideas in columns from left (what comes first) to right, a
 * solid arrow for "requires" and a dashed one for "helpful first". Drag to
 * move, wheel or the buttons to zoom. The arrow keys move the focus from idea
 * to idea; the map follows it.
 */
export function IdeaMapDrawing({ graph, selected, chosen, marks, matches, onPick }: IdeaViewProps) {
  const edges = useMemo<MapEdge[]>(() => graph.nodes.flatMap((node) => [
    ...node.requires.map((from) => ({ from, to: node.key, helpful: false })),
    ...node.helpful.map((from) => ({ from, to: node.key, helpful: true })),
  ]), [graph]);
  /** The heights the boxes really have (by key), once they are drawn. */
  const [measured, setMeasured] = useState<ReadonlyMap<string, number>>(new Map());
  const [choice, setChoice] = useMapLayoutChoice(graph);
  // "Around one concept" is drawn around the one selected last
  const [focus, setFocus] = useState(selected);
  if (selected !== null && selected !== focus) setFocus(selected);
  const around = choice.layout === 'focus' ? focus : null;
  /** The links that are drawn. */
  const shown = useMemo(() => shownLinks(edges, choice), [edges, choice]);
  const heightOf = useCallback((key: string) => measured.get(key) ?? guessedHeight(graph.byKey.get(key)?.name ?? ''), [measured, graph]);
  const drawn = useMemo(
    () => layoutFor(choice, { graph, edges, heightOf, sizes: SIZES, focus: around }),
    [edges, heightOf, graph, choice, around],
  );
  const { boxes, lines, frames, bundles, width, height } = drawn;
  const placed = useMemo(() => boxes.map((box) => ({ ...box, node: graph.byKey.get(box.key)! })), [boxes, graph]);
  const frame = useRef<HTMLDivElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>({ x: 0, y: 0, k: 1 });

  // A box is as tall as its name makes it. The browser tells the heights
  // once the boxes are drawn, and again when one changes (a font arrives, a
  // name is edited); the map is laid out again with them before it paints.
  useEffect(() => {
    const el = layer.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      const next = new Map<string, number>();
      for (const box of el.querySelectorAll<HTMLElement>('[data-key]')) {
        // 0: not laid out (the page is hidden): the guess stays
        if (box.offsetHeight > 0) next.set(box.dataset.key!, box.offsetHeight);
      }
      flushSync(() => setMeasured((now) => (
        next.size === now.size && [...next].every(([key, tall]) => now.get(key) === tall) ? now : next
      )));
    });
    for (const box of el.querySelectorAll('[data-key]')) observer.observe(box);
    return () => observer.disconnect();
  }, [graph]);

  /**
   * The map is shown whole, as "Fit" left it. It then stays whole when the
   * frame changes size (the side panel opens or closes) or the map does (a
   * concept is added). Moving or zooming it by hand ends that.
   */
  const shownWhole = useRef(false);
  const fit = useCallback(() => {
    const el = frame.current;
    if (!el || !width || !el.clientWidth) return;
    const all = wholeView(el.clientWidth, el.clientHeight, width, height);
    shownWhole.current = all.whole;
    setView((v) => (v.k === all.view.k && v.x === all.view.x && v.y === all.view.y ? v : all.view));
  }, [width, height]);

  // When it opens: the whole map if its names stay readable at that size,
  // else its left end (where to start) at a readable size. Later changes
  // keep where you are.
  const opened = useRef(false);
  useLayoutEffect(() => {
    const el = frame.current;
    if (opened.current || !el || !width || !el.clientWidth) return;
    opened.current = true;
    if (wholeView(el.clientWidth, el.clientHeight, width, height).view.k >= READABLE_ZOOM) fit();
    else setView({ k: READABLE_ZOOM, x: 0, y: (el.clientHeight - height * READABLE_ZOOM) / 2 });
  }, [fit, width, height]);

  // Drawn another way, the map is somewhere else: show all of it
  const drawnAs = `${choice.layout} ${GROUPED_LAYOUTS.includes(choice.layout) ? choice.groupBy : ''} ${around}`;
  const fitted = useRef(drawnAs);
  useLayoutEffect(() => {
    if (fitted.current === drawnAs) return;
    fitted.current = drawnAs;
    fit();
  }, [drawnAs, fit]);

  const zoomAt = useCallback((cx: number, cy: number, factor: number) => {
    shownWhole.current = false;
    setView((v) => {
      const k = clampZoom(v.k * factor);
      const ratio = k / v.k;
      return { k, x: cx - (cx - v.x) * ratio, y: cy - (cy - v.y) * ratio };
    });
  }, []);
  const zoomButton = (factor: number) => {
    const el = frame.current;
    if (el) zoomAt(el.clientWidth / 2, el.clientHeight / 2, factor);
  };

  // React's wheel listener is passive: the page would scroll under the map.
  useEffect(() => {
    const el = frame.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      // A pinch on a trackpad arrives as ctrl+wheel with small steps
      zoomAt(e.clientX - rect.left, e.clientY - rect.top, Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [zoomAt]);

  // The selected idea comes into view when it is outside it (picked in the
  // table, just created, or covered by the side panel that opened).
  const placedRef = useRef(placed);
  useEffect(() => { placedRef.current = placed; }, [placed]);
  const placedSelected = selected !== null && placed.some((p) => p.node.key === selected);
  useEffect(() => {
    const el = frame.current;
    const at = placedRef.current.find((p) => p.node.key === selected);
    if (!el || !at || !el.clientWidth) return;
    // Shown whole it is in view; in a frame that just changed size it is again once the map is fitted to it
    if (shownWhole.current) return;
    setView((v) => {
      const left = at.x * v.k + v.x;
      const top = at.y * v.k + v.y;
      const inside = left >= 0 && top >= 0 && left + NODE_W * v.k <= el.clientWidth && top + at.height * v.k <= el.clientHeight;
      if (inside) return v;
      return centred(
        { ...v, x: el.clientWidth / 2 - (at.x + NODE_W / 2) * v.k, y: el.clientHeight / 2 - (at.y + at.height / 2) * v.k },
        el, width, height,
      );
    });
  }, [selected, placedSelected, width, height]);

  // The frame changes size when the side panel opens or closes: a map that
  // was shown whole is fitted into the new frame, so no part of it ends up
  // under the edge; one that was moved or zoomed stays where it is (in the
  // middle along a side it fits in).
  useEffect(() => {
    const el = frame.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (!opened.current || !el.clientWidth) return;
      if (shownWhole.current) fit();
      else setView((v) => centred(v, el, width, height));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [fit, width, height]);

  // The map itself changed size (a concept was added, a name got longer)
  // while it was shown whole: it still is
  useLayoutEffect(() => {
    if (opened.current && shownWhole.current) fit();
  }, [fit]);

  // Dragging moves the map; a press that did not move is a click.
  const drag = useRef<{ id: number; x: number; y: number; viewX: number; viewY: number; moved: boolean } | null>(null);
  const swallowClick = useRef(false);
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    swallowClick.current = false;
    if (e.button !== 0 || (e.target as Element).closest('[data-map-control]')) return;
    drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, viewX: view.x, viewY: view.y, moved: false };
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.moved) {
      if (Math.hypot(dx, dy) < 4) return;
      d.moved = true;
      shownWhole.current = false;
      e.currentTarget.setPointerCapture(e.pointerId);
    }
    setView((v) => ({ ...v, x: d.viewX + dx, y: d.viewY + dy }));
  };
  const onPointerEnd = () => {
    swallowClick.current = drag.current?.moved ?? false;
    drag.current = null;
  };

  // A box that takes the focus by the keyboard (arrow keys, Tab) outside the
  // frame, or half under its edge, comes into view. A click moves nothing
  // under the pointer.
  const followFocus = (e: ReactFocusEvent<HTMLDivElement>) => {
    const box = e.target.closest<HTMLElement>('[data-key]');
    if (!box || !focusByKeys(box)) return;
    const inside = e.currentTarget.getBoundingClientRect();
    // Not laid out: nowhere to bring it
    if (!inside.width || !inside.height) return;
    const at = box.getBoundingClientRect();
    const dx = at.left < inside.left + FOCUS_EDGE ? inside.left + FOCUS_EDGE - at.left
      : at.right > inside.right - FOCUS_EDGE ? inside.right - FOCUS_EDGE - at.right : 0;
    const dy = at.top < inside.top + FOCUS_EDGE ? inside.top + FOCUS_EDGE - at.top
      : at.bottom > inside.bottom - FOCUS_EDGE ? inside.bottom - FOCUS_EDGE - at.bottom : 0;
    if (!dx && !dy) return;
    shownWhole.current = false;
    setView((v) => ({ ...v, x: v.x + dx, y: v.y + dy }));
  };

  /** Key of the idea under the pointer. */
  const [hovered, setHovered] = useState<string | null>(null);
  // How many links a chain of Requires says already
  const implied = useMemo(() => impliedLinks(choice.links === 'requires' ? edges.filter((edge) => !edge.helpful) : edges).size, [edges, choice.links]);
  // The concept whose chain stands out: the one pointed at, else the selected
  // one (drawn around the selected one, the map is its chain already)
  const lit = hovered ?? (around === null ? selected : null);
  const chain = useMemo(() => (lit !== null && graph.byKey.has(lit) ? chainOf(lit, shown) : null), [graph, lit, shown]);
  const inLitChain = (key: string) => key === lit || chain!.before.has(key) || chain!.after.has(key);
  const dimmed = (key: string) => (matches ? !matches.has(key) : chain ? !inLitChain(key) : false);
  const tones = useMemo(() => {
    const toneOf = new Map(topicsOf(graph).map((topic) => [topic.key, topic.tone]));
    return new Map(graph.nodes.flatMap((node) => (toneOf.has(topicKey(node)) ? [[node.key, toneOf.get(topicKey(node))!] as const] : [])));
  }, [graph]);

  return (
    <div
      ref={frame}
      className="relative h-full w-full cursor-grab touch-none select-none overflow-hidden bg-gray-50 active:cursor-grabbing"
      data-testid="idea-map"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      onKeyDown={arrowFocus}
      onFocus={followFocus}
      onScroll={(e) => {
        // The browser scrolls the frame under a box that takes the focus
        // beyond its right or lower edge: the map moves by that much instead
        const el = e.currentTarget;
        const { scrollLeft, scrollTop } = el;
        if (!scrollLeft && !scrollTop) return;
        el.scrollLeft = 0;
        el.scrollTop = 0;
        shownWhole.current = false;
        setView((v) => ({ ...v, x: v.x - scrollLeft, y: v.y - scrollTop }));
      }}
      onClickCapture={(e) => {
        if (!swallowClick.current) return;
        swallowClick.current = false;
        e.stopPropagation();
      }}
    >
      <div
        ref={layer}
        className="absolute left-0 top-0 origin-top-left"
        style={{ width, height, transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}
      >
        <MapFrames frames={frames} zoom={view.k} />
        {bundles && <MapBundles bundles={bundles} width={width} height={height} zoom={view.k} faint={chain !== null || matches !== null} />}
        <svg className="absolute inset-0 overflow-visible" width={width} height={height} aria-hidden="true">
          <defs>
            <marker id="idea-map-arrow" viewBox="0 0 6 6" refX="5" refY="3" markerWidth="6" markerHeight="6" orient="auto">
              <path d="M0,0 L6,3 L0,6 z" className="fill-gray-400" />
            </marker>
            <marker id="idea-map-arrow-near" viewBox="0 0 6 6" refX="5" refY="3" markerWidth="6" markerHeight="6" orient="auto">
              <path d="M0,0 L6,3 L0,6 z" className="fill-indigo-500" />
            </marker>
            <marker id="idea-map-arrow-far" viewBox="0 0 6 6" refX="5" refY="3" markerWidth="6" markerHeight="6" orient="auto">
              <path d="M0,0 L6,3 L0,6 z" className="fill-indigo-300" />
            </marker>
          </defs>
          {lines.map((line) => {
            // Its two ends, and the rest of the chain of the concept that is pointed at or selected
            const touches = !matches && lit !== null && (line.from === lit || line.to === lit);
            const onChain = touches || (!matches && chain !== null && inChain(line, lit!, chain));
            const faint = matches ? !(matches.has(line.from) && matches.has(line.to)) : chain !== null && !onChain;
            if (line.quiet && !onChain) return null;
            return (
              <path
                key={`${line.from}>${line.to}>${line.helpful}`}
                d={line.d}
                data-edge={line.helpful ? 'helpful' : 'requires'}
                data-chain={onChain ? (touches ? 'near' : 'far') : undefined}
                className={`fill-none ${touches ? 'stroke-indigo-500' : onChain ? 'stroke-indigo-300' : 'stroke-gray-400'} ${faint ? 'opacity-15' : line.helpful && !onChain ? 'opacity-60' : ''}`}
                strokeWidth={touches ? 1.75 : onChain ? 1.5 : 1.25}
                strokeDasharray={line.helpful ? '5 4' : undefined}
                markerEnd={`url(#idea-map-arrow${touches ? '-near' : onChain ? '-far' : ''})`}
              />
            );
          })}
        </svg>
        {placed.map(({ node, x, y }) => {
          const word = pickWord(marks, node.key);
          const ring = word ? 'ring-2 ring-indigo-500' : node.key === selected ? 'ring-2 ring-blue-600' : '';
          const inSet = chosen.has(node.key);
          const tone = tones.get(node.key);
          return (
            <button
              key={node.key}
              type="button"
              data-idea={node.name}
              data-key={node.key}
              data-written={node.written}
              data-chosen={inSet || undefined}
              aria-pressed={marks ? word !== null : inSet || node.key === selected}
              title={ideaTitle(node)}
              onClick={(e) => onPick(node.key, pickKeys(e))}
              onKeyDown={(e) => pickByEnter(e, (keys) => onPick(node.key, keys))}
              onPointerEnter={() => setHovered(node.key)}
              onPointerLeave={() => setHovered(null)}
              className={`absolute flex items-center rounded border px-2 py-1 text-left text-xs leading-[14px] transition-opacity hover:brightness-95 ${ideaLook(node)} ${ring} ${inSet ? CHOSEN_LOOK : ''} ${dimmed(node.key) && !inSet ? 'opacity-30' : ''}`}
              // As tall as the name needs; the layout is made with the height it then has
              style={{ left: x, top: y, width: NODE_W, minHeight: NODE_H }}
            >
              {tone !== undefined && <span className="absolute inset-y-0 left-0 w-[3px] rounded-l" style={{ background: topicColours(tone).mark }} data-topic-mark />}
              <span className="min-w-0 flex-1 break-words">{node.name}</span>
              {word && (
                <span className="absolute -top-2 right-1 rounded bg-indigo-600 px-1 py-px text-[9px] font-medium leading-none text-white">{word}</span>
              )}
              {inSet && <ChosenTick className="absolute -left-2 -top-2" />}
            </button>
          );
        })}
      </div>
      <Legend topics={tones.size > 0} />
      <div className="absolute right-3 top-3 flex max-w-[calc(100%-1.5rem)] flex-wrap items-center justify-end gap-1" data-map-control>
        <MapLayoutSwitch choice={choice} topics={hasTopics(graph)} implied={implied} onChoose={setChoice} />
        <button type="button" className={`${BUTTON} bg-white`} onClick={() => zoomButton(1 / 1.3)} aria-label="Zoom out" title="Zoom out">−</button>
        <button type="button" className={`${BUTTON} bg-white`} onClick={() => zoomButton(1.3)} aria-label="Zoom in" title="Zoom in">+</button>
        <button type="button" className={`${BUTTON} bg-white`} onClick={fit} title="Show the whole map">Fit</button>
      </div>
    </div>
  );
}
