import { test, expect, type Page } from '@playwright/test';
import type { EditorView } from '@codemirror/view';
import type { CriticMarkupRange } from '../src/lib/criticmarkup-parser';

// Live preview hides a suggestion's delimiters and metadata. Copying, cutting
// or dragging a selection that runs into a suggestion must not take part of
// them along: pasted, an opening delimiter without its closing one runs on into
// the lines after it (src/components/Editor/extensions/criticmarkup-copy.ts).

type FixtureWindow = Window & {
  view: EditorView;
  ranges: () => CriticMarkupRange[];
  authors: (from: number, to: number) => string[];
  setSourceMode: (on: boolean) => void;
  seedRandom: (seed: number) => void;
};

const LINES = 10; // e2e/fixtures/criticmarkup-copy.ts
const PASTE_LINE = 7; // "Paste here: ", followed by a line with a suggestion
const ELIAS = '{"author":"Elias","timestamp":1760000000000}@@';

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

function lineEnd(page: Page, n: number): Promise<number> {
  return page.evaluate((n) => (window as unknown as FixtureWindow).view.state.doc.line(n).to, n);
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
async function select(page: Page, from: number, to: number, seed = 7): Promise<void> {
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
 * Drag the selection with the mouse, from document position `grab` (in it) to
 * the end of line `n`. The mouse first moves a few pixels only, so that the
 * browser starts dragging before CodeMirror takes the move for a new selection.
 */
async function dragTo(page: Page, grab: number, n: number): Promise<void> {
  const a = await pointAt(page, grab);
  const b = await pointAt(page, await lineEnd(page, n));
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(a.x + 4, a.y, { steps: 2 });
  await page.mouse.move(b.x + 4, b.y, { steps: 8 });
  await page.mouse.up();
}

function clipboard(page: Page): Promise<string> {
  return page.evaluate(() => navigator.clipboard.readText());
}

/** Paste with Ctrl+V at the end of the paste line; returns where the paste starts */
async function pasteOnPasteLine(page: Page): Promise<number> {
  const at = await lineEnd(page, PASTE_LINE);
  await place(page, at);
  await page.keyboard.press('Control+v');
  return at;
}

function authors(page: Page, from: number, to: number): Promise<string[]> {
  return page.evaluate(({ from, to }) => (window as unknown as FixtureWindow).authors(from, to), { from, to });
}

/**
 * Every suggestion and comment still ends on the line it starts on (none ran
 * on into the next lines), the line after the paste line shows its own
 * suggestion as before, and the last two lines show as plain text
 */
async function expectNoRunOn(page: Page): Promise<void> {
  const spanning = await page.evaluate(() => {
    const { view, ranges } = window as unknown as FixtureWindow;
    const lineOf = (p: number) => view.state.doc.lineAt(p).number;
    return ranges().filter((r) => lineOf(r.from) !== lineOf(r.to)).map((r) => `${r.type} on lines ${lineOf(r.from)}-${lineOf(r.to)}`);
  });
  expect(spanning).toEqual([]);
  expect(await lineText(page, PASTE_LINE + 1)).toBe(`This line has {++${ELIAS}its own addition++} after the paste.`);
  await expect(page.locator('.cm-content > .cm-line').nth(PASTE_LINE).locator('.cm-addition')).toHaveText('its own addition');
  for (const n of [LINES - 1, LINES]) {
    await expect(page.locator('.cm-content > .cm-line').nth(n - 1).locator('.cm-addition, .cm-deletion, .cm-hidden-syntax'))
      .toHaveCount(0);
  }
}

test.describe('Live preview: copying part of a suggestion', () => {
  test.beforeEach(async ({ page, context, baseURL }) => {
    pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    // CodeMirror catches what a key binding throws and only logs it
    page.on('console', (message) => {
      if (message.type() === 'error') pageErrors.push(message.text());
    });
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: baseURL });
    await page.addInitScript(() => {
      let state = 1;
      Object.assign(window, {
        seedRandom: (seed: number) => { state = seed; },
      });
      Math.random = () => (state = (state * 16807) % 2147483647) / 2147483647;
    });
    await page.setViewportSize({ width: 900, height: 900 });
    await page.goto('/e2e/fixtures/criticmarkup-copy.html');
    await expect(page.locator('.cm-content > .cm-line')).toHaveCount(LINES);
    await page.evaluate(() => document.fonts.ready);
  });

  test.afterEach(() => {
    expect(pageErrors).toEqual([]);
  });

  test('Ctrl+C on a mouse selection into a suggestion copies the text shown, and Ctrl+V pastes it as plain text', async ({ page }) => {
    // "A suggestion [with metadata some ad]ded words …"
    await select(page, await pos(page, 3, 'with'), await pos(page, 3, 'added', 2));
    await page.keyboard.press('Control+c');
    expect(await clipboard(page)).toBe('with metadata some ad');

    const at = await pasteOnPasteLine(page);
    expect(await lineText(page, PASTE_LINE)).toBe('Paste here: with metadata some ad');
    await expectNoRunOn(page);
    // The paste is the copy, so it keeps its authors
    expect(await authors(page, at, at + 'with metadata some ad'.length)).toEqual(['human:Luc: with metadata ', 'human:Elias: some ad']);
  });

  test('Ctrl+X on a mouse selection out of a suggestion cuts the text shown, and Ctrl+V pastes it as plain text', async ({ page }) => {
    // "… some added wo[rds in] the middle …"
    await select(page, await pos(page, 3, 'words', 2), await pos(page, 3, ' the middle'), 6);
    await page.keyboard.press('Control+x');
    expect(await lineText(page, 3)).toBe(`A suggestion with metadata {++${ELIAS}some added wo++} the middle of a sentence.`);
    expect(await clipboard(page)).toBe('rds in');

    const at = await pasteOnPasteLine(page);
    expect(await lineText(page, PASTE_LINE)).toBe('Paste here: rds in');
    await expectNoRunOn(page);
    expect(await authors(page, at, at + 'rds in'.length)).toEqual(['human:Elias: rds', 'human:Luc:  in']);
  });

  test('dragging a mouse selection into a suggestion to another line drops the text shown', async ({ page }) => {
    await select(page, await pos(page, 3, 'with'), await pos(page, 3, 'added', 2));
    await dragTo(page, await pos(page, 3, 'metadata', 3), PASTE_LINE);
    expect(await lineText(page, 3)).toBe(`A suggestion {++${ELIAS}ded words++} in the middle of a sentence.`);
    expect(await lineText(page, PASTE_LINE)).toBe('Paste here: with metadata some ad');
    await expectNoRunOn(page);
    const at = await pos(page, PASTE_LINE, 'with');
    expect(await authors(page, at, at + 'with metadata some ad'.length)).toEqual(['human:Luc: with metadata ', 'human:Elias: some ad']);
  });

  test('Ctrl+C on a selection over a whole suggestion copies it as it is, and Ctrl+V pastes a whole suggestion', async ({ page }) => {
    // "This line [ends with an addition]", to the line's end with Shift+End
    await place(page, await pos(page, 4, 'ends'));
    await page.keyboard.press('Shift+End');
    expect(await selection(page)).toEqual({ anchor: await pos(page, 4, 'ends'), head: await lineEnd(page, 4) });
    await page.keyboard.press('Control+c');
    expect(await clipboard(page)).toBe(`ends with {++${ELIAS}an addition++}`);

    await pasteOnPasteLine(page);
    expect(await lineText(page, PASTE_LINE)).toBe(`Paste here: ends with {++${ELIAS}an addition++}`);
    await expect(page.locator('.cm-content > .cm-line').nth(PASTE_LINE - 1).locator('.cm-addition')).toHaveText('an addition');
    await expectNoRunOn(page);
  });

  test('Ctrl+C on a selection of only a suggestion\'s hidden opening copies nothing', async ({ page }) => {
    // Shift+ArrowRight right before a suggestion selects its hidden opening
    await page.evaluate(() => navigator.clipboard.writeText('before'));
    await place(page, await pos(page, 3, '{++'));
    await page.keyboard.press('Shift+ArrowRight');
    expect(await selection(page)).toEqual({ anchor: await pos(page, 3, '{++'), head: await pos(page, 3, 'some added') });
    await page.keyboard.press('Control+c');
    expect(await clipboard(page)).toBe('');
  });

  test('source mode shows the syntax, and copying takes it as it is', async ({ page }) => {
    await page.evaluate(() => (window as unknown as FixtureWindow).setSourceMode(true));
    await page.evaluate(({ from, to }) => {
      const { view } = window as unknown as FixtureWindow;
      view.dispatch({ selection: { anchor: from, head: to } });
      view.focus();
    }, { from: await pos(page, 3, 'with'), to: await pos(page, 3, 'added', 2) });
    await page.keyboard.press('Control+c');
    expect(await clipboard(page)).toBe(`with metadata {++${ELIAS}some ad`);
  });
});
