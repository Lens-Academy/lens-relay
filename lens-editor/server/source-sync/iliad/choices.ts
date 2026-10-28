/**
 * Where a worksheet's text lets the learner pick some of several readings.
 * A module lists such readings in a choice group (`# Choose: k`, the
 * readings one heading level down), and the learner completes k of them
 * (lens-platform's content processor, `flattenChoose`). This file reads the
 * text; `arrangeChoices` in course-files.ts decides which readings of a
 * module go into a group.
 *
 * Two forms of sentence offer a choice:
 *   - a reading instruction that gives its links as alternatives: "Read
 *     [A](..), or [B](..), or [C](..)." Each link is an option.
 *   - a sentence that says to pick ("Pick one most interesting to you",
 *     "from one of these papers:"), last in its paragraph, above a list.
 *     Each item is one option, named by its first link: an item's later
 *     links ("Extension: the [timeline](..)") are extras.
 * A sentence that opens with a hedge ("Optionally, read [A] or [B]")
 * offers extras, not a choice. A sentence that names no number to pick
 * ("concentrating on the one most interesting to you") offers none.
 */

export interface Choice {
  /** How many options the learner completes. */
  pick: number;
  /** The address of each option, in order. */
  options: string[];
}

const COUNTS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5 };
/** A number written as a digit or a word ("2", "two"); NaN for anything else. */
export const countOf = (word: string): number => COUNTS[word.toLowerCase()] ?? Number(word);
const PICK = /\b(?:pick|choose|select)\s+(?:(?:any|just|only|at least)\s+)?(one|two|three|four|five|[1-9])\b/i;
const OF_THESE = /\b(one|two|three|four|five|[1-9])\s+of\s+(?:these|those|the following|them)\b/i;
const READ = /\b(?:read|reading|readings|watch)\b/i;
const HEDGE = /\b(?:optional(?:ly)?|if you (?:want|like|wish|have time|finish)|extension|bonus|for (?:instance|example))\b/i;
const LINK = /\[(?:[^[\]\n]|\[[^\]\n]*\])*\]\((https?:\/\/[^\s)]+)\)/g;
/** A list item at the top level: an item indented further, or by a tab, belongs to the one above it. */
const ITEM = /^ {0,3}(?:[-*+]|\d{1,2}[.)])\s+/;

const linksIn = (text: string): string[] => [...text.matchAll(LINK)].map((link) => link[1]);

/** The choices a lens's markdown offers, in order. */
export function choicesIn(markdown: string): Choice[] {
  const choices: Choice[] = [];
  const blocks = markdown.split(/\n[ \t]*\n/);
  blocks.forEach((block, i) => {
    if (ITEM.test(block)) return;
    const sentences = sentencesOf(block);
    for (const sentence of sentences) {
      const options = alternatives(sentence);
      if (options) choices.push({ pick: pickIn(sentence)?.count ?? 1, options });
    }
    const last = sentences[sentences.length - 1] ?? "";
    const pick = pickIn(last);
    if (!pick || alternatives(last)) return;
    const items = firstLinkPerItem(blocks, i + 1);
    const options = items.length ? items : linksIn(last.slice(pick.end));
    if (options.length >= 2) choices.push({ pick: pick.count, options });
  });
  return choices;
}

/** The sentences of a paragraph. A full stop inside a link's text ends nothing. */
function sentencesOf(paragraph: string): string[] {
  const sentences: string[] = [];
  let start = 0;
  let from = 0;
  for (const link of [...paragraph.matchAll(LINK), null]) {
    const end = link ? link.index! : paragraph.length;
    for (const stop of paragraph.slice(from, end).matchAll(/[.!?](?=\s|$)/g)) {
      sentences.push(paragraph.slice(start, from + stop.index! + 1).trim());
      start = from + stop.index! + 1;
    }
    from = link ? end + link[0].length : end;
  }
  if (paragraph.slice(start).trim()) sentences.push(paragraph.slice(start).trim());
  return sentences;
}

/** The count a sentence says to pick, and where its words end; null when it says none, or says it after a hedge. */
function pickIn(sentence: string): { count: number; end: number } | null {
  const signal = sentence.match(PICK) ?? sentence.match(OF_THESE);
  if (!signal || HEDGE.test(sentence.slice(0, signal.index))) return null;
  return { count: countOf(signal[1]), end: signal.index! + signal[0].length };
}

/** The links of a reading instruction that offers them as alternatives: an "or" between two of them, no "and". */
function alternatives(sentence: string): string[] | null {
  const links = [...sentence.matchAll(LINK)];
  if (links.length < 2 || !READ.test(sentence) || HEDGE.test(sentence.slice(0, links[0].index))) return null;
  const between = links.slice(1).map((link, i) => sentence.slice(links[i].index! + links[i][0].length, link.index));
  return between.some((text) => /\bor\b/i.test(text)) && !between.some((text) => /\band\b/i.test(text)) ? links.map((link) => link[1]) : null;
}

/** The first link of each top-level item of the list that starts at `blocks[from]`; empty when no list starts there. */
function firstLinkPerItem(blocks: string[], from: number): string[] {
  if (!ITEM.test(blocks[from] ?? "")) return [];
  const indent = blocks[from].search(/\S/);
  const firsts: (string | undefined)[] = [];
  for (let j = from; j < blocks.length && (ITEM.test(blocks[j]) || /^\s/.test(blocks[j])); j++) {
    for (const line of blocks[j].split("\n")) {
      if (ITEM.test(line) && line.search(/\S/) <= indent) firsts.push(undefined);
      if (firsts.length) firsts[firsts.length - 1] ??= linksIn(line)[0];
    }
  }
  return firsts.filter((link): link is string => link !== undefined);
}
