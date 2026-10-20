import { test, expect, type Page } from '@playwright/test';
import type { EditorView } from '@codemirror/view';
import type { CriticMarkupRange } from '../src/lib/criticmarkup-parser';

// Mark, in suggestion mode, edits inside Elias's pending suggestions
// (e2e/fixtures/criticmarkup-suggest-inside.ts). What he types must never go
// inside Elias's addition: an addition ends at the first `++}`, so a nested one
// cut Elias's short and showed the rest as raw markup. It splits Elias's
// addition instead (placeAddition in src/components/Editor/extensions/criticmarkup.ts).
// In the same way a deletion never goes in Elias's deletion, nor a substitution
// in his substitution (suggestionModeFilter there).

type FixtureWindow = Window & {
  view: EditorView;
  ranges: () => CriticMarkupRange[];
};

const LINES = 8;
const ELIAS = '\\{"author":"Elias","timestamp":1760000000000\\}@@';
const MARK = '\\{"author":"Mark","timestamp":\\d+\\}@@';
/** Line `n` as the fixture has it */
const ORIGINAL: Record<number, string> = {
  2: '{++{"author":"Elias","timestamp":1760000000000}@@An added line with metadata++}',
  3: 'Plain text {++{"author":"Elias","timestamp":1760000000000}@@inserted words++} in the middle.',
  6: 'A deletion: {--{"author":"Elias","timestamp":1760000000000}@@Deleted words--} and more.',
  7: 'A substitution: {~~{"author":"Elias","timestamp":1760000000000}@@old text~>new text~~} here.',
};

let pageErrors: string[] = [];

function lineText(page: Page, n: number): Promise<string> {
  return page.evaluate((n) => (window as unknown as FixtureWindow).view.state.doc.line(n).text, n);
}

/** What live preview shows of line `n`: no hidden syntax, no buttons */
function shown(page: Page, n: number): Promise<string> {
  return page.locator('.cm-content > .cm-line').nth(n - 1).evaluate((line) => {
    const copy = line.cloneNode(true) as HTMLElement;
    copy.querySelectorAll('.cm-hidden-syntax, .cm-criticmarkup-buttons').forEach((el) => el.remove());
    return copy.textContent ?? '';
  });
}

/** Line `n`'s suggestions: type, author, text */
function parts(page: Page, n: number): Promise<Array<[string, string | undefined, string]>> {
  return page.evaluate((n) => {
    const { view, ranges } = window as unknown as FixtureWindow;
    const line = view.state.doc.line(n);
    return ranges()
      .filter((r) => r.from >= line.from && r.to <= line.to)
      .map((r) => [r.type, r.metadata?.author, r.content] as [string, string | undefined, string]);
  }, n);
}

/** Document position of `text` (its `at`th character) on line `n` */
function posOf(page: Page, n: number, text: string, at = 0): Promise<number> {
  return page.evaluate(({ n, text, at }) => {
    const { view } = window as unknown as FixtureWindow;
    const line = view.state.doc.line(n);
    const i = line.text.indexOf(text);
    if (i < 0) throw new Error(`${text} not on line ${n}`);
    return line.from + i + at;
  }, { n, text, at });
}

function head(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as FixtureWindow).view.state.selection.main.head);
}

/** A real click between two characters of visible text */
async function clickAt(page: Page, pos: number): Promise<void> {
  const point = await page.evaluate((pos) => {
    const c = (window as unknown as FixtureWindow).view.coordsAtPos(pos)!;
    return { x: c.left, y: (c.top + c.bottom) / 2 };
  }, pos);
  await page.mouse.click(point.x, point.y);
  expect(await head(page)).toBe(pos);
}

/** A real click left of line `n`'s text (`side` -1) or right of it (1) */
async function clickBeside(page: Page, n: number, side: -1 | 1): Promise<void> {
  const point = await page.evaluate(({ n, side }) => {
    const { view } = window as unknown as FixtureWindow;
    const line = view.state.doc.line(n);
    const c = view.coordsAtPos(side < 0 ? line.from : line.to, side)!;
    return { x: side < 0 ? c.left - 8 : c.right + 30, y: (c.top + c.bottom) / 2 };
  }, { n, side });
  await page.mouse.click(point.x, point.y);
}

/**
 * The cursor at `pos`. For the edges of a suggestion's text, where its hidden
 * delimiters make a click land on either side (#162 settles that), and for
 * lines where a click maps to the wrong column: with a deletion+addition pair,
 * or with accept/reject buttons showing, CodeMirror's posAtCoords is thrown
 * off by the zero-size hidden syntax (main does the same)
 */
async function place(page: Page, pos: number): Promise<void> {
  await page.evaluate((pos) => {
    const { view } = window as unknown as FixtureWindow;
    view.dispatch({ selection: { anchor: pos } });
    view.focus();
  }, pos);
}

async function expectNoRawMarkup(page: Page, n: number): Promise<void> {
  expect(await shown(page, n)).not.toMatch(/\{\+\+|\+\+\}|\{--|--\}|\{~~|~~\}|@@|"author"/);
}

test.beforeEach(async ({ page }) => {
  pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  // CodeMirror catches what a key binding throws and only logs it
  page.on('console', (message) => {
    if (message.type() === 'error') pageErrors.push(message.text());
  });
  await page.setViewportSize({ width: 900, height: 700 });
  await page.goto('/e2e/fixtures/criticmarkup-suggest-inside.html');
  await expect(page.locator('.cm-content > .cm-line')).toHaveCount(LINES);
  await page.evaluate(() => document.fonts.ready);
});

test.afterEach(() => {
  expect(pageErrors).toEqual([]);
});

test.describe("Suggestion mode inside someone else's addition", () => {
  test('typing in the middle of their text adds yours between two parts of theirs', async ({ page }) => {
    await clickAt(page, await posOf(page, 2, ' line with'));
    await page.keyboard.type(' new');

    expect(await lineText(page, 2)).toMatch(
      new RegExp(`^\\{\\+\\+${ELIAS}An added\\+\\+\\}\\{\\+\\+${MARK} new\\+\\+\\}\\{\\+\\+${ELIAS} line with metadata\\+\\+\\}$`),
    );
    expect(await parts(page, 2)).toEqual([
      ['addition', 'Elias', 'An added'],
      ['addition', 'Mark', ' new'],
      ['addition', 'Elias', ' line with metadata'],
    ]);
    expect(await shown(page, 2)).toBe('An added new line with metadata');
    await expectNoRawMarkup(page, 2);
  });

  test('Backspace over all you typed joins their addition again', async ({ page }) => {
    await clickAt(page, await posOf(page, 2, ' line with'));
    await page.keyboard.type(' new');
    for (let i = 0; i < 4; i++) await page.keyboard.press('Backspace');

    expect(await lineText(page, 2)).toBe(ORIGINAL[2]);
    expect(await parts(page, 2)).toHaveLength(1);
  });

  test('rejecting your part joins their addition again', async ({ page }) => {
    await clickAt(page, await posOf(page, 2, ' line with'));
    await page.keyboard.type(' new');
    const yours = await posOf(page, 2, '{++{"author":"Mark"');
    await page.locator(`.cm-criticmarkup-buttons[data-range-from="${yours}"] .cm-criticmarkup-reject`).click();

    expect(await lineText(page, 2)).toBe(ORIGINAL[2]);
  });

  test('a click left of their line, then typing, puts yours before theirs', async ({ page }) => {
    await clickBeside(page, 2, -1);
    await page.keyboard.type('Z');

    expect(await lineText(page, 2)).toMatch(new RegExp(`^\\{\\+\\+${MARK}Z\\+\\+\\}\\{\\+\\+${ELIAS}An added line with metadata\\+\\+\\}$`));
    expect(await shown(page, 2)).toBe('ZAn added line with metadata');
  });

  test('a click right of their line, then typing, puts yours after theirs', async ({ page }) => {
    await clickBeside(page, 2, 1);
    await page.keyboard.type('Z');

    expect(await lineText(page, 2)).toMatch(new RegExp(`^\\{\\+\\+${ELIAS}An added line with metadata\\+\\+\\}\\{\\+\\+${MARK}Z\\+\\+\\}$`));
    expect(await shown(page, 2)).toBe('An added line with metadataZ');
  });

  test('typing at the start or end of their text puts yours beside theirs', async ({ page }) => {
    await place(page, await posOf(page, 3, 'inserted words'));
    await page.keyboard.type('Z');
    await place(page, await posOf(page, 3, 'inserted words', 'inserted words'.length));
    await page.keyboard.type('Y');

    expect(await lineText(page, 3)).toMatch(new RegExp(
      `^Plain text \\{\\+\\+${MARK}Z\\+\\+\\}\\{\\+\\+${ELIAS}inserted words\\+\\+\\}\\{\\+\\+${MARK}Y\\+\\+\\} in the middle\\.$`,
    ));
    expect(await shown(page, 3)).toBe('Plain text Zinserted wordsY in the middle.');
  });

  test("typing at the start of a pair's new text keeps the pair together", async ({ page }) => {
    await place(page, await posOf(page, 4, 'new words'));
    await page.keyboard.type('Z');

    expect(await lineText(page, 4)).toMatch(new RegExp(
      `^A pair: \\{\\+\\+${MARK}Z\\+\\+\\}\\{--${ELIAS}old words--\\}\\{\\+\\+${ELIAS}new words\\+\\+\\} replaces text\\.$`,
    ));
    // Still one ✓ for the pair, which leaves yours
    await place(page, await posOf(page, 4, 'new words', 4));
    await expect(page.locator('.cm-criticmarkup-buttons[data-merged]')).toHaveCount(1);
    await page.locator('.cm-criticmarkup-buttons[data-merged] .cm-criticmarkup-accept').click();
    expect(await lineText(page, 4)).toMatch(new RegExp(`^A pair: \\{\\+\\+${MARK}Z\\+\\+\\}new words replaces text\\.$`));
  });

  test('pasting in the middle of their text splits it the same way', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.evaluate(() => navigator.clipboard.writeText('pasted text'));
    await clickAt(page, await posOf(page, 3, ' words'));
    await page.keyboard.press('Control+V');

    expect(await lineText(page, 3)).toMatch(new RegExp(
      `^Plain text \\{\\+\\+${ELIAS}inserted\\+\\+\\}\\{\\+\\+${MARK}pasted text\\+\\+\\}\\{\\+\\+${ELIAS} words\\+\\+\\} in the middle\\.$`,
    ));
    expect(await shown(page, 3)).toBe('Plain text insertedpasted text words in the middle.');
  });

  test('an addition without metadata splits the same way', async ({ page }) => {
    await clickAt(page, await posOf(page, 5, ' line without'));
    await page.keyboard.type(' new');

    expect(await lineText(page, 5)).toMatch(new RegExp(`^\\{\\+\\+An added\\+\\+\\}\\{\\+\\+${MARK} new\\+\\+\\}\\{\\+\\+ line without metadata\\+\\+\\}$`));
    expect(await shown(page, 5)).toBe('An added new line without metadata');
  });

  test('deleting some of their text nests a deletion, whose ✓ accepts just that', async ({ page }) => {
    await clickAt(page, await posOf(page, 2, ' line with'));
    for (let i = 0; i < 'added'.length; i++) await page.keyboard.press('Backspace');

    expect(await lineText(page, 2)).toMatch(new RegExp(`^\\{\\+\\+${ELIAS}An \\{--${MARK}added--\\} line with metadata\\+\\+\\}$`));
    await expect(page.locator('.cm-content > .cm-line').nth(1).locator('.cm-deletion')).toHaveText('added');
    await expectNoRawMarkup(page, 2);

    // The cursor is in the deletion: its buttons and the addition's show
    await expect(page.locator('.cm-criticmarkup-buttons')).toHaveCount(2);
    const deletion = await posOf(page, 2, '{--');
    await page.locator(`.cm-criticmarkup-buttons[data-range-from="${deletion}"] .cm-criticmarkup-accept`).click();
    expect(await lineText(page, 2)).toBe(ORIGINAL[2].replace('added', ''));
  });

  test('the ✗ of your deletion in their text rejects just that', async ({ page }) => {
    await clickAt(page, await posOf(page, 2, ' line with'));
    for (let i = 0; i < 'added'.length; i++) await page.keyboard.press('Backspace');
    const deletion = await posOf(page, 2, '{--');
    await page.locator(`.cm-criticmarkup-buttons[data-range-from="${deletion}"] .cm-criticmarkup-reject`).click();

    expect(await lineText(page, 2)).toBe(ORIGINAL[2]);
  });

  test("their addition's own ✓ accepts it and keeps your deletion in it", async ({ page }) => {
    await clickAt(page, await posOf(page, 2, ' line with'));
    for (let i = 0; i < 'added'.length; i++) await page.keyboard.press('Backspace');
    const theirs = await posOf(page, 2, '{++');
    await page.locator(`.cm-criticmarkup-buttons[data-range-from="${theirs}"] .cm-criticmarkup-accept`).click();

    expect(await lineText(page, 2)).toMatch(new RegExp(`^An \\{--${MARK}added--\\} line with metadata$`));
  });

  test('replacing a word of their text nests a substitution in it', async ({ page }) => {
    await clickAt(page, await posOf(page, 3, 'inserted', 1));
    await page.keyboard.press('ArrowLeft');
    for (let i = 0; i < 'inserted'.length; i++) await page.keyboard.press('Shift+ArrowRight');
    await page.keyboard.type('added');

    expect(await lineText(page, 3)).toMatch(new RegExp(
      `^Plain text \\{\\+\\+${ELIAS}\\{~~${MARK}inserted~>added~~\\} words\\+\\+\\} in the middle\\.$`,
    ));
    expect((await parts(page, 3)).map(([type, author]) => [type, author])).toEqual([
      ['addition', 'Elias'],
      ['substitution', 'Mark'],
    ]);
  });
});

test.describe("Suggestion mode inside someone else's deletion or substitution", () => {
  test('Backspace and Delete in their deleted text move the cursor over it, changing nothing', async ({ page }) => {
    const from = await posOf(page, 6, ' words');
    await clickAt(page, from);
    for (let i = 0; i < 3; i++) await page.keyboard.press('Backspace');
    expect(await head(page)).toBe(from - 3);
    for (let i = 0; i < 5; i++) await page.keyboard.press('Delete');
    expect(await head(page)).toBe(from + 2);

    expect(await lineText(page, 6)).toBe(ORIGINAL[6]);
    await expectNoRawMarkup(page, 6);
  });

  test('typing in their deleted text puts yours just before their deletion, which leaves it when accepted', async ({ page }) => {
    await clickAt(page, await posOf(page, 6, ' words'));
    await page.keyboard.type('Kept ');

    expect(await lineText(page, 6)).toMatch(new RegExp(
      `^A deletion: \\{\\+\\+${MARK}Kept \\+\\+\\}\\{--${ELIAS}Deleted words--\\} and more\\.$`,
    ));
    expect(await parts(page, 6)).toEqual([
      ['addition', 'Mark', 'Kept '],
      ['deletion', 'Elias', 'Deleted words'],
    ]);
    expect(await shown(page, 6)).toBe('A deletion: Kept Deleted words and more.');
    await expectNoRawMarkup(page, 6);

    await place(page, await posOf(page, 6, 'Deleted', 3));
    const theirs = await posOf(page, 6, '{--');
    await page.locator(`.cm-criticmarkup-buttons[data-range-from="${theirs}"] .cm-criticmarkup-accept`).click();
    expect(await lineText(page, 6)).toMatch(new RegExp(`^A deletion: \\{\\+\\+${MARK}Kept \\+\\+\\} and more\\.$`));
  });

  test("typing at the end of a pair's deleted text keeps the pair together", async ({ page }) => {
    // Where ArrowRight first stops at the pair's boundary (with #162). Clicks
    // on a pair's line land at the wrong column
    await place(page, await posOf(page, 4, 'old words', 'old words'.length));
    await page.keyboard.type('Z');

    expect(await lineText(page, 4)).toMatch(new RegExp(
      `^A pair: \\{\\+\\+${MARK}Z\\+\\+\\}\\{--${ELIAS}old words--\\}\\{\\+\\+${ELIAS}new words\\+\\+\\} replaces text\\.$`,
    ));
    await place(page, await posOf(page, 4, 'new words', 4));
    await expect(page.locator('.cm-criticmarkup-buttons[data-merged]')).toHaveCount(1);
  });

  test("replacing a word of their substitution's new text nests a deletion+addition pair of yours", async ({ page }) => {
    // Clicks on this line land at the wrong column: the selection is made with keys
    await place(page, await posOf(page, 7, 'new text'));
    for (let i = 0; i < 'new'.length; i++) await page.keyboard.press('Shift+ArrowRight');
    await page.keyboard.type('next');

    expect(await lineText(page, 7)).toMatch(new RegExp(
      `^A substitution: \\{~~${ELIAS}old text~>\\{--${MARK}new--\\}\\{\\+\\+${MARK}next\\+\\+\\} text~~\\} here\\.$`,
    ));
    const [theirs, ...yours] = await parts(page, 7);
    expect(theirs.slice(0, 2)).toEqual(['substitution', 'Elias']);
    expect(yours).toEqual([
      ['deletion', 'Mark', 'new'],
      ['addition', 'Mark', 'next'],
    ]);
    expect(await shown(page, 7)).toBe('A substitution: old text~>newnext text here.');
    await expectNoRawMarkup(page, 7);

    // Your pair's one ✓ accepts just it
    const pair = await posOf(page, 7, '{--');
    await page.locator(`.cm-criticmarkup-buttons[data-merged][data-range-from="${pair}"] .cm-criticmarkup-accept`).click();
    expect(await lineText(page, 7)).toBe(ORIGINAL[7].replace('new text', 'next text'));
  });

  test("replacing a word of their substitution's old text does the same there", async ({ page }) => {
    await place(page, await posOf(page, 7, 'old text'));
    for (let i = 0; i < 'old'.length; i++) await page.keyboard.press('Shift+ArrowRight');
    await page.keyboard.type('past');

    expect(await lineText(page, 7)).toMatch(new RegExp(
      `^A substitution: \\{~~${ELIAS}\\{--${MARK}old--\\}\\{\\+\\+${MARK}past\\+\\+\\} text~>new text~~\\} here\\.$`,
    ));
    expect(await shown(page, 7)).toBe('A substitution: oldpast text~>new text here.');
    await expectNoRawMarkup(page, 7);
  });

  test("Backspace in your deletion just after theirs leaves their markup whole", async ({ page }) => {
    // Delete just after their deletion suggests deleting the space, beside theirs
    await place(page, await posOf(page, 6, ' and more'));
    await page.keyboard.press('Delete');
    const deleted = await lineText(page, 6);
    expect(deleted).toMatch(new RegExp(`^A deletion: \\{--${ELIAS}Deleted words--\\}\\{--${MARK} --\\}and more\\.$`));

    // Backspace in yours took their `}`
    await page.keyboard.press('Backspace');
    expect(await lineText(page, 6)).toBe(deleted);
    expect(await head(page)).toBe(await posOf(page, 6, ' --}and'));
    await expectNoRawMarkup(page, 6);
  });
});
