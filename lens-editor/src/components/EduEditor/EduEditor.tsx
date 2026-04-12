import { useEffect, useState, useCallback } from 'react';
import { useDocConnection } from '../../hooks/useDocConnection';
import { useNavigation } from '../../contexts/NavigationContext';
import { parseSections } from '../SectionEditor/parseSections';
import type { Section } from '../SectionEditor/parseSections';
import { ModuleTreeEditor } from './ModuleTreeEditor';
import { ContentPanel, type ContentScope } from './ContentPanel';
import { CourseOverview } from './CourseOverview';
import { RELAY_ID } from '../../lib/constants';

interface EduEditorProps {
  moduleDocId: string;
  sourcePath?: string;
}

export function EduEditor({ moduleDocId, sourcePath }: EduEditorProps) {
  const { getOrConnect, disconnectAll } = useDocConnection();
  const { metadata } = useNavigation();
  const [docSections, setDocSections] = useState<Section[]>([]);
  const [synced, setSynced] = useState(false);
  const [scope, setScope] = useState<ContentScope | null>(null);

  // Selected module state (course mode only)
  const [selectedModuleDocId, setSelectedModuleDocId] = useState<string | null>(null);
  const [selectedModuleName, setSelectedModuleName] = useState('');
  const [selectedModuleSections, setSelectedModuleSections] = useState<Section[]>([]);
  const [selectedModuleSynced, setSelectedModuleSynced] = useState(false);

  const isCourseMode = docSections.some(s => s.type === 'module-ref');

  // Connect to the primary doc (course or module)
  useEffect(() => {
    let cancelled = false;

    async function connect() {
      const { doc } = await getOrConnect(moduleDocId);
      if (cancelled) return;

      const ytext = doc.getText('contents');
      const update = () => {
        setDocSections(parseSections(ytext.toString()));
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

  // Connect to selected module doc (course mode)
  useEffect(() => {
    if (!selectedModuleDocId) {
      setSelectedModuleSections([]);
      setSelectedModuleSynced(false);
      return;
    }

    let cancelled = false;

    async function connect() {
      const { doc } = await getOrConnect(selectedModuleDocId!);
      if (cancelled) return;

      const ytext = doc.getText('contents');
      const update = () => {
        setSelectedModuleSections(parseSections(ytext.toString()));
      };

      setSelectedModuleSynced(true);
      update();
      ytext.observe(update);

      return () => { ytext.unobserve(update); };
    }

    const cleanupPromise = connect();
    return () => {
      cancelled = true;
      cleanupPromise.then(cleanup => cleanup?.());
    };
  }, [selectedModuleDocId, getOrConnect]);

  // Reset selection when top-level doc changes
  useEffect(() => {
    setSelectedModuleDocId(null);
    setSelectedModuleName('');
    setScope(null);
  }, [moduleDocId]);

  useEffect(() => disconnectAll, [disconnectAll]);

  const handleSelect = useCallback((next: ContentScope) => {
    setScope(next);
  }, []);

  const handleSelectModule = useCallback((docId: string, name: string) => {
    setSelectedModuleDocId(docId);
    setSelectedModuleName(name);
    setScope(null);
  }, []);

  // Derive module path for the selected module
  const selectedModuleUuid = selectedModuleDocId?.slice(RELAY_ID.length + 1);
  const selectedModulePath = selectedModuleUuid
    ? Object.entries(metadata).find(([, m]) => m.id === selectedModuleUuid)?.[0] ?? ''
    : '';

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
        Connecting...
      </div>
    );
  }

  // Determine which sections/path/docId to pass to ModuleTreeEditor
  const moduleTreeSections = isCourseMode ? selectedModuleSections : docSections;
  const moduleTreePath = isCourseMode ? selectedModulePath : (sourcePath ?? '');
  const moduleTreeDocId = isCourseMode ? (selectedModuleDocId ?? undefined) : moduleDocId;

  return (
    <div className="h-full flex">
      <div className="w-[420px] min-w-[420px] border-r-2 border-gray-200 bg-[#fbfaf7] overflow-y-auto p-4">
        {isCourseMode ? (
          <>
            <div className="text-[11px] uppercase tracking-wider text-gray-500 font-semibold mb-3 pb-2 border-b border-gray-200">
              Course
            </div>
            <CourseOverview
              courseSections={docSections}
              coursePath={sourcePath ?? ''}
              metadata={metadata}
              selectedModuleDocId={selectedModuleDocId}
              onSelectModule={handleSelectModule}
            />
            {selectedModuleDocId && (
              <>
                <div className="text-[11px] uppercase tracking-wider text-gray-500 font-semibold mt-4 mb-3 pt-3 pb-2 border-t border-b border-gray-200">
                  {selectedModuleName}
                </div>
                {selectedModuleSynced ? (
                  <ModuleTreeEditor
                    moduleSections={moduleTreeSections}
                    modulePath={moduleTreePath}
                    moduleDocId={moduleTreeDocId}
                    activeSelection={activeSelection}
                    onSelect={handleSelect}
                  />
                ) : (
                  <div className="text-xs text-gray-400 italic py-2">Loading module...</div>
                )}
              </>
            )}
          </>
        ) : (
          <>
            <div className="text-[11px] uppercase tracking-wider text-gray-500 font-semibold mb-3 pb-2 border-b border-gray-200">
              {sourcePath?.split('/').pop()?.replace(/\.md$/, '') ?? 'Module'}
            </div>
            <ModuleTreeEditor
              moduleSections={moduleTreeSections}
              modulePath={moduleTreePath}
              moduleDocId={moduleTreeDocId}
              activeSelection={activeSelection}
              onSelect={handleSelect}
            />
          </>
        )}
      </div>

      <div className="flex-1 overflow-y-auto" style={{ background: '#faf8f3' }}>
        <div className="max-w-[720px] mx-auto py-8 px-10 h-full">
          <ContentPanel scope={scope} />
        </div>
      </div>
    </div>
  );
}
