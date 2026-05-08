import { ViewPlugin, ViewUpdate, EditorView, Decoration, WidgetType } from '@codemirror/view';
import type { DecorationSet } from '@codemirror/view';
import type { Extension } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import { RangeSetBuilder } from '@codemirror/state';

const COPY_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>`;
const CHECK_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>`;

class CopyButtonWidget extends WidgetType {
  constructor(private readonly codeText: string) {
    super();
  }

  eq(other: CopyButtonWidget): boolean {
    return other.codeText === this.codeText;
  }

  toDOM(): HTMLElement {
    const btn = document.createElement('button');
    btn.className = 'cm-code-copy-btn';
    btn.setAttribute('aria-label', 'Copy code');
    btn.innerHTML = COPY_ICON;

    // Prevent mousedown from repositioning the editor cursor, which would flip
    // the code block into edit mode and reveal the hidden fence markers.
    btn.onmousedown = (e) => e.preventDefault();
    btn.onclick = async (e) => {
      e.preventDefault();
      e.stopPropagation();
      try {
        await navigator.clipboard.writeText(this.codeText);
        btn.innerHTML = CHECK_ICON;
        setTimeout(() => { btn.innerHTML = COPY_ICON; }, 2000);
      } catch {
        // Clipboard API unavailable (e.g. insecure context)
      }
    };
    return btn;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

const copyButtonPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = this.build(view);
    }

    update(update: ViewUpdate) {
      if (update.docChanged || update.selectionSet || update.viewportChanged) {
        this.decorations = this.build(update.view);
      }
    }

    build(view: EditorView): DecorationSet {
      const builder = new RangeSetBuilder<Decoration>();
      const { selection } = view.state;
      const widgets: Array<{ from: number; deco: Decoration }> = [];

      syntaxTree(view.state).iterate({
        from: view.viewport.from,
        to: view.viewport.to,
        enter(node) {
          if (node.name !== 'FencedCode') return;

          // Hide the copy button when the cursor is inside the block so the
          // user can see and edit the raw fence syntax unobstructed.
          const cursorInside = selection.ranges.some(
            r => r.to >= node.from && r.from <= node.to,
          );
          if (cursorInside) return false;

          const openLine = view.state.doc.lineAt(node.from);

          // Extract text from the CodeText child, trimming any trailing newline
          // so the clipboard content doesn't have a spurious blank line.
          let codeText = '';
          for (let child = node.node.firstChild; child; child = child.nextSibling) {
            if (child.name === 'CodeText') {
              codeText = view.state.sliceDoc(child.from, child.to).trimEnd();
              break;
            }
          }

          // Place the widget at the end of the opening fence line. The fence
          // text is hidden (font-size:0 via cm-hidden-syntax), so this button
          // is the only visible element in that row. position:absolute (declared
          // in copyButtonTheme) pins it to the top-right of the line box.
          widgets.push({
            from: openLine.to,
            deco: Decoration.widget({ widget: new CopyButtonWidget(codeText), side: 1 }),
          });

          return false;
        },
      });

      widgets.sort((a, b) => a.from - b.from);
      for (const { from, deco } of widgets) {
        builder.add(from, from, deco);
      }
      return builder.finish();
    }
  },
  { decorations: (v) => v.decorations },
);

const copyButtonTheme = EditorView.theme({
  // position:relative makes each code-block line a containing block so the
  // absolutely-positioned copy button anchors to the opening fence row.
  '.cm-code-block': {
    position: 'relative',
  },
  '.cm-code-copy-btn': {
    position: 'absolute',
    right: '6px',
    top: '6px',
    zIndex: '1',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '3px',
    background: 'transparent',
    border: '1px solid transparent',
    borderRadius: '4px',
    cursor: 'pointer',
    color: '#9ca3af',
    lineHeight: '1',
    transition: 'color 0.1s, background 0.1s, border-color 0.1s',
  },
  '.cm-code-copy-btn:hover': {
    color: '#4b5563',
    background: '#e5e7eb',
    borderColor: '#d1d5db',
  },
});

export function codeBlockCopyButton(): Extension {
  return [copyButtonPlugin, copyButtonTheme];
}
