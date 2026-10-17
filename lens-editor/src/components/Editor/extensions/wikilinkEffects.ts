import { StateEffect } from '@codemirror/state';

/**
 * StateEffect dispatched when wikilink metadata changes (e.g., file renames).
 * Triggers decoration rebuild so widget resolution state updates.
 */
export const wikilinkMetadataChanged = StateEffect.define<void>();
