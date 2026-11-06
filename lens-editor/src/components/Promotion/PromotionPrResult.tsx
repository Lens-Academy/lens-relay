import type { PromotionPrResponse } from '../../lib/promotion-api';

const HEADING: Record<PromotionPrResponse['merge'], string> = {
  merged: 'Merged to production',
  'auto-merge': 'Pull request created',
  open: 'Not merged yet',
};

/** What became of a promotion's pull request, with its link. The Promotion page and the one-file dialog both show it. */
export function PromotionPrResult({ response, className = '' }: { response: PromotionPrResponse; className?: string }) {
  const open = response.merge === 'open';
  const note =
    response.merge === 'merged'
      ? 'The change is in production now.'
      : response.merge === 'auto-merge'
        ? "Auto-merge is on: GitHub merges it once production's required checks or reviews pass."
        : response.warning || 'The pull request is open. Merge it on GitHub.';

  return (
    <section
      aria-label="Promotion result"
      className={`rounded-md border px-4 py-3 text-sm ${open ? 'border-amber-200 bg-amber-50 text-amber-950' : 'border-emerald-200 bg-emerald-50 text-emerald-950'} ${className}`}
    >
      <h2 className="font-semibold">{HEADING[response.merge]}</h2>
      <a href={response.prUrl} target="_blank" rel="noreferrer" className="mt-1 inline-block font-medium underline">
        Pull request #{response.prNumber}
      </a>
      {response.branch && <div className="mt-1 font-mono text-xs opacity-80">{response.branch}</div>}
      <p className="mt-2">{note}</p>
    </section>
  );
}
