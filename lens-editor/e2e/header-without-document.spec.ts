import { test, expect } from '@playwright/test';

// The global header must offer the workflows menu (Review Suggestions, ...)
// before any document is open, and hide the toggles that only act on an
// open document. Needs a running local relay + dev server and a share link:
//   E2E_SHARE_URL='https://localhost:5273/?t=...' npx playwright test header-without-document
const SHARE_URL = process.env.E2E_SHARE_URL;

const VIEWPORTS = [
  { name: 'desktop', width: 1280, height: 800 },
  { name: 'phone', width: 390, height: 844 },
];

// A fresh profile is asked for a display name first
async function openApp(page: import('@playwright/test').Page) {
  await page.goto(SHARE_URL!);
  await page.getByPlaceholder('Enter your display name').fill('E2E');
  await page.keyboard.press('Enter');
}

test.describe('Header on the start page', () => {
  test.skip(!SHARE_URL, 'set E2E_SHARE_URL to a share link for the dev server');

  for (const vp of VIEWPORTS) {
    test(`${vp.name}: workflows menu works without a document`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await openApp(page);
      await expect(page.getByRole('heading', { name: 'Select a document' })).toBeVisible();

      await expect(page.locator('button[title="Toggle right sidebar"]')).toHaveCount(0);
      await expect(page.locator('button[title="Toggle comments"]')).toHaveCount(0);

      await page.getByRole('button', { name: 'Open workflows menu' }).click();
      await page.getByRole('menuitem', { name: /review suggestions/i }).click();
      await expect(page).toHaveURL(/\/review$/);
    });
  }

  test('a document page keeps one workflows menu and its panel toggles', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await openApp(page);
    await page.getByText('Welcome.md').click();
    await page.waitForSelector('#editor', { timeout: 15_000 });

    await expect(page.getByRole('button', { name: 'Open workflows menu' })).toHaveCount(1);
    await expect(page.locator('button[title="Toggle right sidebar"]')).toBeVisible();
    await expect(page.locator('button[title="Toggle comments"]')).toBeVisible();
  });
});
