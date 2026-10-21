import { describe, it, expect, vi, afterEach } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { codeBlockCopyButton } from './codeBlockCopyButton';

let view: EditorView | undefined;

afterEach(() => {
  view?.destroy();
  view = undefined;
  vi.restoreAllMocks();
});

/** What a click on the copy button of the code block in `block` writes to the clipboard */
function copiedFrom(block: string): string {
  // The button shows only while the cursor is outside the block
  view = new EditorView({
    parent: document.body,
    state: EditorState.create({
      doc: `Intro.\n${block}`,
      selection: { anchor: 0 },
      extensions: [markdown({ base: markdownLanguage }), codeBlockCopyButton()],
    }),
  });
  const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
  const buttons = view.contentDOM.querySelectorAll<HTMLButtonElement>('.cm-code-copy-btn');
  expect(buttons).toHaveLength(1);
  buttons[0].click();
  expect(writeText).toHaveBeenCalledTimes(1);
  return writeText.mock.calls[0][0];
}

describe('Code block copy button', () => {
  // In a quote or a list item, Lezer starts a new CodeText on every line of
  // code, and the button copied only the first
  it.each([
    ['at the top level', '```js\none();\ntwo();\n```', 'one();\ntwo();'],
    ['in a list item', '- Install:\n  ```bash\n  npm ci\n  npm test\n  ```', 'npm ci\nnpm test'],
    ['in a quote', '> ```js\n> one();\n> two();\n> ```', 'one();\ntwo();'],
    ['in a quote, with a line that is only >', '> ```js\n> one();\n>\n> two();\n> ```', 'one();\n\ntwo();'],
    ['in a list item, with an indented blank line', '- Install:\n  ```bash\n  npm ci\n  \n  npm test\n  ```', 'npm ci\n\nnpm test'],
    ['in a list item, with an empty line', '- Install:\n  ```bash\n  npm ci\n\n  npm test\n  ```', 'npm ci\n\nnpm test'],
    ['in a list item, indented inside the code', '- Define:\n  ```python\n  def f():\n      return 1\n  ```', 'def f():\n    return 1'],
    ['with ~~~ fences, in a quote', '> ~~~python\n> a = 1\n> b = 2\n> ~~~', 'a = 1\nb = 2'],
    ['in a list item in a quote', '> - Run:\n>   ```sh\n>   ls\n>   pwd\n>   ```', 'ls\npwd'],
    ['in a quote in a quote', '> > ```\n> > a\n> > b\n> > ```', 'a\nb'],
  ])('copies every line of a code block %s', (_, block, code) => {
    expect(copiedFrom(block)).toBe(code);
  });

  // With no closing fence, a code block runs to the end of its quote or list
  // item, or of the note
  it.each([
    ['its quote', '> ```js\n> one();\n> two();\n\nAfter.', 'one();\ntwo();'],
    ['its list item', '- Install:\n  ```bash\n  npm ci\n  npm test\nAfter.', 'npm ci\nnpm test'],
    ['the note, in a quote', '> ```js\n> one();\n> two();', 'one();\ntwo();'],
    ['the note, in a list item', '- Install:\n  ```bash\n  npm ci\n  npm test\n', 'npm ci\nnpm test'],
  ])('copies every line of a code block left open, up to the end of %s', (_, block, code) => {
    expect(copiedFrom(block)).toBe(code);
  });

  it.each([
    ['at the top level', '```js\nlet a = 1;\n\n```', 'let a = 1;'],
    ['in a list item', '- Install:\n  ```bash\n  npm ci\n  npm test\n\n  ```', 'npm ci\nnpm test'],
    ['in a quote', '> ```js\n> one();\n> two();\n>\n> ```', 'one();\ntwo();'],
  ])('leaves out blank lines at the end of a code block %s', (_, block, code) => {
    expect(copiedFrom(block)).toBe(code);
  });
});
