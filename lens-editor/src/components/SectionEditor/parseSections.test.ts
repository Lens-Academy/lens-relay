import { describe, it, expect } from 'vitest';
import { parseSections } from './parseSections';

describe('parseSections', () => {
  it('returns empty for empty string', () => {
    expect(parseSections('')).toEqual([]);
  });

  it('parses frontmatter', () => {
    const text = '---\ntitle: Test\nslug: test\n---\n# Hello\nContent';
    const sections = parseSections(text);
    expect(sections[0].type).toBe('frontmatter');
    expect(sections[0].from).toBe(0);
    expect(sections[0].content).toContain('title: Test');
  });

  it('parses heading sections', () => {
    const text = '# Welcome\nHello world\n\n# Features\nStuff here';
    const sections = parseSections(text);
    expect(sections).toHaveLength(2);
    expect(sections[0].label).toBe('Welcome');
    expect(sections[0].from).toBe(0);
    expect(sections[1].label).toBe('Features');
    expect(sections[1].from).toBe(text.indexOf('# Features'));
  });

  it('section ranges cover the entire document with no gaps', () => {
    const text = '---\nid: test\n---\n# Welcome\nHello\n\n## Features\nStuff\n\n## Links\nMore';
    const sections = parseSections(text);
    // Verify no gaps between sections
    for (let i = 0; i < sections.length - 1; i++) {
      expect(sections[i].to).toBe(sections[i + 1].from);
    }
    // First section starts at 0, last ends at text.length
    expect(sections[0].from).toBe(0);
    expect(sections[sections.length - 1].to).toBe(text.length);
  });

  it('classifies #### Video/Text/Chat correctly', () => {
    const text = '#### Video\nsource:: foo\n#### Text\ncontent\n#### Chat\ninstructions';
    const sections = parseSections(text);
    expect(sections.map(s => s.type)).toEqual(['video', 'text', 'chat']);
  });

  it('classifies lens/test/LO references', () => {
    const text = '## Lens:\nsource:: foo\n## Test:\nq1\n## Learning Outcome:\nsrc';
    const sections = parseSections(text);
    expect(sections.map(s => s.type)).toEqual(['lens-ref', 'test-ref', 'lo-ref']);
  });

  it('covers whitespace-only gaps between frontmatter and headers', () => {
    const text = '---\nid: test\n---\n\n\n# Welcome\nHello';
    const sections = parseSections(text);
    // No gaps — frontmatter should extend to cover the blank lines
    expect(sections[0].from).toBe(0);
    expect(sections[0].to).toBe(text.indexOf('# Welcome'));
    expect(sections[sections.length - 1].to).toBe(text.length);
    for (let i = 0; i < sections.length - 1; i++) {
      expect(sections[i].to).toBe(sections[i + 1].from);
    }
  });

  it('covers gap when document starts with blank lines before header', () => {
    const text = '\n\n# Welcome\nHello\n\n## Features\nStuff';
    const sections = parseSections(text);
    expect(sections[0].from).toBe(0);
    expect(sections[sections.length - 1].to).toBe(text.length);
    for (let i = 0; i < sections.length - 1; i++) {
      expect(sections[i].to).toBe(sections[i + 1].from);
    }
  });

  it('handles document with only content and no headers', () => {
    const text = 'Just some plain text\nwith multiple lines';
    const sections = parseSections(text);
    expect(sections).toHaveLength(1);
    expect(sections[0].type).toBe('body');
    expect(sections[0].from).toBe(0);
    expect(sections[0].to).toBe(text.length);
  });
});
