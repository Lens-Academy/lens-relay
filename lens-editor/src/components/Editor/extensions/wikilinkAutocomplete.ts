import { autocompletion } from '@codemirror/autocomplete';
import type { CompletionContext, CompletionResult } from '@codemirror/autocomplete';
import type { FolderMetadata } from '../../../hooks/useFolderMetadata';

/**
 * Create a completion source for wikilinks.
 * Triggers when user types [[ and provides document name suggestions.
 */
export function createWikilinkCompletionSource(getMetadata: () => FolderMetadata | null) {
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

    // Build document options from metadata
    const options: { label: string; apply: string; boost?: number }[] = [];

    for (const [path, meta] of Object.entries(metadata)) {
      if (meta.type !== 'markdown') continue;

      // Extract filename without extension
      const filename = path.split('/').pop() || '';
      const name = filename.replace(/\.md$/i, '');

      // Filter by query
      if (query && !name.toLowerCase().includes(query)) continue;

      options.push({
        label: name,
        // Only add ]] if not already present
        apply: hasClosingBrackets ? name : `${name}]]`,
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
 * Pass a getter function for metadata to avoid stale closures.
 */
export function wikilinkAutocomplete(getMetadata: () => FolderMetadata | null) {
  return autocompletion({
    override: [createWikilinkCompletionSource(getMetadata)],
    // Show immediately after [[, don't wait for more characters
    activateOnTyping: true,
    // Close on blur
    closeOnBlur: true,
    // Max items to show
    maxRenderedOptions: 20,
  });
}
