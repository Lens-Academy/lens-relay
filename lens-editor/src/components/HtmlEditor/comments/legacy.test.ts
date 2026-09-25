import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import { hasLegacyComments, legacyMarkerRanges, parseLegacyComments, stripLegacyMarkers, withoutLegacyTextAnchors } from './legacy';

const SOURCE = '<p>a</p>[[@comment:c1]]<!--lens-comment {"id":"c1","author":"ann","ts":"t1","body":"has --\\u003e and \\"quotes\\""}-->'
  + '<p>b</p><!--lens-reply {"id":"r2","parent":"c1","author":"bob","ts":"t3","body":"late reply"}-->'
  + '<!--lens-comment {"id":"c2","author":"cy","ts":"t2","body":"second"}--><!--lens-other x-->';

describe('legacy inline comments', () => {
  it('detects and parses threads, attaching replies wherever they are', () => {
    expect(hasLegacyComments(SOURCE)).toBe(true);
    expect(hasLegacyComments('<p>clean</p>')).toBe(false);
    const threads = parseLegacyComments(SOURCE);
    expect(threads.map(t => [t.id, t.author, t.body, t.replies.map(r => r.body)])).toEqual([
      ['c1', 'ann', 'has --> and "quotes"', ['late reply']],
      ['c2', 'cy', 'second', []],
    ]);
  });

  it('removes only the text anchors for rendering', () => {
    expect(withoutLegacyTextAnchors(SOURCE)).not.toContain('[[@comment:');
    expect(withoutLegacyTextAnchors(SOURCE)).toContain('<!--lens-comment');
  });

  it('strips every marker from the Y.Text and nothing else', () => {
    const doc = new Y.Doc();
    const text = doc.getText('contents');
    text.insert(0, SOURCE);
    expect(legacyMarkerRanges(SOURCE)).toHaveLength(4);
    expect(stripLegacyMarkers(text, 'o')).toBe(4);
    expect(text.toString()).toBe('<p>a</p><p>b</p><!--lens-other x-->');
  });
});
