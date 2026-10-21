// src/lib/criticmarkup-actions.ts
import { parse, type CriticMarkupRange } from './criticmarkup-parser';

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

/**
 * The parts of `text` that stay when every CriticMarkup change in it is
 * accepted, in order and apart: an addition's or a highlight's text without
 * its delimiters and metadata, a substitution's new text, and nothing of a
 * deletion or a comment. A change nested in another (a deletion of part of
 * someone's addition) is accepted too.
 */
export function acceptedPieces(text: string): { from: number; to: number }[] {
  // What accepting each change takes out
  const cuts: { from: number; to: number }[] = [];
  for (const range of parse(text)) {
    if (range.type === 'deletion' || range.type === 'comment') {
      cuts.push({ from: range.from, to: range.to });
    } else {
      const keptFrom = range.type === 'substitution'
        ? range.contentTo - (range.newContent ?? '').length
        : range.contentFrom;
      cuts.push({ from: range.from, to: keptFrom }, { from: range.contentTo, to: range.to });
    }
  }
  cuts.sort((a, b) => a.from - b.from);
  const pieces: { from: number; to: number }[] = [];
  let pos = 0;
  for (const cut of cuts) {
    if (cut.from > pos) pieces.push({ from: pos, to: cut.from });
    pos = Math.max(pos, cut.to);
  }
  if (pos < text.length) pieces.push({ from: pos, to: text.length });
  return pieces;
}
