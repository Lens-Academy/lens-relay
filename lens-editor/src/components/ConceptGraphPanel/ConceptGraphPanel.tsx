import { useMemo, useState } from 'react';
import type * as Y from 'yjs';
import dagre from '@dagrejs/dagre';
import { countBelow, graphData, isConceptPath, MAX_ANCESTORS, type GraphEdge, type GraphNode } from '../../lib/concept-graph';
import { docUuidFromCompoundId } from '../../lib/url-utils';
import { DocLink } from '../DocLink';
import { useConceptGraph, type ConceptGraph } from './useConceptGraph';

const OPEN_KEY = 'lens-editor:concept-graph-open';

function readOpen(): boolean {
  try {
    return localStorage.getItem(OPEN_KEY) !== 'false';
  } catch {
    return true;
  }
}

function writeOpen(open: boolean): void {
  try {
    localStorage.setItem(OPEN_KEY, String(open));
  } catch {
    // storage unavailable
  }
}

interface PanelProps {
  /** Compound id (relay-doc) of the opened document. */
  docId: string;
  /** Its merged path, e.g. /Lens Edu/Concepts/x.md. */
  path: string | undefined;
  /** Its text: parents come from its frontmatter, live. */
  ytext: Y.Text;
}

/**
 * "Concept graph" header on concept files (lib/concept-graph.ts): a drawn
 * layered graph of every ancestor, the opened concept and its direct
 * children, then the same direct links as plain lists (the accessible
 * version; the drawing is aria-hidden). Read-only: parents are edited in the
 * file's `parent-concepts:` frontmatter. Nothing for other files.
 */
export function ConceptGraphPanel(props: PanelProps) {
  if (!props.path || !isConceptPath(props.path)) return null;
  return <Panel {...props} path={props.path} />;
}

const NODE_H = 24;
const CHAR_W = 7;

function nodeLabel(node: GraphNode, graph: ConceptGraph): string {
  return node.kind === 'more' ? `+${node.more} more` : graph.nameOf(node.id);
}

function countLabel(node: GraphNode): string {
  return node.count ? `+${node.count}${node.countCut ? '+' : ''}` : '';
}

function nodeWidth(node: GraphNode, graph: ConceptGraph): number {
  const chars = nodeLabel(node, graph).length + (countLabel(node).length ? countLabel(node).length + 1 : 0);
  return Math.round(Math.min(190, Math.max(56, chars * CHAR_W + 20)));
}

interface Placed {
  node: GraphNode;
  x: number;
  y: number;
  w: number;
}

/** Top-to-bottom layered layout (dagre): broader concepts above. */
function layout(nodes: GraphNode[], edges: GraphEdge[], graph: ConceptGraph) {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'TB', nodesep: 10, ranksep: 22, marginx: 2, marginy: 2 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of nodes) g.setNode(n.id, { width: nodeWidth(n, graph), height: NODE_H });
  for (const e of edges) g.setEdge(e.from, e.to);
  dagre.layout(g);
  const placed: Placed[] = nodes.map((node) => {
    const { x, y, width } = g.node(node.id);
    return { node, x: x - width / 2, y: y - NODE_H / 2, w: width };
  });
  const lines = edges.map((e) => g.edge(e.from, e.to)?.points ?? []);
  const { width = 0, height = 0 } = g.graph();
  return { placed, lines, width, height };
}

const NODE_CLASS = 'absolute flex items-center gap-1 rounded border px-1.5 text-xs leading-none';

function Drawing({ graph, self }: { graph: ConceptGraph; self: string }) {
  const { nodes, edges } = useMemo(
    () => graphData(self, graph.ancestors, graph.parentsOf, graph.below),
    [self, graph.ancestors, graph.parentsOf, graph.below],
  );
  const { placed, lines, width, height } = useMemo(() => layout(nodes, edges, graph), [nodes, edges, graph]);
  if (nodes.length <= 1) return null;
  return (
    <div className="max-h-[260px] overflow-auto px-3 pb-1" data-testid="concept-graph-drawing" aria-hidden="true">
      <div className="relative mx-auto" style={{ width, height }}>
        <svg className="absolute inset-0 overflow-visible" width={width} height={height}>
          <defs>
            <marker id="concept-graph-arrow" viewBox="0 0 6 6" refX="5" refY="3" markerWidth="5" markerHeight="5" orient="auto">
              <path d="M0,0 L6,3 L0,6 z" className="fill-gray-400" />
            </marker>
          </defs>
          {lines.map((pts, i) => (
            <polyline
              key={i}
              points={pts.map((p: { x: number; y: number }) => `${p.x},${p.y}`).join(' ')}
              className="fill-none stroke-gray-400"
              strokeWidth={1}
              markerEnd="url(#concept-graph-arrow)"
            />
          ))}
        </svg>
        {placed.map(({ node, x, y, w }) => {
          const label = nodeLabel(node, graph);
          const style = { left: x, top: y, width: w, height: NODE_H };
          const count = countLabel(node);
          const title = node.kind === 'more' ? `${node.more} more child concepts: see the list below` : graph.pathOf(node.id) ?? label;
          const inner = (
            <>
              <span className="min-w-0 flex-1 truncate">{label}</span>
              {count && <span className="shrink-0 text-[10px] text-gray-400">{count}</span>}
            </>
          );
          if (node.kind === 'self') {
            return (
              <div key={node.id} className={`${NODE_CLASS} border-indigo-400 bg-indigo-50 font-semibold text-indigo-900`} style={style} title={title} data-kind="self">
                {inner}
              </div>
            );
          }
          if (node.kind === 'more') {
            return (
              <div key={node.id} className={`${NODE_CLASS} border-dashed border-gray-300 bg-white text-gray-500`} style={style} title={title} data-kind="more">
                {inner}
              </div>
            );
          }
          return (
            <div key={node.id} className="absolute" style={style} data-kind={node.kind}>
              <DocLink
                docId={node.id}
                tabIndex={-1}
                title={title}
                className={`${NODE_CLASS} relative h-full w-full border-gray-200 bg-white text-gray-700 hover:border-indigo-300 hover:text-indigo-700`}
              >
                {inner}
              </DocLink>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Chip({ id, graph, suffix }: { id: string; graph: ConceptGraph; suffix?: string }) {
  return (
    <span className="inline-flex max-w-full items-baseline gap-1">
      <DocLink
        docId={id}
        title={graph.pathOf(id) ?? graph.nameOf(id)}
        className="max-w-full truncate rounded border border-gray-200 bg-white px-1.5 py-0.5 text-gray-700 hover:border-indigo-300 hover:text-indigo-700"
      >
        {graph.nameOf(id)}
      </DocLink>
      {suffix && <span className="text-xs text-gray-400">{suffix}</span>}
    </span>
  );
}

function Panel({ docId, path, ytext }: PanelProps & { path: string }) {
  const self = docUuidFromCompoundId(docId);
  const [open, setOpen] = useState(readOpen);
  const graph = useConceptGraph(self, path, ytext, open);
  const { own, ancestors, below } = graph;

  const toggle = () => {
    setOpen((v) => {
      writeOpen(!v);
      return !v;
    });
  };

  const children = below.kids.get(self) ?? [];
  const childCount = (id: string) => countBelow(id, below.kids, self).count;
  const throughSelf = below.cycle || (ancestors.cycle?.includes(self) ?? false);
  const noEntries = own.parents.length === 0 && own.unresolved.length === 0;

  return (
    <section
      className="concept-graph-panel mb-3 mt-1 rounded-md border border-gray-200 bg-gray-50/70 text-sm"
      data-testid="concept-graph-panel"
      aria-label="Concept graph"
    >
      <header className="flex items-center gap-2 px-2 py-1.5">
        <button
          type="button"
          onClick={toggle}
          className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-gray-500 cursor-pointer"
          aria-expanded={open}
        >
          <span className="w-3 text-gray-400">{open ? '▾' : '▸'}</span>
          Concept graph
        </button>
        {!open && ancestors.main.length > 0 && (
          <span className="min-w-0 truncate text-xs text-gray-400">{ancestors.main.map(graph.nameOf).join(' › ')}</span>
        )}
      </header>
      {open && (
        <div className="pb-2.5" data-testid="concept-graph-body">
          <Drawing graph={graph} self={self} />
          <div className="space-y-1 px-3 pt-1">
            <div className="flex flex-wrap items-baseline gap-1" data-testid="concept-graph-parents">
              <span className="mr-1 text-[11px] font-semibold uppercase tracking-wider text-gray-400">Parent concepts:</span>
              {noEntries && <span className="text-gray-500">none (top-level concept)</span>}
              {!noEntries && own.parents.length === 0 && <span className="text-gray-500">none resolved</span>}
              {own.parents.map((id, i) => <Chip key={id} id={id} graph={graph} suffix={i === 0 && own.parents.length > 1 ? 'primary' : undefined} />)}
            </div>
            {children.length > 0 && (
              <div className="flex flex-wrap items-baseline gap-1" data-testid="concept-graph-children">
                <span className="mr-1 text-[11px] font-semibold uppercase tracking-wider text-gray-400">Child concepts:</span>
                {children.map((id) => {
                  const n = childCount(id);
                  return <Chip key={id} id={id} graph={graph} suffix={n ? `+${n}` : undefined} />;
                })}
              </div>
            )}
            {own.unresolved.map((raw, i) => (
              <div key={i} className="text-xs text-red-700" data-testid="concept-graph-unresolved">Parent not found: {raw}</div>
            ))}
            {throughSelf && <div className="text-xs text-red-700" data-testid="concept-graph-cycle">A cycle runs through this file</div>}
            {!throughSelf && ancestors.cycle && (
              <div className="text-xs text-red-700" data-testid="concept-graph-cycle">
                A cycle runs above this file ({ancestors.cycle.map(graph.nameOf).join(' › ')})
              </div>
            )}
            {ancestors.cut && <div className="text-xs text-gray-400">More ancestors not shown (at most {MAX_ANCESTORS}).</div>}
            {ancestors.pending.length > 0 && <div className="text-xs text-gray-400">Loading…</div>}
            {graph.failed > 0 && (
              <div className="text-xs text-red-700">
                {graph.failed === 1 ? 'One concept file' : `${graph.failed} concept files`} could not be read.
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
