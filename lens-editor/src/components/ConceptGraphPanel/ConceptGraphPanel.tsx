import { lazy, Suspense, useState } from 'react';
import type * as Y from 'yjs';
import { countLabel, isConceptPath, MAX_ANCESTORS, MAX_CHILD_CANDIDATES } from '../../lib/concept-graph';
import { docUuidFromCompoundId } from '../../lib/url-utils';
import { DocLink } from '../DocLink';
import { useConceptGraph, type ConceptGraph } from './useConceptGraph';

const ConceptGraphDrawing = lazy(() => import('./ConceptGraphDrawing'));

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
    writeOpen(!open);
    setOpen(!open);
  };

  const children = below.children;
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
          {/* The lists show at once; the drawing follows when its module has loaded. */}
          <Suspense fallback={null}>
            <ConceptGraphDrawing graph={graph} self={self} />
          </Suspense>
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
                {children.map((id) => (
                  <Chip key={id} id={id} graph={graph} suffix={countLabel(below.counts.get(id)) || undefined} />
                ))}
                {below.pendingCounts > 0 && <span className="text-xs text-gray-400">counting…</span>}
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
            {below.candidatesCut > 0 && (
              <div className="text-xs text-gray-400">
                {below.candidatesCut} more concept file(s) link here and were not checked (at most {MAX_CHILD_CANDIDATES}).
              </div>
            )}
            {ancestors.cut && <div className="text-xs text-gray-400">More ancestors not shown (at most {MAX_ANCESTORS}).</div>}
            {(ancestors.pending.length > 0 || below.pendingChildren > 0) && <div className="text-xs text-gray-400">Loading…</div>}
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
