// src/components/SegmentedToggle/SegmentedToggle.tsx
import type { ReactNode } from 'react';

export type SegmentedValue = 'left' | 'right';

interface SegmentedToggleProps {
  leftLabel: ReactNode;
  rightLabel: ReactNode;
  value: SegmentedValue;
  onChange: (value: SegmentedValue) => void;
  disabled?: boolean;
  ariaLabel?: string;
  /** Tooltip for left option */
  leftTitle?: string;
  /** Tooltip for right option */
  rightTitle?: string;
  /** Extra classes on the track, e.g. to make it fill its row */
  className?: string;
}

/**
 * A segmented toggle control showing two options side-by-side in a grey
 * track; the active option is a raised white segment (index.css,
 * `.lens-segmented`, with its dark-mode colours).
 */
export function SegmentedToggle({
  leftLabel,
  rightLabel,
  value,
  onChange,
  disabled = false,
  ariaLabel,
  leftTitle,
  rightTitle,
  className = '',
}: SegmentedToggleProps) {
  const handleClick = (newValue: SegmentedValue) => {
    if (newValue !== value) {
      onChange(newValue);
    }
  };

  const option = (side: SegmentedValue, label: ReactNode, title?: string) => (
    <button
      type="button"
      onClick={() => handleClick(side)}
      disabled={disabled}
      title={title}
      aria-pressed={value === side}
      className={`lens-segmented-option${value === side ? ' is-active' : ''}`}
    >
      {label}
    </button>
  );

  return (
    <div role="group" aria-label={ariaLabel} className={`lens-segmented ${className}`.trim()}>
      {option('left', leftLabel, leftTitle)}
      {option('right', rightLabel, rightTitle)}
    </div>
  );
}
