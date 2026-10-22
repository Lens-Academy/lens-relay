import { test, expect, type Page } from '@playwright/test';

// The page typography, after Notion's: computed styles, which unit tests
// (happy-dom, no stylesheet) can't check.

type View = import('@codemirror/view').EditorView;

/** Computed style of the element that holds `text` most closely. */
function styleOf(page: Page, text: string) {
  return page.evaluate((text) => {
    const view = (window as unknown as { __view: View }).__view;
    const walker = document.createTreeWalker(view.contentDOM, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.textContent!.includes(text)) {
        const s = getComputedStyle(node.parentElement!);
        return { fontSize: s.fontSize, fontWeight: s.fontWeight, lineHeight: s.lineHeight, color: s.color, fontFamily: s.fontFamily };
      }
    }
    throw new Error(`"${text}" not found`);
  }, text);
}

/** Put the cursor at the first occurrence of `text` (plus an offset). */
async function cursorAt(page: Page, text: string, offset = 0) {
  await page.evaluate(([text, offset]) => {
    const view = (window as unknown as { __view: View }).__view;
    view.dispatch({ selection: { anchor: view.state.doc.toString().indexOf(text as string) + (offset as number) } });
  }, [text, offset] as const);
}

test.describe('Typography', () => {
  const errors: string[] = [];

  test.beforeEach(async ({ page }) => {
    errors.length = 0;
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    await page.setViewportSize({ width: 1000, height: 1400 });
    await page.goto('/e2e/fixtures/typography.html');
    await expect(page.locator('.cm-md-table')).toHaveCount(1);
  });

  test.afterEach(() => {
    expect(errors).toEqual([]);
  });

  test('body text is the system font at 16px on a 24px line, in warm near-black', async ({ page }) => {
    const body = await styleOf(page, 'We make quarterly priorities');
    expect(body.fontFamily).toMatch(/^ui-sans-serif, -apple-system/);
    expect(body).toMatchObject({ fontSize: '16px', lineHeight: '24px', color: 'rgb(44, 44, 43)', fontWeight: '400' });
  });

  test('headings are 30, 24, 20 and 18px, all semibold', async ({ page }) => {
    expect(await styleOf(page, 'Q4 operating plan')).toMatchObject({ fontSize: '30px', fontWeight: '600' });
    expect(await styleOf(page, 'Key results')).toMatchObject({ fontSize: '24px', fontWeight: '600' });
    expect(await styleOf(page, 'Notes from the meeting')).toMatchObject({ fontSize: '20px', fontWeight: '600' });
    expect(await styleOf(page, 'Numbers')).toMatchObject({ fontSize: '18px', fontWeight: '600' });
  });

  test('a heading stays semibold while the cursor is on it', async ({ page }) => {
    await cursorAt(page, 'Key results');
    expect(await styleOf(page, 'Key results')).toMatchObject({ fontSize: '24px', fontWeight: '600' });
  });

  test('bold is semibold, and stays so while the cursor is in it', async ({ page }) => {
    expect((await styleOf(page, 'main risks')).fontWeight).toBe('600');
    await cursorAt(page, 'main risks', 2);
    expect((await styleOf(page, 'main risks')).fontWeight).toBe('600');
  });

  test('the title is 40px bold and starts in line with the text', async ({ page }) => {
    const title = page.locator('.lens-doc-title');
    await expect(title).toHaveCSS('font-size', '40px');
    await expect(title).toHaveCSS('font-weight', '700');
    const [titleLeft, textLeft] = await page.evaluate(() => {
      const t = document.querySelector('.lens-doc-title')!;
      const view = (window as unknown as { __view: View }).__view;
      // The paragraph's first letter
      const line = [...view.contentDOM.querySelectorAll('.cm-line')].find((l) => l.textContent!.startsWith('We make'))!;
      const range = document.createRange();
      range.setStart(line.firstChild!, 0);
      range.setEnd(line.firstChild!, 1);
      return [t.getBoundingClientRect().left + parseFloat(getComputedStyle(t).paddingLeft), range.getBoundingClientRect().left];
    });
    expect(Math.abs(titleLeft - textLeft)).toBeLessThan(1);
  });

  test('bullets are •, ◦, ▪ by depth, in the text colour', async ({ page }) => {
    await expect(page.locator('.cm-bullet')).toHaveText(['•', '•', '◦', '▪']);
    await expect(page.locator('.cm-bullet').first()).toHaveCSS('color', 'rgb(44, 44, 43)');
  });

  test('the ~~ around struck-through text is hidden', async ({ page }) => {
    // Hidden syntax is shrunk to nothing (font size 0), not removed
    const marks = page.locator('.cm-hidden-syntax', { hasText: '~~' });
    await expect(marks).toHaveCount(2);
    await expect(marks.first()).toHaveCSS('font-size', '0px');
  });

  test('a code block is a box with round corners', async ({ page }) => {
    await expect(page.locator('.cm-code-block-first')).toHaveCSS('border-top-left-radius', '10px');
    await expect(page.locator('.cm-code-block-last')).toHaveCSS('border-bottom-right-radius', '10px');
  });
});
