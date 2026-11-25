import { describe, it, expect } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { markdown } from '@codemirror/lang-markdown';
import { forceParsing, syntaxTreeAvailable } from '@codemirror/language';
import { codeBlockCopyButton } from './codeBlockCopyButton';

describe('codeBlockCopyButton', () => {
  it('adds the button to a code block the parser reaches after load, without a click or keystroke', () => {
    // Long enough that the initial parse stops well before the code block
    const prose = 'Ordinary prose that makes the document long. '.repeat(40);
    const content = Array.from({ length: 2000 }, () => prose).join('\n\n') + '\n\n```\ncode\n```';
    const view = new EditorView({
      state: EditorState.create({ doc: content, extensions: [markdown(), codeBlockCopyButton()] }),
      parent: document.body,
    });
    try {
      view.dispatch({ effects: EditorView.scrollIntoView(content.length) });
      expect(syntaxTreeAvailable(view.state, content.length)).toBe(false);
      expect(view.contentDOM.querySelectorAll('.cm-code-copy-btn').length).toBe(0);

      forceParsing(view, content.length, 10_000);

      expect(view.contentDOM.querySelectorAll('.cm-code-copy-btn').length).toBe(1);
    } finally {
      view.destroy();
    }
  });
});
