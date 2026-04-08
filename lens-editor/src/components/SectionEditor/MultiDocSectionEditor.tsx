import { useEffect, useRef, useState, useCallback } from 'react';
import { EditorView } from 'codemirror';
import { keymap, drawSelection } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { defaultKeymap } from '@codemirror/commands';
import { indentUnit, syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { parseSections } from './parseSections';
import { ySectionSync, ySectionUndoManagerKeymap } from './y-section-sync';
import { remoteCursorTheme } from '../Editor/remoteCursorTheme';
import { SectionCard, getDocColor } from './SectionCard';
import { useMultiDocSections } from './useMultiDocSections';

interface MultiDocSectionEditorProps {
  compoundDocIds: string[];
  docLabels?: string[];
  onOpenInEditor?: (docUuid: string) => void;
}

export function MultiDocSectionEditor({ compoundDocIds, docLabels }: MultiDocSectionEditorProps) {
  const mountRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const { sections, synced, docStates } = useMultiDocSections(compoundDocIds);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);

  // Snapshot the section info when user clicks — so the CM creation effect
  // doesn't depend on `sections` (which changes on every Y.Text edit).
  const activeSectionRef = useRef<{ compoundDocId: string; from: number; to: number } | null>(null);

  const activate = useCallback((i: number) => {
    const section = sections[i];
    if (section) {
      activeSectionRef.current = {
        compoundDocId: section.compoundDocId,
        from: section.from,
        to: section.to,
      };
    }
    setActiveIndex(i);
  }, [sections]);

  // Create/destroy CM when activeIndex changes
  // Does NOT depend on `sections` — uses activeSectionRef snapshot instead
  useEffect(() => {
    if (viewRef.current) {
      viewRef.current.destroy();
      viewRef.current = null;
    }
    if (activeIndex === null || !mountRef.current || !activeSectionRef.current) return;

    const { compoundDocId, from, to } = activeSectionRef.current;
    const state = docStates.get(compoundDocId);
    if (!state) return;

    const { ytext, awareness } = state;

    // Re-parse to get fresh offsets
    const freshSections = parseSections(ytext.toString());
    const freshSection = freshSections.find(s => s.from === from && s.to === to);
    if (!freshSection) return;

    // Trim trailing newlines so CM doesn't show an empty editable line
    const fullText = ytext.toString();
    let editTo = freshSection.to;
    while (editTo > freshSection.from && fullText[editTo - 1] === '\n') {
      editTo--;
    }
    const sectionText = fullText.slice(freshSection.from, editTo);

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
          ySectionSync(ytext, freshSection.from, editTo, { awareness }),
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
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeIndex]);

  const deactivate = useCallback(() => setActiveIndex(null), []);

  return (
    <div className="max-w-2xl mx-auto py-6 px-4">
      {!synced ? (
        <div className="flex items-center justify-center h-64 text-gray-400 text-sm">
          Connecting to documents...
        </div>
      ) : (<>
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-lg font-semibold text-gray-800">Section Editor</h2>
          <div className="flex items-center gap-2">
            {compoundDocIds.map((id, i) => {
              const color = getDocColor(i);
              const label = docLabels?.[i] ?? `Doc ${i + 1}`;
              return (
                <span key={id} className={`text-xs px-2 py-1 rounded ${color.bg} ${color.text}`}>
                  {label}
                </span>
              );
            })}
          </div>
        </div>

        <div className="space-y-3">
          {sections.map((section, i) => (
            <div key={`${section.compoundDocId}-${section.docIndex}-${i}`}>
              {activeIndex === i ? (
                <div className="rounded-lg border-2 border-blue-400 bg-white overflow-hidden">
                  <div className="flex items-center justify-between px-4 py-2 bg-blue-50 border-b border-blue-200">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-sm text-blue-700">{section.label}</span>
                      {(() => {
                        const color = getDocColor(section.docIndex);
                        const label = docLabels?.[section.docIndex] ?? `Doc ${section.docIndex + 1}`;
                        return (
                          <span className={`text-xs px-1.5 py-0.5 rounded ${color.bg} ${color.text}`}>
                            {label}
                          </span>
                        );
                      })()}
                    </div>
                    <button onClick={deactivate}
                      className="text-xs px-2 py-1 bg-blue-100 hover:bg-blue-200 text-blue-600 rounded">
                      Done
                    </button>
                  </div>
                  <div ref={mountRef} style={{ minHeight: '60px' }} />
                </div>
              ) : (
                <SectionCard
                  section={section}
                  onClick={() => activate(i)}
                  docLabel={docLabels?.[section.docIndex] ?? `Doc ${section.docIndex + 1}`}
                  docIndex={section.docIndex}
                />
              )}
            </div>
          ))}
        </div>
      </>)}
    </div>
  );
}
