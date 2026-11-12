import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { flushSync } from 'react-dom';
import { wrappedLines, type MapEdge, type MapSizes } from '../../lib/idea-map-layout';
import { layoutFor } from '../../lib/idea-map-layouts';
import { ChosenTick } from './ChosenTick';
import { MapFrames, MapLayoutSwitch } from './MapLayoutSwitch';
import { useMapLayoutChoice } from './useMapLayoutChoice';
import { BUTTON, CHOSEN_LOOK, PRIORITY_LABEL, PRIORITY_LOOK, UNWRITTEN_LOOK, ideaLook, ideaTitle, pickKeys, pickWord, type IdeaViewProps } from './ideaLook';

// Every box is as wide as the others and as tall as its name needs: a long
// name wraps onto more lines. Columns stand close enough that 150 ideas
// (about ten columns) stay readable on one screen width or two.
const NODE_W = 176;
/** The least height of a box: a name of two lines. */
const NODE_H = 36;
const LINE_H = 14;
const SIZES: MapSizes = { nodeWidth: NODE_W, gapX: 40, gapY: 12, margin: 16 };
const MIN_ZOOM = 0.15;
const MAX_ZOOM = 2;
/** The zoom below which names are too small to read. */
const READABLE_ZOOM = 0.75;
/** About how many letters fit on a line of a box, until the box is measured. */
const LETTERS_PER_LINE = 24;

/** The height a box is given before it is measured. */
const guessedHeight = (name: string) => Math.max(NODE_H, wrappedLines(name, LETTERS_PER_LINE) * LINE_H + 10);

interface View { x: number; y: number; k: number }
const clampZoom = (k: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, k));

function Legend() {
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
 * move, wheel or the buttons to zoom.
 */
export function IdeaMapDrawing({ graph, selected, chosen, marks, matches, onPick }: IdeaViewProps) {
  const edges = useMemo<MapEdge[]>(() => graph.nodes.flatMap((node) => [
    ...node.requires.map((from) => ({ from, to: node.key, helpful: false })),
    ...node.helpful.map((from) => ({ from, to: node.key, helpful: true })),
  ]), [graph]);
  /** The heights the boxes really have (by key), once they are drawn. */
  const [measured, setMeasured] = useState<ReadonlyMap<string, number>>(new Map());
  const [choice, setChoice] = useMapLayoutChoice();
  // "Around one concept" is drawn around the one selected last
  const [focus, setFocus] = useState(selected);
  if (selected !== null && selected !== focus) setFocus(selected);
  const around = choice.layout === 'focus' ? focus : null;
  const { boxes, lines, frames, width, height } = useMemo(
    () => layoutFor(choice, { graph, edges, heightOf: (key) => measured.get(key) ?? guessedHeight(graph.byKey.get(key)?.name ?? ''), sizes: SIZES, focus: around }),
    [edges, measured, graph, choice, around],
  );
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

  const fit = useCallback(() => {
    const el = frame.current;
    if (!el || !width || !el.clientWidth) return;
    const k = clampZoom(Math.min(el.clientWidth / width, el.clientHeight / height, 1));
    setView({ k, x: (el.clientWidth - width * k) / 2, y: (el.clientHeight - height * k) / 2 });
  }, [width, height]);

  // When it opens: the whole map if its names stay readable at that size,
  // else its left end (where to start) at a readable size. Later changes
  // keep where you are.
  const opened = useRef(false);
  useLayoutEffect(() => {
    const el = frame.current;
    if (opened.current || !el || !width || !el.clientWidth) return;
    opened.current = true;
    const whole = Math.min(el.clientWidth / width, el.clientHeight / height, 1);
    if (whole >= READABLE_ZOOM) fit();
    else setView({ k: READABLE_ZOOM, x: 0, y: (el.clientHeight - height * READABLE_ZOOM) / 2 });
  }, [fit, width, height]);

  // Drawn another way, the map is somewhere else: show all of it
  const drawnAs = `${choice.layout} ${choice.groupBy} ${around}`;
  const fitted = useRef(drawnAs);
  useLayoutEffect(() => {
    if (fitted.current === drawnAs) return;
    fitted.current = drawnAs;
    fit();
  }, [drawnAs, fit]);

  const zoomAt = useCallback((cx: number, cy: number, factor: number) => {
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
  // fits stays whole in the middle instead of half under the edge.
  useEffect(() => {
    const el = frame.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (opened.current && el.clientWidth) setView((v) => centred(v, el, width, height));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [width, height]);

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
      e.currentTarget.setPointerCapture(e.pointerId);
    }
    setView((v) => ({ ...v, x: d.viewX + dx, y: d.viewY + dy }));
  };
  const onPointerEnd = () => {
    swallowClick.current = drag.current?.moved ?? false;
    drag.current = null;
  };

  const near = useMemo(() => {
    // Drawn around the selected one, the map is its neighbourhood already: nothing is dimmed
    const node = selected && around === null ? graph.byKey.get(selected) : undefined;
    return node ? new Set([node.key, ...node.requires, ...node.helpful, ...node.neededFor, ...node.helpfulFor]) : null;
  }, [graph, selected, around]);
  const dimmed = (key: string) => (matches ? !matches.has(key) : near ? !near.has(key) : false);
  /** Key of the idea under the pointer: its lines stand out, so each can be followed in a full map. */
  const [hovered, setHovered] = useState<string | null>(null);

  return (
    <div
      ref={frame}
      className="relative h-full w-full cursor-grab touch-none select-none overflow-hidden bg-gray-50 active:cursor-grabbing"
      data-testid="idea-map"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
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
        <svg className="absolute inset-0 overflow-visible" width={width} height={height} aria-hidden="true">
          <defs>
            <marker id="idea-map-arrow" viewBox="0 0 6 6" refX="5" refY="3" markerWidth="6" markerHeight="6" orient="auto">
              <path d="M0,0 L6,3 L0,6 z" className="fill-gray-400" />
            </marker>
            <marker id="idea-map-arrow-near" viewBox="0 0 6 6" refX="5" refY="3" markerWidth="6" markerHeight="6" orient="auto">
              <path d="M0,0 L6,3 L0,6 z" className="fill-indigo-500" />
            </marker>
          </defs>
          {lines.map((line) => {
            const touches = !matches && [selected, hovered].some((key) => key !== null && (line.from === key || line.to === key));
            const faint = matches ? !(matches.has(line.from) && matches.has(line.to)) : (near !== null || hovered !== null) && !touches;
            if (line.quiet && !touches) return null;
            return (
              <path
                key={`${line.from}>${line.to}>${line.helpful}`}
                d={line.d}
                data-edge={line.helpful ? 'helpful' : 'requires'}
                className={`fill-none ${touches ? 'stroke-indigo-500' : 'stroke-gray-400'} ${faint ? 'opacity-20' : line.helpful && !touches ? 'opacity-60' : ''}`}
                strokeWidth={touches ? 1.75 : 1.25}
                strokeDasharray={line.helpful ? '5 4' : undefined}
                markerEnd={`url(#idea-map-arrow${touches ? '-near' : ''})`}
              />
            );
          })}
        </svg>
        {placed.map(({ node, x, y }) => {
          const word = pickWord(marks, node.key);
          const ring = word ? 'ring-2 ring-indigo-500' : node.key === selected ? 'ring-2 ring-blue-600' : '';
          const inSet = chosen.has(node.key);
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
              onPointerEnter={() => setHovered(node.key)}
              onPointerLeave={() => setHovered(null)}
              className={`absolute flex items-center rounded border px-2 py-1 text-left text-xs leading-[14px] hover:brightness-95 ${ideaLook(node)} ${ring} ${inSet ? CHOSEN_LOOK : ''} ${dimmed(node.key) && !inSet ? 'opacity-30' : ''}`}
              // As tall as the name needs; the layout is made with the height it then has
              style={{ left: x, top: y, width: NODE_W, minHeight: NODE_H }}
            >
              <span className="min-w-0 flex-1 break-words">{node.name}</span>
              {word && (
                <span className="absolute -top-2 right-1 rounded bg-indigo-600 px-1 py-px text-[9px] font-medium leading-none text-white">{word}</span>
              )}
              {inSet && <ChosenTick className="absolute -left-2 -top-2" />}
            </button>
          );
        })}
      </div>
      <Legend />
      <div className="absolute right-3 top-3 flex items-center gap-1" data-map-control>
        <MapLayoutSwitch choice={choice} onChoose={setChoice} />
        <button type="button" className={`${BUTTON} bg-white`} onClick={() => zoomButton(1 / 1.3)} aria-label="Zoom out" title="Zoom out">−</button>
        <button type="button" className={`${BUTTON} bg-white`} onClick={() => zoomButton(1.3)} aria-label="Zoom in" title="Zoom in">+</button>
        <button type="button" className={`${BUTTON} bg-white`} onClick={fit} title="Show the whole map">Fit</button>
      </div>
    </div>
  );
}
