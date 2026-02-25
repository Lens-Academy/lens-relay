import { useState, useEffect, useRef } from 'react';
import { useDisplayName } from '../../contexts/DisplayNameContext';

interface DisplayNameBadgeProps {
  /** When true, show only the avatar initial, hide name text */
  compact?: boolean;
}

export function DisplayNameBadge({ compact = false }: DisplayNameBadgeProps) {
  const { displayName, setDisplayName } = useDisplayName();
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  // Auto-focus input when entering edit mode
  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  // Don't render if no display name (prompt overlay handles this)
  if (!displayName) return null;

  const startEditing = () => {
    setEditValue(displayName);
    setEditing(true);
  };

  const cancelEditing = () => {
    setEditing(false);
    setEditValue('');
  };

  const commitEdit = () => {
    const trimmed = editValue.trim();
    if (trimmed.length > 0 && !/clyde/i.test(trimmed)) {
      setDisplayName(trimmed);
    }
    setEditing(false);
    setEditValue('');
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitEdit();
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      cancelEditing();
    }
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        type="text"
        value={editValue}
        onChange={(e) => setEditValue(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={commitEdit}
        maxLength={66}
        className="text-sm px-2 py-1 border border-blue-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
      />
    );
  }

  if (compact) {
    return (
      <button
        onClick={startEditing}
        title={displayName}
        className="w-8 h-8 rounded-full bg-gray-200 text-gray-700 text-sm font-medium flex items-center justify-center hover:bg-gray-300 transition-colors cursor-pointer"
      >
        {displayName.charAt(0).toUpperCase()}
      </button>
    );
  }

  return (
    <button
      onClick={startEditing}
      className="group flex items-center gap-1 text-sm text-gray-600 hover:text-gray-900 hover:bg-gray-100 px-2 py-1 rounded transition-colors cursor-pointer"
    >
      <span>{displayName}</span>
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="opacity-0 group-hover:opacity-100 transition-opacity"
      >
        <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
      </svg>
    </button>
  );
}
