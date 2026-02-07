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
}

/**
 * A segmented toggle control showing two options side-by-side.
 * The active option is highlighted with a white background.
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
}: SegmentedToggleProps) {
  const handleClick = (newValue: SegmentedValue) => {
    if (newValue !== value) {
      onChange(newValue);
    }
  };

  const baseButtonClass =
    'px-3 py-1 text-xs font-medium transition-colors rounded';
  const activeClass = 'bg-white text-gray-900 shadow-sm';
  const inactiveClass = 'text-gray-500 hover:text-gray-700';
  const disabledClass = 'opacity-50 cursor-not-allowed';

  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className="inline-flex items-center bg-gray-100 rounded p-0.5"
    >
      <button
        type="button"
        onClick={() => handleClick('left')}
        disabled={disabled}
        title={leftTitle}
        className={`${baseButtonClass} ${value === 'left' ? activeClass : inactiveClass} ${disabled ? disabledClass : ''}`}
      >
        {leftLabel}
      </button>
      <button
        type="button"
        onClick={() => handleClick('right')}
        disabled={disabled}
        title={rightTitle}
        className={`${baseButtonClass} ${value === 'right' ? activeClass : inactiveClass} ${disabled ? disabledClass : ''}`}
      >
        {rightLabel}
      </button>
    </div>
  );
}
