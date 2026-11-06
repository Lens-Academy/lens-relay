import { describe, expect, it } from 'vitest';
import { barModel, barOffset, estimateMinutes, formatEstimate, sourceLabel, type RowState, type SourceQueue, type SourceRow } from './bar-model';

const QUEUE: SourceQueue = { workers: 2, avg_job_minutes: 4, queued: 0, processing: 0 };

function row(state: RowState, n: number, extra: Partial<SourceRow> = {}): SourceRow {
  const url = `https://example.com/post-${n}`;
  return { key: url, url, urls: [url], kind: 'article', label: `example.com/post-${n}`, state, jobIds: [], ...extra };
}

const rows = (state: RowState, count: number, from = 0, extra: Partial<SourceRow> = {}) =>
  Array.from({ length: count }, (_, i) => row(state, from + i, extra));

describe('barModel: the plan\'s table', () => {
  it('Offer, all new', () => {
    const model = barModel(rows('new', 3), QUEUE);
    expect(model.kind).toBe('offer');
    expect(model.text).toBe("3 sources on this page aren't in the library yet.");
    expect(model.primary?.label).toBe('Import and link');
    expect(model.primary?.urls).toHaveLength(3);
    expect(model.canChoose).toBe(true);
  });

  it('Offer, one', () => {
    const model = barModel([row('new', 1, { label: 'example.com/post' })], QUEUE);
    expect(model.text).toBe("example.com/post isn't in the library yet.");
    expect(model.primary?.label).toBe('Import and link');
    expect(model.canChoose).toBe(false);
  });

  it('Offer, all in library', () => {
    const model = barModel(rows('library', 2), QUEUE);
    expect(model.text).toBe('2 sources on this page are already in the library.');
    expect(model.primary?.label).toBe('Use library copies');
    expect(model.canChoose).toBe(true);
  });

  it('Offer, mixed', () => {
    const model = barModel([...rows('library', 1), ...rows('new', 3, 1)], QUEUE);
    expect(model.text).toBe('4 sources on this page: 1 is in the library, 3 can be imported.');
    expect(model.primary?.label).toBe('Import and link');
    expect(model.primary?.urls).toHaveLength(4);
    expect(model.canChoose).toBe(true);
  });

  it('Offer, more than 10 new: Choose is the way in', () => {
    const model = barModel(rows('new', 34), QUEUE);
    expect(model.text).toBe("34 sources on this page aren't in the library yet.");
    expect(model.primary).toBeUndefined();
    expect(model.canChoose).toBe(true);
  });

  it('Working', () => {
    const model = barModel(rows('working', 2, 0, { step: 'queued', jobIds: ['a'], etaMinutes: 8 }), QUEUE);
    expect(model.kind).toBe('working');
    expect(model.text).toBe('Importing 2 sources, about 8 min. You can keep working or close this page.');
    expect(model.canStop).toBe(true);
  });

  it('Done', () => {
    const model = barModel(rows('done', 3, 0, { imported: true }), QUEUE);
    expect(model.kind).toBe('done');
    expect(model.text).toBe('3 sources imported and linked.');
    expect(model.primary).toBeUndefined();
    expect(model.dismissUrls).toBeUndefined();
  });

  it('Failed', () => {
    const model = barModel(rows('failed', 1), QUEUE);
    expect(model.kind).toBe('failed');
    expect(model.text).toBe("1 source couldn't be imported.");
    expect(model.dismissUrls).toEqual(['https://example.com/post-0']);
  });
});

describe('barModel: what the table leaves open', () => {
  it('nothing to say hides the bar', () => {
    expect(barModel([], QUEUE).kind).toBe('hidden');
  });

  it('one source in the library says "Use library copy", under its title', () => {
    const model = barModel([row('library', 1, { label: 'On Doubt' })], QUEUE);
    expect(model.text).toBe('On Doubt is already in the library.');
    expect(model.primary?.label).toBe('Use library copy');
    expect(model.canChoose).toBe(false);
  });

  it('exactly 10 new can still go with one click, and 11 cannot', () => {
    expect(barModel(rows('new', 10), QUEUE).primary?.label).toBe('Import and link');
    expect(barModel(rows('new', 11), QUEUE).primary).toBeUndefined();
  });

  it('mixed with more than 10 new is Choose too, and only new ones count', () => {
    const many = barModel([...rows('library', 2), ...rows('new', 32, 2)], QUEUE);
    expect(many.text).toBe('34 sources on this page: 2 are in the library, 32 can be imported.');
    expect(many.primary).toBeUndefined();
    const few = barModel([...rows('library', 20), ...rows('new', 2, 20)], QUEUE);
    expect(few.primary?.label).toBe('Import and link');
  });

  it('cuts a long URL so the offer stays on one line', () => {
    const label = `example.com/${'a'.repeat(200)}`;
    const model = barModel([row('new', 1, { label })], QUEUE);
    expect(model.text.length).toBeLessThan(90);
    expect(model.text).toContain('…');
  });

  it('counts one source as a source', () => {
    const model = barModel([row('working', 1, { step: 'importing', jobIds: ['a'], etaMinutes: 4 })], QUEUE);
    expect(model.text).toBe('Importing 1 source, about 4 min. You can keep working or close this page.');
  });

  it('work outranks failures, and failures outrank Done and offers', () => {
    const working = row('working', 1, { step: 'queued', jobIds: ['a'] });
    expect(barModel([working, row('failed', 2), row('done', 3), row('new', 4)], QUEUE).kind).toBe('working');
    expect(barModel([row('failed', 2), row('done', 3), row('new', 4)], QUEUE).kind).toBe('failed');
    expect(barModel([row('done', 3), row('new', 4)], QUEUE).kind).toBe('done');
  });

  it('Details lists work, failures and what finished, and no offers', () => {
    const working = row('working', 1, { step: 'queued', jobIds: ['a'] });
    const model = barModel([working, row('failed', 2), row('done', 3), row('new', 4)], QUEUE);
    expect(model.rows.map((r) => r.state)).toEqual(['working', 'failed', 'done']);
    expect(barModel([row('failed', 2), row('done', 3)], QUEUE).rows.map((r) => r.state)).toEqual(['failed', 'done']);
  });

  it('Dismiss on failures lists the failures alone', () => {
    const model = barModel([row('failed', 2), row('done', 3)], QUEUE);
    expect(model.dismissUrls).toEqual(['https://example.com/post-2']);
  });

  it('says it is linking, not importing, when nothing needs importing', () => {
    const model = barModel(rows('working', 2, 0, { step: 'linking' }), QUEUE);
    expect(model.text).toBe('Linking 2 sources.');
    expect(model.canStop).toBeFalsy();
  });

  it('has no Stop before there is a job to stop', () => {
    const model = barModel(rows('working', 2, 0, { step: 'starting' }), QUEUE);
    expect(model.kind).toBe('working');
    expect(model.canStop).toBe(false);
  });

  it('works the estimate out when the server has not given one, and leaves it out when it cannot', () => {
    const starting = rows('working', 2, 0, { step: 'starting' });
    expect(barModel(starting, QUEUE).text).toContain('Importing 2 sources, about 4 min.');
    expect(barModel(starting, null).text).toBe('Importing 2 sources. You can keep working or close this page.');
  });

  it('takes the last job to finish as the estimate', () => {
    const model = barModel([
      row('working', 1, { step: 'importing', jobIds: ['a'], etaMinutes: 3 }),
      row('working', 2, { step: 'queued', jobIds: ['b'], etaMinutes: 12 }),
    ], QUEUE);
    expect(model.text).toContain('about 12 min');
  });

  it('keeps the moving estimate out of what screen readers hear', () => {
    const model = barModel(rows('working', 2, 0, { step: 'queued', jobIds: ['a'], etaMinutes: 8 }), QUEUE);
    expect(model.announce).toBe('Importing 2 sources. You can keep working or close this page.');
  });

  it('says linked, not imported, when only links changed', () => {
    expect(barModel(rows('done', 2, 0, { imported: false }), QUEUE).text).toBe('2 sources linked.');
    expect(barModel(rows('done', 1, 0, { imported: false }), QUEUE).text).toBe('1 source linked.');
  });
});

describe('barModel: suggestions', () => {
  it('says suggested, not linked, when the swap is a pending suggestion', () => {
    expect(barModel(rows('done', 2, 0, { suggested: true }), QUEUE).text).toBe('2 sources suggested.');
    expect(barModel(rows('done', 1, 0, { suggested: true, imported: true }), QUEUE).text).toBe(
      '1 source imported and suggested.',
    );
  });
});

describe('barOffset', () => {
  const BAR = { top: 50, height: 42 };
  const offset = (caretTop: number, caretBottom: number, pageBottom = 800) =>
    barOffset({ top: caretTop, bottom: caretBottom }, BAR.top, BAR.height, pageBottom);

  it('leaves the bar alone when the caret is clear of it', () => {
    expect(offset(100, 120)).toBe(0);
    expect(offset(20, 50)).toBe(0);
  });

  it('steps down past a caret under the bar', () => {
    expect(offset(60, 80)).toBe(36); // to 6px below the caret
  });

  it('counts a caret that only touches the bar', () => {
    expect(offset(85, 105)).toBe(61);
    expect(offset(40, 60)).toBe(16);
  });

  it('stays on the page, so its buttons can be reached', () => {
    expect(offset(60, 80, 100)).toBe(8);
    expect(offset(60, 80, 60)).toBe(0);
  });
});

describe('estimateMinutes', () => {
  it('is avg × ceil(n / workers)', () => {
    expect(estimateMinutes(1, QUEUE)).toBe(4);
    expect(estimateMinutes(2, QUEUE)).toBe(4);
    expect(estimateMinutes(3, QUEUE)).toBe(8);
  });

  it('adds what is queued ahead', () => {
    expect(estimateMinutes(2, { ...QUEUE, queued: 3 })).toBe(12);
  });

  it('survives a queue that reports no workers', () => {
    expect(estimateMinutes(2, { ...QUEUE, workers: 0 })).toBe(8);
  });
});

describe('formatEstimate', () => {
  it.each([
    [8, 'about 8 min'],
    [0.2, 'about 1 min'],
    [59, 'about 59 min'],
    [60, 'about 1 h'],
    [80, 'about 1 h 20 min'],
    [83, 'about 1 h 25 min'],
    [120, 'about 2 h'],
  ])('%s minutes is "%s"', (minutes, text) => {
    expect(formatEstimate(minutes)).toBe(text);
  });
});

describe('sourceLabel', () => {
  it.each([
    ['https://www.example.com/post/', 'example.com/post'],
    ['https://example.com/a/b?x=1', 'example.com/a/b?x=1'],
    ['https://www.youtube.com/watch?v=abc', 'youtube.com/watch?v=abc'],
    ['https://example.com/', 'example.com'],
    ['not a url', 'not a url'],
  ])('%s is %s', (url, label) => {
    expect(sourceLabel(url)).toBe(label);
  });
});
