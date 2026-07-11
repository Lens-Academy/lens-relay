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
    await expect(page.locator('.cm-md-table-wrapper')).toHaveCount(2);
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
});
