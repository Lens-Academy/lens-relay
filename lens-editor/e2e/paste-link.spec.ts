import { test, expect, type Page } from '@playwright/test';

const DOC_URL = 'https://editor.lensacademy.org/a1b2c3d4/Lens/03-Product/Pitch.md';

const docText = (page: Page) =>
  page.evaluate(() => (window as unknown as { __view: { state: { doc: { toString(): string } } } }).__view.state.doc.toString());

/** Select the first occurrence of `text` in the doc, with the editor focused. */
async function select(page: Page, text: string) {
  await page.evaluate((text) => {
    const view = (window as unknown as { __view: import('@codemirror/view').EditorView }).__view;
    const from = view.state.doc.toString().indexOf(text);
    view.focus();
    view.dispatch({ selection: { anchor: from, head: from + text.length } });
  }, text);
}

async function copy(page: Page, text: string) {
  await page.evaluate((text) => navigator.clipboard.writeText(text), text);
}

test.describe('Pasting a link over selected text', () => {
  const errors: string[] = [];

  test.beforeEach(async ({ page, context, baseURL }) => {
    errors.length = 0;
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(baseURL!).origin });
    await page.goto('/e2e/fixtures/paste-link.html');
    await expect(page.locator('.cm-md-table')).toHaveCount(1);
  });

  test.afterEach(() => {
    expect(errors).toEqual([]);
  });

  test('Ctrl+V of a doc link makes a wikilink', async ({ page }) => {
    await select(page, '40%');
    await copy(page, DOC_URL);
    await page.keyboard.press('Control+V');
    expect(await docText(page)).toContain('Revenue grew [[Pitch|40%]] last year');
    // Shown as a link at once, not as its syntax
    await expect(page.locator('.cm-wikilink-widget')).toHaveText('40%');
    await expect(page.locator('.cm-line').first()).not.toContainText('[[');
  });

  test('Ctrl+V of another URL makes a markdown link', async ({ page }) => {
    await select(page, '120');
    await copy(page, 'https://example.com/report');
    await page.keyboard.press('Control+V');
    expect(await docText(page)).toContain('and [120](https://example.com/report) students');
    await expect(page.locator('.cm-link-widget')).toHaveText('120');
    await expect(page.locator('.cm-line').first()).not.toContainText('](');
    // Typing on keeps it a link; arrowing back onto it shows the syntax to edit
    await page.keyboard.type(' new');
    await expect(page.locator('.cm-link-widget')).toHaveText('120');
    for (let i = 0; i < ' new'.length + 1; i++) await page.keyboard.press('ArrowLeft');
    await expect(page.locator('.cm-line').first()).toContainText('[120](https://example.com/report)');
  });

  test('Ctrl+V with no selection pastes the URL', async ({ page }) => {
    await page.evaluate(() => {
      const view = (window as unknown as { __view: import('@codemirror/view').EditorView }).__view;
      view.focus();
      view.dispatch({ selection: { anchor: view.state.doc.toString().indexOf('End') } });
    });
    await copy(page, DOC_URL);
    await page.keyboard.press('Control+V');
    expect(await docText(page)).toContain(`${DOC_URL}End`);
  });

  test('Ctrl+V over a number in a table cell links it', async ({ page }) => {
    const cell = page.locator('.cm-md-table td').filter({ hasText: '350' });
    await cell.click();
    await cell.evaluate((td) => window.getSelection()!.selectAllChildren(td));
    await copy(page, DOC_URL);
    await page.keyboard.press('Control+V');
    expect(await docText(page)).toContain(`| Signups | [350](${DOC_URL}) |`);
  });
});
