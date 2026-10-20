import { test, expect, type Page } from '@playwright/test';
import type { EditorView } from '@codemirror/view';

// While the cursor is outside a code block, its fences are hidden. As a hidden
// mark, the opening fence (```js) held one span per highlight token, and next
// to the copy button CodeMirror found nothing to measure on that row: a click
// on it, or ArrowDown onto it, threw "Cannot read properties of undefined
// (reading 'top')". Every character of a hidden closing fence had the same x,
// and a click on its row put the cursor between the backticks, where typing
// breaks the fence (HiddenSyntaxWidget in
// src/components/Editor/extensions/livePreview.ts).

type FixtureWindow = Window & { view: EditorView };

const LINES = 24; // e2e/fixtures/live-preview-code-fences.ts
const everyLine = Array.from({ length: LINES }, (_, i) => i + 1);

// Opening fences: ```js, ~~~python, an info string, none, in a quote, and
// indented in a list item
const OPENING_FENCES = [2, 6, 9, 12, 16, 21];
// Their closing fences
const CLOSING_FENCES = [4, 8, 11, 14, 18, 23];

let errors: string[] = [];

/** The cursor's line and column, and the column it keeps for vertical moves */
function cursor(page: Page): Promise<{ line: number; column: number; atLineEnd: boolean; goal: number | undefined }> {
  return page.evaluate(() => {
    const { view } = window as FixtureWindow;
    const { main } = view.state.selection;
    const line = view.state.doc.lineAt(main.head);
    return { line: line.number, column: main.head - line.from, atLineEnd: main.head === line.to, goal: main.goalColumn };
  });
}

/** Put the cursor on line `n`, `column` characters in (at most its end) */
async function placeCursor(page: Page, n: number, column: number): Promise<void> {
  await page.evaluate(({ n, column }) => {
    const { view } = window as FixtureWindow;
    const line = view.state.doc.line(n);
    view.dispatch({ selection: { anchor: Math.min(line.from + column, line.to) } });
    view.focus();
  }, { n, column });
}

/** The box of line `n`'s row */
async function rowBox(page: Page, n: number): Promise<{ x: number; y: number; width: number; height: number }> {
  return (await page.locator('.cm-content > .cm-line').nth(n - 1).boundingBox())!;
}

test.describe('Live preview: the fence rows of a code block', () => {
  test.beforeEach(async ({ page }) => {
    errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    // CodeMirror logs an exception in a key binding instead of throwing it
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    await page.setViewportSize({ width: 900, height: 900 });
    await page.goto('/e2e/fixtures/live-preview-code-fences.html');
    await expect(page.locator('.cm-content > .cm-line')).toHaveCount(LINES);
    await expect(page.locator('.cm-code-copy-btn')).toHaveCount(OPENING_FENCES.length);
    await page.evaluate(() => document.fonts.ready);
  });

  test.afterEach(() => {
    expect(errors).toEqual([]);
  });

  for (const n of OPENING_FENCES) {
    test(`a click on the row of the fence on line ${n} puts the cursor at its end`, async ({ page }) => {
      await placeCursor(page, LINES, 0);
      const row = await page.locator('.cm-content > .cm-line').nth(n - 1).boundingBox();
      await page.mouse.click(row!.x + row!.width / 2, row!.y + row!.height / 2);
      expect(await cursor(page)).toMatchObject({ line: n, atLineEnd: true });
    });
  }

  for (const n of CLOSING_FENCES) {
    test(`a click on the row of the closing fence on line ${n} puts the cursor at the start or end of that line`, async ({ page }) => {
      // Left of where the text starts: the start of the line
      await placeCursor(page, LINES, 0);
      let box = await rowBox(page, n);
      await page.mouse.click(box.x + 2, box.y + box.height / 2);
      expect(await cursor(page), 'click at the left edge').toMatchObject({ line: n, column: 0 });

      // Further right: its end
      await placeCursor(page, LINES, 0);
      box = await rowBox(page, n);
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      expect(await cursor(page), 'click in the middle').toMatchObject({ line: n, atLineEnd: true });
    });
  }

  test('ArrowUp from the last line never stops inside a closing fence', async ({ page }) => {
    // Where ArrowUp stops on a closing fence's row, it is at the start or end
    // of the line. (CodeMirror's own ArrowUp jumps over lines that start with
    // hidden syntax, closing fences included.)
    for (const column of [0, 5]) {
      await placeCursor(page, LINES, column);
      for (let i = 1; i < LINES; i++) {
        await page.keyboard.press('ArrowUp');
        const at = await cursor(page);
        if (CLOSING_FENCES.includes(at.line)) {
          expect(at.column === 0 || at.atLineEnd, `from column ${column}, press ${i}: ${JSON.stringify(at)}`).toBe(true);
        }
      }
    }
  });

  test('ArrowDown from the first line visits every line, keeping the column', async ({ page }) => {
    await placeCursor(page, 1, 5);
    const steps = [await cursor(page)];
    for (let i = 1; i < LINES; i++) {
      await page.keyboard.press('ArrowDown');
      steps.push(await cursor(page));
    }
    expect(steps.map((s) => s.line)).toEqual(everyLine);
    // Set by the first press, then kept
    expect(new Set(steps.slice(1).map((s) => s.goal)).size).toBe(1);
  });
});
