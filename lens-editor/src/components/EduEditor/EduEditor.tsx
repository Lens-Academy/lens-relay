import { useEffect, useState, useCallback } from 'react';
import { useDocConnection } from '../../hooks/useDocConnection';
import { parseSections } from '../SectionEditor/parseSections';
import type { Section } from '../SectionEditor/parseSections';
import { ModuleTreeEditor } from './ModuleTreeEditor';
import { ContentPanel, type ContentScope } from './ContentPanel';

interface EduEditorProps {
  moduleDocId: string;
  sourcePath?: string;
}

export function EduEditor({ moduleDocId, sourcePath }: EduEditorProps) {
  const { getOrConnect, disconnectAll } = useDocConnection();
  const [moduleSections, setModuleSections] = useState<Section[]>([]);
  const [synced, setSynced] = useState(false);
  const [scope, setScope] = useState<ContentScope | null>(null);

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

      return () => { ytext.unobserve(update); };
    }

    const cleanupPromise = connect();
    return () => {
      cancelled = true;
      cleanupPromise.then(cleanup => cleanup?.());
    };
  }, [moduleDocId, getOrConnect]);

  useEffect(() => disconnectAll, [disconnectAll]);

  const handleSelect = useCallback((next: ContentScope) => {
    setScope(next);
  }, []);

  const activeSelection =
    scope === null
      ? null
      : {
          docId: scope.docId,
          rootIndex: scope.kind === 'subtree' ? scope.rootSectionIndex : undefined,
        };

  if (!synced) {
    return (
      <div className="h-full flex items-center justify-center text-gray-400 text-sm">
        Connecting to module...
      </div>
    );
  }

  return (
    <div className="h-full flex">
      <div className="w-[420px] min-w-[420px] border-r-2 border-gray-200 bg-[#fbfaf7] overflow-y-auto p-4">
        <div className="text-[11px] uppercase tracking-wider text-gray-500 font-semibold mb-3 pb-2 border-b border-gray-200">
          {sourcePath?.split('/').pop()?.replace(/\.md$/, '') ?? 'Module'}
        </div>
        <ModuleTreeEditor
          moduleSections={moduleSections}
          modulePath={sourcePath ?? ''}
          moduleDocId={moduleDocId}
          activeSelection={activeSelection}
          onSelect={handleSelect}
        />
      </div>

      <div className="flex-1 overflow-y-auto" style={{ background: '#faf8f3' }}>
        <div className="max-w-[720px] mx-auto py-8 px-10 h-full">
          <ContentPanel scope={scope} />
        </div>
      </div>
    </div>
  );
}
