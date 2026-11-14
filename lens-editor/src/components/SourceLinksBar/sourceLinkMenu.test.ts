import { commonmarkLanguage, markdown } from '@codemirror/lang-markdown';
import { ensureSyntaxTree } from '@codemirror/language';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { lensMarkdownExtensions } from '../Editor/extensions/wikilinkTable';
import { externalLinkAt, sourceLinkMenuItem } from './sourceLinkMenu';

const URL_A = 'https://example.com/a';

/** A state with the main editor's Markdown, parsed. */
function stateOf(doc: string): EditorState {
  const state = EditorState.create({
    doc,
    extensions: [markdown({ base: commonmarkLanguage, extensions: lensMarkdownExtensions, addKeymap: false })],
  });
  ensureSyntaxTree(state, doc.length, 1000);
  return state;
}

/** The URL found at `needle` in `doc`. */
function at(doc: string, needle: string): string | null {
  return externalLinkAt(stateOf(doc), doc.indexOf(needle));
}

describe('externalLinkAt', () => {
  it('finds an inline link from its label', () => {
    expect(at(`Read [the post](${URL_A}) now`, 'post')).toBe(URL_A);
  });

  it('finds it from its URL', () => {
    expect(at(`Read [the post](${URL_A}) now`, 'example')).toBe(URL_A);
  });

  it('finds an autolink and a bare URL', () => {
    expect(at(`Read <${URL_A}> now`, 'example')).toBe(URL_A);
    expect(at(`Read ${URL_A} now`, 'example')).toBe(URL_A);
  });

  it('counts either edge of a link, where a click on a rendered link lands', () => {
    const doc = `Read [the post](${URL_A}) now`;
    const from = doc.indexOf('[');
    const to = doc.indexOf(')') + 1;
    expect(externalLinkAt(stateOf(doc), from)).toBe(URL_A);
    expect(externalLinkAt(stateOf(doc), to)).toBe(URL_A);
  });

  it('gives the spelling the scanner gives, without trailing punctuation', () => {
    expect(at(`Read ${URL_A}, then stop.`, 'example')).toBe(URL_A);
  });

  it('finds the right link of two', () => {
    const doc = `[one](${URL_A}) and [two](https://example.com/b)`;
    expect(at(doc, 'two')).toBe('https://example.com/b');
  });

  it('finds a link in a table', () => {
    expect(at(`| Name |\n|---|\n| [the post](${URL_A}) |\n`, 'post')).toBe(URL_A);
  });

  it('leaves a link that cannot become a wikilink', () => {
    expect(at(`[![alt](https://example.com/i.png)](${URL_A})`, 'i.png')).toBeNull();
  });

  it.each([
    ['plain text', `Read the post. ${URL_A}`, 'Read'],
    ['an image', '![alt](https://example.com/i.png)', 'i.png'],
    ['a wikilink', 'See [[Some page]] here', 'Some'],
    ['inline code', `Run \`${URL_A}\` now`, 'example'],
    ['a code block', `\`\`\`\n${URL_A}\n\`\`\`\n`, 'example'],
    ['a reference definition', `[id]: ${URL_A}\n`, 'example'],
    ['a pending suggestion', `{++[the post](${URL_A})++}`, 'post'],
    ['a pending deletion', `{--[the post](${URL_A})--}`, 'post'],
    ['frontmatter', `---\nlink: ${URL_A}\n---\n\nBody`, 'example'],
    ['a relative link', '[the post](./a.md)', 'post'],
    ['a mailto link', '[write](mailto:a@example.com)', 'write'],
  ])('finds nothing in %s', (_name, doc, needle) => {
    expect(at(doc, needle)).toBeNull();
  });
});

describe('sourceLinkMenuItem', () => {
  let view: EditorView | null = null;

  afterEach(() => {
    view?.destroy();
    view = null;
  });

  function viewOf(doc: string) {
    view = new EditorView({ state: stateOf(doc), parent: document.body });
    return view;
  }

  const doc = `Read [the post](${URL_A}) now`;
  const onLink = doc.indexOf('post');
  const target = (canImport = true) => ({ canImport: vi.fn(() => canImport), importSource: vi.fn() });

  it('offers "Import and link this source" on a link', () => {
    const page = target();
    const item = sourceLinkMenuItem(viewOf(doc), onLink, page);
    expect(item?.label).toBe('Import and link this source');
    expect(page.canImport).toHaveBeenCalledWith(URL_A);
  });

  it('imports the link and gives the keyboard back to the page', () => {
    const page = target();
    const editor = viewOf(doc);
    const focus = vi.spyOn(editor, 'focus');
    sourceLinkMenuItem(editor, onLink, page)?.action();
    expect(page.importSource).toHaveBeenCalledWith(URL_A);
    expect(focus).toHaveBeenCalled();
  });

  it('is not offered when the bar says this page or link cannot have it', () => {
    expect(sourceLinkMenuItem(viewOf(doc), onLink, target(false))).toBeNull();
  });

  it('is not offered off a link', () => {
    expect(sourceLinkMenuItem(viewOf(doc), 1, target())).toBeNull();
  });

  it('is not offered with no bar, as in other editors', () => {
    expect(sourceLinkMenuItem(viewOf(doc), onLink, null)).toBeNull();
  });
});
