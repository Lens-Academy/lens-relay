import { Fragment, useState, type ReactNode } from 'react';
import type * as Y from 'yjs';
import { isConceptPath, type TreeNode } from '../../lib/concept-graph';
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
 * "Concept graph" header on concept files (lib/concept-graph.ts): the main
 * path upward (first parents), other paths, direct parents and children, and
 * on request everything below. Read-only: parents are edited in the file's
 * `parent:` frontmatter. Nothing for other files.
 */
export function ConceptGraphPanel(props: PanelProps) {
  if (!props.path || !isConceptPath(props.path)) return null;
  return <Panel {...props} path={props.path} />;
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <div className="pt-0.5 text-[11px] font-semibold uppercase tracking-wider text-gray-400">{label}</div>
      <div className="min-w-0">{children}</div>
    </>
  );
}

function Chip({ id, graph }: { id: string; graph: ConceptGraph }) {
  return (
    <DocLink
      docId={id}
      title={`Open ${graph.pathOf(id) ?? graph.nameOf(id)}`}
      className="inline-block max-w-full truncate rounded border border-gray-200 bg-white px-1.5 py-0.5 text-gray-700 hover:border-indigo-300 hover:text-indigo-700"
    >
      {graph.nameOf(id)}
    </DocLink>
  );
}

function PathLinks({ path, graph }: { path: readonly string[]; graph: ConceptGraph }) {
  return (
    <>
      {path.map((id, i) => (
        <Fragment key={`${id}:${i}`}>
          {i > 0 && <span className="px-1 text-gray-400">›</span>}
          <DocLink docId={id} title={`Open ${graph.pathOf(id) ?? graph.nameOf(id)}`} className="text-gray-700 hover:text-indigo-700 hover:underline">
            {graph.nameOf(id)}
          </DocLink>
        </Fragment>
      ))}
    </>
  );
}

function Tree({ nodes, graph }: { nodes: readonly TreeNode[]; graph: ConceptGraph }) {
  return (
    <ul className="ml-3 border-l border-gray-200 pl-2">
      {nodes.map((n, i) => (
        <li key={`${n.id}:${i}`} className="py-px">
          <DocLink docId={n.id} title={`Open ${graph.pathOf(n.id) ?? graph.nameOf(n.id)}`} className="text-gray-700 hover:text-indigo-700 hover:underline">
            {graph.nameOf(n.id)}
          </DocLink>
          {n.repeat && <span className="ml-1 text-xs text-gray-400">(also listed under another parent)</span>}
          {n.children.length > 0 && <Tree nodes={n.children} graph={graph} />}
        </li>
      ))}
    </ul>
  );
}

function Panel({ docId, path, ytext }: PanelProps & { path: string }) {
  const self = docUuidFromCompoundId(docId);
  const [open, setOpen] = useState(readOpen);
  const [showPaths, setShowPaths] = useState(false);
  const [showBelow, setShowBelow] = useState(false);
  const graph = useConceptGraph(self, path, ytext, open, showBelow);
  const { own, ancestors, children, descendants } = graph;

  const toggle = () => {
    setOpen((v) => {
      writeOpen(!v);
      return !v;
    });
  };

  const loadingUp = ancestors.pending.length > 0;
  const cycle = ancestors.cycle ?? (descendants?.cycle ? [self, self] : null);
  const topLevel = own.parents.length === 0;

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
          <span className="min-w-0 truncate text-xs text-gray-400">
            {ancestors.main.map(graph.nameOf).join(' › ')}
          </span>
        )}
      </header>
      {open && (
        <div className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-2 gap-y-1.5 px-3 pb-2.5" data-testid="concept-graph-body">
          <Row label="Part of">
            {topLevel ? (
              <span className="text-gray-500">Top-level concept</span>
            ) : (
              <div data-testid="concept-graph-main-path">
                <PathLinks path={ancestors.main} graph={graph} />
                {(loadingUp || ancestors.cut) && <span className="pl-1 text-gray-400" title={ancestors.cut ? 'Cut: too deep or too many concepts' : 'Loading…'}>…</span>}
              </div>
            )}
            {ancestors.others.length > 0 && (
              <div className="text-xs">
                <button
                  type="button"
                  onClick={() => setShowPaths((v) => !v)}
                  className="text-gray-500 hover:underline cursor-pointer"
                  aria-expanded={showPaths}
                >
                  {showPaths ? '− fewer paths' : `+${ancestors.others.length}${ancestors.pathsCut ? '+' : ''} more path${ancestors.others.length === 1 ? '' : 's'}`}
                </button>
                {showPaths && ancestors.others.map((p, i) => (
                  <div key={i} className="text-gray-600" data-testid="concept-graph-other-path">
                    <span className="pr-1 text-gray-400">also:</span>
                    <PathLinks path={p} graph={graph} />
                  </div>
                ))}
                {showPaths && ancestors.pathsCut && <div className="text-gray-400">… more paths not listed</div>}
              </div>
            )}
          </Row>
          {(own.parents.length > 0 || own.unresolved.length > 0) && (
            <Row label="Parents">
              <div className="flex flex-wrap gap-1" data-testid="concept-graph-parents">
                {own.parents.map((id) => <Chip key={id} id={id} graph={graph} />)}
                {own.unresolved.map((raw, i) => (
                  <span
                    key={`u${i}`}
                    className="inline-block max-w-full truncate rounded border border-red-200 bg-red-50 px-1.5 py-0.5 text-red-700"
                    title="This parent: entry is not a wikilink to a file in Lens Edu/Concepts/"
                  >
                    {raw} (not found)
                  </span>
                ))}
              </div>
            </Row>
          )}
          {children.ids.length > 0 && (
            <Row label="Contains">
              <div className="flex flex-wrap gap-1" data-testid="concept-graph-children">
                {children.ids.map((id) => <Chip key={id} id={id} graph={graph} />)}
                {children.pending.length > 0 && <span className="px-1 text-gray-400">…</span>}
              </div>
              <div className="pt-1 text-xs">
                <button
                  type="button"
                  onClick={() => setShowBelow((v) => !v)}
                  className="text-gray-500 hover:underline cursor-pointer"
                  aria-expanded={showBelow}
                  data-testid="concept-graph-below-toggle"
                >
                  {showBelow ? '▾ ' : '▸ '}
                  {descendants
                    ? `${descendants.count}${descendants.cut ? '+' : ''} concept${descendants.count === 1 ? '' : 's'} in total below${descendants.pending.length ? ' …' : ''}`
                    : 'All concepts below'}
                </button>
                {descendants && <Tree nodes={descendants.tree} graph={graph} />}
              </div>
            </Row>
          )}
          {cycle && (
            <div className="col-span-2 text-xs text-amber-700" data-testid="concept-graph-cycle">
              Cycle in parent: links ({cycle.map(graph.nameOf).join(' › ')}). A concept cannot be part of itself; fix the
              parent: frontmatter.
            </div>
          )}
          {graph.failed > 0 && (
            <div className="col-span-2 text-xs text-red-700">
              {graph.failed === 1 ? 'One concept file' : `${graph.failed} concept files`} could not be read.
            </div>
          )}
        </div>
      )}
    </section>
  );
}
