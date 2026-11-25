import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useAuth } from '../../contexts/AuthContext';
import { MenuCheck } from '../Menu/MenuSwitchRow';
import { useMenuPopover } from '../Menu/useMenuPopover';

function EditIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4" aria-hidden="true">
      <path d="M2.695 14.763l-1.262 3.154a.5.5 0 00.65.65l3.155-1.262a4 4 0 001.343-.885L17.5 5.5a2.121 2.121 0 00-3-3L3.58 13.42a4 4 0 00-.885 1.343z" />
    </svg>
  );
}

function SuggestIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4" aria-hidden="true">
      <path fillRule="evenodd" d="M10 2c-2.236 0-4.43.18-6.57.524C1.993 2.755 1 4.014 1 5.426v5.148c0 1.413.993 2.67 2.43 2.902 1.168.188 2.352.327 3.55.414.28.02.521.18.642.413l1.713 3.293a.75.75 0 001.33 0l1.713-3.293a.783.783 0 01.642-.413 41.102 41.102 0 003.55-.414c1.437-.231 2.43-1.49 2.43-2.902V5.426c0-1.413-.993-2.67-2.43-2.902A41.289 41.289 0 0010 2zM6.75 6a.75.75 0 000 1.5h6.5a.75.75 0 000-1.5h-6.5zm0 2.5a.75.75 0 000 1.5h3.5a.75.75 0 000-1.5h-3.5z" clipRule="evenodd" />
    </svg>
  );
}

function ViewIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4" aria-hidden="true">
      <path d="M10 12.5a2.5 2.5 0 100-5 2.5 2.5 0 000 5z" />
      <path fillRule="evenodd" d="M.664 10.59a1.651 1.651 0 010-1.186A10.004 10.004 0 0110 3c4.257 0 7.893 2.66 9.336 6.41.147.381.146.804 0 1.186A10.004 10.004 0 0110 17c-4.257 0-7.893-2.66-9.336-6.41zM14 10a4 4 0 11-8 0 4 4 0 018 0z" clipRule="evenodd" />
    </svg>
  );
}

const MODES = [
  { suggesting: false, label: 'Editing', description: 'Change the page directly', icon: <EditIcon /> },
  { suggesting: true, label: 'Suggesting', description: 'Edits become suggestions to accept or reject', icon: <SuggestIcon /> },
];

interface SuggestionModeControlProps {
  isSuggestionMode: boolean;
  onChange: (next: boolean) => void;
  iconOnly?: boolean;
  disabled?: boolean;
}

/**
 * The editing mode, as Google Docs shows it in its top bar: a button with
 * the current mode ("Editing", or "Suggesting" in green), whose menu
 * switches it. Links that may only suggest, or only read, show their mode
 * without a menu.
 */
export function SuggestionModeControl({
  isSuggestionMode,
  onChange,
  iconOnly = false,
  disabled = false,
}: SuggestionModeControlProps) {
  const { role } = useAuth();
  const { open, setOpen, toggle, position, buttonRef, menuRef } = useMenuPopover(300);

  useEffect(() => {
    if (role === 'suggest' && !isSuggestionMode) {
      onChange(true);
    }
  }, [role, isSuggestionMode, onChange]);

  if (role === 'view') {
    return (
      <span className="lens-topbar-button is-locked" title="Read-Only">
        <ViewIcon />
        {!iconOnly && <span>Viewing</span>}
      </span>
    );
  }

  if (role === 'suggest') {
    return (
      <span className="lens-topbar-button is-suggesting is-locked" title="Suggest + Comment Only">
        <SuggestIcon />
        {!iconOnly && <span>Suggesting</span>}
      </span>
    );
  }

  const current = MODES[isSuggestionMode ? 1 : 0];

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={toggle}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Mode: ${current.label}`}
        title={`${current.label}: ${current.description.toLowerCase()}`}
        className={`lens-topbar-button${isSuggestionMode ? ' is-suggesting' : ''} disabled:opacity-40`}
      >
        {current.icon}
        {!iconOnly && <span>{current.label}</span>}
        <svg className="h-3 w-3 opacity-60" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="m3 4.5 3 3 3-3" />
        </svg>
      </button>
      {open && createPortal(
        <div
          ref={menuRef}
          role="menu"
          aria-label="Mode"
          className="lens-popover fixed z-[1200] p-1"
          style={{ top: position.top, left: position.left, width: 'min(300px, calc(100vw - 16px))' }}
        >
          {MODES.map((mode) => (
            <button
              key={mode.label}
              type="button"
              role="menuitemradio"
              aria-checked={mode.suggesting === isSuggestionMode}
              onClick={() => {
                setOpen(false);
                if (mode.suggesting !== isSuggestionMode) onChange(mode.suggesting);
              }}
              className="lens-menu-item"
            >
              <span className="lens-menu-item-icon">{mode.icon}</span>
              <span className="min-w-0 flex-1">
                <span className="lens-menu-item-label block text-sm leading-5">{mode.label}</span>
                <span className="lens-menu-item-description">{mode.description}</span>
              </span>
              {mode.suggesting === isSuggestionMode && <MenuCheck />}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}
