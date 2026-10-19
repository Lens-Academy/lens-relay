import { test, expect, type Page } from '@playwright/test';
import type { EditorView } from '@codemirror/view';

// CodeMirror's ArrowUp took a line whose first character is hidden syntax for
// padding and jumped over it: `## Decisions`, `---`, a setext underline, a
// code block's closing fence, lines opening with **, `, > or {++
// (src/components/Editor/extensions/verticalMotion.ts).

type FixtureWindow = Window & { view: EditorView };

const LINES = 21; // e2e/fixtures/live-preview-arrows.ts
const everyLine = Array.from({ length: LINES }, (_, i) => i + 1);

let pageErrors: string[] = [];

/** The cursor's line, and the column it keeps for vertical moves */
function cursor(page: Page): Promise<{ line: number; anchorLine: number; goal: number | undefined }> {
  return page.evaluate(() => {
    const { view } = window as FixtureWindow;
    const { main } = view.state.selection;
    const { doc } = view.state;
    return { line: doc.lineAt(main.head).number, anchorLine: doc.lineAt(main.anchor).number, goal: main.goalColumn };
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

/** The cursor before and after each of `presses` presses of `key` */
async function press(page: Page, key: string, presses: number) {
  const steps = [await cursor(page)];
  for (let i = 0; i < presses; i++) {
    await page.keyboard.press(key);
    steps.push(await cursor(page));
  }
  return steps;
}

test.describe('Live preview: arrow keys over lines that start with hidden syntax', () => {
  test.beforeEach(async ({ page }) => {
    pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.setViewportSize({ width: 900, height: 900 });
    await page.goto('/e2e/fixtures/live-preview-arrows.html');
    await expect(page.locator('.cm-content > .cm-line')).toHaveCount(LINES);
    await page.evaluate(() => document.fonts.ready);
  });

  test.afterEach(() => {
    expect(pageErrors).toEqual([]);
  });

  for (const column of [0, 5]) {
    test(`ArrowUp from column ${column} of the last line visits every line, keeping the column`, async ({ page }) => {
      await placeCursor(page, LINES, column);
      const steps = await press(page, 'ArrowUp', LINES - 1);
      expect(steps.map((s) => s.line)).toEqual([...everyLine].reverse());
      // Set by the first press, then kept: the cursor doesn't drift sideways
      expect(new Set(steps.slice(1).map((s) => s.goal)).size).toBe(1);
    });

    test(`ArrowDown from column ${column} of the first line visits every line`, async ({ page }) => {
      await placeCursor(page, 1, column);
      const steps = await press(page, 'ArrowDown', LINES - 1);
      expect(steps.map((s) => s.line)).toEqual(everyLine);
    });
  }

  test('Shift+ArrowUp extends the selection one line at a time', async ({ page }) => {
    await placeCursor(page, LINES, 3);
    const steps = await press(page, 'Shift+ArrowUp', LINES - 1);
    expect(steps.map((s) => s.line)).toEqual([...everyLine].reverse());
    expect(steps.every((s) => s.anchorLine === LINES)).toBe(true);
  });
});
