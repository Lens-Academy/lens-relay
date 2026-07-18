import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import { surgicalDeletions } from './criticmarkup-surgical';
import { applySuggestionAction } from './suggestion-actions';
import { getAuthorshipRuns } from './authorship-runs';
import type { SuggestionItem } from '../hooks/useSuggestions';

const META = '{"author":"Luc\'s AI","timestamp":1784380170036}@@';

function applyDeletions(doc: string, ranges: Array<{ from: number; to: number }>): string {
  let out = doc;
  for (const r of [...ranges].sort((a, b) => b.from - a.from)) {
    out = out.slice(0, r.from) + out.slice(r.to);
  }
  return out;
}

describe('surgicalDeletions', () => {
  it('accept addition deletes only markers and metadata, keeping payload', () => {
    const markup = `{++${META}hello world++}`;
    const doc = `before ${markup} after`;
    const ranges = surgicalDeletions({
      markup,
      start: 7,
      type: 'addition',
      action: 'accept',
      content: 'hello world',
    });
    expect(ranges).not.toBeNull();
    expect(applyDeletions(doc, ranges!)).toBe('before hello world after');
    // Payload chars must not be inside any deleted range.
    const payloadStart = 7 + markup.indexOf('hello world');
    for (const r of ranges!) {
      expect(r.to <= payloadStart || r.from >= payloadStart + 'hello world'.length).toBe(true);
    }
  });

  it('reject addition deletes the whole span', () => {
    const markup = `{++${META}zap++}`;
    const doc = `a ${markup} b`;
    const ranges = surgicalDeletions({
      markup, start: 2, type: 'addition', action: 'reject', content: 'zap',
    });
    expect(applyDeletions(doc, ranges!)).toBe('a  b');
  });

  it('accept deletion removes everything; reject keeps original content', () => {
    const markup = `{--${META}old text--}`;
    const doc = `x ${markup} y`;
    const acc = surgicalDeletions({
      markup, start: 2, type: 'deletion', action: 'accept', content: 'old text',
    });
    expect(applyDeletions(doc, acc!)).toBe('x  y');
    const rej = surgicalDeletions({
      markup, start: 2, type: 'deletion', action: 'reject', content: 'old text',
    });
    expect(applyDeletions(doc, rej!)).toBe('x old text y');
  });

  it('substitution keeps the right side per action', () => {
    const markup = `{~~${META}old stuff~>new stuff~~}`;
    const doc = `A ${markup} B`;
    const acc = surgicalDeletions({
      markup, start: 2, type: 'substitution', action: 'accept',
      content: '', oldContent: 'old stuff', newContent: 'new stuff',
    });
    expect(applyDeletions(doc, acc!)).toBe('A new stuff B');
    const rej = surgicalDeletions({
      markup, start: 2, type: 'substitution', action: 'reject',
      content: '', oldContent: 'old stuff', newContent: 'new stuff',
    });
    expect(applyDeletions(doc, rej!)).toBe('A old stuff B');
  });

  it('works without metadata prefix', () => {
    const markup = '{++plain++}';
    const ranges = surgicalDeletions({
      markup, start: 0, type: 'addition', action: 'accept', content: 'plain',
    });
    expect(applyDeletions(markup, ranges!)).toBe('plain');
  });

  it('returns null when the markup does not match the expected structure', () => {
    expect(
      surgicalDeletions({
        markup: '{++broken', start: 0, type: 'addition', action: 'accept', content: 'nope',
      })
    ).toBeNull();
    expect(
      surgicalDeletions({
        markup: `{~~${META}old~>new~~}`, start: 0, type: 'substitution', action: 'accept',
        content: '', oldContent: 'MISMATCH', newContent: 'new',
      })
    ).toBeNull();
  });
});

describe('applySuggestionAction preserves authorship (the whole point)', () => {
  function docWithAiSuggestion() {
    // Human writes a sentence...
    const doc = new Y.Doc();
    const humanId = doc.clientID;
    const ytext = doc.getText('contents');
    ytext.insert(0, 'Human prose. ');
    // ...then the "AI" (different clientID) inserts a suggestion after it.
    const markup = `{++${META}AI payload text.++}`;
    doc.clientID = 424242;
    ytext.insert('Human prose. '.length, markup);
    doc.clientID = humanId;
    return { doc, ytext, humanId, markup };
  }

  function suggestionFor(markup: string, from: number): SuggestionItem {
    return {
      doc_id: 'test', path: '/t.md', type: 'addition',
      content: 'AI payload text.', old_content: null, new_content: null,
      author: "Luc's AI", timestamp: 1, from, to: from + markup.length,
      raw_markup: markup,
    } as unknown as SuggestionItem;
  }

  it('accepted AI text keeps the AI clientID', () => {
    const { doc, ytext, humanId, markup } = docWithAiSuggestion();
    applySuggestionAction(doc, suggestionFor(markup, 13), 'accept');

    expect(ytext.toString()).toBe('Human prose. AI payload text.');
    const runs = getAuthorshipRuns(ytext);
    expect(runs).toEqual([
      { from: 0, to: 13, client: humanId },
      { from: 13, to: 29, client: 424242 },
    ]);
  });

  it('rejected deletion keeps the original author', () => {
    const doc = new Y.Doc();
    const humanId = doc.clientID;
    const ytext = doc.getText('contents');
    ytext.insert(0, 'keep me');
    // AI wraps the human text in a delete-suggestion: {--<meta>keep me--}
    const markup = `{--${META}keep me--}`;
    doc.clientID = 424242;
    // Simulate the server merge: markers+meta inserted around the human text.
    ytext.insert(0, `{--${META}`);
    ytext.insert(`{--${META}`.length + 'keep me'.length, '--}');
    doc.clientID = humanId;
    expect(ytext.toString()).toBe(markup);

    const s = {
      doc_id: 'test', path: '/t.md', type: 'deletion',
      content: 'keep me', old_content: null, new_content: null,
      author: "Luc's AI", timestamp: 1, from: 0, to: markup.length,
      raw_markup: markup,
    } as unknown as SuggestionItem;
    applySuggestionAction(doc, s, 'reject');

    expect(ytext.toString()).toBe('keep me');
    // The surviving text is the human's original items.
    expect(getAuthorshipRuns(ytext)).toEqual([{ from: 0, to: 7, client: humanId }]);
  });
});
