import { useCollaborators } from '../../hooks/useCollaborators';

const MAX_VISIBLE_AVATARS = 3;

export function PresencePanel() {
  const { self, others } = useCollaborators();

  const visibleOthers = others.slice(0, MAX_VISIBLE_AVATARS);
  const overflowCount = others.length - MAX_VISIBLE_AVATARS;

  return (
    <div className="flex items-center">
      {/* Self avatar with blue ring to distinguish */}
      <div
        className="relative w-8 h-8 rounded-full flex items-center justify-center text-white text-sm font-medium ring-2 ring-blue-500 group"
        style={{ backgroundColor: self.color }}
      >
        {self.name.charAt(0).toUpperCase()}
        {/* Tooltip */}
        <div className="absolute top-full left-1/2 -translate-x-1/2 mt-2 px-2 py-1 bg-gray-900 text-white text-xs rounded opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap pointer-events-none z-10">
          {self.name} (you)
        </div>
      </div>

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
