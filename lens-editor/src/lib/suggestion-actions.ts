import * as Y from 'yjs';
import type { SuggestionItem } from '../hooks/useSuggestions';
import { surgicalDeletions } from './criticmarkup-surgical';

/**
 * Apply accept/reject to a suggestion in a Y.Doc.
 * Uses `raw_markup` from the server to find the exact string (avoids reconstruction fragility).
 * Searches near `suggestion.from` first, then falls back to searching the entire doc.
 */
export function applySuggestionAction(
  doc: Y.Doc,
  suggestion: SuggestionItem,
  action: 'accept' | 'reject',
) {
  const text = doc.getText('contents');
  const content = text.toString();

  const markup = suggestion.raw_markup;
  // Search near the expected position first (within 200 chars), then fall back to full search
  let idx = content.indexOf(markup, Math.max(0, suggestion.from - 200));
  if (idx === -1) {
    idx = content.indexOf(markup);
  }
  if (idx === -1) {
    throw new Error('Suggestion no longer found in document');
  }

  // Surgical path: delete only markers/metadata/discarded content so the kept
  // payload keeps its original authorship (clientID). Falls back to the legacy
  // whole-span rewrite when the markup structure can't be verified.
  const deletions = surgicalDeletions({
    markup,
    start: idx,
    type: suggestion.type,
    action,
    content: suggestion.content,
    oldContent: suggestion.old_content,
    newContent: suggestion.new_content,
  });

  doc.transact(() => {
    if (deletions) {
      for (const d of [...deletions].sort((a, b) => b.from - a.from)) {
        text.delete(d.from, d.to - d.from);
      }
    } else {
      const replacement = action === 'accept'
        ? getAcceptText(suggestion)
        : getRejectText(suggestion);
      text.delete(idx, markup.length);
      if (replacement) {
        text.insert(idx, replacement);
      }
    }
  });
}

export interface BatchResult {
  applied: SuggestionItem[];
  failed: SuggestionItem[];
}

/**
 * Apply accept/reject to many suggestions of one Y.Doc in a single transaction,
 * so the provider syncs the whole batch in one round-trip instead of one per
 * suggestion. Applies in descending `from` order so earlier applies don't shift
 * the positions of later ones. A suggestion whose markup is no longer present
 * is reported in `failed` without aborting the rest.
 */
export function applySuggestionActions(
  doc: Y.Doc,
  suggestions: SuggestionItem[],
  action: 'accept' | 'reject',
): BatchResult {
  const applied: SuggestionItem[] = [];
  const failed: SuggestionItem[] = [];

  doc.transact(() => {
    for (const s of [...suggestions].sort((a, b) => b.from - a.from)) {
      try {
        applySuggestionAction(doc, s, action);
        applied.push(s);
      } catch {
        failed.push(s);
      }
    }
  });

  return { applied, failed };
}

export function getAcceptText(s: SuggestionItem): string {
  switch (s.type) {
    case 'addition': return s.content;
    case 'deletion': return '';
    case 'substitution': return s.new_content ?? '';
  }
}

export function getRejectText(s: SuggestionItem): string {
  switch (s.type) {
    case 'addition': return '';
    case 'deletion': return s.content;
    case 'substitution': return s.old_content ?? '';
  }
}
