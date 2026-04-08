import { useEffect, useRef, useState, useCallback } from 'react';
import { EditorView } from 'codemirror';
import { keymap, drawSelection } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { defaultKeymap } from '@codemirror/commands';
import { indentUnit, syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { useYDoc, useYjsProvider } from '@y-sweet/react';
import { parseSections, type Section } from './parseSections';
import { ySectionSync, ySectionUndoManagerKeymap } from './y-section-sync';

interface SectionEditorProps {
  onOpenInEditor?: () => void;
}

function SectionCard({ section, onClick }: { section: Section; onClick: () => void }) {
  const colors: Record<string, string> = {
    frontmatter: 'bg-gray-50 border-gray-200',
    video: 'bg-purple-50 border-purple-200',
    text: 'bg-blue-50 border-blue-200',
    chat: 'bg-green-50 border-green-200',
    'lens-ref': 'bg-indigo-50 border-indigo-200',
    'test-ref': 'bg-amber-50 border-amber-200',
    'lo-ref': 'bg-rose-50 border-rose-200',
  };
  const lines = section.content.split('\n');
  const body = (section.type === 'frontmatter' ? lines.slice(1, -2) : lines.slice(1))
    .join('\n').trim();

  return (
    <div
      className={`rounded-lg border ${colors[section.type] || 'bg-white border-gray-200'} cursor-pointer hover:ring-1 hover:ring-blue-300 transition-all`}
      onClick={onClick}
    >
      <div className="flex items-center gap-2 px-4 py-2 border-b border-inherit">
        <span className="font-medium text-sm text-gray-700">{section.label}</span>
        <span className="text-xs text-gray-400 ml-auto">click to edit</span>
      </div>
      <div className="px-4 py-3 text-xs text-gray-500 whitespace-pre-wrap max-h-40 overflow-hidden">
        {body ? (body.length > 300 ? body.slice(0, 300) + '...' : body) : <em className="text-gray-400">Empty</em>}
      </div>
    </div>
  );
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

    const sectionText = ytext.toString().slice(section.from, section.to);

    const view = new EditorView({
      state: EditorState.create({
        doc: sectionText,
        extensions: [
          indentUnit.of('\t'),
          EditorState.tabSize.of(4),
          drawSelection(),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          keymap.of(defaultKeymap),
          ySectionUndoManagerKeymap,
          markdown({ base: markdownLanguage, addKeymap: false }),
          ySectionSync(ytext, section.from, section.to),
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
