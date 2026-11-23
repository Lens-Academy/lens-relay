import { test, expect, type Page } from '@playwright/test';

declare global {
  interface Window {
    text(): string;
    load(doc: string): void;
    placeCursor(pos: number): void;
  }
}

/**
 * Opens the fixture page (Editor.tsx's keymaps, in its order; suggestion mode
 * on for Mark, who can only suggest). Collects page errors and console errors:
 * CodeMirror only logs what a key binding throws.
 */
async function open(page: Page, problems: string[]) {
  page.on('pageerror', (e) => problems.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(m.text());
  });
  await page.goto('/e2e/fixtures/criticmarkup-own-addition.html');
  await expect(page.locator('.cm-content')).toBeVisible();
}

// Every suggestion's metadata, with the time left out
const MARK = '{"author":"Mark","timestamp":T}';
const YOURS = `{++${MARK}@@my words++}`;

/** The document, with each suggestion's time as T */
const text = async (page: Page) =>
  (await page.evaluate(() => window.text())).replace(/"timestamp":\d+/g, '"timestamp":T');

/** Loads `doc` (T for the time) and puts the cursor just before the closing `++}` of Mark's addition */
async function loadWithCursorAtYourEnd(page: Page, doc: string) {
  await page.evaluate((d) => {
    window.load(d.replace(/"timestamp":T/g, '"timestamp":1760000000000'));
    window.placeCursor(window.text().indexOf('my words') + 'my words'.length);
  }, doc);
}

test.describe('Suggestion mode, keys pressed with the cursor in your own addition', () => {
  const problems: string[] = [];
  test.beforeEach(async ({ page }) => {
    problems.length = 0;
    await open(page, problems);
  });
  test.afterEach(() => expect(problems).toEqual([]));

  test("Ctrl+Enter suggests a new line at the line's end, and typing goes on there", async ({ page }) => {
    await loadWithCursorAtYourEnd(page, `I ${YOURS} here\nnext line`);
    await page.keyboard.press('Control+Enter');
    expect(await text(page)).toBe(`I ${YOURS} here{++${MARK}@@\n++}\nnext line`);

    await page.keyboard.type('more');
    expect(await text(page)).toBe(`I ${YOURS} here{++${MARK}@@\nmore++}\nnext line`);
  });

  test('Ctrl+Enter on a line your addition ends suggests the new line right after it', async ({ page }) => {
    await loadWithCursorAtYourEnd(page, `I ${YOURS}\nnext line`);
    await page.keyboard.press('Control+Enter');
    await page.keyboard.type('more');

    // A new addition right after yours, or yours made longer: either way,
    // nothing is suggested for deletion
    const doc = await text(page);
    expect(doc).not.toContain('{--');
    expect(doc.replace(/\{\+\+\{"author":"Mark","timestamp":T\}@@|\+\+\}/g, '')).toBe('I my words\nmore\nnext line');
  });

  test("Tab suggests an indent at the line's start, Shift+Tab deleting one", async ({ page }) => {
    await loadWithCursorAtYourEnd(page, `I ${YOURS} here`);
    await page.keyboard.press('Tab');
    expect(await text(page)).toBe(`{++${MARK}@@\t++}I ${YOURS} here`);

    await loadWithCursorAtYourEnd(page, `\tI ${YOURS} here`);
    await page.keyboard.press('Shift+Tab');
    expect(await text(page)).toBe(`{--${MARK}@@\t--}I ${YOURS} here`);
  });

  test('typing and Enter go into its text, as before', async ({ page }) => {
    await loadWithCursorAtYourEnd(page, `I ${YOURS} here`);
    await page.keyboard.type(' too');
    await page.keyboard.press('Enter');
    await page.keyboard.type('and more');
    expect(await text(page)).toBe(`I {++${MARK}@@my words too\nand more++} here`);
  });
});
