import { test, expect, type Page } from '@playwright/test';
import type { EditorView } from '@codemirror/view';
import type { CriticMarkupRange } from '../src/lib/criticmarkup-parser';

// Clicks and drags on a line with a suggestion put the cursor where the
// pointer is. CodeMirror finds that position with a search over the boxes of
// the line's pieces, which a suggestion's hidden delimiters and metadata used
// to throw off by tens of characters, differently from one try to the next
// (hiddenSyntaxMarks in src/components/Editor/extensions/criticmarkup.ts).
// That search breaks ties with Math.random, so every click and drag here runs
// under several seeds.

type FixtureWindow = Window & {
  view: EditorView;
  ranges: () => CriticMarkupRange[];
  seedRandom: (seed: number) => void;
};

const LINES = 12; // e2e/fixtures/criticmarkup-pointer.ts
const SEEDS = [1, 2, 3];
const DRAG_SEEDS = [1, 2, 3, 4, 5, 6];
const HEIGHTS = ['top', 'middle', 'bottom'] as const;
type Height = (typeof HEIGHTS)[number];

let pageErrors: string[] = [];

/** The document position of `needle` on line `n`, plus `offset` */
function pos(page: Page, n: number, needle: string, offset = 0): Promise<number> {
  return page.evaluate(({ n, needle, offset }) => {
    const line = (window as unknown as FixtureWindow).view.state.doc.line(n);
    const at = line.text.indexOf(needle);
    if (at < 0) throw new Error(`"${needle}" is not on line ${n}`);
    return line.from + at + offset;
  }, { n, needle, offset });
}

/** Put the cursor at document position `at` */
async function place(page: Page, at: number): Promise<void> {
  await page.evaluate((at) => {
    const { view } = window as unknown as FixtureWindow;
    view.dispatch({ selection: { anchor: at } });
    view.focus();
  }, at);
}

function selection(page: Page): Promise<{ anchor: number; head: number }> {
  return page.evaluate(() => {
    const { main } = (window as unknown as FixtureWindow).view.state.selection;
    return { anchor: main.anchor, head: main.head };
  });
}

/**
 * The screen point just right of document position `at` (between its two
 * characters), near the top of the text, in the middle, or near the bottom:
 * below the baseline, where hidden syntax used to read as a row above
 */
function pointAt(page: Page, at: number, height: Height = 'middle'): Promise<{ x: number; y: number }> {
  return page.evaluate(({ at, height }) => {
    const c = (window as unknown as FixtureWindow).view.coordsAtPos(at, 1)!;
    const y = height === 'top' ? c.top + 2 : height === 'bottom' ? c.bottom - 2 : (c.top + c.bottom) / 2;
    return { x: c.left + 1, y };
  }, { at, height });
}

/** `at` shown in its line, as `…text|text…` */
function described(page: Page, at: number): Promise<string> {
  return page.evaluate((at) => {
    const { doc } = (window as unknown as FixtureWindow).view.state;
    const line = doc.lineAt(at);
    return `line ${line.number} "${doc.sliceString(Math.max(line.from, at - 12), at)}|${doc.sliceString(at, Math.min(line.to, at + 12))}"`;
  }, at);
}

/**
 * Click at the point of `at` under each seed and height, with the cursor at
 * `from` before each click; the clicks that put the cursor anywhere but `at`
 */
async function missedClicks(page: Page, at: number, from: number, heights: readonly Height[] = HEIGHTS): Promise<string[]> {
  const missed: string[] = [];
  for (const height of heights) {
    for (const seed of SEEDS) {
      await place(page, from);
      const point = await pointAt(page, at, height);
      await page.evaluate((seed) => (window as unknown as FixtureWindow).seedRandom(seed), seed);
      await page.mouse.click(point.x, point.y);
      const { anchor, head } = await selection(page);
      if (anchor !== at || head !== at) {
        missed.push(`${await described(page, at)}, ${height}, seed ${seed}: ${anchor === head ? `cursor at ${await described(page, head)}` : `selected ${anchor}-${head}`}`);
      }
    }
  }
  return missed;
}

/**
 * Drag with the mouse from document position `from` to `to` under `seed`.
 * Once the selection reaches a suggestion, its ✓ ✗ buttons appear and move
 * what follows them; the pointer then goes to where `to` is now, as a person
 * would follow the text.
 */
async function drag(page: Page, from: number, to: number, seed: number): Promise<{ anchor: number; head: number }> {
  await place(page, await pos(page, 1, '#'));
  await page.evaluate((seed) => (window as unknown as FixtureWindow).seedRandom(seed), seed);
  const a = await pointAt(page, from);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  for (let i = 0; i < 3; i++) {
    const b = await pointAt(page, to);
    await page.mouse.move(b.x, b.y, { steps: 4 });
  }
  await page.mouse.up();
  return selection(page);
}

test.describe('Live preview: pointing at a line with a suggestion', () => {
  test.beforeEach(async ({ page }) => {
    pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') pageErrors.push(message.text());
    });
    await page.addInitScript(() => {
      let state = 1;
      Object.assign(window, {
        seedRandom: (seed: number) => { state = seed; },
      });
      Math.random = () => (state = (state * 16807) % 2147483647) / 2147483647;
    });
    await page.setViewportSize({ width: 900, height: 900 });
    await page.goto('/e2e/fixtures/criticmarkup-pointer.html');
    await expect(page.locator('.cm-content > .cm-line')).toHaveCount(LINES);
    await page.evaluate(() => document.fonts.ready);
  });

  test.afterEach(() => {
    expect(pageErrors).toEqual([]);
  });

  test('a click on a suggestion\'s text, or on the text after it, puts the cursor under the pointer', async ({ page }) => {
    const targets: Array<[number, string, number]> = [
      [2, 'inserted', 3], [2, ' in the', 4],
      [3, 'added', 2], [3, ' in the middle', 5],
      [4, 'old words', 4], [4, 'new words', 4], [4, 'replaces', 3],
      [6, 'removed', 3], [6, 'and more', 4],
      [7, 'added words', 3], [7, 'phrase to', 3], [7, 'carries', 3], [7, 'twice', 2],
      [8, 'an addition', 3],
    ];
    const away = await pos(page, 1, '#');
    const missed: string[] = [];
    for (const [n, needle, offset] of targets) {
      missed.push(...await missedClicks(page, await pos(page, n, needle, offset), away));
    }
    expect(missed).toEqual([]);
  });

  test('with a suggestion\'s ✓ ✗ buttons showing, a click on the text after them puts the cursor under the pointer', async ({ page }) => {
    // [line, a point in the suggestion's text, the target after the buttons]
    const cases: Array<[number, [string, number], [string, number]]> = [
      [2, ['inserted', 3], ['the middle', 2]],
      [3, ['added', 2], ['middle of', 3]],
      [4, ['new words', 2], ['replaces', 3]],
      [4, ['old words', 2], [' text.', 3]],
      [7, ['phrase to', 2], ['a little', 3]],
    ];
    const missed: string[] = [];
    for (const [n, [inNeedle, inOffset], [needle, offset]] of cases) {
      missed.push(...await missedClicks(page, await pos(page, n, needle, offset), await pos(page, n, inNeedle, inOffset)));
    }
    expect(missed).toEqual([]);
  });

  test('with a suggestion\'s ✓ ✗ buttons at the end of a line, a click right of them puts the cursor after the suggestion', async ({ page }) => {
    const inside = await pos(page, 8, 'addition', 3);
    const end = await page.evaluate(() => (window as unknown as FixtureWindow).view.state.doc.line(8).to);
    const missed: string[] = [];
    for (const height of HEIGHTS) {
      for (const seed of SEEDS) {
        await place(page, inside);
        const point = await page.evaluate(({ inside, height }) => {
          const { view } = window as unknown as FixtureWindow;
          const c = view.coordsAtPos(inside, 1)!;
          const buttons = view.contentDOM.querySelector('.cm-criticmarkup-buttons')!.getBoundingClientRect();
          const y = height === 'top' ? c.top + 2 : height === 'bottom' ? c.bottom - 2 : (c.top + c.bottom) / 2;
          return { x: buttons.right + 12, y };
        }, { inside, height });
        await page.evaluate((seed) => (window as unknown as FixtureWindow).seedRandom(seed), seed);
        await page.mouse.click(point.x, point.y);
        const { anchor, head } = await selection(page);
        if (anchor !== end || head !== end) missed.push(`${height}, seed ${seed}: ${anchor === head ? `cursor at ${await described(page, head)}` : `selected ${anchor}-${head}`}`);
      }
    }
    expect(missed).toEqual([]);
  });

  test('a click on a line with a comment badge puts the cursor under the pointer, low on the line too', async ({ page }) => {
    const targets: Array<[number, string, number]> = [
      [5, 'Some', 2], [5, 'highlighted', 4], [5, 'after it', 2],
      [7, 'highlight==', 5], [7, 'before the text', 3],
    ];
    const away = await pos(page, 1, '#');
    const missed: string[] = [];
    for (const [n, needle, offset] of targets) {
      missed.push(...await missedClicks(page, await pos(page, n, needle, offset), away));
    }
    expect(missed).toEqual([]);
  });

  test('a drag from plain text into a suggestion\'s text selects up to the pointer', async ({ page }) => {
    const drags: Array<[number, [string, number], [string, number]]> = [
      [2, ['Plain', 2], ['inserted', 4]],
      [3, ['with', 0], ['added', 2]],
      [4, ['pair', 1], ['new words', 4]],
      [7, ['wraps', 0], ['phrase to', 3]],
    ];
    const missed: string[] = [];
    for (const [n, [fromNeedle, fromOffset], [toNeedle, toOffset]] of drags) {
      const from = await pos(page, n, fromNeedle, fromOffset);
      const to = await pos(page, n, toNeedle, toOffset);
      for (const seed of DRAG_SEEDS) {
        const sel = await drag(page, from, to, seed);
        if (sel.anchor !== from || sel.head !== to) {
          missed.push(`${await described(page, from)} to ${await described(page, to)}, seed ${seed}: selected ${await described(page, sel.anchor)} to ${await described(page, sel.head)}`);
        }
      }
    }
    expect(missed).toEqual([]);
  });

  test('a drag across a suggestion ends under the pointer after its ✓ ✗ buttons move the text', async ({ page }) => {
    const drags: Array<[number, [string, number], [string, number]]> = [
      [2, ['Plain', 2], ['the middle', 2]],
      [3, ['with', 0], ['middle of', 3]],
      [4, ['pair', 1], ['replaces', 3]],
      [6, ['list item', 2], ['and more', 4]],
    ];
    const missed: string[] = [];
    for (const [n, [fromNeedle, fromOffset], [toNeedle, toOffset]] of drags) {
      const from = await pos(page, n, fromNeedle, fromOffset);
      const to = await pos(page, n, toNeedle, toOffset);
      for (const seed of DRAG_SEEDS) {
        const sel = await drag(page, from, to, seed);
        if (sel.anchor !== from || sel.head !== to) {
          missed.push(`${await described(page, from)} to ${await described(page, to)}, seed ${seed}: selected ${await described(page, sel.anchor)} to ${await described(page, sel.head)}`);
        }
      }
    }
    expect(missed).toEqual([]);
  });

  test('clicks on the lines of a suggestion that show none of its text never throw or stop inside its markup', async ({ page }) => {
    // Lines 9 and 11 hold only the hidden `{++…@@` and `++}`: with the cursor
    // in the suggestion, line 9 also gets a zero-width cursor anchor and line
    // 11 the ✓ ✗ buttons
    const inside = [await pos(page, 10, 'added', 2), await pos(page, 9, '@@', 2)];
    const landed: string[] = [];
    const expected: string[] = [];
    for (const at of inside) {
      for (const n of [9, 11]) {
        for (const dx of [-6, 0, 2, 30, 60, 300]) {
          await place(page, at);
          const point = await page.evaluate(({ n, dx }) => {
            const { view } = window as unknown as FixtureWindow;
            const block = view.lineBlockAt(view.state.doc.line(n).from);
            const left = view.contentDOM.getBoundingClientRect().left + 24;
            const x = left + dx, y = view.documentTop + block.top + block.height / 2;
            // Not on the ✓ ✗ buttons, which would accept or reject
            const onButtons = Array.from(document.querySelectorAll('.cm-criticmarkup-buttons')).some((b) => {
              const r = b.getBoundingClientRect();
              return x >= r.left - 2 && x <= r.right + 2 && y >= r.top - 2 && y <= r.bottom + 2;
            });
            return onButtons ? null : { x, y };
          }, { n, dx });
          if (!point) continue;
          await page.mouse.click(point.x, point.y);
          expected.push(`line ${n}`);
          landed.push(await page.evaluate(() => {
            const { view, ranges } = window as unknown as FixtureWindow;
            const { head } = view.state.selection.main;
            const hidden = ranges().some((r) => (r.from < head && head < r.contentFrom) || (r.contentTo < head && head < r.to));
            return `line ${view.state.doc.lineAt(head).number}${hidden ? ', inside hidden markup' : ''}`;
          }));
        }
      }
    }
    expect(landed).toEqual(expected);
  });
});
