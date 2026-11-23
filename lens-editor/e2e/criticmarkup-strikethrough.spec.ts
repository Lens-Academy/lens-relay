import { test, expect, type Page } from '@playwright/test';

// The fixture page has Editor.tsx's highlighting and live preview. Markdown
// reads a substitution's {~~ ~~} as strikethrough; none of that line may show
// on its text, while deletions (also one nested in a substitution) and real
// ~~strike~~ keep theirs.
const elias = '{"author":"Elias","timestamp":1760000000000}@@';

/** Per line of the editor: the visible runs of text drawn with a line through them. */
function struckRuns(page: Page): Promise<string[][]> {
  return page.evaluate(() => [...document.querySelectorAll('.cm-content > .cm-line')].map((line) => {
    const runs: string[] = [];
    let run = '';
    const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      // Hidden markup
      if (parseFloat(getComputedStyle(node.parentElement!).fontSize) === 0) continue;
      let struck = false;
      for (let el = node.parentElement; el && el !== line.parentElement; el = el.parentElement) {
        if (getComputedStyle(el).textDecorationLine.includes('line-through')) struck = true;
      }
      if (struck) {
        run += node.textContent;
      } else if (run) {
        runs.push(run);
        run = '';
      }
    }
    if (run) runs.push(run);
    return runs;
  }));
}

test.describe('Line through CriticMarkup substitutions', () => {
  let errors: string[];

  test.beforeEach(async ({ page }) => {
    errors = [];
    // CodeMirror reports exceptions in its update cycle with console.error
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    page.on('pageerror', (error) => errors.push(String(error)));
    await page.goto('/e2e/fixtures/criticmarkup-strikethrough.html');
    await expect(page.locator('.cm-content > .cm-line')).toHaveCount(8);
    await expect(page.locator('.cm-substitution')).toHaveCount(5);
  });

  test.afterEach(() => {
    expect(errors).toEqual([]);
  });

  test('live preview: substitutions have no line through them; deletions and real ~~strike~~ do', async ({ page }) => {
    expect(await struckRuns(page)).toEqual([
      [],
      [],
      [],
      ['text'],
      ['text'],
      ['deleted words'],
      ['~~strike~~'],
      [],
    ]);
  });

  test('source mode: a substitution\'s text has no line through it; real ~~strike~~ does', async ({ page }) => {
    await page.evaluate(() => (window as unknown as { setSourceMode: (on: boolean) => void }).setSourceMode(true));

    // Its ~~ delimiters and metadata are Markdown strikethrough marks and text there
    expect(await struckRuns(page)).toEqual([
      [],
      [`~~${elias}`, '~~'],
      ['~~', '~~'],
      [`~~${elias}`, 'text', '~~'],
      [`~~${elias}`, 'text', '~~'],
      ['deleted words'],
      ['~~strike~~', '~~', '~~'],
      [],
    ]);
  });
});
