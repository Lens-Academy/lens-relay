import { test, expect, type Locator } from '@playwright/test';

type Box = NonNullable<Awaited<ReturnType<Locator['boundingBox']>>>;

async function box(locator: Locator): Promise<Box> {
  const result = await locator.boundingBox();
  expect(result).not.toBeNull();
  return result!;
}

test.describe('Markdown table responsive layout', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/e2e/fixtures/markdown-table-layout.html');
    await expect(page.locator('.cm-md-table-wrapper')).toHaveCount(4);
  });

  test('keeps prose constrained, narrow tables in-column, and gives wide tables extra pane width', async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 800 });

    const pane = await box(page.locator('#editor-pane'));
    const content = await box(page.locator('.cm-content'));
    const prose = await box(page.locator('.cm-line').filter({ hasText: 'Ordinary prose' }));
    const tables = page.locator('.cm-md-table-wrapper');
    const narrow = await box(tables.nth(0));
    const wide = await box(tables.nth(1));

    expect(content.width).toBeCloseTo(700, 0);
    expect(prose.width).toBeLessThanOrEqual(700);
    expect(narrow.width).toBeCloseTo(content.width - 48, 0);
    expect(wide.width).toBeGreaterThan(content.width);
    expect(wide.x).toBeGreaterThanOrEqual(pane.x + 15);
    expect(wide.x + wide.width).toBeLessThanOrEqual(pane.x + pane.width - 15);
  });

  test('contains a wide table beside a sidebar and scrolls the table locally on a narrow viewport', async ({ page }) => {
    await page.setViewportSize({ width: 760, height: 800 });

    const pane = await box(page.locator('#editor-pane'));
    const sidebar = await box(page.locator('#right-sidebar'));
    const wideWrapper = page.locator('.cm-md-table-wrapper').nth(1);
    const wide = await box(wideWrapper);
    const overflow = await wideWrapper.evaluate(element => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      overflowX: getComputedStyle(element).overflowX,
    }));

    expect(wide.x).toBeGreaterThanOrEqual(pane.x + 15);
    expect(wide.x + wide.width).toBeLessThanOrEqual(sidebar.x - 15);
    expect(overflow.overflowX).toBe('auto');
    expect(overflow.scrollWidth).toBeGreaterThan(overflow.clientWidth);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(760);
  });

  test('wraps long breakable cell text instead of scrolling', async ({ page }) => {
    await page.setViewportSize({ width: 760, height: 800 });

    const proseWrapper = page.locator('.cm-md-table-wrapper').nth(2);
    const overflow = await proseWrapper.evaluate(element => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
    }));
    expect(overflow.scrollWidth).toBe(overflow.clientWidth);

    // The long description cell must have wrapped onto multiple lines
    // (a single 14px/1.5 line plus padding is ~33px tall).
    const cell = proseWrapper.locator('td', { hasText: 'Show the importance of x-risk' });
    const cellBox = await box(cell);
    expect(cellBox.height).toBeGreaterThan(45);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(760);
  });

  test('caps column width so one long column cannot stretch the table across the pane', async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 800 });

    const content = await box(page.locator('.cm-content'));
    const capWrapper = page.locator('.cm-md-table-wrapper').nth(3);
    const cap = await box(capWrapper);

    // Without the per-column max-width the huge prose cell would push this
    // wrapper well past the reading column (like the 12-column table above);
    // with the cap it stays at the column width and wraps instead.
    expect(cap.width).toBeLessThanOrEqual(content.width);

    const proseCell = capWrapper.locator('td', { hasText: 'far far longer than the per-column cap' });
    expect((await box(proseCell)).height).toBeGreaterThan(45);

    // The unbreakable URL must emergency-break inside its capped column
    // rather than spill out of the cell or force local scrolling.
    const urlCell = capWrapper.locator('td', { hasText: 'averylongpathsegment' });
    expect((await box(urlCell)).height).toBeGreaterThan(45);
    const overflow = await capWrapper.evaluate(element => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
    }));
    expect(overflow.scrollWidth).toBe(overflow.clientWidth);
  });
});
