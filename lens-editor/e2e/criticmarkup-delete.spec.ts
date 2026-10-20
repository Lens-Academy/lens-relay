import { test, expect, type Page } from '@playwright/test';
import type { EditorView } from '@codemirror/view';
import type { CriticMarkupRange } from '../src/lib/criticmarkup-parser';

// Live preview hides a suggestion's delimiters and metadata. Deleting must
// never take part of them: a suggestion that loses its closing delimiter runs
// on into the lines after it (src/components/Editor/extensions/criticmarkup-delete.ts).

type FixtureWindow = Window & {
  view: EditorView;
  ranges: () => CriticMarkupRange[];
  setSuggestionMode: (on: boolean) => void;
  setSourceMode: (on: boolean) => void;
  seedRandom: (seed: number) => void;
};

const LINES = 9; // e2e/fixtures/criticmarkup-delete.ts
const ELIAS = '{"author":"Elias","timestamp":1760000000000}@@';
// Suggestion mode writes {"author":"Mark","timestamp":…}@@
const MARK = '\\{"author":"Mark","timestamp":\\d+\\}@@';
const escape = (s: string) => s.replace(/[{}()[\]+*?.^$|\\]/g, '\\$&');

let pageErrors: string[] = [];

function lineText(page: Page, n: number): Promise<string> {
  return page.evaluate((n) => (window as unknown as FixtureWindow).view.state.doc.line(n).text, n);
}

/** The document position of `needle` on line `n`, plus `offset` */
function pos(page: Page, n: number, needle: string, offset = 0): Promise<number> {
  return page.evaluate(({ n, needle, offset }) => {
    const line = (window as unknown as FixtureWindow).view.state.doc.line(n);
    const at = line.text.indexOf(needle);
    if (at < 0) throw new Error(`"${needle}" is not on line ${n}`);
    return line.from + at + offset;
  }, { n, needle, offset });
}

async function place(page: Page, at: number): Promise<void> {
  await page.evaluate((at) => {
    const { view } = window as unknown as FixtureWindow;
    view.dispatch({ selection: { anchor: at } });
    view.focus();
  }, at);
}

function selection(page: Page): Promise<{ anchor: number; head: number }> {
  return page.evaluate(() => {
    const { main } = (window as unknown as FixtureWindow).view.state.selection;
    return { anchor: main.anchor, head: main.head };
  });
}

/** The screen point of document position `at`, mid-height of its line */
function pointAt(page: Page, at: number): Promise<{ x: number; y: number }> {
  return page.evaluate((at) => {
    const c = (window as unknown as FixtureWindow).view.coordsAtPos(at, 1)!;
    return { x: c.left, y: (c.top + c.bottom) / 2 };
  }, at);
}

/**
 * Select with the mouse from document position `from` to `to`. CodeMirror
 * turns a point into a position with a search that breaks ties at random,
 * and the zero-size boxes of hidden syntax (and of the ✓ ✗ buttons) steer it
 * off: on a suggestion's line a point can come back as the suggestion's start.
 * So `Math.random` is seeded, with a seed under which the drag lands where
 * aimed, and the selection is checked before the test goes on.
 */
async function drag(page: Page, from: number, to: number, seed = 7): Promise<void> {
  await page.evaluate((seed) => (window as unknown as FixtureWindow).seedRandom(seed), seed);
  const a = await pointAt(page, from);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  // Once the selection reaches a suggestion, its ✓ ✗ buttons show at the end
  // of its text and move what follows: aim again
  for (let i = 0; i < 3; i++) {
    const b = await pointAt(page, to);
    await page.mouse.move(b.x, b.y, { steps: 4 });
  }
  await page.mouse.up();
  expect(await selection(page), 'the mouse selection').toEqual({ anchor: from, head: to });
}

/**
 * Every suggestion and comment still ends on the line it starts on (none ran
 * on into the next lines), and the last two lines show as plain text
 */
async function expectNoRunOn(page: Page): Promise<void> {
  const spanning = await page.evaluate(() => {
    const { view, ranges } = window as unknown as FixtureWindow;
    const lineOf = (p: number) => view.state.doc.lineAt(p).number;
    return ranges().filter((r) => lineOf(r.from) !== lineOf(r.to)).map((r) => `${r.type} on lines ${lineOf(r.from)}-${lineOf(r.to)}`);
  });
  expect(spanning).toEqual([]);
  for (const n of [LINES - 1, LINES]) {
    await expect(page.locator('.cm-content > .cm-line').nth(n - 1).locator('.cm-addition, .cm-deletion, .cm-hidden-syntax'))
      .toHaveCount(0);
  }
}

test.describe('Live preview: deleting next to hidden CriticMarkup syntax', () => {
  test.beforeEach(async ({ page }) => {
    pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    // CodeMirror catches what a key binding throws and only logs it
    page.on('console', (message) => {
      if (message.type() === 'error') pageErrors.push(message.text());
    });
    await page.addInitScript(() => {
      let state = 1;
      Object.assign(window, {
        seedRandom: (seed: number) => { state = seed; },
      });
      Math.random = () => (state = (state * 16807) % 2147483647) / 2147483647;
    });
    await page.setViewportSize({ width: 900, height: 900 });
    await page.goto('/e2e/fixtures/criticmarkup-delete.html');
    await expect(page.locator('.cm-content > .cm-line')).toHaveCount(LINES);
    await page.evaluate(() => document.fonts.ready);
  });

  test.afterEach(() => {
    expect(pageErrors).toEqual([]);
  });

  test('Ctrl+Delete before a suggestion deletes the word shown after the cursor', async ({ page }) => {
    // "Plain text| inserted in the middle."
    await place(page, await pos(page, 2, ' {++'));
    await page.keyboard.press('Control+Delete');
    expect(await lineText(page, 2)).toBe('Plain text in the middle.');

    // "A suggestion with metadata| some added words …"
    await place(page, await pos(page, 3, ' {++'));
    await page.keyboard.press('Control+Delete');
    expect(await lineText(page, 3)).toBe(`A suggestion with metadata{++${ELIAS} added words++} in the middle of a sentence.`);
    await expectNoRunOn(page);
  });

  test('Ctrl+Backspace after a suggestion deletes the word shown before the cursor', async ({ page }) => {
    // "Plain text inserted |in the middle."
    await place(page, await pos(page, 2, ' in the middle', 1));
    await page.keyboard.press('Control+Backspace');
    expect(await lineText(page, 2)).toBe('Plain text in the middle.');

    // At the end of "This line ends with an addition"
    await place(page, await pos(page, 4, '++}', 3));
    await page.keyboard.press('Control+Backspace');
    expect(await lineText(page, 4)).toBe('This line ends with {++an ++}');
    await expectNoRunOn(page);
  });

  test('Ctrl+Delete before a comment badge deletes the word after it and keeps the comment', async ({ page }) => {
    // "Some highlighted text|¹ after it."
    await place(page, await pos(page, 6, '==}'));
    await page.keyboard.press('Control+Delete');
    expect(await lineText(page, 6)).toBe(`Some {==highlighted text==}{>>${ELIAS}A comment<<} it.`);
    await expect(page.locator('.cm-comment-badge')).toHaveCount(1);
    await expectNoRunOn(page);
  });

  test('a mouse selection into a suggestion, then Backspace, deletes the text shown in it', async ({ page }) => {
    // "A suggestion [with metadata some ad]ded words …"
    await drag(page, await pos(page, 3, 'with'), await pos(page, 3, 'added', 2));
    await page.keyboard.press('Backspace');
    expect(await lineText(page, 3)).toBe(`A suggestion {++${ELIAS}ded words++} in the middle of a sentence.`);
    await expectNoRunOn(page);
  });

  test('typing over a mouse selection into a suggestion puts the text where the selection starts', async ({ page }) => {
    await drag(page, await pos(page, 3, 'with'), await pos(page, 3, 'added', 2));
    await page.keyboard.type('X');
    expect(await lineText(page, 3)).toBe(`A suggestion X{++${ELIAS}ded words++} in the middle of a sentence.`);
    await expectNoRunOn(page);
  });

  test('cutting a mouse selection into a suggestion takes the text shown in it', async ({ page }) => {
    await drag(page, await pos(page, 3, 'with'), await pos(page, 3, 'added', 2));
    await page.keyboard.press('Control+x');
    expect(await lineText(page, 3)).toBe(`A suggestion {++${ELIAS}ded words++} in the middle of a sentence.`);
    await expectNoRunOn(page);
  });

  test('a mouse selection out of a suggestion, then Delete, keeps its closing delimiter', async ({ page }) => {
    // "… some added wo[rds in] the middle …"
    await drag(page, await pos(page, 3, 'words', 2), await pos(page, 3, ' the middle'), 6);
    await page.keyboard.press('Delete');
    expect(await lineText(page, 3)).toBe(`A suggestion with metadata {++${ELIAS}some added wo++} the middle of a sentence.`);
    await expectNoRunOn(page);
  });

  test('a mouse selection across a deletion+addition pair keeps the markup of both', async ({ page }) => {
    // "A pair: o[ld words ne]w words replaces text."
    await drag(page, await pos(page, 7, 'old', 1), await pos(page, 7, 'new', 2));
    await page.keyboard.press('Backspace');
    expect(await lineText(page, 7)).toBe(`A pair: {--${ELIAS}o--}{++${ELIAS}w words++} replaces text.`);
    await expectNoRunOn(page);
  });

  test('in suggestion mode, deleting a mouse selection into a suggestion suggests deleting the text shown', async ({ page }) => {
    await page.evaluate(() => (window as unknown as FixtureWindow).setSuggestionMode(true));
    await drag(page, await pos(page, 3, 'with'), await pos(page, 3, 'added', 2));
    await page.keyboard.press('Backspace');
    expect(await lineText(page, 3)).toMatch(new RegExp(
      `^A suggestion \\{--${MARK}with metadata --\\}\\{\\+\\+${escape(ELIAS)}\\{--${MARK}some ad--\\}ded words\\+\\+\\} in the middle of a sentence\\.$`,
    ));
    await expectNoRunOn(page);
  });

  test('the ✓ and ✗ buttons still act on a suggestion that lost part of its text', async ({ page }) => {
    await drag(page, await pos(page, 3, 'with'), await pos(page, 3, 'added', 2));
    await page.keyboard.press('Backspace');
    await place(page, await pos(page, 3, 'ded words', 1));
    await page.locator('.cm-criticmarkup-accept').click();
    expect(await lineText(page, 3)).toBe('A suggestion ded words in the middle of a sentence.');

    await drag(page, await pos(page, 2, 'text'), await pos(page, 2, 'inserted', 3));
    await page.keyboard.press('Backspace');
    await place(page, await pos(page, 2, 'erted', 1));
    await page.locator('.cm-criticmarkup-reject').click();
    expect(await lineText(page, 2)).toBe('Plain  in the middle.');
    await expectNoRunOn(page);
  });

  test('source mode shows the syntax, and deleting takes it as it is', async ({ page }) => {
    await page.evaluate(() => (window as unknown as FixtureWindow).setSourceMode(true));
    await place(page, await pos(page, 2, ' {++'));
    await page.keyboard.press('Control+Delete');
    expect(await lineText(page, 2)).toBe('Plain textinserted++} in the middle.');
  });
});
