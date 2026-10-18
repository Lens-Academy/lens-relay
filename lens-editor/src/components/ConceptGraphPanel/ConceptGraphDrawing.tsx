import { useMemo } from 'react';
import dagre from '@dagrejs/dagre';
import { countLabel, graphData, type GraphEdge, type GraphNode } from '../../lib/concept-graph';
import { DocLink } from '../DocLink';
import type { ConceptGraph } from './useConceptGraph';

const NODE_H = 24;
const CHAR_W = 7;

type NameOf = (id: string) => string;

function nodeLabel(node: GraphNode, nameOf: NameOf): string {
  return node.kind === 'more' ? `+${node.more} more` : nameOf(node.id);
}

function nodeWidth(node: GraphNode, nameOf: NameOf): number {
  const count = countLabel(node.count);
  const chars = nodeLabel(node, nameOf).length + (count ? count.length + 1 : 0);
  return Math.round(Math.min(190, Math.max(56, chars * CHAR_W + 20)));
}

interface Placed {
  node: GraphNode;
  x: number;
  y: number;
  w: number;
}

/** Top-to-bottom layered layout (dagre): broader concepts above. */
function layout(nodes: GraphNode[], edges: GraphEdge[], nameOf: NameOf) {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'TB', nodesep: 10, ranksep: 22, marginx: 2, marginy: 2 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of nodes) g.setNode(n.id, { width: nodeWidth(n, nameOf), height: NODE_H });
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

/** The drawn graph. Its own module, loaded on demand, so pages that are not
 *  concept files never download dagre. */
export default function ConceptGraphDrawing({ graph, self }: { graph: ConceptGraph; self: string }) {
  const { nameOf } = graph;
  const { nodes, edges } = useMemo(
    () => graphData(self, graph.ancestors, graph.parentsOf, graph.below),
    [self, graph.ancestors, graph.parentsOf, graph.below],
  );
  // Laid out again only when the graph data or the names change.
  const { placed, lines, width, height } = useMemo(() => layout(nodes, edges, nameOf), [nodes, edges, nameOf]);
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
          const label = nodeLabel(node, nameOf);
          const style = { left: x, top: y, width: w, height: NODE_H };
          const count = countLabel(node.count);
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
