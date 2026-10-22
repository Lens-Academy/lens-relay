import { describe, it, expect } from 'vitest';
import { defaultHighlightStyle } from '@codemirror/language';
import { tags, type Tag } from '@lezer/highlight';
import { markdownHighlightStyle } from './editorTheme';

const specFor = (style: typeof defaultHighlightStyle, tag: Tag) => style.specs.find((spec) => spec.tag === tag);

describe('markdownHighlightStyle', () => {
  it('keeps bold and headings semibold, the weight live preview draws them in', () => {
    expect(specFor(markdownHighlightStyle, tags.strong)?.fontWeight).toBe('600');
    expect(specFor(markdownHighlightStyle, tags.heading)?.fontWeight).toBe('600');
  });

  it('does not underline headings', () => {
    expect(specFor(markdownHighlightStyle, tags.heading)?.textDecoration).toBe('none');
  });

  it('keeps every other default style', () => {
    expect(markdownHighlightStyle.specs).toHaveLength(defaultHighlightStyle.specs.length);
    for (const tag of [tags.emphasis, tags.strikethrough, tags.link, tags.url]) {
      expect(specFor(markdownHighlightStyle, tag)).toEqual(specFor(defaultHighlightStyle, tag));
    }
  });
});
