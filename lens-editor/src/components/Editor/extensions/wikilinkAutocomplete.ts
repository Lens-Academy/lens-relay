import { autocompletion } from '@codemirror/autocomplete';
import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete';
import type { EditorView } from '@codemirror/view';
import type { FolderMetadata } from '../../../hooks/useFolderMetadata';
import { computeRelativePath } from '../../../lib/document-resolver';

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
    const query = before.text.slice(2).toLowerCase();

    // Get current metadata
    const metadata = getMetadata();
    if (!metadata) return null;

    // Check if ]] already exists after cursor (from closeBrackets)
    const after = context.state.sliceDoc(context.pos, context.pos + 2);
    const hasClosingBrackets = after === ']]';

    const currentFilePath = getCurrentFilePath();

    // Build document options from metadata
    const options: { label: string; apply: string | ((view: EditorView, completion: Completion, from: number, to: number) => void); boost?: number }[] = [];

    for (const [path, meta] of Object.entries(metadata)) {
      if (meta.type !== 'markdown') continue;

      const name = currentFilePath
        ? computeRelativePath(currentFilePath, path)
        : path.slice(1).replace(/\.md$/i, ''); // absolute without leading /

      // Filter by query
      if (query && !name.toLowerCase().includes(query)) continue;

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
        boost: name.toLowerCase().startsWith(query) ? 1 : 0,
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
      validFor: /^[^\]]*$/, // Valid while no ] typed
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
