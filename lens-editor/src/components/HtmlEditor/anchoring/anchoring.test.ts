import { describe, it, expect, beforeEach } from 'vitest';
import { buildTextIndex, normalizeText, rangeFor, offsetOfPoint } from './text-index';
import { clickSpan, describeElement, describeRange, describeSpan, uniqueCssPath } from './describe';
import { resolveAnchor, type TextResolution } from './resolve';
import { fuzzyFind, similarity } from './fuzzy';
import { readAnchor, type TextAnchor } from './types';

function page(html: string): Document {
  document.body.innerHTML = html;
  return document;
}

function anchorFor(quote: string, occurrence = 0): TextAnchor {
  const index = buildTextIndex(document.body);
  let at = -1;
  for (let i = 0; i <= occurrence; i++) at = index.text.indexOf(quote, at + 1);
  if (at < 0) throw new Error(`quote not on page: ${quote}`);
  const anchor = describeSpan(index, at, at + quote.length);
  if (!anchor) throw new Error('no anchor');
  return anchor;
}

function resolveNow(anchor: TextAnchor) {
  const index = buildTextIndex(document.body);
  const res = resolveAnchor(document, index, anchor);
  const text = res.kind === 'text' ? index.text.slice(res.start, res.end) : null;
  return { res, text, index };
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('text index', () => {
  it('collapses whitespace and separates blocks like a reader sees them', () => {
    page('<h1>Title</h1>\n  <ul><li>One</li><li>Two  <b>bold</b></li></ul><p>A&nbsp;b</p><script>var x = "no";</script>');
    expect(buildTextIndex(document.body).text).toBe('Title One Two bold A b');
  });

  it('maps offsets back to DOM ranges and points', () => {
    page('<p>Hello <em>brave</em> new world</p>');
    const index = buildTextIndex(document.body);
    const at = index.text.indexOf('brave new');
    const range = rangeFor(index, at, at + 'brave new'.length)!;
    expect(normalizeText(range.toString())).toBe('brave new');
    expect(offsetOfPoint(index, range.startContainer, range.startOffset)).toBe(at);
    // The end maps to the next character, past the collapsed space.
    expect(offsetOfPoint(index, range.endContainer, range.endOffset)).toBe(at + 'brave new '.length);
    expect(describeRange(index, range)?.quote).toBe('brave new');
  });

  it('skips the bridge overlay and zero-width characters', () => {
    page('<p>so​ft</p><div data-lens-overlay>1</div>');
    expect(buildTextIndex(document.body).text).toBe('soft');
  });
});

describe('describing', () => {
  it('keeps context even for a unique quote and records the section', () => {
    page('<h2>Pricing</h2><p>The basic plan costs ten euros a month.</p>');
    const anchor = anchorFor('ten euros');
    expect(anchor.prefix).toBe('Pricing The basic plan costs ');
    expect(anchor.suffix).toBe(' a month.');
    expect(anchor.section).toBe('Pricing');
    expect(anchor.ordinal).toBeUndefined();
  });

  it('grows context until a repeated quote is unique', () => {
    const filler = 'x'.repeat(40);
    page(`<p>${filler} alpha Read more</p><p>${filler} beta Read more</p>`);
    const anchor = anchorFor('Read more', 1);
    expect(anchor.prefix.endsWith('beta ')).toBe(true);
    expect(anchor.ordinal).toBeUndefined();
  });

  it('tells list items apart by context when it can', () => {
    page('<ul><li>Edit</li><li>Edit</li><li>Edit</li></ul>');
    // The page edges make each one's surroundings unique.
    expect(anchorFor('Edit', 1).ordinal).toBeUndefined();
  });

  it('falls back to scope and ordinal for long verbatim repeats', () => {
    // 200 characters of context each side are still identical in the middle.
    page(`<ul>${'<li>Edit</li>'.repeat(120)}</ul>`);
    const anchor = anchorFor('Edit', 60);
    expect(anchor.ordinal).toBeGreaterThan(0);
    expect(anchor.scope?.css).toBe('li:nth-of-type(61)');
  });

  it('uses a stable id as scope and ignores generated ones', () => {
    page('<p>Intro text for the page.</p><section id="faq"><div id=":r3:"><p>Question one</p></div></section><p>Outro text for the page.</p>');
    expect(anchorFor('Question').scope).toEqual({ id: 'faq', tag: 'section' });
  });

  it('never uses a whole-app container like #root as scope', () => {
    page('<div id="root"><h1>App</h1><p>Total: 42 items</p></div>');
    expect(anchorFor('Total').scope).toBeUndefined();
  });

  it('builds the shortest unique css path', () => {
    page('<main><section><p>a</p><p>b</p></section><section><p>c</p></section></main>');
    const p = document.querySelectorAll('p')[1];
    expect(uniqueCssPath(p)).toBe('p:nth-of-type(2)');
    expect(uniqueCssPath(document.querySelectorAll('p')[0])).toBe('section:nth-of-type(1) > p:nth-of-type(1)');
  });

  it('clicks select a short block whole, a long one by sentence', () => {
    const long = 'First sentence is here. The second sentence talks about something else entirely and keeps going. '
      + 'A third one follows it to make the paragraph long enough for splitting into sentences.';
    page(`<h3>Short heading</h3><p>${long}</p>`);
    const index = buildTextIndex(document.body);
    const head = clickSpan(index, 2)!;
    expect(index.text.slice(head.start, head.end)).toBe('Short heading');
    const at = index.text.indexOf('talks');
    const span = clickSpan(index, at)!;
    expect(index.text.slice(span.start, span.end).trim()).toBe(
      'The second sentence talks about something else entirely and keeps going.',
    );
  });

  it('describes element pins with label, index and point', () => {
    page('<figure><img src="/charts/revenue.png" alt="Revenue by month"></figure><img src="b.png">');
    const img = document.querySelector('img')!;
    const anchor = describeElement(img, { x: 0, y: 0 });
    expect(anchor).toMatchObject({ kind: 'element', tag: 'img', label: 'Revenue by month', tagIndex: 0 });
  });
});

describe('resolving text anchors', () => {
  it('finds an unchanged anchor', () => {
    page('<p>The quick brown fox jumps over the lazy dog.</p>');
    const { res, text } = resolveNow(anchorFor('brown fox'));
    expect(res.state).toBe('anchored');
    expect(text).toBe('brown fox');
  });

  it('survives restructuring, new content before it and reordering', () => {
    page('<h2>Intro</h2><p>Alpha paragraph here.</p><h2>Details</h2><p>The important claim sits here.</p>');
    const anchor = anchorFor('important claim');
    page('<div class="grid"><article><h2>Details</h2><div><p>The <strong>important</strong> claim sits here.</p></div></article>'
      + '<article><h2>New section</h2><p>Lots of new text.</p></article><h2>Intro</h2><p>Alpha paragraph here.</p></div>');
    const { res, text } = resolveNow(anchor);
    expect(res.state).toBe('anchored');
    expect(text).toBe('important claim');
  });

  it('follows a fixed typo inside the quote', () => {
    page('<p>We recieve many applications every single year from students.</p>');
    const anchor = anchorFor('We recieve many applications every single year');
    page('<p>We receive many applications every single year from students.</p>');
    const { res, text } = resolveNow(anchor);
    expect(res.state).toBe('anchored');
    expect(text).toBe('We receive many applications every single year');
  });

  it('prefers a lightly edited short quote in place over the same words elsewhere', () => {
    page('<p>The job fires a full Coach turn per due row.</p><p>Later we run a full backfill of the data.</p>');
    const anchor = anchorFor('a full');
    page('<p>The job fires a flul Coach turn per due row.</p><p>Later we run a full backfill of the data.</p>');
    const { res, text } = resolveNow(anchor);
    expect(text).toBe('a flul');
    expect(res.state).not.toBe('orphaned');
  });

  it('marks a reworded quote as guessed rather than anchored', () => {
    page('<p>Before text. Our team meets every Tuesday at noon in room four. After text follows.</p>');
    const anchor = anchorFor('Our team meets every Tuesday at noon in room four.');
    page('<p>Before text. The group now gathers on Thursdays after lunch downstairs. After text follows.</p>');
    const { res, text } = resolveNow(anchor);
    expect(res.state).toBe('guessed');
    expect(text).toBe('The group now gathers on Thursdays after lunch downstairs.');
  });

  it('orphans an anchor whose text was removed', () => {
    page('<p>Keep this.</p><p>Delete this whole sentence about llamas.</p>');
    const anchor = anchorFor('sentence about llamas');
    page('<p>Keep this.</p><p>Something completely unrelated.</p>');
    expect(resolveNow(anchor).res.state).toBe('orphaned');
  });

  it('orphans a deleted sentence even when a look-alike remains elsewhere', () => {
    const intro = 'The compute used to train the largest AI models has doubled roughly every six months since 2010.';
    const filler = 'Some other paragraph text about scaling laws and hardware. '.repeat(20);
    page(`<p>${intro}</p><p>${filler}</p><p>A 6-month doubling is 4× per year. `
      + 'For comparison, Moore’s law (transistors per chip) doubled roughly every 24 months. Frontier AI training has grown far faster.</p>');
    const anchor = anchorFor('For comparison, Moore’s law (transistors per chip) doubled roughly every 24 months.');
    page(`<p>${intro}</p><p>${filler}</p><p>A 6-month doubling is 4× per year. Frontier AI training has grown far faster.</p>`);
    expect(resolveNow(anchor).res.state).toBe('orphaned');
  });

  it('does not guess a short reworded quote onto a far-away look-alike', () => {
    const filler = 'Unrelated words fill this long paragraph for a while. '.repeat(60);
    page(`<h2>Why the trend could bend</h2><p>${filler}</p><p>Before. Why the trend might bend. After.</p>`);
    const anchor = anchorFor('Why the trend might bend');
    page(`<h2>Why the trend could bend</h2><p>${filler}</p><p>Before. After.</p>`);
    expect(resolveNow(anchor).res.state).toBe('orphaned');
  });

  it('does not trust a short quote found elsewhere once its own text was rewritten', () => {
    page('<p>First paragraph mentions the cat in passing, among other things.</p>'
      + '<p>Second paragraph: the cat sat on the mat and looked around.</p>');
    const anchor = anchorFor('the cat', 1);
    page('<p>First paragraph mentions the cat in passing, among other things.</p>'
      + '<p>Second paragraph: a dog lay by the door and slept soundly.</p>');
    expect(resolveNow(anchor).res.state).not.toBe('anchored');
  });

  it('does not move a deleted heading onto its table-of-contents copy', () => {
    const body = '<p>' + 'Body text about many things. '.repeat(10) + '</p>';
    page(`<nav><a href="#i">Introduction</a> <a href="#m">Methods</a></nav><h2 id="i">Introduction</h2>${body}<h2 id="m">Methods</h2>${body}`);
    const anchor = anchorFor('Introduction', 1);
    page(`<nav><a href="#i">Introduction</a> <a href="#m">Methods</a></nav>${body}<h2 id="m">Methods</h2>${body}`);
    expect(resolveNow(anchor).res.state).not.toBe('anchored');
  });

  it('keeps a long verbatim sentence anchored after it moved to another section', () => {
    const moved = 'This particular sentence was moved into a different section of the page.';
    page(`<h2>One</h2><p>Alpha text here. ${moved} Beta text here.</p><h2>Two</h2><p>Gamma text.</p>`);
    const anchor = anchorFor(moved);
    page(`<h2>One</h2><p>Alpha text here. Beta text here.</p><h2>Two</h2><p>Gamma text. ${moved}</p>`);
    const { res, text } = resolveNow(anchor);
    expect(res.state).toBe('anchored');
    expect(text).toBe(moved);
  });

  it('demotes a match outside the id scope that no longer holds the quote', () => {
    page('<p>Lead.</p><section id="a"><p>Shared words appear here</p></section><section id="b"><p>Other stuff</p></section>');
    const anchor = anchorFor('Shared words appear here');
    expect(anchor.scope?.id).toBe('a');
    page('<p>Lead.</p><section id="a"><p>Rewritten entirely</p></section><section id="b"><p>Shared words appear here</p></section>');
    expect(resolveNow(anchor).res.state).toBe('guessed');
  });

  it('survives a hostile ordinal', () => {
    page(`<ul>${'<li>Edit</li>'.repeat(120)}</ul>`);
    const anchor = { ...anchorFor('Edit', 60), ordinal: -1 };
    page(`<ul>${'<li>Edit</li>'.repeat(121)}</ul>`);
    expect(() => resolveNow(anchor)).not.toThrow();
    expect(readAnchor({ ...anchor, ordinal: -1 })?.kind === 'text' && readAnchor({ ...anchor, ordinal: -1 })).not.toHaveProperty('ordinal');
  });

  it('keeps the right duplicate when context tells them apart', () => {
    page('<ul><li>Apples: in stock</li><li>Pears: in stock</li></ul>');
    const anchor = anchorFor('in stock', 1);
    page('<ul><li>Kiwis: sold out</li><li>Apples: in stock</li><li>Pears: in stock</li></ul>');
    const { res, index } = resolveNow(anchor);
    const r = res as TextResolution;
    expect(res.state).toBe('anchored');
    expect(index.text.slice(r.start - 7, r.start)).toBe('Pears: ');
  });

  it('uses the scope id to tell verbatim duplicates apart after reordering', () => {
    page('<div id="plan-a"><p>Includes support</p></div><div id="plan-b"><p>Includes support</p></div>');
    const anchor = anchorFor('Includes support', 1);
    expect(anchor.scope?.id).toBe('plan-b');
    page('<div id="plan-b"><p>Includes support</p></div><div id="plan-a"><p>Includes support</p></div>');
    const { res } = resolveNow(anchor);
    expect(res.state).toBe('anchored');
    const r = res as TextResolution;
    const range = rangeFor(buildTextIndex(document.body), r.start, r.end)!;
    expect((range.startContainer.parentElement!.closest('div') as HTMLElement).id).toBe('plan-b');
  });

  it('reports a verbatim duplicate as guessed once the page changed', () => {
    page(`<ul>${'<li>Edit</li>'.repeat(120)}</ul>`);
    const anchor = anchorFor('Edit', 60);
    expect(resolveNow(anchor).res.state).toBe('anchored');
    page(`<ul>${'<li>Edit</li>'.repeat(121)}</ul>`);
    expect(resolveNow(anchor).res.state).toBe('guessed');
  });

  it('finds long quotes by head and tail when the middle changed', () => {
    const before = 'This long passage opens with a distinctive start and continues through a middle section '
      + 'that someone will later rewrite, before it closes with an equally distinctive ending.';
    page(`<p>${before}</p>`);
    const anchor = anchorFor(before);
    const after = before.replace('a middle section that someone will later rewrite', 'a middle that was rewritten');
    page(`<p>${after}</p>`);
    const { res, text } = resolveNow(anchor);
    expect(res.state).not.toBe('orphaned');
    expect(text).toBe(after);
  });
});

describe('resolving element anchors', () => {
  it('finds an image by label after it moved', () => {
    page('<img src="a.png" alt="Logo"><p>x</p><img src="chart.png" alt="Revenue chart">');
    const anchor = describeElement(document.querySelectorAll('img')[1], { x: 10, y: 10 });
    page('<section><img src="chart.png" alt="Revenue chart"></section><img src="a.png" alt="Logo">');
    const res = resolveAnchor(document, buildTextIndex(document.body), anchor);
    expect(res.state).toBe('anchored');
    expect(res.kind === 'element' && res.element.getAttribute('alt')).toBe('Revenue chart');
  });

  it('keeps the only canvas on the page anchored when its wrapper changed', () => {
    page('<div><canvas></canvas></div>');
    const anchor = describeElement(document.querySelector('canvas')!, { x: 0, y: 0 });
    page('<main><section><canvas></canvas></section></main>');
    expect(resolveAnchor(document, buildTextIndex(document.body), anchor).state).toBe('anchored');
  });

  it('guesses an unlabelled canvas when another one is inserted before it', () => {
    page('<div><p>a</p><canvas></canvas></div><div><p>b</p><canvas></canvas></div>');
    const anchor = describeElement(document.querySelectorAll('canvas')[1], { x: 0, y: 0 });
    page('<div><p>a</p><canvas></canvas></div><div><p>b</p><canvas></canvas><canvas></canvas></div>');
    expect(resolveAnchor(document, buildTextIndex(document.body), anchor).state).not.toBe('anchored');
  });

  it('guesses an unlabelled canvas by position when its path broke', () => {
    page('<div><canvas></canvas></div><div><canvas></canvas></div>');
    const anchor = describeElement(document.querySelectorAll('canvas')[1], { x: 0, y: 0 });
    page('<section><canvas></canvas><canvas></canvas></section>');
    const res = resolveAnchor(document, buildTextIndex(document.body), anchor);
    expect(res.state).toBe('guessed');
    expect(res.kind === 'element' && res.element).toBe(document.querySelectorAll('canvas')[1]);
  });
});

describe('fuzzy matching', () => {
  it('finds approximate matches with their extent', () => {
    const text = 'lorem ipsum dolor sit amet, consectetur adipiscing elit';
    const match = fuzzyFind(text, 'dolar sit amt', 3)!;
    expect(text.slice(match.start, match.end)).toBe('dolor sit amet');
    expect(match.errors).toBe(2);
  });

  it('prefers the match nearest the expected position', () => {
    const text = 'the cat sat. '.repeat(3);
    const match = fuzzyFind(text, 'the kat sat', 2, { expected: 13 })!;
    expect(match.start).toBe(13);
  });

  it('scores similarity', () => {
    expect(similarity('abc', 'abc')).toBe(1);
    expect(similarity('abcd', 'abxd')).toBe(0.75);
  });
});

describe('readAnchor', () => {
  it('accepts anchors and clips untrusted strings', () => {
    const anchor = readAnchor({ kind: 'text', quote: 'q'.repeat(5000), prefix: 'p', suffix: 's', position: { start: 1 } });
    expect(anchor?.kind === 'text' && anchor.quote.length).toBe(2000);
    expect(readAnchor({ kind: 'text', quote: '' })).toBeNull();
    expect(readAnchor({ kind: 'nope' })).toBeNull();
  });
});
