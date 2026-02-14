import { describe, it, expect } from 'vitest';
import { extractWikilinks } from './link-extractor';

describe('extractWikilinks', () => {
  describe('basic extraction', () => {
    it('extracts a simple wikilink', () => {
      const result = extractWikilinks('[[Note]]');
      expect(result).toEqual(['Note']);
    });

    it('returns empty array for no links', () => {
      const result = extractWikilinks('plain text with no links');
      expect(result).toEqual([]);
    });

    it('extracts multiple wikilinks', () => {
      const result = extractWikilinks('[[PageOne]] and [[PageTwo]]');
      expect(result).toEqual(['PageOne', 'PageTwo']);
    });
  });

  describe('anchor handling', () => {
    it('strips anchor from link', () => {
      const result = extractWikilinks('[[Note#Section]]');
      expect(result).toEqual(['Note']);
    });

    it('strips deep anchor', () => {
      const result = extractWikilinks('[[Guide#Chapter 1#Section 2]]');
      expect(result).toEqual(['Guide']);
    });
  });

  describe('alias handling', () => {
    it('strips alias from link', () => {
      const result = extractWikilinks('[[Note|Display Text]]');
      expect(result).toEqual(['Note']);
    });

    it('handles anchor and alias combined', () => {
      const result = extractWikilinks('[[Note#Section|Display]]');
      expect(result).toEqual(['Note']);
    });
  });

  describe('edge cases', () => {
    it('ignores empty brackets', () => {
      const result = extractWikilinks('[[]]');
      expect(result).toEqual([]);
    });

    it('ignores unclosed brackets', () => {
      const result = extractWikilinks('[[Broken');
      expect(result).toEqual([]);
    });

    it('ignores whitespace-only content', () => {
      const result = extractWikilinks('[[   ]]');
      expect(result).toEqual([]);
    });

    it('handles link with spaces in name', () => {
      const result = extractWikilinks('[[My Note]]');
      expect(result).toEqual(['My Note']);
    });

    it('preserves duplicate links', () => {
      const result = extractWikilinks('[[A]] and [[A]]');
      expect(result).toEqual(['A', 'A']);
    });
  });

  describe('code block handling', () => {
    it('ignores links in inline code', () => {
      const result = extractWikilinks('See `[[CodeNote]]` here');
      expect(result).toEqual([]);
    });

    it('ignores links in fenced code blocks', () => {
      const markdown = `
\`\`\`
[[BlockNote]]
\`\`\`
`;
      const result = extractWikilinks(markdown);
      expect(result).toEqual([]);
    });

    it('ignores links in tilde-fenced code blocks', () => {
      const markdown = `
~~~
[[TildeBlock]]
~~~
`;
      const result = extractWikilinks(markdown);
      expect(result).toEqual([]);
    });

    it('ignores links in code blocks with language specifier', () => {
      const markdown = `
\`\`\`markdown
[[InCodeBlock]]
\`\`\`
`;
      const result = extractWikilinks(markdown);
      expect(result).toEqual([]);
    });

    it('extracts links outside code but ignores inside', () => {
      const markdown = '[[RealLink]] and `[[FakeLink]]`';
      const result = extractWikilinks(markdown);
      expect(result).toEqual(['RealLink']);
    });
  });

  describe('anchor-only links', () => {
    it('returns empty for anchor-only links (current doc reference)', () => {
      const result = extractWikilinks('[[#Section]]');
      expect(result).toEqual([]);
    });
  });

  describe('embed syntax', () => {
    it('extracts link from embed syntax ![[Page]]', () => {
      expect(extractWikilinks('![[Page]]')).toEqual(['Page']);
    });

    it('extracts both embeds and regular links', () => {
      expect(extractWikilinks('![[Embed]] and [[Regular]]')).toEqual(['Embed', 'Regular']);
    });
  });
});
