import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { mapColumns, type IdeaGraph, type IdeaNode } from '../../lib/idea-map';
import { BUTTON, PRIORITY_LABEL, PRIORITY_LOOK, UNWRITTEN_LOOK, ideaLook, ideaTitle, pickWord, type PickMarks } from './ideaLook';

// A box holds a name on two lines; columns stand close enough that 150
// ideas (about ten columns of twenty) stay readable on one screen width or two.
const NODE_W = 156;
const NODE_H = 36;
const GAP_X = 56;
const GAP_Y = 8;
const MARGIN = 16;
const ROW = NODE_H + GAP_Y;
const MIN_ZOOM = 0.15;
const MAX_ZOOM = 2;
/** The zoom below which names are too small to read. */
const READABLE_ZOOM = 0.75;

interface Placed { node: IdeaNode; x: number; y: number }
interface Line { from: string; to: string; helpful: boolean; d: string }

/** A curve that leaves and arrives level. */
const bend = (x1: number, y1: number, x2: number, y2: number) => {
  const reach = (x2 - x1) / 2;
  return ` C${x1 + reach},${y1} ${x2 - reach},${y2} ${x2},${y2}`;
};

/**
 * Where every idea and line goes: columns from lib/idea-map (what comes
 * first on the left), each centred on the tallest. A line between
 * neighbouring columns is one curve; a longer one passes the columns between
 * through the nearest gap between two boxes, never behind a box.
 */
function layout(graph: IdeaGraph) {
  const columns = mapColumns(graph);
  const tallest = Math.max(0, ...columns.map((keys) => keys.length));
  const top = (count: number) => MARGIN + ((tallest - count) * ROW) / 2;
  const left = (column: number) => MARGIN + column * (NODE_W + GAP_X);
  const at = new Map<string, { column: number; x: number; y: number }>();
  const placed: Placed[] = [];
  columns.forEach((keys, column) => keys.forEach((key, row) => {
    const spot = { column, x: left(column), y: top(keys.length) + row * ROW };
    at.set(key, spot);
    placed.push({ node: graph.byKey.get(key)!, ...spot });
  }));

  /** The gap of `column` nearest to height `y`: between two boxes, or free space above or below them. */
  const gapNear = (column: number, y: number) => {
    const first = top(columns[column].length) - GAP_Y / 2;
    const last = first + columns[column].length * ROW;
    if (y <= first || y >= last) return y;
    return first + Math.round((y - first) / ROW) * ROW;
  };

  const line = (from: string, to: string): string => {
    const a = at.get(from)!;
    const b = at.get(to)!;
    const ay = a.y + NODE_H / 2;
    const by = b.y + NODE_H / 2;
    const right = a.x + NODE_W;
    if (a.column >= b.column) {
      // Only inside a circle of requirements: round the right-hand side
      const out = right + GAP_X / 2;
      return from === to
        ? `M${right},${ay - 6} C${out},${ay - 14} ${out},${ay + 14} ${right},${ay + 6}`
        : `M${right},${ay} C${out},${ay} ${out},${by} ${b.x + NODE_W},${by}`;
    }
    let d = `M${right},${ay}`;
    let x = right;
    let y = ay;
    for (let column = a.column + 1; column < b.column; column++) {
      const passX = left(column);
      const passY = gapNear(column, ay + ((by - ay) * (passX + NODE_W / 2 - right)) / (b.x - right));
      d += `${bend(x, y, passX, passY)} L${passX + NODE_W},${passY}`;
      x = passX + NODE_W;
      y = passY;
    }
    return d + bend(x, y, b.x, by);
  };

  const lines: Line[] = [];
  for (const node of graph.nodes) {
    for (const from of node.requires) lines.push({ from, to: node.key, helpful: false, d: line(from, node.key) });
    for (const from of node.helpful) lines.push({ from, to: node.key, helpful: true, d: line(from, node.key) });
  }
  return {
    placed,
    lines,
    width: columns.length === 0 ? 0 : left(columns.length - 1) + NODE_W + MARGIN,
    height: tallest * ROW - GAP_Y + 2 * MARGIN,
  };
}

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
export function IdeaMapDrawing({ graph, selected, marks, matches, onPick }: {
  graph: IdeaGraph;
  /** Key of the selected idea: it and what it touches stand out. */
  selected: string | null;
  /** Set while a form is open: clicks pick requirements. */
  marks: PickMarks | null;
  /** Ideas the find box matches, or null when it is empty. */
  matches: ReadonlySet<string> | null;
  onPick: (key: string, shift: boolean) => void;
}) {
  const { placed, lines, width, height } = useMemo(() => layout(graph), [graph]);
  const frame = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>({ x: 0, y: 0, k: 1 });

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
      const inside = left >= 0 && top >= 0 && left + NODE_W * v.k <= el.clientWidth && top + NODE_H * v.k <= el.clientHeight;
      if (inside) return v;
      return centred(
        { ...v, x: el.clientWidth / 2 - (at.x + NODE_W / 2) * v.k, y: el.clientHeight / 2 - (at.y + NODE_H / 2) * v.k },
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
    const node = selected ? graph.byKey.get(selected) : undefined;
    return node ? new Set([node.key, ...node.requires, ...node.helpful, ...node.neededFor, ...node.helpfulFor]) : null;
  }, [graph, selected]);
  const dimmed = (key: string) => (matches ? !matches.has(key) : near ? !near.has(key) : false);

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
        className="absolute left-0 top-0 origin-top-left"
        style={{ width, height, transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}
      >
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
            const touches = selected !== null && !matches && (line.from === selected || line.to === selected);
            const faint = matches ? !(matches.has(line.from) && matches.has(line.to)) : near !== null && !touches;
            return (
              <path
                key={`${line.from}>${line.to}>${line.helpful}`}
                d={line.d}
                data-edge={line.helpful ? 'helpful' : 'requires'}
                className={`fill-none ${touches ? 'stroke-indigo-500' : 'stroke-gray-400'} ${faint ? 'opacity-20' : ''}`}
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
          return (
            <button
              key={node.key}
              type="button"
              data-idea={node.name}
              data-written={node.written}
              aria-pressed={marks ? word !== null : node.key === selected}
              title={ideaTitle(node)}
              onClick={(e) => onPick(node.key, e.shiftKey)}
              className={`absolute flex items-center rounded border px-2 text-left text-xs leading-[14px] hover:brightness-95 ${ideaLook(node)} ${ring} ${dimmed(node.key) ? 'opacity-30' : ''}`}
              style={{ left: x, top: y, width: NODE_W, height: NODE_H }}
            >
              <span className="line-clamp-2 min-w-0 flex-1 break-words">{node.name}</span>
              {word && (
                <span className="absolute -top-2 right-1 rounded bg-indigo-600 px-1 py-px text-[9px] font-medium leading-none text-white">{word}</span>
              )}
            </button>
          );
        })}
      </div>
      <Legend />
      <div className="absolute right-3 top-3 flex items-center gap-1" data-map-control>
        <button type="button" className={`${BUTTON} bg-white`} onClick={() => zoomButton(1 / 1.3)} aria-label="Zoom out" title="Zoom out">−</button>
        <button type="button" className={`${BUTTON} bg-white`} onClick={() => zoomButton(1.3)} aria-label="Zoom in" title="Zoom in">+</button>
        <button type="button" className={`${BUTTON} bg-white`} onClick={fit} title="Show the whole map">Fit</button>
      </div>
    </div>
  );
}
