/**
 * Banner shown when source mode and suggestion mode are both active.
 * The editor is read-only in this state to prevent nested CriticMarkup.
 */
export function SourceSuggestionBanner() {
  return (
    <div className="mx-auto max-w-[700px] w-full px-6">
      <div className="px-4 py-2.5 bg-amber-50 border border-amber-200 rounded-md text-sm text-amber-800">
        Source mode is read-only while suggesting. Switch to Live Preview or Editing to make changes.
      </div>
    </div>
  );
}
