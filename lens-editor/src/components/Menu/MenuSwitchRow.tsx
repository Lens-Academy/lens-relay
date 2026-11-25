import type { ReactNode } from 'react';

/** Notion's switch in a menu: a small pill, blue while on (index.css) */
export function Switch({ on }: { on: boolean }) {
  return (
    <span aria-hidden="true" className={`lens-switch${on ? ' is-on' : ''}`}>
      <span className="lens-switch-knob" />
    </span>
  );
}

/** A menu row that turns a setting on or off: its icon, label and a switch */
export function MenuSwitchRow({
  icon,
  label,
  description,
  checked,
  onToggle,
  disabled = false,
  title,
}: {
  icon: ReactNode;
  label: string;
  description?: string;
  checked: boolean;
  onToggle: () => void;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      role="menuitemcheckbox"
      aria-checked={checked}
      disabled={disabled}
      title={title}
      onClick={onToggle}
      className="lens-menu-item lens-menu-item-compact disabled:opacity-40"
    >
      <span className="lens-menu-item-icon">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="lens-menu-item-label block text-sm leading-5">{label}</span>
        {description && <span className="lens-menu-item-description">{description}</span>}
      </span>
      <Switch on={checked} />
    </button>
  );
}

/** The tick on a menu's chosen option */
export function MenuCheck() {
  return (
    <svg className="h-4 w-4 flex-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}
