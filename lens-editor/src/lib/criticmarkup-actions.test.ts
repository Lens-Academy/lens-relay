// src/lib/criticmarkup-actions.test.ts
import { describe, it, expect } from 'vitest';
import { acceptChange, rejectChange } from './criticmarkup-actions';
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
});
