// src/lib/criticmarkup-actions.test.ts
import { describe, it, expect } from 'vitest';
import { acceptChange, acceptedPieces, rejectChange } from './criticmarkup-actions';
import type { CriticMarkupRange } from './criticmarkup-parser';

describe('Accept/Reject Actions', () => {
  describe('acceptChange', () => {
    it('accept addition: removes delimiters, keeps content', () => {
      const doc = 'hello {++world++} end';
      const range: CriticMarkupRange = {
        type: 'addition',
        from: 6,
        to: 17,
        contentFrom: 9,
        contentTo: 14,
        content: 'world',
      };

      const result = acceptChange(doc, range);

      expect(result).toBe('hello world end');
    });

    it('accept deletion: removes entire markup', () => {
      const doc = 'hello {--removed--} end';
      const range: CriticMarkupRange = {
        type: 'deletion',
        from: 6,
        to: 19,
        contentFrom: 9,
        contentTo: 16,
        content: 'removed',
      };

      const result = acceptChange(doc, range);

      expect(result).toBe('hello  end');
    });

    it('accept substitution: keeps new content', () => {
      const doc = 'hello {~~old~>new~~} end';
      const range: CriticMarkupRange = {
        type: 'substitution',
        from: 6,
        to: 20,
        contentFrom: 9,
        contentTo: 17,
        content: 'old~>new',
        oldContent: 'old',
        newContent: 'new',
      };

      const result = acceptChange(doc, range);

      expect(result).toBe('hello new end');
    });

    it('accept highlight: removes delimiters, keeps content', () => {
      const doc = 'hello {==important==} end';
      const range: CriticMarkupRange = {
        type: 'highlight',
        from: 6,
        to: 21,
        contentFrom: 9,
        contentTo: 18,
        content: 'important',
      };

      const result = acceptChange(doc, range);

      expect(result).toBe('hello important end');
    });

    it('accept comment: removes entire markup', () => {
      const doc = 'hello {>>note<<} end';
      const range: CriticMarkupRange = {
        type: 'comment',
        from: 6,
        to: 16,
        contentFrom: 9,
        contentTo: 13,
        content: 'note',
      };

      const result = acceptChange(doc, range);

      expect(result).toBe('hello  end');
    });
  });

  describe('rejectChange', () => {
    it('reject addition: removes entire markup', () => {
      const doc = 'hello {++world++} end';
      const range: CriticMarkupRange = {
        type: 'addition',
        from: 6,
        to: 17,
        contentFrom: 9,
        contentTo: 14,
        content: 'world',
      };

      const result = rejectChange(doc, range);

      expect(result).toBe('hello  end');
    });

    it('reject deletion: removes delimiters, keeps content', () => {
      const doc = 'hello {--removed--} end';
      const range: CriticMarkupRange = {
        type: 'deletion',
        from: 6,
        to: 19,
        contentFrom: 9,
        contentTo: 16,
        content: 'removed',
      };

      const result = rejectChange(doc, range);

      expect(result).toBe('hello removed end');
    });

    it('reject substitution: keeps old content', () => {
      const doc = 'hello {~~old~>new~~} end';
      const range: CriticMarkupRange = {
        type: 'substitution',
        from: 6,
        to: 20,
        contentFrom: 9,
        contentTo: 17,
        content: 'old~>new',
        oldContent: 'old',
        newContent: 'new',
      };

      const result = rejectChange(doc, range);

      expect(result).toBe('hello old end');
    });

    it('reject highlight: removes delimiters, keeps content', () => {
      const doc = 'hello {==important==} end';
      const range: CriticMarkupRange = {
        type: 'highlight',
        from: 6,
        to: 21,
        contentFrom: 9,
        contentTo: 18,
        content: 'important',
      };

      const result = rejectChange(doc, range);

      expect(result).toBe('hello important end');
    });

    it('reject comment: removes entire markup', () => {
      const doc = 'hello {>>note<<} end';
      const range: CriticMarkupRange = {
        type: 'comment',
        from: 6,
        to: 16,
        contentFrom: 9,
        contentTo: 13,
        content: 'note',
      };

      const result = rejectChange(doc, range);

      expect(result).toBe('hello  end');
    });
  });

  describe('acceptedPieces', () => {
    const META = '{"author":"Elias","timestamp":1000}';
    /** `text` as acceptedPieces leaves it */
    const accepted = (text: string) => acceptedPieces(text).map((p) => text.slice(p.from, p.to)).join('');

    it('keeps text without CriticMarkup whole', () => {
      expect(acceptedPieces('plain text')).toEqual([{ from: 0, to: 10 }]);
      expect(acceptedPieces('')).toEqual([]);
    });

    it('keeps an addition\'s text, without its delimiters and metadata', () => {
      const text = `ends with {++${META}@@an addition++}`;
      const start = text.indexOf('an addition');
      expect(acceptedPieces(text)).toEqual([{ from: 0, to: 10 }, { from: start, to: start + 'an addition'.length }]);
    });

    it('drops a deletion and a comment, keeps a highlight\'s text and a substitution\'s new text', () => {
      expect(accepted(`A {--${META}@@very --}quick {~~${META}@@red~>brown~~} fox`)).toBe('A quick brown fox');
      expect(accepted(`{==jumps==}{>>${META}@@Which way?<<}{>>${META}@@North<<} over`)).toBe('jumps over');
      expect(accepted(`the {--old--}{++new++} one`)).toBe('the new one');
    });

    it('accepts a change nested in another', () => {
      expect(accepted(`{++${META}@@an {--${META}@@extra --}addition++}`)).toBe('an addition');
    });

    it('leaves markup that is not a whole change as it is', () => {
      expect(accepted('an {++unclosed one')).toBe('an {++unclosed one');
      expect(accepted('a stray ++} closer')).toBe('a stray ++} closer');
    });
  });
});
