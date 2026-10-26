import { describe, it, expect } from 'vitest';
import { defaultHighlightStyle } from '@codemirror/language';
import { tags, type Tag } from '@lezer/highlight';
import { markdownHighlightStyle } from './editorTheme';

const specFor = (style: typeof defaultHighlightStyle, tag: Tag) => style.specs.find((spec) => spec.tag === tag);

describe('markdownHighlightStyle', () => {
  it('keeps bold semibold, and headings at their level weight, as live preview draws them', () => {
    expect(specFor(markdownHighlightStyle, tags.strong)?.fontWeight).toBe('600');
    expect(specFor(markdownHighlightStyle, tags.heading)?.fontWeight).toBe('inherit');
  });

  it('does not underline headings', () => {
    expect(specFor(markdownHighlightStyle, tags.heading)?.textDecoration).toBe('none');
  });

  it('keeps every other default style', () => {
    expect(markdownHighlightStyle.specs).toHaveLength(defaultHighlightStyle.specs.length);
    for (const tag of [tags.emphasis, tags.strikethrough, tags.link]) {
      expect(specFor(markdownHighlightStyle, tag)).toEqual(specFor(defaultHighlightStyle, tag));
    }
  });

  it('gives each colour as a token dark mode can set, with the default as fallback', () => {
    // Specs can list several tags
    const colorOf = (tag: Tag) => markdownHighlightStyle.specs
      .find((spec) => (Array.isArray(spec.tag) ? spec.tag : [spec.tag]).includes(tag))?.color;
    expect(colorOf(tags.url)).toBe('var(--lens-syntax-219, #219)');
    expect(colorOf(tags.keyword)).toBe('var(--lens-syntax-708, #708)');
  });
});
