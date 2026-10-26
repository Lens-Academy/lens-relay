import { useState, useEffect, useRef } from 'react';
import { useCollaborators } from '../../hooks/useCollaborators';
import { useDisplayName } from '../../contexts/DisplayNameContext';
import { Tooltip } from '../Tooltip/Tooltip';

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
    <div className="lens-avatar-stack flex items-center px-1">
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
        <Tooltip label={`${self.name} (you): click to change your name`}>
          <button
            onClick={startEditing}
            className="lens-avatar cursor-pointer"
            style={{ backgroundColor: self.color }}
            aria-label={`${self.name} (you): change your name`}
          >
            {self.name.charAt(0).toUpperCase()}
          </button>
        </Tooltip>
      )}

      {/* Other users - stacked with overlap */}
      {visibleOthers.map((user) => (
        <Tooltip key={user.clientId} label={user.name}>
          <span className="lens-avatar" style={{ backgroundColor: user.color }}>
            {user.name.charAt(0).toUpperCase()}
          </span>
        </Tooltip>
      ))}

      {/* Overflow indicator */}
      {overflowCount > 0 && (
        <Tooltip label={`${overflowCount} more ${overflowCount === 1 ? 'user' : 'users'}`}>
          <span className="lens-avatar lens-avatar-more">+{overflowCount}</span>
        </Tooltip>
      )}
    </div>
  );
}
