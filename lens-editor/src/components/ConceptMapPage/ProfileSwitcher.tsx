import { useEffect, useRef, useState, type ReactNode } from 'react';
import { profileNameProblem } from '../../lib/idea-map';
import { Confirm } from './Confirm';
import { IdeaMenu, type MenuItem } from './IdeaMenu';
import { BUTTON, FIELD_LABEL, PRIMARY_BUTTON } from './ideaLook';
import type { IdeaProfiles } from './useIdeaMap';

/**
 * The small form that asks for the name of a profile: the name is checked
 * while it is typed, Enter saves, Escape cancels.
 */
export function ProfileNameForm({ title, action, busyAction, initial = '', existing, children, onCancel, onSubmit }: {
  title: string;
  action: string;
  busyAction: string;
  initial?: string;
  /** The names the new one must differ from. */
  existing: readonly string[];
  /** More to choose under the name. */
  children?: ReactNode;
  onCancel: () => void;
  /** Resolves to an error to show, or null. */
  onSubmit: (name: string) => Promise<string | null>;
}) {
  const [name, setName] = useState(initial);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const problem = profileNameProblem(name, existing);
  // "Give it a name" only once it was tried without one
  const shown = error ?? (problem && (tried || name.trim() !== '') ? problem : null);

  return (
    <form
      className="space-y-2"
      aria-label={title}
      data-testid="profile-form"
      onKeyDown={(e) => {
        if (e.key !== 'Escape' || busy) return;
        e.preventDefault();
        e.stopPropagation();
        onCancel();
      }}
      onSubmit={async (e) => {
        e.preventDefault();
        setTried(true);
        if (problem || busy) return;
        setBusy(true);
        setError(null);
        const failed = await onSubmit(name.trim());
        setBusy(false);
        if (failed) setError(failed);
      }}
    >
      <label className="block">
        <span className={FIELD_LABEL}>{title}</span>
        <input
          className="lens-input w-full"
          value={name}
          autoFocus
          onFocus={(e) => e.target.select()}
          onChange={(e) => {
            setName(e.target.value);
            setError(null);
          }}
          placeholder="Name"
          aria-label="Profile name"
          aria-invalid={shown !== null}
          maxLength={80}
        />
      </label>
      {children}
      {shown && <p className="text-xs text-red-700" role="alert">{shown}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" className={`${BUTTON} bg-white`} onClick={onCancel} disabled={busy}>Cancel</button>
        <button type="submit" className={PRIMARY_BUTTON} disabled={busy}>{busy ? busyAction : action}</button>
      </div>
    </form>
  );
}

/**
 * The profile switcher next to the title: the current profile, the others to
 * switch to, and new / rename / delete. Shown only where the hook has
 * profiles (`IdeaMap.profiles`).
 */
export function ProfileSwitcher({ profiles, count }: {
  profiles: IdeaProfiles;
  /** How many concepts the current profile has, once they are read. */
  count: number | null;
}) {
  const [dialog, setDialog] = useState<'new' | 'rename' | 'delete' | null>(null);
  const [copy, setCopy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const { current, names } = profiles;
  const others = names.filter((name) => name !== current);

  const ask = (what: typeof dialog) => {
    setDialog(what);
    setCopy(false);
    setError(null);
  };
  const close = () => {
    setDialog(null);
    button.current?.focus();
  };

  // A press outside the small form closes it
  useEffect(() => {
    if (!dialog) return;
    const away = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setDialog(null);
    };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [dialog]);

  const items: MenuItem[] = [
    { id: `profile:${current}`, label: current, checked: true, onSelect: () => {} },
    ...others.map((name) => ({ id: `profile:${name}`, label: name, checked: false, onSelect: () => profiles.open(name) })),
    { id: 'new', label: 'New profile…', divider: true, onSelect: () => ask('new') },
    { id: 'rename', label: 'Rename…', onSelect: () => ask('rename') },
    // The last profile left stays
    ...(others.length > 0 ? [{ id: 'delete', label: 'Delete profile…', onSelect: () => ask('delete') }] : []),
  ];

  return (
    <div className="relative" data-testid="profile-switcher">
      <IdeaMenu
        label={<span className="max-w-56 truncate">{current}</span>}
        name={`Profile: ${current}`}
        title="Switch to another profile, or make a new one"
        items={items}
        className={`${BUTTON} inline-flex items-center bg-white font-medium text-gray-800`}
        buttonRef={button}
      />
      {dialog && (
        <div ref={box} className="absolute left-0 top-full z-30 mt-1 w-72 rounded border border-gray-200 bg-white p-3 shadow-lg">
          {dialog === 'new' && (
            <ProfileNameForm
              title="New profile"
              action="Create profile"
              busyAction="Creating…"
              existing={names}
              onCancel={close}
              onSubmit={async (name) => {
                const failed = await profiles.create(name, copy ? current : undefined);
                if (!failed) setDialog(null);
                return failed;
              }}
            >
              <fieldset className="space-y-1 text-sm text-gray-700">
                <legend className="sr-only">What the new profile starts with</legend>
                <label className="flex items-center gap-2">
                  <input type="radio" name="profile-start" checked={!copy} onChange={() => setCopy(false)} />
                  Start empty
                </label>
                <label className="flex items-start gap-2">
                  <input type="radio" name="profile-start" className="mt-1" checked={copy} onChange={() => setCopy(true)} />
                  <span className="min-w-0 break-words">Copy everything from {current}</span>
                </label>
              </fieldset>
            </ProfileNameForm>
          )}
          {dialog === 'rename' && (
            <ProfileNameForm
              title="Rename profile"
              action="Rename"
              busyAction="Renaming…"
              initial={current}
              existing={others}
              onCancel={close}
              onSubmit={async (name) => {
                const failed = name === current ? null : await profiles.rename(current, name);
                if (!failed) close();
                return failed;
              }}
            />
          )}
          {dialog === 'delete' && (
            <Confirm
              label="Delete profile"
              action="Delete profile"
              busy={busy}
              error={error}
              onCancel={close}
              onConfirm={async () => {
                setBusy(true);
                setError(null);
                const failed = await profiles.remove(current);
                setBusy(false);
                if (failed) {
                  setError(failed);
                  return;
                }
                setDialog(null);
                // The deleted profile was the open one: the first of the others opens
                profiles.open(others[0]);
              }}
            >
              <p className="break-words">Delete the profile "{current}"?</p>
              <p className="mt-1">
                {count === null ? 'Its concepts are' : count === 0 ? 'It has no concepts.' : count === 1 ? 'Its 1 concept is' : `Its ${count} concepts are`}
                {count !== 0 && ' deleted with it.'}
              </p>
            </Confirm>
          )}
        </div>
      )}
    </div>
  );
}
