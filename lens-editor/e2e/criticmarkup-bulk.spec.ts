import { test, expect, type Page } from '@playwright/test';

declare global {
  interface Window {
    text(): string;
    selectedText(): string;
  }
}

const line = async (page: Page, n: number) => (await page.evaluate(() => window.text())).split('\n')[n - 1];

const meta = (author: string) => JSON.stringify({ author, timestamp: 1760000000000 });
const EDIT_NOTE = `{>>${meta('Elias')}@@Why the change?<<}`;
const THREAD = `{>>${meta('Elias')}@@Is big right?<<}{>>${meta('Mark')}@@Yes.<<}`;
const HIGHLIGHTED = `Some {==highlighted text==}{>>${meta('Elias')}@@A comment<<} here.`;

test.describe('bulk ✓ ✗ on a selection with comments in it', () => {
  const problems: string[] = [];
  test.beforeEach(async ({ page }) => {
    problems.length = 0;
    page.on('pageerror', (e) => problems.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') problems.push(m.text());
    });
    await page.goto('/e2e/fixtures/criticmarkup-bulk.html');
    await expect(page.locator('.cm-content')).toBeVisible();
  });
  test.afterEach(() => expect(problems).toEqual([]));

  test('Ctrl+A shows the two suggestions, and ✓ accepts them and keeps every comment', async ({ page }) => {
    await page.locator('.cm-content').click();
    await page.keyboard.press('Control+a');
    const accept = page.locator('.cm-criticmarkup-bulk .cm-criticmarkup-accept');
    await expect(accept).toHaveText('✓ 2');
    await expect(page.locator('.cm-criticmarkup-bulk .cm-criticmarkup-reject')).toHaveText('✗ 2');

    await accept.click();

    expect(await line(page, 2)).toBe(`An edit: new words${EDIT_NOTE} here.`);
    expect(await line(page, 3)).toBe(`Hello big world${THREAD} there.`);
    expect(await line(page, 4)).toBe(HIGHLIGHTED);
    await expect(page.locator('.cm-comment-badge')).toHaveCount(3);
  });

  test('a line with one suggestion and a comment thread: ✗ 1 rejects the suggestion, the thread stays', async ({ page }) => {
    await page.getByText('there.').click({ clickCount: 3 });
    const reject = page.locator('.cm-criticmarkup-bulk .cm-criticmarkup-reject');
    await expect(reject).toHaveText('✗ 1');

    await reject.click();

    expect(await line(page, 3)).toBe(`Hello world${THREAD} there.`);
  });

  test('a line with only a highlighted comment gets no ✓ ✗', async ({ page }) => {
    await page.getByText('highlighted text').click({ clickCount: 3 });
    expect(await page.evaluate(() => window.selectedText())).toBe(`${HIGHLIGHTED}\n`);
    await expect(page.locator('.cm-criticmarkup-buttons')).toHaveCount(0);
  });

  test('right-clicking a comment badge offers no accept or reject; the suggestion beside it does', async ({ page }) => {
    const menu = page.locator('#menu button');
    await page.locator('.cm-comment-badge').first().click({ button: 'right' });
    await expect(page.locator('#menu')).toHaveAttribute('data-pos', /\d+/);
    await expect(menu).toHaveCount(0);

    await page.getByText('new words').click({ button: 'right' });
    await expect(menu).toHaveText(['Accept Change', 'Reject Change']);
  });
});
