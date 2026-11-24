/** The small blue tick on an idea that is in the selection of several. */
export function ChosenTick({ className = '' }: { className?: string }) {
  return (
    <span className={`flex h-4 w-4 items-center justify-center rounded-full bg-blue-600 text-white ${className}`} aria-hidden="true" data-testid="idea-chosen-tick">
      <svg className="h-2.5 w-2.5" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M2.5 6.5 5 9l4.5-5.5" />
      </svg>
    </span>
  );
}
