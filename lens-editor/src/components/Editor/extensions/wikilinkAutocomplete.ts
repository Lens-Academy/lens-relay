import { autocompletion } from '@codemirror/autocomplete';
import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete';
import type { EditorView } from '@codemirror/view';
import type { FolderMetadata } from '../../../hooks/useFolderMetadata';
import { computeRelativePath } from '../../../lib/document-resolver';

const SEPARATOR = /[\s_-]/;

/**
 * Lowercase and treat every run of spaces, dashes and underscores as one
 * space, so "what cognitive" finds "what-cognitive-biases". `starts[i]` is
 * the index in `text` where normalised character i came from, for highlighting.
 */
export function normalizeForSearch(text: string): { text: string; starts: number[] } {
  let out = '';
  const starts: number[] = [];
  for (let i = 0; i < text.length; i++) {
    if (SEPARATOR.test(text[i])) {
      if (out.endsWith(' ')) continue;
      out += ' ';
    } else {
      out += text[i].toLowerCase();
    }
    starts.push(i);
  }
  return { text: out, starts };
}

/** Range in `label` (as [from, to] pairs) covered by the normalised `query`, or null. */
export function matchLabel(label: string, query: string): number[] | null {
  const q = normalizeForSearch(query).text;
  if (!q) return [];
  const { text, starts } = normalizeForSearch(label);
  const at = text.indexOf(q);
  if (at < 0) return null;
  const end = at + q.length;
  return [starts[at], end < starts.length ? starts[end] : label.length];
}

/**
 * Create a completion source for wikilinks.
 * Triggers when user types [[ and provides document name suggestions.
 */
export function createWikilinkCompletionSource(
  getMetadata: () => FolderMetadata | null,
  getCurrentFilePath: () => string | null = () => null,
) {
  return (context: CompletionContext): CompletionResult | null => {
    // Match [[ followed by any non-] characters
    const before = context.matchBefore(/\[\[[^\]]*$/);
    if (!before) return null;

    // Extract the query (text after [[)
    const query = before.text.slice(2);
    const normalizedQuery = normalizeForSearch(query).text;

    // Get current metadata
    const metadata = getMetadata();
    if (!metadata) return null;

    // Check if ]] already exists after cursor (from closeBrackets)
    const after = context.state.sliceDoc(context.pos, context.pos + 2);
    const hasClosingBrackets = after === ']]';

    const currentFilePath = getCurrentFilePath();

    // Build document options from metadata
    const options: { label: string; apply: string | ((view: EditorView, completion: Completion, from: number, to: number) => void); boost?: number; match: number[] }[] = [];

    for (const [path, meta] of Object.entries(metadata)) {
      if (meta.type !== 'markdown') continue;

      const name = currentFilePath
        ? computeRelativePath(currentFilePath, path)
        : path.slice(1).replace(/\.md$/i, ''); // absolute without leading /

      // Filter by query, ignoring case and the difference between spaces, dashes and underscores
      const match = matchLabel(name, query);
      if (!match) continue;

      options.push({
        label: name,
        // When ]] exists (from closeBrackets), replace through it and place cursor after
        apply: hasClosingBrackets
          ? (view: EditorView, _completion: Completion, from: number, to: number) => {
              view.dispatch({
                changes: { from, to: to + 2, insert: name + ']]' },
                selection: { anchor: from + name.length + 2 },
              });
            }
          : `${name}]]`,
        // Boost exact prefix matches
        boost: normalizeForSearch(name).text.startsWith(normalizedQuery) ? 1 : 0,
        match,
      });
    }

    // Sort alphabetically, with boosted items first
    options.sort((a, b) => {
      if ((b.boost || 0) !== (a.boost || 0)) {
        return (b.boost || 0) - (a.boost || 0);
      }
      return a.label.localeCompare(b.label);
    });

    // Start from after [[ (position where query begins)
    const fromPos = before.from + 2;
    return {
      from: fromPos,
      options,
      // We filter and order ourselves: CodeMirror's fuzzy filter would drop
      // "what cognitive" against "what-cognitive-biases". Without validFor the
      // source runs again on every keystroke.
      filter: false,
      getMatch: (completion) => (completion as Completion & { match?: number[] }).match ?? [],
    };
  };
}

/**
 * Create wikilink autocomplete extension.
 * Pass getter functions for metadata and current file path to avoid stale closures.
 */
export function wikilinkAutocomplete(
  getMetadata: () => FolderMetadata | null,
  getCurrentFilePath: () => string | null = () => null,
) {
  return autocompletion({
    override: [createWikilinkCompletionSource(getMetadata, getCurrentFilePath)],
    // Show immediately after [[, don't wait for more characters
    activateOnTyping: true,
    // Close on blur
    closeOnBlur: true,
    // Max items to show
    maxRenderedOptions: 20,
  });
}
