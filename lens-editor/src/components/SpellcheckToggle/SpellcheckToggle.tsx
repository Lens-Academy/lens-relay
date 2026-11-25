import { MenuSwitchRow } from '../Menu/MenuSwitchRow';
import type { SpellcheckSetting } from './useSpellcheckSetting';

// Heroicons "check" with a text glyph: spelling checked.
function SpellcheckIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="w-4 h-4"
      aria-hidden="true"
    >
      <path d="M2.5 13.5 5.5 5l3 8.5M3.6 10.5h3.8" />
      <path d="M10.5 12.5 12.5 15 17.5 8.5" />
    </svg>
  );
}

/** Spellcheck, a switch in the page menu (its setting: useSpellcheckSetting) */
export function SpellcheckToggle({ setting, disabled = false }: { setting: SpellcheckSetting; disabled?: boolean }) {
  return (
    <MenuSwitchRow
      icon={<SpellcheckIcon />}
      label="Spellcheck"
      description="English only"
      checked={setting.enabled}
      onToggle={setting.toggle}
      disabled={disabled}
    />
  );
}
