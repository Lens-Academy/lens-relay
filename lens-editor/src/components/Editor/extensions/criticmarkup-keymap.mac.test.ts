// src/components/Editor/extensions/criticmarkup-keymap.mac.test.ts
import { describe, it, expect, vi } from 'vitest';

// CodeMirror reads the platform when it loads: make this file's copy a Mac's,
// where Mod is Cmd and defaultKeymap binds Cmd-Backspace to
// deleteLineBoundaryBackward (and word deletion to Alt-Backspace)
vi.hoisted(() => {
  Object.defineProperty(navigator, 'platform', { value: 'MacIntel', configurable: true });
});

const { EditorState } = await import('@codemirror/state');
const { EditorView, keymap, runScopeHandlers } = await import('@codemirror/view');
const { defaultKeymap } = await import('@codemirror/commands');
const { markdown } = await import('@codemirror/lang-markdown');
const { criticMarkupExtension } = await import('./criticmarkup');

/** defaultKeymap ahead of criticMarkupExtension, as in Editor.tsx */
function editor(doc: string, cursor: number) {
  return new EditorView({
    parent: document.body,
    state: EditorState.create({
      doc,
      selection: { anchor: cursor },
      extensions: [keymap.of(defaultKeymap), markdown(), criticMarkupExtension()],
    }),
  });
}

function press(view: InstanceType<typeof EditorView>, key: string, mods: { metaKey?: boolean; altKey?: boolean; ctrlKey?: boolean }) {
  runScopeHandlers(view, new KeyboardEvent('keydown', { key, ...mods, bubbles: true, cancelable: true }), 'editor');
  const text = view.state.doc.toString();
  view.destroy();
  return text;
}

describe('the accept/reject keys on a Mac', () => {
  it('Cmd+Enter accepts and Cmd+Backspace rejects the suggestion at the cursor', () => {
    expect(press(editor('hello {++world++} end', 10), 'Enter', { metaKey: true })).toBe('hello world end');
    expect(press(editor('hello {++world++} end', 10), 'Backspace', { metaKey: true })).toBe('hello  end');
  });

  it('away from suggestions, Cmd+Backspace deletes to the line start and Alt+Backspace a word', () => {
    expect(press(editor('hello world {++x++}', 11), 'Backspace', { metaKey: true })).toBe(' {++x++}');
    expect(press(editor('hello world {++x++}', 11), 'Backspace', { altKey: true })).toBe('hello  {++x++}');
  });

  it('Ctrl+Enter is not the shortcut there', () => {
    expect(press(editor('hello {++world++} end', 10), 'Enter', { ctrlKey: true })).toBe('hello {++world++} end');
  });
});
