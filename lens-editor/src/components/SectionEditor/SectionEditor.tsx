import { useEffect, useState } from 'react';
import { useYDoc, useYjsProvider } from '@y-sweet/react';
import { parseSections, type Section } from './parseSections';
import { SectionCard } from './SectionCard';
import { useSectionEditor } from '../../hooks/useSectionEditor';

interface SectionEditorProps {
  onOpenInEditor?: () => void;
}

export function SectionEditor({ onOpenInEditor }: SectionEditorProps) {
  const ydoc = useYDoc();
  const provider = useYjsProvider();

  const [synced, setSynced] = useState(false);
  const [sections, setSections] = useState<Section[]>([]);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);

  const activeSection = activeIndex !== null
    ? parseSections(ydoc.getText('contents').toString())[activeIndex] ?? null
    : null;

  const { mountRef } = useSectionEditor({
    ytext: ydoc.getText('contents'),
    sectionFrom: activeSection?.from ?? 0,
    sectionTo: activeSection?.to ?? 0,
    active: activeIndex !== null,
    awareness: provider.awareness,
  });

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
                    <button onClick={() => setActiveIndex(null)}
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
