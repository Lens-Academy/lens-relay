// src/lib/criticmarkup-parser.test.ts
import { describe, it, expect } from 'vitest';
import { parse, parseThreads } from './criticmarkup-parser';

describe('CriticMarkup Parser', () => {
  describe('basic patterns', () => {
    it('parses addition', () => {
      const result = parse('hello {++world++} end');

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        type: 'addition',
        from: 6,
        to: 17,
        contentFrom: 9,   // after {++
        contentTo: 14,    // before ++}
        content: 'world',
      });
    });

    it('parses deletion', () => {
      const result = parse('hello {--removed--} end');

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        type: 'deletion',
        from: 6,
        to: 19,
        content: 'removed',
      });
    });

    it('parses substitution', () => {
      const result = parse('hello {~~old~>new~~} end');

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        type: 'substitution',
        from: 6,
        to: 20,
        content: 'old~>new',
        oldContent: 'old',
        newContent: 'new',
      });
    });

    it('parses comment', () => {
      const result = parse('hello {>>note<<} end');

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        type: 'comment',
        from: 6,
        to: 16,
        content: 'note',
      });
    });

    it('parses highlight', () => {
      const result = parse('hello {==important==} end');

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        type: 'highlight',
        from: 6,
        to: 21,
        content: 'important',
      });
    });
  });

  describe('metadata', () => {
    it('extracts author and timestamp from addition', () => {
      const result = parse('{++{"author":"alice","timestamp":1706900000}@@added text++}');

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        type: 'addition',
        content: 'added text',
        metadata: {
          author: 'alice',
          timestamp: 1706900000,
        },
      });
      // contentFrom should be after metadata+@@, not just after {++
      // {++{"author":"alice","timestamp":1706900000}@@ = 46 chars
      expect(result[0].contentFrom).toBe(46);
    });

    it('extracts metadata from comment', () => {
      const result = parse('{>>{"author":"bob"}@@This is my comment<<}');

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        type: 'comment',
        content: 'This is my comment',
        metadata: {
          author: 'bob',
        },
      });
    });

    it('handles missing metadata gracefully', () => {
      const result = parse('{++plain text++}');

      expect(result).toHaveLength(1);
      expect(result[0].metadata).toBeUndefined();
      expect(result[0].content).toBe('plain text');
    });

    it('handles malformed JSON metadata', () => {
      const result = parse('{++{invalid json}@@content++}');

      expect(result).toHaveLength(1);
      // Should treat entire thing as content when JSON is invalid
      expect(result[0].content).toBe('{invalid json}@@content');
      expect(result[0].metadata).toBeUndefined();
    });
  });

  describe('multiline', () => {
    it('parses multiline addition', () => {
      const doc = `{++
Hello world

Can I do multiline?++}`;

      const result = parse(doc);

      expect(result).toHaveLength(1);
      expect(result[0].type).toBe('addition');
      expect(result[0].content).toContain('Hello world');
      expect(result[0].content).toContain('Can I do multiline?');
    });

    it('parses multiline with metadata', () => {
      const doc = `{++{"author":"alice"}@@
First line
Second line++}`;

      const result = parse(doc);

      expect(result).toHaveLength(1);
      expect(result[0].metadata?.author).toBe('alice');
      expect(result[0].content).toContain('First line');
      expect(result[0].content).toContain('Second line');
    });

    it('parses multiline comment', () => {
      const doc = `{>>
This is a
multi-line comment
<<}`;

      const result = parse(doc);

      expect(result).toHaveLength(1);
      expect(result[0].type).toBe('comment');
      expect(result[0].content).toContain('multi-line');
    });
  });

  describe('threads', () => {
    it('groups adjacent comments into a thread', () => {
      const doc = 'text{>>first<<}{>>reply<<}{>>another<<} more';
      const ranges = parse(doc);
      const threads = parseThreads(ranges);

      expect(threads).toHaveLength(1);
      expect(threads[0].comments).toHaveLength(3);
      expect(threads[0].from).toBe(4);
      expect(threads[0].to).toBe(39);
    });

    it('separates comments with characters between', () => {
      const doc = 'text{>>first<<} {>>second<<} more';
      const ranges = parse(doc);
      const threads = parseThreads(ranges);

      expect(threads).toHaveLength(2);
      expect(threads[0].comments).toHaveLength(1);
      expect(threads[1].comments).toHaveLength(1);
    });

    it('returns empty array when no comments', () => {
      const doc = 'text{++addition++} more';
      const ranges = parse(doc);
      const threads = parseThreads(ranges);

      expect(threads).toHaveLength(0);
    });
  });

  describe('edge cases', () => {
    it('handles multiple markup types in same document', () => {
      const doc = '{++added++} normal {--deleted--} {==highlighted==}';
      const result = parse(doc);

      expect(result).toHaveLength(3);
      expect(result[0].type).toBe('addition');
      expect(result[1].type).toBe('deletion');
      expect(result[2].type).toBe('highlight');
    });

    it('handles empty content', () => {
      const result = parse('{++++}');

      // Empty content should still match
      expect(result).toHaveLength(1);
      expect(result[0].content).toBe('');
    });

    it('handles unclosed markup (no match)', () => {
      const result = parse('{++unclosed');

      expect(result).toHaveLength(0);
    });

    it('handles nested braces in content', () => {
      const result = parse('{++function() { return 1; }++}');

      expect(result).toHaveLength(1);
      expect(result[0].content).toBe('function() { return 1; }');
    });

    it('preserves position accuracy with unicode', () => {
      const doc = '🎉{++emoji++}';
      const result = parse(doc);

      expect(result).toHaveLength(1);
      // 🎉 is 2 UTF-16 code units
      expect(result[0].from).toBe(2);
    });
  });
});
