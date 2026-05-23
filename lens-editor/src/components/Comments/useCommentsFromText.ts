// src/components/Comments/useCommentsFromText.ts
import { parse, parseThreads, type CommentThread } from '../../lib/criticmarkup-parser';

/**
 * Variant for callers that don't have a CodeMirror EditorView available
 * (e.g. EduEditor's read-only renderers). Parses directly from the source
 * markdown string.
 *
 * Like useComments, this is a pure function — caller controls
 * re-rendering by passing freshly-stringified text.
 */
export function useCommentsFromText(text: string | null): CommentThread[] {
  if (!text) return [];
  const ranges = parse(text);
  return parseThreads(ranges);
}
