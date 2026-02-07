// src/lib/criticmarkup-actions.ts
import type { CriticMarkupRange } from './criticmarkup-parser';

/**
 * Accept a CriticMarkup change, returning the modified document.
 * - Addition: keep content, remove delimiters
 * - Deletion: remove entire markup (content is deleted)
 * - Substitution: keep new content
 * - Highlight: keep content, remove delimiters
 * - Comment: remove entire markup
 */
export function acceptChange(doc: string, range: CriticMarkupRange): string {
  const before = doc.slice(0, range.from);
  const after = doc.slice(range.to);

  switch (range.type) {
    case 'addition':
      return before + range.content + after;
    case 'deletion':
      return before + after;
    case 'substitution':
      return before + (range.newContent ?? '') + after;
    case 'highlight':
      return before + range.content + after;
    case 'comment':
      // Accepting a comment just removes it
      return before + after;
    default:
      return doc;
  }
}

/**
 * Reject a CriticMarkup change, returning the modified document.
 * - Addition: remove entire markup (content is not added)
 * - Deletion: keep content, remove delimiters
 * - Substitution: keep old content
 * - Highlight: keep content, remove delimiters
 * - Comment: remove entire markup
 */
export function rejectChange(doc: string, range: CriticMarkupRange): string {
  const before = doc.slice(0, range.from);
  const after = doc.slice(range.to);

  switch (range.type) {
    case 'addition':
      return before + after;
    case 'deletion':
      return before + range.content + after;
    case 'substitution':
      return before + (range.oldContent ?? '') + after;
    case 'highlight':
      return before + range.content + after;
    case 'comment':
      // Rejecting a comment removes it
      return before + after;
    default:
      return doc;
  }
}
