import { useState, useEffect, useRef } from 'react';
import { useCollaborators } from '../../hooks/useCollaborators';
import { useDisplayName } from '../../contexts/DisplayNameContext';

const MAX_VISIBLE_AVATARS = 3;

export function PresencePanel() {
  const { self, others } = useCollaborators();
  const { displayName, setDisplayName } = useDisplayName();
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const startEditing = () => {
    setEditValue(displayName || self.name);
    setEditing(true);
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
    if (e.key === 'Enter') { e.preventDefault(); commitEdit(); }
    if (e.key === 'Escape') { e.preventDefault(); setEditing(false); setEditValue(''); }
  };

  const visibleOthers = others.slice(0, MAX_VISIBLE_AVATARS);
  const overflowCount = others.length - MAX_VISIBLE_AVATARS;

  return (
    <div className="flex items-center">
      {/* Self avatar — click to edit display name */}
      {editing ? (
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
      ) : (
        <button
          onClick={startEditing}
          className="relative w-8 h-8 rounded-full flex items-center justify-center text-white text-sm font-medium ring-2 ring-blue-500 group cursor-pointer"
          style={{ backgroundColor: self.color }}
          title={`${self.name} (click to edit)`}
        >
          {self.name.charAt(0).toUpperCase()}
          {/* Tooltip */}
          <div className="absolute top-full left-1/2 -translate-x-1/2 mt-2 px-2 py-1 bg-gray-900 text-white text-xs rounded opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap pointer-events-none z-10">
            {self.name} (you)
          </div>
        </button>
      )}

      {/* Other users - stacked with overlap */}
      {visibleOthers.map((user) => (
        <div
          key={user.clientId}
          className="relative w-8 h-8 rounded-full flex items-center justify-center text-white text-sm font-medium -ml-2 ring-2 ring-white group"
          style={{ backgroundColor: user.color }}
        >
          {user.name.charAt(0).toUpperCase()}
          {/* Tooltip */}
          <div className="absolute top-full left-1/2 -translate-x-1/2 mt-2 px-2 py-1 bg-gray-900 text-white text-xs rounded opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap pointer-events-none z-10">
            {user.name}
          </div>
        </div>
      ))}

      {/* Overflow indicator */}
      {overflowCount > 0 && (
        <div
          className="relative w-8 h-8 rounded-full flex items-center justify-center text-gray-600 text-xs font-medium bg-gray-200 -ml-2 ring-2 ring-white group"
        >
          +{overflowCount}
          {/* Tooltip */}
          <div className="absolute top-full left-1/2 -translate-x-1/2 mt-2 px-2 py-1 bg-gray-900 text-white text-xs rounded opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap pointer-events-none z-10">
            {overflowCount} more {overflowCount === 1 ? 'user' : 'users'}
          </div>
        </div>
      )}
    </div>
  );
}
