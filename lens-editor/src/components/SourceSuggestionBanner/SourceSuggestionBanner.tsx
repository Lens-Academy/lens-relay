import { useAuth } from '../../contexts/AuthContext';

interface SourceSuggestionBannerProps {
  onSwitchToPreview: () => void;
  onSwitchToEditing: () => void;
}

/**
 * Banner shown when source mode and suggestion mode are both active.
 * The editor is read-only in this state to prevent nested CriticMarkup.
 */
export function SourceSuggestionBanner({ onSwitchToPreview, onSwitchToEditing }: SourceSuggestionBannerProps) {
  const { canEdit } = useAuth();

  return (
    <div className="mx-auto max-w-[700px] w-full px-6">
      <div className="flex items-center gap-3 px-4 py-2.5 bg-amber-50 border border-amber-200 rounded-md text-sm text-amber-800">
        <span className="flex-1">Source mode is read-only while suggesting.</span>
        <button
          onClick={onSwitchToPreview}
          className="px-3 py-1 rounded bg-amber-100 hover:bg-amber-200 font-medium transition-colors cursor-pointer"
        >
          Live Preview
        </button>
        {canEdit && (
          <button
            onClick={onSwitchToEditing}
            className="px-3 py-1 rounded bg-amber-100 hover:bg-amber-200 font-medium transition-colors cursor-pointer"
          >
            Switch to Editing
          </button>
        )}
      </div>
    </div>
  );
}
