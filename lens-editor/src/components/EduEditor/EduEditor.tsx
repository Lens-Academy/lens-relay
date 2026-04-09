import { useEffect, useState, useCallback } from 'react';
import { useDocConnection } from '../../hooks/useDocConnection';
import { parseSections } from '../SectionEditor/parseSections';
import type { Section } from '../SectionEditor/parseSections';
import { ModulePanel } from './ModulePanel';

interface EduEditorProps {
  moduleDocId: string;
  sourcePath?: string;
}

export function EduEditor({ moduleDocId, sourcePath }: EduEditorProps) {
  const { getOrConnect, disconnectAll } = useDocConnection();
  const [moduleSections, setModuleSections] = useState<Section[]>([]);
  const [synced, setSynced] = useState(false);
  const [selectedLensDocId, setSelectedLensDocId] = useState<string | null>(null);
  const [selectedLensName, setSelectedLensName] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function connect() {
      const { doc } = await getOrConnect(moduleDocId);
      if (cancelled) return;

      const ytext = doc.getText('contents');
      const update = () => {
        setModuleSections(parseSections(ytext.toString()));
      };

      setSynced(true);
      update();
      ytext.observe(update);

      return () => {
        ytext.unobserve(update);
      };
    }

    const cleanupPromise = connect();
    return () => {
      cancelled = true;
      cleanupPromise.then(cleanup => cleanup?.());
    };
  }, [moduleDocId, getOrConnect]);

  useEffect(() => disconnectAll, [disconnectAll]);

  const handleSelectLens = useCallback((docId: string, name: string) => {
    setSelectedLensDocId(docId);
    setSelectedLensName(name);
  }, []);

  // Suppress unused variable warning — will be used in Task 6
  void selectedLensName;

  if (!synced) {
    return (
      <div className="h-full flex items-center justify-center text-gray-400 text-sm">
        Connecting to module...
      </div>
    );
  }

  return (
    <div className="h-full flex">
      {/* Left panel: Module structure */}
      <div className="w-[340px] min-w-[340px] border-r-2 border-gray-200 bg-white overflow-y-auto p-4">
        <div className="text-[11px] uppercase tracking-wider text-gray-500 font-semibold mb-3 pb-2 border-b border-gray-200">
          Module Structure
        </div>
        <ModulePanel
          sections={moduleSections}
          sourcePath={sourcePath ?? ''}
          onSelectLens={handleSelectLens}
          activeLensDocId={selectedLensDocId}
        />
      </div>

      {/* Right panel: Lens content */}
      <div className="flex-1 overflow-y-auto" style={{ background: '#faf8f3' }}>
        <div className="max-w-[720px] mx-auto py-8 px-10">
          {selectedLensDocId && selectedLensName ? (
            <div className="text-sm text-gray-500">
              Lens panel placeholder — {selectedLensName}
            </div>
          ) : (
            <div className="flex items-center justify-center h-48 text-gray-400 text-sm border-2 border-dashed border-gray-200 rounded-lg">
              Select a lens from the module structure
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
