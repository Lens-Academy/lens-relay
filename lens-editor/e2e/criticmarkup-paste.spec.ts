import { test, expect, type Page } from '@playwright/test';
import type { EditorView } from '@codemirror/view';
import type { CriticMarkupRange } from '../src/lib/criticmarkup-parser';

// Suggestion mode adds what you paste as an addition of yours. Text copied
// with someone's suggestion in it carried the suggestion's markup into yours,
// nested, and the parsers end an addition at the first `++}`: the paste showed
// `{++{"author":…}@@` as text and a stray `++}`. Now pasted suggestions go in
// as plain text, as they read once accepted
// (src/components/Editor/extensions/criticmarkup-paste.ts).

type FixtureWindow = Window & {
  view: EditorView;
  ranges: () => CriticMarkupRange[];
  authors: (from: number, to: number) => string[];
  shownText: (n: number) => string;
  setSuggestionMode: (on: boolean) => void;
  setSourceMode: (on: boolean) => void;
};

const LINES = 7; // e2e/fixtures/criticmarkup-paste.ts
const PASTE_LINE = 4; // "Paste here: ", followed by a line with a suggestion
const ELIAS = '{"author":"Elias","timestamp":1760000000000}@@';
/** Mark's metadata, whose time is the paste's */
const MARK = /\{"author":"Mark","timestamp":\d+\}/g;

let pageErrors: string[] = [];

function lineText(page: Page, n: number): Promise<string> {
  return page.evaluate((n) => (window as unknown as FixtureWindow).view.state.doc.line(n).text, n);
}

/** Line `n`'s text, with Mark's metadata as `<Mark>` */
async function lineWithMark(page: Page, n: number): Promise<string> {
  return (await lineText(page, n)).replace(MARK, '<Mark>');
}

function shownText(page: Page, n: number): Promise<string> {
  return page.evaluate((n) => (window as unknown as FixtureWindow).shownText(n), n);
}

/** The document position of `needle` on line `n` */
function pos(page: Page, n: number, needle: string): Promise<number> {
  return page.evaluate(({ n, needle }) => {
    const line = (window as unknown as FixtureWindow).view.state.doc.line(n);
    const at = line.text.indexOf(needle);
    if (at < 0) throw new Error(`"${needle}" is not on line ${n}`);
    return line.from + at;
  }, { n, needle });
}

function lineEnd(page: Page, n: number): Promise<number> {
  return page.evaluate((n) => (window as unknown as FixtureWindow).view.state.doc.line(n).to, n);
}

/**
 * Select `from`-`to` (a cursor without `to`) and focus the editor. Set
 * directly: clicks and End on a line with hidden syntax are not what this
 * tests, and End can stop inside a suggestion's hidden `++}` at a line's end.
 */
async function select(page: Page, from: number, to = from): Promise<void> {
  await page.evaluate(({ from, to }) => {
    const { view } = window as unknown as FixtureWindow;
    view.dispatch({ selection: { anchor: from, head: to } });
    view.focus();
  }, { from, to });
}

function setSuggestionMode(page: Page, on: boolean): Promise<void> {
  return page.evaluate((on) => (window as unknown as FixtureWindow).setSuggestionMode(on), on);
}

function clipboard(page: Page): Promise<string> {
  return page.evaluate(() => navigator.clipboard.readText());
}

/** The suggestions that start on line `n`, as [type, author, text] */
function suggestionsOn(page: Page, n: number): Promise<[string, string | undefined, string][]> {
  return page.evaluate((n) => {
    const { view, ranges } = window as unknown as FixtureWindow;
    const line = view.state.doc.line(n);
    return ranges()
      .filter((r) => r.from >= line.from && r.from <= line.to)
      .map((r) => [r.type, r.metadata?.author, r.content] as [string, string | undefined, string]);
  }, n);
}

function authors(page: Page, from: number, to: number): Promise<string[]> {
  return page.evaluate(({ from, to }) => (window as unknown as FixtureWindow).authors(from, to), { from, to });
}

/** Copy `ends with an addition` (Elias's addition whole) with Ctrl+C */
async function copyEndsWith(page: Page): Promise<void> {
  await select(page, await pos(page, 2, 'ends'), await lineEnd(page, 2));
  await page.keyboard.press('Control+c');
  expect(await clipboard(page)).toBe(`ends with {++${ELIAS}an addition++}`);
}

/** Paste with Ctrl+V at the end of the paste line; returns where the paste starts */
async function pasteOnPasteLine(page: Page): Promise<number> {
  const at = await lineEnd(page, PASTE_LINE);
  await select(page, at);
  await page.keyboard.press('Control+v');
  return at;
}

/** The paste line holds `Paste here: ` and one addition of Mark's with `text` */
async function expectMarksAddition(page: Page, text: string): Promise<void> {
  expect(await lineWithMark(page, PASTE_LINE)).toBe(`Paste here: {++<Mark>@@${text}++}`);
  expect(await suggestionsOn(page, PASTE_LINE)).toEqual([['addition', 'Mark', text]]);
  expect(await shownText(page, PASTE_LINE)).toBe(`Paste here: ${text}`);
  await expect(page.locator('.cm-content > .cm-line').nth(PASTE_LINE - 1).locator('.cm-addition')).toHaveText(text);
}

/** Nothing ran on into the lines after the paste line */
async function expectLinesAfterIntact(page: Page): Promise<void> {
  expect(await lineText(page, PASTE_LINE + 1)).toBe(`This line has {++${ELIAS}its own addition++} after the paste.`);
  expect(await shownText(page, PASTE_LINE + 1)).toBe('This line has its own addition after the paste.');
  expect(await shownText(page, LINES - 1)).toBe('This line must stay as it is.');
}

test.describe('Suggestion mode: pasting text with suggestions in it', () => {
  test.beforeEach(async ({ page, context, baseURL }) => {
    pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    // CodeMirror catches what a key binding throws and only logs it
    page.on('console', (message) => {
      if (message.type() === 'error') pageErrors.push(message.text());
    });
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: baseURL });
    await page.setViewportSize({ width: 900, height: 700 });
    await page.goto('/e2e/fixtures/criticmarkup-paste.html');
    await expect(page.locator('.cm-content > .cm-line')).toHaveCount(LINES);
    await page.evaluate(() => document.fonts.ready);
  });

  test.afterEach(() => {
    expect(pageErrors).toEqual([]);
  });

  test('Ctrl+V of text copied with someone\'s addition in it adds one addition, with their text as plain text', async ({ page }) => {
    await copyEndsWith(page);
    await setSuggestionMode(page, true);
    await pasteOnPasteLine(page);

    await expectMarksAddition(page, 'ends with an addition');
    await expectLinesAfterIntact(page);
    // Pasted, the text keeps its authors: Luc's, and Elias's in his addition
    const at = await pos(page, PASTE_LINE, 'ends with');
    expect(await authors(page, at, at + 'ends with an addition'.length))
      .toEqual(['human:Luc: ends with ', 'human:Elias: an addition']);
  });

  test('a deletion\'s text and a comment go, a substitution and a replaced pair keep their new text', async ({ page }) => {
    await select(page, await pos(page, 3, 'A '), await lineEnd(page, 3));
    await page.keyboard.press('Control+c');
    await setSuggestionMode(page, true);
    await pasteOnPasteLine(page);

    await expectMarksAddition(page, 'A quick brown fox jumps over the sleepy dog.');
    await expectLinesAfterIntact(page);
  });

  test('Ctrl+V into an addition of your own puts the text in it', async ({ page }) => {
    await copyEndsWith(page);
    await setSuggestionMode(page, true);
    await select(page, await lineEnd(page, PASTE_LINE));
    await page.keyboard.type('My words: ');
    await page.keyboard.press('Control+v');

    await expectMarksAddition(page, 'My words: ends with an addition');
    await expectLinesAfterIntact(page);
  });

  test('a whole line copied with Ctrl+C and nothing selected goes in above the cursor\'s line, as plain text', async ({ page }) => {
    await select(page, await pos(page, 2, 'line'));
    await page.keyboard.press('Control+c');
    expect(await clipboard(page)).toBe(`This line ends with {++${ELIAS}an addition++}`);
    await setSuggestionMode(page, true);
    await select(page, await pos(page, PASTE_LINE, 'here'));
    await page.keyboard.press('Control+v');

    // The line break is in the addition: its `++}` starts the next line
    expect(await lineWithMark(page, PASTE_LINE)).toBe('{++<Mark>@@This line ends with an addition');
    expect(await lineText(page, PASTE_LINE + 1)).toBe('++}Paste here: ');
    expect(await suggestionsOn(page, PASTE_LINE)).toEqual([['addition', 'Mark', 'This line ends with an addition\n']]);
    expect(await shownText(page, PASTE_LINE)).toBe('This line ends with an addition');
    expect(await shownText(page, PASTE_LINE + 1)).toBe('Paste here: ');
    expect(await lineText(page, PASTE_LINE + 2)).toBe(`This line has {++${ELIAS}its own addition++} after the paste.`);
  });

  test('outside suggestion mode, Ctrl+V pastes the addition as it is, still Elias\'s', async ({ page }) => {
    await copyEndsWith(page);
    await pasteOnPasteLine(page);

    expect(await lineText(page, PASTE_LINE)).toBe(`Paste here: ends with {++${ELIAS}an addition++}`);
    expect(await suggestionsOn(page, PASTE_LINE)).toEqual([['addition', 'Elias', 'an addition']]);
    expect(await shownText(page, PASTE_LINE)).toBe('Paste here: ends with an addition');
    await expectLinesAfterIntact(page);
  });
});
