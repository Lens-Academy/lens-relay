import type { SuggestionItem } from '../hooks/useSuggestions';
import { relayHeaders } from './relay-api';

/** Sentinel error message: the suggestion itself failed to apply (vs a
 * transport/server error, which should leave the row pending/retryable). */
export const SUGGESTION_NOT_FOUND = 'suggestion-not-found';

export interface BatchResult {
  applied: SuggestionItem[];
  failed: SuggestionItem[];
}

interface ApplyResponse {
  applied: number[];
  failed: { index: number; reason: string }[];
  remaining_suggestions: number;
}

/**
 * Apply accept/reject to many suggestions of one document server-side via
 * POST /api/relay/suggestions/apply, so the review page never has to open a
 * Y.Doc websocket per file (which crashed weak machines at the
 * 5000-suggestion/200-file scale). The response references suggestions by
 * index into the request array; this maps them back to SuggestionItems so
 * callers get a BatchResult of the items themselves.
 *
 * `folderId` is the compound folder doc id the suggestions were fetched for
 * (same value the GET /suggestions query uses), passed as a query param; the
 * proxy checks it against folder-scoped share tokens and the relay verifies
 * the doc belongs to it.
 */
export async function applySuggestionActionsViaServer(
  docId: string,
  folderId: string,
  suggestions: SuggestionItem[],
  action: 'accept' | 'reject',
): Promise<BatchResult> {
  if (suggestions.length === 0) return { applied: [], failed: [] };

  const res = await fetch(`/api/relay/suggestions/apply?folder_id=${encodeURIComponent(folderId)}`, {
    method: 'POST',
    headers: relayHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      doc_id: docId,
      action,
      suggestions: suggestions.map(s => ({
        raw_markup: s.raw_markup,
        type: s.type,
        content: s.content,
        old_content: s.old_content,
        new_content: s.new_content,
      })),
    }),
    // Bound the wait: a hung relay must surface as an error, not a stuck
    // "Applying…" state. Generous because a batch may span many suggestions.
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    throw new Error(`Failed to apply suggestions: ${res.status}`);
  }

  const json = await res.json() as ApplyResponse;
  const inRange = (i: number) => Number.isInteger(i) && i >= 0 && i < suggestions.length;
  const applied = json.applied.filter(inRange).map(i => suggestions[i]);
  const failed = json.failed.filter(f => inRange(f.index)).map(f => suggestions[f.index]);
  if (json.failed.length > 0) {
    console.warn(
      `[suggestions/apply] ${json.failed.length} suggestion(s) failed for doc ${docId}:`,
      json.failed.map(f => f.reason),
    );
  }
  return { applied, failed };
}
