import { useState } from 'react';
import { deletePlan, ideaKey, type IdeaGraph } from '../../lib/idea-map';
import { Confirm } from './Confirm';
import { IdeaMenu, type MenuItem } from './IdeaMenu';
import { ProfileNameForm } from './ProfileSwitcher';
import { BUTTON, listed } from './ideaLook';
import type { IdeaProfiles } from './useIdeaMap';

/** "3 concepts", "1 concept". */
const concepts = (count: number) => `${count} ${count === 1 ? 'concept' : 'concepts'}`;

/** What a copy into another profile did, in a sentence. */
function copySummary(copied: number, skipped: number, target: string, replaced: boolean): string {
  const there = skipped === 1 ? '1 was already there and was skipped' : `${skipped} were already there and were skipped`;
  if (replaced) return `${copied} replaced in ${target}.`;
  if (copied > 0) return `${copied} copied to ${target}${skipped > 0 ? `; ${there}` : ''}.`;
  return skipped > 0 ? `Nothing copied to ${target}: ${there}.` : `Nothing was copied to ${target}.`;
}

type Outcome =
  | { kind: 'copied'; target: string; copied: string[]; skipped: string[]; replaced: boolean; left: number }
  | { kind: 'note'; text: string }
  | { kind: 'error'; text: string };

/**
 * The bar over the views while several ideas are selected: how many, what
 * can be done with them all, and "Clear". An action is a button (or a button
 * with a menu) in `actions`; what it asks before it runs opens under the bar.
 */
export function SelectionBar({ graph, keys, profiles, deleteNote, onClear, onDelete }: {
  graph: IdeaGraph;
  /** The keys of the selected ideas. */
  keys: readonly string[];
  /** Where there are profiles, the selection can be copied into another. */
  profiles?: IdeaProfiles;
  /** What becomes of a deleted file, said before deleting. */
  deleteNote?: string;
  onClear: () => void;
  /** Delete them all, once confirmed here; resolves to an error to show, or null. */
  onDelete: (keys: string[]) => Promise<string | null>;
}) {
  /** What is open under the bar. */
  const [panel, setPanel] = useState<'delete' | 'new-profile' | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const open = (next: typeof panel) => {
    setPanel(next);
    setError(null);
    setOutcome(null);
  };

  const plan = deletePlan(graph, keys);
  const count = plan.files.length + plan.unwritten.length;
  /** Only an idea with a file can be copied. */
  const copyKeys = plan.files.map((node) => node.key);

  const copy = async (target: string, which: string[], replace: boolean) => {
    if (!profiles) return;
    setBusy(true);
    setOutcome(null);
    const result = await profiles.copyTo(which, target, replace);
    setBusy(false);
    setOutcome('error' in result
      ? { kind: 'error', text: result.error }
      : { kind: 'copied', target, copied: result.copied, skipped: result.skipped, replaced: replace, left: replace ? 0 : plan.unwritten.length });
  };

  const copyTargets: MenuItem[] = profiles ? [
    ...profiles.names.filter((name) => name !== profiles.current).map((name) => ({
      id: `profile:${name}`,
      label: name,
      onSelect: () => {
        setPanel(null);
        void copy(name, copyKeys, false);
      },
    })),
    { id: 'new', label: 'New profile…', divider: profiles.names.length > 1, onSelect: () => open('new-profile') },
  ] : [];

  // One entry per thing that can be done with the selection; a new one (set
  // the priority of them all, say) is one more entry and its panel below.
  const actions: Array<{ id: string; label: string; title?: string; menu?: MenuItem[]; onRun?: () => void }> = [
    { id: 'delete', label: 'Delete', onRun: () => open(panel === 'delete' ? null : 'delete') },
    ...(profiles ? [copyKeys.length > 0
      ? { id: 'copy', label: 'Copy to…', title: 'Copy the selected concepts into another profile', menu: copyTargets }
      : {
        id: 'copy',
        label: 'Copy to…',
        onRun: () => {
          setPanel(null);
          setOutcome({ kind: 'note', text: 'Nothing to copy: the selected concepts are not written yet, so they have no file.' });
        },
      }] : []),
  ];

  const names = (nodes: Array<{ name: string }>) => nodes.map((node) => node.name);

  return (
    <div className="border-b border-blue-200 bg-blue-50 px-6 py-2 text-sm text-gray-800" role="region" aria-label="Selected concepts" data-testid="idea-selection">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium" title={listed(names([...plan.files, ...plan.unwritten]))} data-testid="idea-selection-count">{count} selected</span>
        {actions.map((action) => (action.menu ? (
          <IdeaMenu key={action.id} label={action.label} name={action.label} title={action.title} items={action.menu} className={`${BUTTON} bg-white`} disabled={busy} />
        ) : (
          <button key={action.id} type="button" className={`${BUTTON} bg-white`} title={action.title} disabled={busy} onClick={action.onRun}>{action.label}</button>
        )))}
        <button type="button" className={`${BUTTON} bg-white`} disabled={busy} onClick={onClear} title="Select nothing (Escape)">Clear</button>
        {busy && panel === null && <span className="text-xs text-gray-500" role="status">Copying…</span>}
        {outcome && (
          <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs" data-testid="idea-selection-outcome">
            {outcome.kind === 'error' && <span className="text-red-700" role="alert">{outcome.text}</span>}
            {outcome.kind === 'note' && <span className="text-gray-600" role="status">{outcome.text}</span>}
            {outcome.kind === 'copied' && profiles && (
              <>
                <span className="text-gray-700" role="status">
                  {copySummary(outcome.copied.length, outcome.skipped.length, outcome.target, outcome.replaced)}
                  {outcome.left > 0 && ` ${outcome.left} not written yet ${outcome.left === 1 ? 'was' : 'were'} left out.`}
                </span>
                {outcome.skipped.length > 0 && (
                  <button
                    type="button"
                    className="text-blue-600 hover:underline"
                    title={`Replace in ${outcome.target}: ${listed(outcome.skipped)}`}
                    onClick={() => void copy(outcome.target, outcome.skipped.map(ideaKey), true)}
                  >
                    Replace {outcome.skipped.length === 1 ? 'it' : 'those'}
                  </button>
                )}
                <button type="button" className="text-blue-600 hover:underline" onClick={() => profiles.open(outcome.target)}>Open {outcome.target}</button>
              </>
            )}
          </span>
        )}
      </div>

      {panel === 'delete' && (
        <div className="max-w-2xl">
          <Confirm
            label="Delete the selected concepts"
            action={plan.files.length === 0 ? 'Remove the links' : `Delete ${concepts(plan.files.length)}`}
            busy={busy}
            error={error}
            onCancel={() => open(null)}
            onConfirm={async () => {
              setBusy(true);
              setError(null);
              const failed = await onDelete([...plan.files, ...plan.unwritten].map((node) => node.key));
              setBusy(false);
              if (failed) setError(failed);
              else setPanel(null);
            }}
          >
            {plan.files.length > 0 && (
              <>
                <p>Delete {plan.files.length === 1 ? 'this concept' : `these ${plan.files.length} concepts`}?</p>
                <ul className="mt-1 max-h-32 list-disc overflow-y-auto pl-5" data-testid="idea-delete-list">
                  {plan.files.map((node) => <li key={node.key} className="break-words">{node.name}</li>)}
                </ul>
              </>
            )}
            {plan.unwritten.length > 0 && (
              <p className="mt-1" data-testid="idea-delete-unwritten">
                {listed(names(plan.unwritten))} {plan.unwritten.length === 1 ? 'is' : 'are'} not written yet and {plan.unwritten.length === 1 ? 'has' : 'have'} no file:
                {' '}deleting {plan.unwritten.length === 1 ? 'it' : 'them'} takes every link to {plan.unwritten.length === 1 ? 'it' : 'them'} out.
              </p>
            )}
            {plan.losing.length > 0 && (
              <>
                <p className="mt-1">These concepts lose a link:</p>
                <ul className="max-h-32 list-disc overflow-y-auto pl-5" data-testid="idea-delete-losing">
                  {plan.losing.map(({ node, names: lost }) => <li key={node.key} className="break-words">{node.name} (to {listed(lost)})</li>)}
                </ul>
              </>
            )}
            {plan.questions > 0 && (
              <p className="mt-1">{plan.questions === 1 ? '1 question goes' : `${plan.questions} questions go`} with {plan.files.length === 1 ? 'it' : 'them'}.</p>
            )}
            {plan.orphaned.length > 0 && (
              <p className="mt-1">
                {listed(names(plan.orphaned))} {plan.orphaned.length === 1 ? 'is' : 'are'} not written yet and named only here: {plan.orphaned.length === 1 ? 'it leaves' : 'they leave'} the map too.
              </p>
            )}
            {deleteNote && plan.files.length > 0 && <p className="mt-1 text-xs text-gray-600">{deleteNote}</p>}
          </Confirm>
        </div>
      )}

      {panel === 'new-profile' && profiles && (
        <div className="mt-2 max-w-xs rounded border border-gray-200 bg-white p-3">
          <ProfileNameForm
            title={`Copy ${concepts(copyKeys.length)} to a new profile`}
            action="Create and copy"
            busyAction="Copying…"
            existing={profiles.names}
            onCancel={() => open(null)}
            onSubmit={async (name) => {
              // The new profile is made without opening it: the selection stays here
              const failed = await profiles.create(name, undefined, false);
              if (failed) return failed;
              setPanel(null);
              await copy(name, copyKeys, false);
              return null;
            }}
          />
        </div>
      )}
    </div>
  );
}
