import { parseSections } from '../components/SectionEditor/parseSections';
import { parse as parseCriticMarkup } from './criticmarkup-parser';
import { acceptChange, rejectChange } from './criticmarkup-actions';

export type SegmentTimeField = 'from' | 'to';

export interface TextEdit {
  index: number;
  deleteCount: number;
  insert: string;
}

/**
 * The edit that sets `from::` or `to::` of the video segment at
 * `sectionIndex` to `value`: it replaces just the old value when the field is
 * there, and otherwise adds the field on a line of its own (`from::` after
 * `source::`, `to::` after `from::` or `source::`, else after the heading).
 * Null when that section is not a video segment.
 */
export function segmentTimeEdit(
  text: string,
  sectionIndex: number,
  field: SegmentTimeField,
  value: string,
): TextEdit | null {
  const section = parseSections(text)[sectionIndex];
  if (!section || section.type !== 'video') return null;
  const content = section.content;

  const existing = new RegExp(`^${field}::[ \\t]*(.*)$`, 'm').exec(content);
  if (existing) {
    const valueStart = existing.index + existing[0].length - existing[1].length;
    return {
      index: section.from + valueStart,
      deleteCount: existing[1].length,
      insert: value,
    };
  }

  const after = field === 'to' ? ['from', 'source'] : ['source'];
  let lineEnd = -1;
  for (const name of after) {
    const m = new RegExp(`^${name}::.*$`, 'm').exec(content);
    if (m) {
      lineEnd = m.index + m[0].length;
      break;
    }
  }
  if (lineEnd === -1) lineEnd = content.indexOf('\n');
  if (lineEnd === -1) {
    return { index: section.from + content.length, deleteCount: 0, insert: `\n${field}:: ${value}` };
  }
  return { index: section.from + lineEnd, deleteCount: 0, insert: `\n${field}:: ${value}` };
}

/** A field value with its pending CriticMarkup resolved: as it reads once
 *  every suggestion is accepted, or as it is live (all rejected). */
export function resolvePending(value: string, how: 'accept' | 'reject'): string {
  const ranges = parseCriticMarkup(value);
  let out = value;
  // From the last range back, so earlier offsets stay valid
  for (const range of [...ranges].sort((a, b) => b.from - a.from)) {
    out = how === 'accept' ? acceptChange(out, range) : rejectChange(out, range);
  }
  return out.trim();
}
