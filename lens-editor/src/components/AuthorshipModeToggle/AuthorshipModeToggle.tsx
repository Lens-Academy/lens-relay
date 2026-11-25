import { useState } from 'react';
import { RECENT_WINDOW_PRESETS, type AuthorshipMode } from '../Editor/extensions/authorship';
import { MenuCheck, MenuSwitchRow, Switch } from '../Menu/MenuSwitchRow';
import type { AuthorshipSettings } from './useAuthorshipSettings';

const MODES: Array<{ value: AuthorshipMode; label: string; description: string }> = [
  { value: 'hidden', label: 'Off', description: 'No authorship display' },
  { value: 'gutter', label: 'Gutter', description: 'Colored strip per line' },
  { value: 'expanded', label: 'Expanded', description: 'Author names in the margin' },
  { value: 'inline', label: 'Inline', description: 'Expanded + per-word tint' },
];

// Outlined document with an edge strip — a miniature of the authorship gutter.
function AuthorshipIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      className="w-4 h-4"
      aria-hidden="true"
    >
      <rect x="3" y="3" width="14" height="14" rx="2" />
      <line x1="6.5" y1="6.5" x2="6.5" y2="13.5" strokeWidth="2" />
      <line x1="10" y1="7" x2="14" y2="7" />
      <line x1="10" y1="10" x2="14" y2="10" />
      <line x1="10" y1="13" x2="14" y2="13" />
    </svg>
  );
}

/** One on/off row of the authorship options */
function OptionSwitch({ label, description, checked, onClick }: {
  label: string;
  description: string;
  checked: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitemcheckbox"
      aria-checked={checked}
      onClick={onClick}
      className="lens-menu-item lens-menu-item-compact lens-menu-subitem"
    >
      <span className="min-w-0 flex-1">
        <span className="block text-sm leading-5">{label}</span>
        <span className="lens-menu-item-description">{description}</span>
      </span>
      <Switch on={checked} />
    </button>
  );
}

/**
 * Authorship in the page menu: a row with the current display, which opens
 * the options under it (the modes, the author on hover).
 */
export function AuthorshipModeToggle({ settings, disabled = false }: { settings: AuthorshipSettings; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const current = MODES.find((m) => m.value === settings.mode) ?? MODES[1];

  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen(!open)}
        title="Who wrote what: people or AI"
        className="lens-menu-item lens-menu-item-compact disabled:opacity-40"
      >
        <span className="lens-menu-item-icon"><AuthorshipIcon /></span>
        <span className="lens-menu-item-label min-w-0 flex-1 text-sm leading-5">Authorship</span>
        <span className="lens-menu-item-value">{current.label}</span>
        <svg className={`lens-menu-chevron${open ? ' is-open' : ''}`} viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="m4.5 2.75 3.25 3.25-3.25 3.25" />
        </svg>
      </button>
      {open && (
        <div role="group" aria-label="Authorship" className="lens-menu-options">
          {MODES.map((m) => (
            <button
              key={m.value}
              type="button"
              role="menuitemradio"
              aria-checked={m.value === settings.mode}
              onClick={() => settings.selectMode(m.value)}
              className="lens-menu-item lens-menu-item-compact lens-menu-subitem"
            >
              <span className="min-w-0 flex-1">
                <span className="block text-sm leading-5">{m.label}</span>
                <span className="lens-menu-item-description">{m.description}</span>
              </span>
              {m.value === settings.mode && <MenuCheck />}
            </button>
          ))}
          <OptionSwitch
            label="Show author on hover"
            description="Who wrote the word under the pointer"
            checked={settings.hoverEnabled}
            onClick={settings.toggleHover}
          />
        </div>
      )}
    </div>
  );
}

// A clock: changes within a time window.
function RecentIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4" aria-hidden="true">
      <circle cx="10" cy="10" r="7" />
      <path d="M10 6v4l2.5 1.5" />
    </svg>
  );
}

/**
 * "Highlight recent changes", a switch of its own in the page menu (beside
 * Authorship, not inside it); while on, the time window's choices under it.
 */
export function RecentChangesToggle({ settings, disabled = false }: { settings: AuthorshipSettings; disabled?: boolean }) {
  return (
    <div>
      <MenuSwitchRow
        icon={<RecentIcon />}
        label="Highlight recent changes"
        description="Direct AI edits within a time window"
        checked={settings.recentEnabled}
        onToggle={settings.toggleRecent}
        disabled={disabled}
      />
      {settings.recentEnabled && (
        <div className="flex gap-1 px-2 pb-1.5 pt-0.5 lens-menu-subitem" role="group" aria-label="Recent changes window">
          {RECENT_WINDOW_PRESETS.map((p) => (
            <button
              key={p.label}
              type="button"
              role="menuitemradio"
              aria-checked={p.ms === settings.windowMs}
              onClick={() => settings.selectWindow(p.ms)}
              className={`px-2 py-0.5 rounded-full text-xs transition-colors ${
                p.ms === settings.windowMs
                  ? 'bg-purple-100 text-purple-700'
                  : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
