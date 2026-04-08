import { useEffect, useRef, useState, useCallback } from 'react';
import { EditorView } from 'codemirror';
import { keymap, drawSelection } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { defaultKeymap } from '@codemirror/commands';
import { indentUnit, syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { useYDoc, useYjsProvider } from '@y-sweet/react';
import { parseSections } from './parseSections';
import { ySectionSync, ySectionUndoManagerKeymap } from './y-section-sync';
import { remoteCursorTheme } from '../Editor/remoteCursorTheme';
import { SectionCard } from './SectionCard';

interface SectionEditorProps {
  onOpenInEditor?: () => void;
}

export function SectionEditor({ onOpenInEditor }: SectionEditorProps) {
  const mountRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const ydoc = useYDoc();
  const provider = useYjsProvider();

  const [synced, setSynced] = useState(false);
  const [sections, setSections] = useState<Section[]>([]);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);

  // Sync detection
  useEffect(() => {
    if ((provider as any).synced) { setSynced(true); return; }
    const onSync = () => setSynced(true);
    provider.on('synced', onSync);
    const ytext = ydoc.getText('contents');
    const poll = setInterval(() => {
      if (ytext.length > 0) { setSynced(true); clearInterval(poll); }
    }, 200);
    return () => { provider.off('synced', onSync); clearInterval(poll); };
  }, [provider, ydoc]);

  // Observe Y.Text to keep section list in sync
  useEffect(() => {
    if (!synced) return;
    const ytext = ydoc.getText('contents');
    const update = () => setSections(parseSections(ytext.toString()));
    update();
    ytext.observe(update);
    return () => ytext.unobserve(update);
  }, [ydoc, synced]);

  // Create/destroy CM when activeIndex changes
  useEffect(() => {
    // Destroy previous view
    if (viewRef.current) {
      viewRef.current.destroy();
      viewRef.current = null;
    }

    if (activeIndex === null || !mountRef.current) return;

    const ytext = ydoc.getText('contents');
    const currentSections = parseSections(ytext.toString());
    const section = currentSections[activeIndex];
    if (!section) return;

    // Trim trailing newlines so CM doesn't show an empty editable line
    // that would allow typing at the start of the next section's header
    const fullText = ytext.toString();
    let editTo = section.to;
    while (editTo > section.from && fullText[editTo - 1] === '\n') {
      editTo--;
    }
    const sectionText = fullText.slice(section.from, editTo);

    const view = new EditorView({
      state: EditorState.create({
        doc: sectionText,
        extensions: [
          indentUnit.of('\t'),
          EditorState.tabSize.of(4),
          drawSelection(),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          ySectionUndoManagerKeymap,
          keymap.of(defaultKeymap),
          markdown({ base: markdownLanguage, addKeymap: false }),
          ySectionSync(ytext, section.from, editTo, { awareness: provider.awareness }),
          remoteCursorTheme,
          EditorView.lineWrapping,
          EditorView.theme({
            '&': { fontSize: '14px', outline: 'none' },
            '&.cm-focused': { outline: 'none' },
            '.cm-scroller': {
              fontFamily: '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
            },
            '.cm-content': { padding: '12px 16px' },
            '.cm-gutters': { display: 'none' },
          }),
        ],
      }),
      parent: mountRef.current,
    });

    viewRef.current = view;
    requestAnimationFrame(() => view.focus());

    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [activeIndex, ydoc]);

  const deactivate = useCallback(() => setActiveIndex(null), []);

  return (
    <div className="max-w-2xl mx-auto py-6 px-4">
      {!synced ? (
        <div className="flex items-center justify-center h-64 text-gray-400 text-sm">
          Connecting to document...
        </div>
      ) : (<>
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-lg font-semibold text-gray-800">Section Editor</h2>
          {onOpenInEditor && (
            <button onClick={onOpenInEditor}
              className="text-xs px-3 py-1.5 bg-blue-50 hover:bg-blue-100 text-blue-600 rounded">
              Open in full editor
            </button>
          )}
        </div>

        <div className="space-y-3">
          {sections.map((section, i) => (
            <div key={i}>
              {activeIndex === i ? (
                <div className="rounded-lg border-2 border-blue-400 bg-white overflow-hidden">
                  <div className="flex items-center justify-between px-4 py-2 bg-blue-50 border-b border-blue-200">
                    <span className="font-medium text-sm text-blue-700">{section.label}</span>
                    <button onClick={deactivate}
                      className="text-xs px-2 py-1 bg-blue-100 hover:bg-blue-200 text-blue-600 rounded">
                      Done
                    </button>
                  </div>
                  <div ref={mountRef} style={{ minHeight: '60px' }} />
                </div>
              ) : (
                <SectionCard section={section} onClick={() => setActiveIndex(i)} />
              )}
            </div>
          ))}
        </div>
      </>)}
    </div>
  );
}
