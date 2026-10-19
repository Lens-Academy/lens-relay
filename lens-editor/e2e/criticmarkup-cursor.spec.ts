import { test, expect, type Page } from '@playwright/test';
import type { EditorView } from '@codemirror/view';
import type { CriticMarkupRange } from '../src/lib/criticmarkup-parser';

// Live preview keeps a suggestion's delimiters and metadata hidden even with
// the cursor on the line, and a comment behind its badge. The cursor must never
// stop inside that hidden syntax, where typing breaks the markup
// (src/components/Editor/extensions/criticmarkup-cursor.ts).

type FixtureWindow = Window & {
  view: EditorView;
  ranges: () => CriticMarkupRange[];
  setSuggestionMode: (on: boolean) => void;
  setSourceMode: (on: boolean) => void;
};

const LINES = 13; // e2e/fixtures/criticmarkup-cursor.ts
const OPENS_WITH_SUGGESTION = [2, 3, 4, 5, 6];
const ENDS_WITH_SUGGESTION = [2, 3, 4, 7];
const WRAPPED = 10;
const TWO_LINE_COMMENT = 11; // and 12
// Suggestion mode wraps typing in {++{"author":"Mark","timestamp":…}@@…++}
const MARK = '\\{"author":"Mark","timestamp":\\d+\\}@@';

let pageErrors: string[] = [];

type Cursor = { line: number; col: number; head: number; anchor: number; hidden: boolean };

/** The cursor, and whether it is strictly inside hidden syntax */
function cursor(page: Page): Promise<Cursor> {
  return page.evaluate(() => {
    const { view, ranges } = window as unknown as FixtureWindow;
    // What live preview hides: delimiters with their metadata, whole comments
    const spans = ranges().flatMap((r) =>
      r.type === 'comment' ? [[r.from, r.to]] : [[r.from, r.contentFrom], [r.contentTo, r.to]]);
    // Touching spans hide everything in between too (`--}{++`)
    const inside = (pos: number) => spans.some(([from, to]) => from < pos && pos < to)
      || spans.some(([, to]) => spans.some(([from]) => from === to && to === pos));
    const { main } = view.state.selection;
    const line = view.state.doc.lineAt(main.head);
    return {
      line: line.number,
      col: main.head - line.from,
      head: main.head,
      anchor: main.anchor,
      hidden: inside(main.head) || inside(main.anchor),
    };
  });
}

/** Put the cursor at column `col` of line `n` (at most its end; negative: from its end) */
async function place(page: Page, n: number, col: number): Promise<void> {
  await page.evaluate(({ n, col }) => {
    const { view } = window as unknown as FixtureWindow;
    const line = view.state.doc.line(n);
    view.dispatch({ selection: { anchor: col < 0 ? line.to + col + 1 : Math.min(line.from + col, line.to) } });
    view.focus();
  }, { n, col });
}

function lineText(page: Page, n: number): Promise<string> {
  return page.evaluate((n) => (window as unknown as FixtureWindow).view.state.doc.line(n).text, n);
}

function lineLength(page: Page, n: number): Promise<number> {
  return page.evaluate((n) => (window as unknown as FixtureWindow).view.state.doc.line(n).length, n);
}

/** The cursor after each of `presses` presses of `key` */
async function walk(page: Page, key: string, presses: number): Promise<Cursor[]> {
  const steps: Cursor[] = [];
  for (let i = 0; i < presses; i++) {
    await page.keyboard.press(key);
    steps.push(await cursor(page));
  }
  return steps;
}

/** Every stop of `key` from the cursor to the end of its line */
async function walkLine(page: Page, key: string): Promise<Cursor[]> {
  const steps: Cursor[] = [];
  let at = await cursor(page);
  for (;;) {
    await page.keyboard.press(key);
    const next = await cursor(page);
    if (next.line !== at.line || next.head === at.head) return steps;
    steps.push(next);
    at = next;
  }
}

/** Screen points around the start and end of line `n`'s text, mid-height */
function pointsOnLine(page: Page, n: number) {
  return page.evaluate((n) => {
    const { view } = window as unknown as FixtureWindow;
    const line = view.state.doc.line(n);
    const start = view.coordsAtPos(line.from, 1)!;
    const end = view.coordsAtPos(line.to, -1)!;
    const block = view.lineBlockAt(line.from);
    const y = view.documentTop + block.top + Math.min(block.height, view.defaultLineHeight) / 2;
    return [start.left - 8, start.left, start.left + 1, start.left + 3, end.left - 3, end.left, end.left + 1, end.left + 30]
      .map((x) => ({ x, y }));
  }, n);
}

test.describe('Live preview: the cursor and hidden CriticMarkup syntax', () => {
  test.beforeEach(async ({ page }) => {
    pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.setViewportSize({ width: 900, height: 900 });
    await page.goto('/e2e/fixtures/criticmarkup-cursor.html');
    await expect(page.locator('.cm-content > .cm-line')).toHaveCount(LINES);
    await page.evaluate(() => document.fonts.ready);
  });

  test.afterEach(() => {
    expect(pageErrors).toEqual([]);
  });

  test('Home goes to the start of a line that opens with a suggestion, every time', async ({ page }) => {
    for (const n of OPENS_WITH_SUGGESTION) {
      // CodeMirror breaks ties between same-x positions at random: repeat
      for (let i = 0; i < 8; i++) {
        await place(page, n, -1);
        await page.keyboard.press('Home');
        expect(await cursor(page), `line ${n}, try ${i + 1}`).toMatchObject({ line: n, col: 0 });
      }
    }
  });

  test('End goes to the end of a line that ends with a suggestion', async ({ page }) => {
    for (const n of ENDS_WITH_SUGGESTION) {
      for (let i = 0; i < 4; i++) {
        await place(page, n, 0);
        await page.keyboard.press('End');
        expect(await cursor(page), `line ${n}`).toMatchObject({ line: n, col: await lineLength(page, n) });
      }
    }
  });

  test('Home and End on the rows of a wrapped line stop outside hidden syntax', async ({ page }) => {
    const length = await lineLength(page, WRAPPED);
    for (let col = 0; col <= length; col += 7) {
      for (const key of ['Home', 'End']) {
        await place(page, WRAPPED, col);
        if ((await cursor(page)).hidden) continue; // only from where a cursor can be
        await page.keyboard.press(key);
        const at = await cursor(page);
        expect(at, `${key} from column ${col}`).toMatchObject({ line: WRAPPED, hidden: false });
      }
    }
  });

  test('Home and End stay on their row beside a comment written over two lines', async ({ page }) => {
    // Its first line ends, and its second starts, inside the hidden comment
    const first = await lineText(page, TWO_LINE_COMMENT);
    await place(page, TWO_LINE_COMMENT, 0);
    await page.keyboard.press('End');
    expect(await cursor(page)).toMatchObject({ line: TWO_LINE_COMMENT, col: first.indexOf('{>>') });
    const second = await lineText(page, TWO_LINE_COMMENT + 1);
    await place(page, TWO_LINE_COMMENT + 1, -1);
    await page.keyboard.press('Home');
    expect(await cursor(page)).toMatchObject({ line: TWO_LINE_COMMENT + 1, col: second.indexOf('<<}') + 3 });
  });

  test('ArrowRight and ArrowLeft cross a delimiter, with its metadata, in one press', async ({ page }) => {
    // {++An added line++}: content 3-16
    await place(page, 2, 0);
    let steps = await walk(page, 'ArrowRight', 15);
    expect(steps.map((s) => s.col)).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 19]);
    steps = await walk(page, 'ArrowLeft', 15);
    expect(steps.map((s) => s.col)).toEqual([16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 0]);

    // 46 characters of metadata before "An added line with metadata"
    const text = await lineText(page, 3);
    await place(page, 3, 0);
    expect((await walk(page, 'ArrowRight', 1))[0].col).toBe(text.indexOf('An added'));
  });

  test('ArrowRight and ArrowLeft cross a comment badge in one press', async ({ page }) => {
    const text = await lineText(page, 6);
    const beforeBadge = text.indexOf('==}'); // end of "Highlighted text"
    const afterBadge = text.indexOf('<<}') + 3;
    await place(page, 6, beforeBadge);
    expect((await walk(page, 'ArrowRight', 1))[0].col).toBe(afterBadge);
    expect((await walk(page, 'ArrowLeft', 1))[0].col).toBe(beforeBadge);
  });

  for (let n = 2; n <= LINES; n++) {
    test(`no ArrowRight or ArrowLeft stop on line ${n} is inside hidden syntax`, async ({ page }) => {
      await place(page, n, 0);
      const right = await walkLine(page, 'ArrowRight');
      await place(page, n, -1);
      const left = await walkLine(page, 'ArrowLeft');
      expect([...right, ...left].filter((s) => s.hidden).map((s) => s.col)).toEqual([]);
    });
  }

  test('ArrowDown and ArrowUp onto suggestion lines stop outside hidden syntax', async ({ page }) => {
    for (const col of [0, 2, 5, 12]) {
      await place(page, 1, col);
      const down = await walk(page, 'ArrowDown', LINES - 1);
      await place(page, LINES, col);
      const up = await walk(page, 'ArrowUp', LINES - 1);
      expect([...down, ...up].filter((s) => s.hidden).map((s) => `${s.line}:${s.col}`), `column ${col}`).toEqual([]);
    }
  });

  test('clicks around the start and end of suggestion lines land outside hidden syntax', async ({ page }) => {
    for (let n = 2; n <= 9; n++) {
      for (const point of await pointsOnLine(page, n)) {
        for (let i = 0; i < 3; i++) {
          await place(page, 1, 0);
          await page.mouse.click(point.x, point.y);
          const at = await cursor(page);
          expect(at, `line ${n} at x ${point.x.toFixed(1)}`).toMatchObject({ line: n, hidden: false });
        }
      }
    }
  });

  test('typing after Home or End leaves the suggestion intact', async ({ page }) => {
    await place(page, 2, -1);
    await page.keyboard.press('Home');
    await page.keyboard.type('Z');
    expect(await lineText(page, 2)).toBe('Z{++An added line++}');

    await page.keyboard.press('End');
    await page.keyboard.type('Y');
    expect(await lineText(page, 2)).toBe('Z{++An added line++}Y');

    await place(page, 3, -1);
    await page.keyboard.press('Home');
    await page.keyboard.type('X');
    expect(await lineText(page, 3)).toMatch(/^X\{\+\+\{"author":"Elias",.*\}@@An added line with metadata\+\+\}$/);
  });

  test('in suggestion mode, typing after Home or End adds a suggestion beside the other', async ({ page }) => {
    await page.evaluate(() => (window as unknown as FixtureWindow).setSuggestionMode(true));
    await place(page, 2, -1);
    await page.keyboard.press('Home');
    await page.keyboard.type('Z');
    expect(await lineText(page, 2)).toMatch(new RegExp(`^\\{\\+\\+${MARK}Z\\+\\+\\}\\{\\+\\+An added line\\+\\+\\}$`));

    await place(page, 4, 0);
    await page.keyboard.press('End');
    await page.keyboard.type('Y');
    expect(await lineText(page, 4)).toMatch(new RegExp(`^\\{--A deleted line--\\}\\{\\+\\+${MARK}Y\\+\\+\\}$`));
  });

  test('Backspace and Delete next to a suggestion delete the character you see, not the markup', async ({ page }) => {
    await place(page, 2, 0);
    await page.keyboard.press('End');
    await page.keyboard.press('Backspace');
    expect(await lineText(page, 2)).toBe('{++An added lin++}');
    await page.keyboard.press('Home');
    await page.keyboard.press('Delete');
    expect(await lineText(page, 2)).toBe('{++n added lin++}');

    // Line 8: "Plain text {++inserted++} in the middle."
    await place(page, 8, '{++inserted++}'.length + 'Plain text '.length);
    await page.keyboard.press('Backspace');
    expect(await lineText(page, 8)).toBe('Plain text {++inserte++} in the middle.');
    await place(page, 8, 'Plain text {++'.length);
    await page.keyboard.press('Backspace');
    expect(await lineText(page, 8)).toBe('Plain text{++inserte++} in the middle.');
  });

  test('Backspace after a comment badge deletes the character before it and keeps the comment', async ({ page }) => {
    const text = await lineText(page, 6);
    await place(page, 6, text.indexOf('<<}') + 3);
    await page.keyboard.press('Backspace');
    expect(await lineText(page, 6)).toBe(text.replace('Highlighted text==}', 'Highlighted tex==}'));
  });

  test('in suggestion mode, Backspace after your own addition takes the character off it', async ({ page }) => {
    await page.evaluate(() => (window as unknown as FixtureWindow).setSuggestionMode(true));
    await place(page, LINES, -1);
    await page.keyboard.type(' More');
    const own = await lineText(page, LINES);
    expect(own).toMatch(new RegExp(`^Last line\\.\\{\\+\\+${MARK} More\\+\\+\\}$`));
    await page.keyboard.press('Home');
    await page.keyboard.press('End');
    await page.keyboard.press('Backspace');
    expect(await lineText(page, LINES)).toBe(own.replace(' More++}', ' Mor++}'));
  });

  test('the accept button accepts its own suggestion, also in a deletion+addition pair', async ({ page }) => {
    // Line 8: click into "inserted", then on its ✓
    const inserted = await page.evaluate(() => {
      const { view } = window as unknown as FixtureWindow;
      const line = view.state.doc.line(8);
      const c = view.coordsAtPos(line.from + 'Plain text {++ins'.length)!;
      return { x: c.left, y: (c.top + c.bottom) / 2 };
    });
    await page.mouse.click(inserted.x, inserted.y);
    await page.locator('.cm-criticmarkup-accept').first().click();
    expect(await lineText(page, 8)).toBe('Plain text inserted in the middle.');

    // Line 9: one ✓ for the pair
    const pair = await page.evaluate(() => {
      const { view } = window as unknown as FixtureWindow;
      const line = view.state.doc.line(9);
      const c = view.coordsAtPos(line.from + line.text.indexOf('new words') + 2)!;
      return { x: c.left, y: (c.top + c.bottom) / 2 };
    });
    await page.mouse.click(pair.x, pair.y);
    await expect(page.locator('.cm-criticmarkup-accept')).toHaveCount(1);
    await page.locator('.cm-criticmarkup-accept').click();
    expect(await lineText(page, 9)).toBe('A pair: new words replaces text.');
  });

  test('source mode shows the syntax, and the cursor goes inside it', async ({ page }) => {
    await page.evaluate(() => (window as unknown as FixtureWindow).setSourceMode(true));
    await place(page, 2, 0);
    expect((await walk(page, 'ArrowRight', 1))[0].col).toBe(1);
    await place(page, 2, -1);
    await page.keyboard.press('Backspace');
    expect(await lineText(page, 2)).toBe('{++An added line++');
  });
});
