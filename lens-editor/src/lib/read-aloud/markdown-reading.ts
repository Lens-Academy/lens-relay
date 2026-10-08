/**
 * What read-aloud says for a Markdown document: the text a reader sees in
 * live preview, split into sentences, with every character mapped back to its
 * position in the document so highlights and clicks work on the source.
 *
 * Skipped: frontmatter, `key:: value` field lines, code blocks, HTML blocks,
 * tables, images, URLs, comments (`%%…%%`, `<!-- -->`, CriticMarkup
 * comments), pending deletions, and the syntax marks themselves (`#`, `**`,
 * `[`, `](…)`, `>` and list bullets). Pending additions are read.
 *
 * Works from the whole document (not CodeMirror's visible ranges), so it is
 * independent of what is scrolled into view.
 */

import type { EditorState } from '@codemirror/state';
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import { parse as parseCriticMarkup } from '../criticmarkup-parser';
import { splitSentences, type CharRange } from './text';
import type { ReadingUnit } from './engine';

export interface MarkdownReading {
  units: ReadingUnit[];
  /** Document range of each unit, from its first to its last spoken character. */
  docRanges: Array<{ from: number; to: number }>;
  /** Flat-text start of each unit. */
  flatStarts: number[];
  /** Document position of each flat character; -1 for a synthetic separator. */
  pos: Int32Array;
}

/** Nodes whose whole text is never read. */
const SKIP_NODES = new Set([
  'FencedCode', 'CodeBlock', 'HTMLBlock', 'CommentBlock', 'ProcessingInstructionBlock',
  'LinkReference', 'Table', 'HorizontalRule', 'Image', 'URL', 'LinkTitle', 'Autolink',
  'HTMLTag', 'Comment', 'Entity',
]);

/** Syntax marks: hidden in live preview, so not read either. */
const MARK_NODES = new Set([
  'HeaderMark', 'EmphasisMark', 'CodeMark', 'LinkMark', 'QuoteMark', 'ListMark',
  'TaskMarker', 'StrikethroughMark', 'WikilinkMark',
]);

/** Leaf blocks whose text is read; each starts a new sentence. */
const READ_BLOCKS = /^(Paragraph|ATXHeading\d|SetextHeading\d)$/;

/** Silence before the first sentence of a block. */
const BLOCK_PAUSE_S = 0.3;

export function buildMarkdownReading(state: EditorState): MarkdownReading {
  const doc = state.doc.toString();
  const tree = ensureSyntaxTree(state, state.doc.length, 500) ?? syntaxTree(state);
  const hidden = new Uint8Array(doc.length);
  const hide = (start: number, end: number) => {
    if (end > start) hidden.fill(1, start, end);
  };
  const blocks: CharRange[] = [];

  // Frontmatter at the very top.
  const fm = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(doc);
  if (fm) hide(0, fm[0].length);
  for (const m of doc.matchAll(/%%[\s\S]*?%%|<!--[\s\S]*?-->/g)) hide(m.index, m.index + m[0].length);
  // Dataview-style fields (`id:: …`) and callout markers (`[!tip]`).
  for (const m of doc.matchAll(/^[ \t>]*[\w-]+::.*$/gm)) hide(m.index, m.index + m[0].length);
  for (const m of doc.matchAll(/\[![\w-]+\][+-]?/g)) hide(m.index, m.index + m[0].length);
  for (const r of parseCriticMarkup(doc)) {
    if (r.type === 'deletion' || r.type === 'comment') {
      hide(r.from, r.to);
    } else if (r.type === 'substitution') {
      const arrow = doc.indexOf('~>', r.contentFrom);
      hide(r.from, arrow >= 0 && arrow < r.contentTo ? arrow + 2 : r.contentFrom);
      hide(r.contentTo, r.to);
    } else {
      hide(r.from, r.contentFrom);
      hide(r.contentTo, r.to);
    }
  }

  tree.iterate({
    enter(node) {
      const name = node.name;
      if (SKIP_NODES.has(name)) {
        hide(node.from, node.to);
        return false;
      }
      if (MARK_NODES.has(name)) {
        hide(node.from, node.to);
      } else if (name === 'Escape') {
        hide(node.from, node.from + 1);
      } else if (name === 'Wikilink') {
        // [[target#heading|alias]]: read the alias, else the target.
        const inner = doc.slice(node.from + 2, node.to - 2);
        const bar = inner.indexOf('|');
        if (bar >= 0) hide(node.from + 2, node.from + 2 + bar + 1);
        else {
          const hash = inner.indexOf('#');
          if (hash >= 0) hide(node.from + 2 + hash, node.to - 2);
        }
      } else if (READ_BLOCKS.test(name)) {
        blocks.push({ start: node.from, end: node.to });
      }
      return undefined;
    },
  });

  // Flatten: the readable characters of each block, a "\n" after each.
  const chars: string[] = [];
  const posList: number[] = [];
  const blockStartFlat: number[] = [];
  for (const block of blocks) {
    blockStartFlat.push(chars.length);
    for (let i = block.start; i < block.end; i++) {
      if (hidden[i]) continue;
      const c = /\s/.test(doc[i]) ? ' ' : doc[i];
      // Collapse the spaces hidden syntax leaves behind ("paper  and").
      if (c === ' ' && (chars.length === 0 || chars[chars.length - 1] === ' ' || chars[chars.length - 1] === '\n')) continue;
      chars.push(c);
      posList.push(i);
    }
    chars.push('\n');
    posList.push(-1);
  }
  const flat = chars.join('');
  const pos = Int32Array.from(posList);

  const units: ReadingUnit[] = [];
  const docRanges: MarkdownReading['docRanges'] = [];
  const flatStarts: number[] = [];
  let lastBlock = -1;
  let b = 0;
  for (const s of splitSentences(flat)) {
    while (b + 1 < blockStartFlat.length && blockStartFlat[b + 1] <= s.start) b++;
    const newBlock = b !== lastBlock;
    lastBlock = b;
    units.push({ text: flat.slice(s.start, s.end), pauseBefore: newBlock ? BLOCK_PAUSE_S : 0 });
    docRanges.push({ from: pos[s.start], to: pos[s.end - 1] + 1 });
    flatStarts.push(s.start);
  }
  return { units, docRanges, flatStarts, pos };
}

/** Document range of `range` (offsets into unit `unit`'s text). */
export function docRangeOf(reading: MarkdownReading, unit: number, range: CharRange): { from: number; to: number } | null {
  const base = reading.flatStarts[unit];
  if (base === undefined) return null;
  let s = base + range.start;
  let e = base + range.end - 1;
  while (s <= e && reading.pos[s] < 0) s++;
  while (e >= s && reading.pos[e] < 0) e--;
  if (s > e) return null;
  return { from: reading.pos[s], to: reading.pos[e] + 1 };
}

/** The unit whose text covers document position `pos`, or null. */
export function unitAtPos(reading: MarkdownReading, pos: number): number | null {
  const r = reading.docRanges;
  let lo = 0;
  let hi = r.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (r[mid].to <= pos) lo = mid + 1;
    else if (r[mid].from > pos) hi = mid - 1;
    else return mid;
  }
  return null;
}

/** The first unit that starts on the line [from, to], or one that runs through its start. */
export function unitForLine(reading: MarkdownReading, from: number, to: number): number | null {
  const r = reading.docRanges;
  let lo = 0;
  let hi = r.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (r[mid].to <= from) lo = mid + 1;
    else hi = mid;
  }
  if (lo < r.length && r[lo].from <= to) return lo;
  return null;
}
