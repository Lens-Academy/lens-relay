import { test, expect, type Page } from '@playwright/test';
import type { EditorView } from '@codemirror/view';

// With the frontmatter bar expanded, its --- delimiter lines are hidden. As a
// hidden mark, every dash had the same x, so a click on such a row, or
// ArrowDown onto it, put the cursor between the dashes, and typing or Enter
// there broke the frontmatter. Each line is now one widget, which CodeMirror
// measures as a whole (DelimiterWidget in
// src/components/Editor/extensions/frontmatter.ts).

type FixtureWindow = Window & { view: EditorView };

// e2e/fixtures/live-preview-frontmatter.ts: the lines of each note, those of
// its delimiters, and its keys
const CASES = [
  // closing --- under `status: draft`
  { name: 'properties', lines: 9, open: 1, close: 4, keys: ['title', 'status'] },
  // closing --- under a YAML list
  { name: 'list', lines: 9, open: 1, close: 6, keys: ['title', 'tags'] },
];

let errors: string[] = [];

type Cursor = { line: number; column: number; atLineEnd: boolean };

/** The cursor's line and column */
function cursor(page: Page): Promise<Cursor> {
  return page.evaluate(() => {
    const { view } = window as unknown as FixtureWindow;
    const { head } = view.state.selection.main;
    const line = view.state.doc.lineAt(head);
    return { line: line.number, column: head - line.from, atLineEnd: head === line.to };
  });
}

/** Put the cursor on line `n`, `column` characters in (at most its end) */
async function placeCursor(page: Page, n: number, column: number): Promise<void> {
  await page.evaluate(({ n, column }) => {
    const { view } = window as unknown as FixtureWindow;
    const line = view.state.doc.line(n);
    view.dispatch({ selection: { anchor: Math.min(line.from + column, line.to) } });
    view.focus();
  }, { n, column });
}

/** The box of line `n`'s row */
async function rowBox(page: Page, n: number): Promise<{ x: number; y: number; width: number; height: number }> {
  return (await page.locator('.cm-content > .cm-line').nth(n - 1).boundingBox())!;
}

function docText(page: Page): Promise<string> {
  return page.evaluate(() => (window as unknown as FixtureWindow).view.state.doc.toString());
}

/** The text of line `n` that is shown (not in a font-size: 0 element) */
function shownText(page: Page, n: number): Promise<string> {
  return page.evaluate((n) => {
    const row = document.querySelectorAll('.cm-content > .cm-line')[n - 1];
    const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
    let text = '';
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (getComputedStyle(node.parentElement!).fontSize !== '0px') text += node.textContent;
    }
    return text;
  }, n);
}

/** Collapse or expand the frontmatter with a click on its bar */
async function clickBar(page: Page): Promise<void> {
  const bar = (await page.locator('.cm-frontmatter-bar').boundingBox())!;
  await page.mouse.click(bar.x + 20, bar.y + bar.height / 2);
}

for (const { name, lines, open, close, keys } of CASES) {
  /** Whether the cursor is between the dashes of a delimiter row */
  const betweenDashes = (at: Cursor) => (at.line === open || at.line === close) && at.column > 0 && !at.atLineEnd;

  test.describe(`Expanded frontmatter (${name}): the rows of its --- lines`, () => {
    test.beforeEach(async ({ page }) => {
      errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      // CodeMirror logs an exception in a key binding instead of throwing it
      page.on('console', (message) => {
        if (message.type() === 'error') errors.push(message.text());
      });
      await page.setViewportSize({ width: 900, height: 900 });
      await page.goto(`/e2e/fixtures/live-preview-frontmatter.html?case=${name}`);
      await expect(page.locator('.cm-frontmatter-bar')).toHaveCount(1);
      await page.evaluate(() => document.fonts.ready);
      await clickBar(page);
      await expect(page.locator('.cm-content > .cm-line')).toHaveCount(lines);
      await expect(page.locator('.cm-frontmatter-line')).toHaveCount(close);
    });

    test.afterEach(() => {
      expect(errors).toEqual([]);
    });

    for (const n of [open, close]) {
      test(`a click on row ${n} puts the cursor before or after its dashes`, async ({ page }) => {
        // Left of the row (frontmatter lines have no padding)
        await placeCursor(page, lines, 0);
        let box = await rowBox(page, n);
        await page.mouse.click(box.x - 8, box.y + box.height / 2);
        const left = await cursor(page);
        expect(left.line, 'click left of the row').toBe(n);
        expect(betweenDashes(left), `click left of the row: column ${left.column}`).toBe(false);

        // On the row: the end of the line
        for (const dx of [2, box.width / 2]) {
          await placeCursor(page, lines, 0);
          box = await rowBox(page, n);
          await page.mouse.click(box.x + dx, box.y + box.height / 2);
          expect(await cursor(page), `click ${dx}px into the row`).toMatchObject({ line: n, atLineEnd: true });
        }
      });
    }

    test('Enter after a click on the opening row adds a line inside the frontmatter', async ({ page }) => {
      const before = await docText(page);
      await placeCursor(page, lines, 0);
      const box = await rowBox(page, open);
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await page.keyboard.press('Enter');
      const expected = before.split('\n');
      expected.splice(open, 0, '');
      expect(await docText(page)).toBe(expected.join('\n'));
      await expect(page.locator('.cm-frontmatter-line')).toHaveCount(close + 1);
    });

    test('Enter after a click on the closing row adds a line below the frontmatter', async ({ page }) => {
      const before = await docText(page);
      await placeCursor(page, lines, 0);
      const box = await rowBox(page, close);
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await page.keyboard.press('Enter');
      const expected = before.split('\n');
      expected.splice(close, 0, '');
      expect(await docText(page)).toBe(expected.join('\n'));
      await expect(page.locator('.cm-frontmatter-line')).toHaveCount(close);
    });

    test('ArrowDown from the first line visits every line, never stopping between the dashes', async ({ page }) => {
      for (const column of [0, 5]) {
        await placeCursor(page, 1, column);
        const stops: Cursor[] = [];
        for (let i = 1; i < lines; i++) {
          await page.keyboard.press('ArrowDown');
          stops.push(await cursor(page));
        }
        expect(stops.map((at) => at.line)).toEqual(Array.from({ length: lines - 1 }, (_, i) => i + 2));
        expect(stops.filter(betweenDashes), `from column ${column}`).toEqual([]);
      }
    });

    test('ArrowUp to the top of the note never stops between the dashes', async ({ page }) => {
      // CodeMirror's own ArrowUp jumps over lines that start with hidden
      // syntax, and goes from the first property to the start of the note.
      // One press more checks that the cursor stays there.
      for (const column of [0, 5]) {
        await placeCursor(page, lines, column);
        const stops: Cursor[] = [];
        for (let i = 0; i < lines; i++) {
          await page.keyboard.press('ArrowUp');
          stops.push(await cursor(page));
        }
        expect(stops[stops.length - 1], `from column ${column}`).toMatchObject({ line: 1, column: 0 });
        expect(stops.filter(betweenDashes), `from column ${column}`).toEqual([]);
      }
    });

    test('the bar still collapses and expands it, keys styled', async ({ page }) => {
      await clickBar(page);
      await expect(page.locator('.cm-frontmatter-line')).toHaveCount(0);
      await expect(page.locator('.cm-frontmatter-label')).toHaveText(`Frontmatter: ${keys.length} properties`);
      await clickBar(page);
      await expect(page.locator('.cm-frontmatter-line')).toHaveCount(close);
      expect([await shownText(page, open), await shownText(page, close)]).toEqual(['', '']);
      await expect(page.locator('.cm-frontmatter-key')).toHaveText(keys);
    });
  });
}
