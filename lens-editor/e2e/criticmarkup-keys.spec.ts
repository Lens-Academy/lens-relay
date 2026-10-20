import { test, expect, type Page } from '@playwright/test';

declare global {
  interface Window {
    text(): string;
    placeCursor(pos: number): void;
    setSuggestionMode(on: boolean): void;
  }
}

/**
 * Opens the fixture page (Editor.tsx's keymaps, in its order). Collects page
 * errors and console errors: CodeMirror only logs what a key binding throws.
 */
async function open(page: Page, problems: string[]) {
  page.on('pageerror', (e) => problems.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(m.text());
  });
  await page.goto('/e2e/fixtures/criticmarkup-keys.html');
  await expect(page.locator('.cm-content')).toBeVisible();
}

const line = async (page: Page, n: number) => (await page.evaluate(() => window.text())).split('\n')[n - 1];

/** Puts the cursor `offset` characters into the first `needle` of the document */
async function cursorAt(page: Page, needle: string, offset = 0) {
  await page.evaluate(([n, o]) => window.placeCursor(window.text().indexOf(n) + o), [needle, offset] as const);
}

const COMMENT = '{>>{"author":"Elias","timestamp":1760000000000}@@A comment<<}';

test.describe('Ctrl+Enter and Ctrl+Backspace with the keymaps of Editor.tsx', () => {
  const problems: string[] = [];
  test.beforeEach(async ({ page }) => {
    problems.length = 0;
    await open(page, problems);
  });
  test.afterEach(() => expect(problems).toEqual([]));

  test('Ctrl+Enter accepts the suggestion at the cursor', async ({ page }) => {
    await cursorAt(page, 'big', 1);
    await page.keyboard.press('Control+Enter');
    expect(await line(page, 2)).toBe('Hello big world.');
  });

  test('Ctrl+Backspace rejects it', async ({ page }) => {
    await cursorAt(page, 'big', 1);
    await page.keyboard.press('Control+Backspace');
    expect(await line(page, 2)).toBe('Hello world.');
  });

  test('a deletion+addition pair goes as one, as its ✓ ✗ do', async ({ page }) => {
    await cursorAt(page, 'new words', 4);
    await page.keyboard.press('Control+Enter');
    expect(await line(page, 3)).toBe('A pair: new words here.');
  });

  test('Ctrl+Backspace in either half rejects the whole pair', async ({ page }) => {
    await cursorAt(page, 'old words', 4);
    await page.keyboard.press('Control+Backspace');
    expect(await line(page, 3)).toBe('A pair: old words here.');
  });

  test('away from suggestions, Ctrl+Backspace deletes a word and Ctrl+Enter adds a line', async ({ page }) => {
    await cursorAt(page, 'Plain words at the end', 'Plain words at the end'.length);
    await page.keyboard.press('Control+Backspace');
    expect(await line(page, 5)).toBe('Plain words at the ');
    await page.keyboard.press('Control+Enter');
    expect(await page.evaluate(() => window.text().endsWith('at the \n'))).toBe(true);
  });

  test('a comment and its highlighted text are left alone', async ({ page }) => {
    // In the highlighted text: the word before the cursor goes, the highlight stays
    await cursorAt(page, 'highlighted', 'highlighted'.length);
    await page.keyboard.press('Control+Backspace');
    expect(await line(page, 4)).toBe(`Some {== text==}${COMMENT} here.`);
    // Right after the comment's badge: a new line, the comment stays
    await cursorAt(page, COMMENT, COMMENT.length);
    await page.keyboard.press('Control+Enter');
    expect(await line(page, 4)).toBe(`Some {== text==}${COMMENT} here.`);
    expect(await line(page, 5)).toBe('');
  });

  test('in suggestion mode, Ctrl+Backspace deletes words of the suggestion you type, and rejects others\'', async ({ page }) => {
    await page.evaluate(() => window.setSuggestionMode(true));
    await cursorAt(page, 'Plain words at the end', 'Plain words at the end'.length);
    await page.keyboard.type(' and two more');
    expect(await line(page, 5)).toMatch(/^Plain words at the end\{\+\+\{"author":"Mark","timestamp":\d+\}@@ and two more\+\+\}$/);
    await page.keyboard.press('Control+Backspace');
    expect(await line(page, 5)).toMatch(/@@ and two \+\+\}$/);

    await cursorAt(page, 'big', 1);
    await page.keyboard.press('Control+Backspace');
    expect(await line(page, 2)).toBe('Hello world.');
  });
});

test.describe('Cmd+Enter and Cmd+Backspace on a Mac', () => {
  const problems: string[] = [];
  test.beforeEach(async ({ page }) => {
    problems.length = 0;
    // CodeMirror reads the platform when it loads; Mod is then Cmd
    await page.addInitScript(() => {
      Object.defineProperty(Navigator.prototype, 'platform', { get: () => 'MacIntel' });
    });
    await open(page, problems);
  });
  test.afterEach(() => expect(problems).toEqual([]));

  test('accept and reject the suggestion at the cursor', async ({ page }) => {
    await cursorAt(page, 'big', 1);
    await page.keyboard.press('Meta+Enter');
    expect(await line(page, 2)).toBe('Hello big world.');

    await cursorAt(page, 'new words', 4);
    await page.keyboard.press('Meta+Backspace');
    expect(await line(page, 3)).toBe('A pair: old words here.');
  });

  test('away from suggestions, Cmd+Backspace deletes to the line start', async ({ page }) => {
    await cursorAt(page, 'Plain words at the end', 'Plain words at the end'.length);
    await page.keyboard.press('Meta+Backspace');
    expect(await line(page, 5)).toBe('');
  });
});
