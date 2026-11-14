/**
 * Words and characters in the editor's selection, for the counter shown at the
 * bottom right of the editor while text is selected.
 *
 * Counts the text as written (Markdown marks included), minus what suggestions
 * and comments add to it: comment threads ({>>…<<}), the author/time metadata
 * of a suggestion ({"author":…}@@) and the {++ ++}-style delimiters. A word is a run of
 * letters or digits, so "don't" and "e-mail" count as one word each and lone
 * punctuation or list markers count as none. Characters are Unicode code
 * points, spaces and line breaks included, so an emoji counts as one.
 */

const WORD = /[\p{L}\p{N}\p{M}]+(?:['’-][\p{L}\p{N}\p{M}]+)*/gu;

export interface SelectionCount {
  words: number;
  characters: number;
}

// Comment threads; a suggestion's metadata; the delimiters
const CRITIC_HIDDEN = /\{>>[\s\S]*?<<\}|\{"[^}]*\}@@|\{\+\+|\+\+\}|\{--|--\}|\{~~|~>|~~\}|\{==|==\}/g;

export function countText(raw: string): SelectionCount {
  const text = raw.replace(CRITIC_HIDDEN, '');
  return { words: text.match(WORD)?.length ?? 0, characters: Array.from(text).length };
}

/** Sums the counts of several selected ranges (multiple cursors). */
export function countSelections(texts: string[]): SelectionCount {
  return texts.reduce<SelectionCount>((sum, text) => {
    const c = countText(text);
    return { words: sum.words + c.words, characters: sum.characters + c.characters };
  }, { words: 0, characters: 0 });
}

export function formatSelectionCount({ words, characters }: SelectionCount): string {
  const n = (x: number) => x.toLocaleString('en-US');
  return `${n(words)} ${words === 1 ? 'word' : 'words'} · ${n(characters)} ${characters === 1 ? 'character' : 'characters'}`;
}
