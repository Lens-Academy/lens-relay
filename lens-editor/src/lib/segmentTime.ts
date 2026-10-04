import { parseSections, type Section } from '../components/SectionEditor/parseSections';
import { parse as parseCriticMarkup } from './criticmarkup-parser';
import { acceptChange, rejectChange } from './criticmarkup-actions';
import { parseFields } from './parseFields';

export type SegmentTimeField = 'from' | 'to';

export interface TextChange {
  from: number;
  to: number;
  insert: string;
}

/** Text with its pending CriticMarkup resolved: as it reads once every
 *  suggestion is accepted, or as it is live (all rejected). */
export function resolvePending(text: string, how: 'accept' | 'reject'): string {
  let out = text;
  // From the last range back, so earlier offsets stay valid
  for (const range of [...parseCriticMarkup(text)].sort((a, b) => b.from - a.from)) {
    out = how === 'accept' ? acceptChange(out, range) : rejectChange(out, range);
  }
  return out;
}

/** The video segment that contains `pos` (its heading start, mapped through
 *  later edits), or null when there is none there any more. */
export function videoSectionAt(text: string, pos: number): Section | null {
  const section = parseSections(text).find((s) => s.from <= pos && pos < Math.max(s.to, s.from + 1));
  return section?.type === 'video' ? section : null;
}

/** The segment's fields as they read with its pending suggestions accepted. */
export function segmentFields(section: Section): Map<string, string> {
  return parseFields(resolvePending(section.content, 'accept'));
}

export interface SegmentTimeOptions {
  /** Suggesting mode: write the change as a suggestion by `author`. */
  suggest?: { author: string; timestamp: number };
}

function lineAt(content: string, field: string) {
  // A plain line, or one that is a whole pending addition ({++…to:: X++})
  const re = new RegExp(`^(\\{\\+\\+(?:[^\\n]*?@@)?)?${field}::[ \\t]*(.*?)(\\+\\+\\})?$`, 'm');
  const m = re.exec(content);
  if (!m) return null;
  const added = Boolean(m[1] && m[3]);
  if (Boolean(m[1]) !== Boolean(m[3])) return { m, added, broken: true };
  return { m, added, broken: false };
}

/**
 * The change that sets `from::` or `to::` of `section` to `value`.
 *
 * Editing: the value is replaced (a pending suggestion on it is taken over),
 * or a line is added. Suggesting: the change is written as CriticMarkup here
 * rather than left to the editor's suggestion filter (which decides by the
 * cursor): `{~~old~>new~~}` on the value, a whole new line wrapped in
 * `{++…++}`, and a second choice replaces the earlier suggestion instead of
 * nesting markup; choosing the live time again drops it.
 * Returns an error string when the line has other pending markup.
 */
export function segmentTimeChange(
  section: Section,
  field: SegmentTimeField,
  value: string,
  options: SegmentTimeOptions = {},
): TextChange | { error: string } {
  const content = section.content;
  const meta = options.suggest ? JSON.stringify(options.suggest) : null;
  const line = lineAt(content, field);

  if (line && !line.broken) {
    const { m, added } = line;
    if (added) {
      // The line itself is a pending addition: replace it whole
      const from = section.from + m.index;
      const plain = `${field}:: ${value}`;
      return { from, to: from + m[0].length, insert: meta ? `{++${meta}@@${plain}++}` : plain };
    }
    const raw = m[2];
    const valueFrom = section.from + m.index + m[0].length - raw.length;
    const change = (insert: string) => ({ from: valueFrom, to: valueFrom + raw.length, insert });
    if (!raw.includes('{')) {
      if (raw.trim() === value) return change(raw);
      return change(meta ? `{~~${meta}@@${raw}~>${value}~~}` : value);
    }
    if (!/^\{~~(?:[^\n]*?@@)?[^\n]*?~>[^\n]*?~~\}\s*$/.test(raw)) {
      return { error: `The ${field}:: line has other pending changes: accept or reject them first.` };
    }
    const live = resolvePending(raw, 'reject').trim();
    if (!meta || live === value) return change(value);
    return change(`{~~${meta}@@${live}~>${value}~~}`);
  }
  if (line?.broken) {
    return { error: `The ${field}:: line has other pending changes: accept or reject them first.` };
  }

  // No such line yet: add one after from:: (for to::), else source::, else
  // the heading
  const after = field === 'to' ? ['from', 'source'] : ['source'];
  let lineEnd = -1;
  for (const name of after) {
    const found = lineAt(content, name);
    if (found) {
      lineEnd = found.m.index + found.m[0].length;
      break;
    }
  }
  if (lineEnd === -1) lineEnd = content.indexOf('\n');
  if (lineEnd === -1) lineEnd = content.length;
  const plain = `${field}:: ${value}`;
  const pos = section.from + lineEnd;
  return { from: pos, to: pos, insert: `\n${meta ? `{++${meta}@@${plain}++}` : plain}` };
}
