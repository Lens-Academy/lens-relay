import { autocompletion } from '@codemirror/autocomplete';
import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete';
import type { EditorView } from '@codemirror/view';
import type { FolderMetadata } from '../../../hooks/useFolderMetadata';
import { computeRelativePath, isLinkTarget } from '../../../lib/document-resolver';

const SEPARATOR = /[\s_-]/;

/**
 * Lowercase and treat every run of spaces, dashes and underscores as one
 * space, so "what cognitive" finds "what-cognitive-biases".
 */
export function normalizeForSearch(text: string): string {
  const lower = text.toLowerCase();
  // Fast path; the slow one keeps offsets when lowercasing changes length.
  if (lower.length === text.length) return lower.replace(/[\s_-]+/g, ' ');
  let out = '';
  for (const ch of text) {
    if (SEPARATOR.test(ch)) {
      if (!out.endsWith(' ')) out += ' ';
    } else {
      out += lowerChar(ch);
    }
  }
  return out;
}

// One char in, one char out, so normalised offsets map back to the label
// (a few characters, such as İ, lowercase to two code units).
function lowerChar(ch: string): string {
  const lower = ch.toLowerCase();
  return lower.length === ch.length ? lower : ch;
}

/** Map a [from, to) range in normalizeForSearch(label) back to label offsets. */
function originalRange(label: string, from: number, to: number): [number, number] {
  let n = 0;
  let start = label.length;
  let i = 0;
  for (const ch of label) {
    const separator = SEPARATOR.test(ch);
    // A run of separators is one normalised space, emitted by its first char.
    const startsChar = !separator || i === 0 || !SEPARATOR.test(label[i - 1]);
    if (startsChar) {
      if (n === from) start = i;
      if (n === to) return [start, i];
      n += separator ? 1 : ch.length; // offsets are UTF-16 units, like indexOf's
    }
    i += ch.length;
  }
  return [start, label.length];
}

/**
 * How well `label` matches the normalised query, lower is better, or null:
 * 0 file name equals the query, 1 file name starts with it, 2 it starts a
 * word, 3 anywhere. `range` is the match in label offsets, for highlighting.
 */
export function matchLabel(
  label: string,
  normalizedQuery: string,
  text = normalizeForSearch(label),
): { rank: number; range: [number, number] } | null {
  if (!normalizedQuery) return { rank: 3, range: [0, 0] };
  const baseStart = text.lastIndexOf('/') + 1;
  let at = text.indexOf(normalizedQuery, baseStart);
  if (at < 0) at = text.indexOf(normalizedQuery);
  if (at < 0) return null;
  // Prefer an occurrence that starts a word.
  for (let i = at; i !== -1; i = text.indexOf(normalizedQuery, i + 1)) {
    if (i === 0 || text[i - 1] === ' ' || text[i - 1] === '/') {
      at = i;
      break;
    }
  }
  let rank = 3;
  if (at === baseStart && text.length - baseStart === normalizedQuery.length) rank = 0;
  else if (at === baseStart) rank = 1;
  else if (at === 0 || text[at - 1] === ' ' || text[at - 1] === '/') rank = 2;
  return { rank, range: originalRange(label, at, at + normalizedQuery.length) };
}

interface WikilinkOption extends Completion {
  rank: number;
  range: [number, number];
}

/**
 * Create a completion source for wikilinks.
 * Triggers when user types [[ and provides document name suggestions.
 */
export function createWikilinkCompletionSource(
  getMetadata: () => FolderMetadata | null,
  getCurrentFilePath: () => string | null = () => null,
) {
  // Link text and its normalised form per file, rebuilt only when the
  // metadata or the current file changes (the source runs on every keystroke).
  let cache: { metadata: FolderMetadata; currentFilePath: string | null; names: { name: string; text: string }[] } | null = null;
  const namesFor = (metadata: FolderMetadata, currentFilePath: string | null) => {
    if (cache?.metadata !== metadata || cache.currentFilePath !== currentFilePath) {
      const names: { name: string; text: string }[] = [];
      for (const [path, meta] of Object.entries(metadata)) {
        if (!isLinkTarget(path, meta)) continue;
        const name = currentFilePath
          ? computeRelativePath(currentFilePath, path)
          : path.slice(1).replace(/\.(md|html)$/i, ''); // absolute without leading /
        names.push({ name, text: normalizeForSearch(name) });
      }
      cache = { metadata, currentFilePath, names };
    }
    return cache.names;
  };

  return (context: CompletionContext): CompletionResult | null => {
    // Match [[ followed by any non-] characters
    const before = context.matchBefore(/\[\[[^\]]*$/);
    if (!before) return null;

    // Extract the query (text after [[)
    const normalizedQuery = normalizeForSearch(before.text.slice(2));

    // Get current metadata
    const metadata = getMetadata();
    if (!metadata) return null;

    // Check if ]] already exists after cursor (from closeBrackets)
    const after = context.state.sliceDoc(context.pos, context.pos + 2);
    const hasClosingBrackets = after === ']]';

    const currentFilePath = getCurrentFilePath();

    // Build document options from metadata
    const options: WikilinkOption[] = [];

    for (const { name, text } of namesFor(metadata, currentFilePath)) {
      // Filter by query, ignoring case and the difference between spaces, dashes and underscores
      const match = matchLabel(name, normalizedQuery, text);
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
        rank: match.rank,
        range: match.range,
      });
    }

    // Best match first (see matchLabel), then shorter paths, then alphabetical
    options.sort((a, b) =>
      a.rank - b.rank || a.label.length - b.label.length || a.label.localeCompare(b.label),
    );

    // Start from after [[ (position where query begins)
    const fromPos = before.from + 2;
    return {
      from: fromPos,
      options,
      // We filter and order ourselves: CodeMirror's fuzzy filter would drop
      // "what cognitive" against "what-cognitive-biases". Without validFor the
      // source runs again on every keystroke.
      filter: false,
      getMatch: (completion) => {
        const [from, to] = (completion as WikilinkOption).range;
        return from < to ? [from, to] : [];
      },
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
