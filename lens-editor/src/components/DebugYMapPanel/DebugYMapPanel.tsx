import { useState, useEffect } from 'react';
import { useNavigation } from '../../contexts/NavigationContext';

const TEST_MAP_NAME = 'test_backlinks_v0';

/**
 * Debug panel to test Obsidian's behavior with unknown Y.Maps.
 * Shows all Y.Maps in the folder doc and allows creating a test map.
 */
export function DebugYMapPanel() {
  const { folderDocs } = useNavigation();
  // Use first folder doc for debugging
  const doc = folderDocs.values().next().value ?? null;
  const [isOpen, setIsOpen] = useState(false);
  const [mapInfo, setMapInfo] = useState<{ name: string; size: number }[]>([]);
  const [testMapContents, setTestMapContents] = useState<Record<string, unknown> | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  // Scan the Y.Doc for all Y.Maps
  useEffect(() => {
    if (!doc) return;

    const scanMaps = () => {
      const maps: { name: string; size: number }[] = [];

      // Known map names to check
      const knownNames = ['filemeta_v0', 'docs', TEST_MAP_NAME];

      for (const name of knownNames) {
        const map = doc.getMap(name);
        // Y.Map is created on access, but will be empty if it didn't exist
        // We check if it has any content or was explicitly created
        if (map.size > 0 || name === TEST_MAP_NAME) {
          maps.push({ name, size: map.size });
        }
      }

      setMapInfo(maps);

      // Check test map contents
      const testMap = doc.getMap(TEST_MAP_NAME);
      if (testMap.size > 0) {
        const contents: Record<string, unknown> = {};
        testMap.forEach((value, key) => {
          contents[key] = value;
        });
        setTestMapContents(contents);
      } else {
        setTestMapContents(null);
      }
    };

    scanMaps();

    // Re-scan when doc changes
    const testMap = doc.getMap(TEST_MAP_NAME);
    testMap.observe(scanMaps);

    return () => {
      testMap.unobserve(scanMaps);
    };
  }, [doc, refreshKey]);

  const handleCreateTestMap = () => {
    if (!doc) return;

    const testMap = doc.getMap(TEST_MAP_NAME);

    doc.transact(() => {
      testMap.set('created_at', new Date().toISOString());
      testMap.set('created_by', 'lens-editor');
      testMap.set('test_data', { foo: 'bar', count: 42 });
      testMap.set('purpose', 'Testing if Obsidian deletes unknown Y.Maps');
    }, 'lens-editor-debug');

    console.log('[DebugYMapPanel] Created test Y.Map:', TEST_MAP_NAME);
    setRefreshKey(k => k + 1);
  };

  const handleDeleteTestMap = () => {
    if (!doc) return;

    const testMap = doc.getMap(TEST_MAP_NAME);

    doc.transact(() => {
      testMap.clear();
    }, 'lens-editor-debug');

    console.log('[DebugYMapPanel] Cleared test Y.Map:', TEST_MAP_NAME);
    setRefreshKey(k => k + 1);
  };

  const handleRefresh = () => {
    setRefreshKey(k => k + 1);
  };

  if (!isOpen) {
    return (
      <button
        onClick={() => setIsOpen(true)}
        className="px-2 py-1 text-xs bg-yellow-100 text-yellow-800 rounded hover:bg-yellow-200"
        title="Debug Y.Map Panel"
      >
        Debug
      </button>
    );
  }

  return (
    <div className="fixed top-16 right-4 w-80 bg-white border border-gray-300 rounded-lg shadow-lg z-50">
      <div className="flex items-center justify-between px-3 py-2 border-b border-gray-200 bg-gray-50 rounded-t-lg">
        <span className="font-medium text-sm">Y.Map Debug Panel</span>
        <button
          onClick={() => setIsOpen(false)}
          className="text-gray-500 hover:text-gray-700"
        >
          &times;
        </button>
      </div>

      <div className="p-3 space-y-3 text-sm">
        {!doc ? (
          <p className="text-gray-500">No folder doc connected</p>
        ) : (
          <>
            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="font-medium">Y.Maps in folder doc:</span>
                <button
                  onClick={handleRefresh}
                  className="text-xs text-blue-600 hover:underline"
                >
                  Refresh
                </button>
              </div>
              <ul className="space-y-1 ml-2">
                {mapInfo.map(({ name, size }) => (
                  <li key={name} className="flex justify-between">
                    <code className="text-xs bg-gray-100 px-1 rounded">{name}</code>
                    <span className="text-gray-500 text-xs">{size} entries</span>
                  </li>
                ))}
                {!mapInfo.some(m => m.name === TEST_MAP_NAME) && (
                  <li className="flex justify-between text-gray-400">
                    <code className="text-xs bg-gray-50 px-1 rounded">{TEST_MAP_NAME}</code>
                    <span className="text-xs italic">not present</span>
                  </li>
                )}
              </ul>
            </div>

            <div className="border-t pt-2">
              <span className="font-medium">Test Y.Map:</span>
              {testMapContents ? (
                <div className="mt-1">
                  <pre className="text-xs bg-gray-100 p-2 rounded overflow-auto max-h-32">
                    {JSON.stringify(testMapContents, null, 2)}
                  </pre>
                  <button
                    onClick={handleDeleteTestMap}
                    className="mt-2 px-3 py-1 text-xs bg-red-100 text-red-700 rounded hover:bg-red-200"
                  >
                    Delete Test Y.Map
                  </button>
                </div>
              ) : (
                <div className="mt-1">
                  <p className="text-gray-500 text-xs mb-2">
                    No test map exists. Create one to test Obsidian behavior.
                  </p>
                  <button
                    onClick={handleCreateTestMap}
                    className="px-3 py-1 text-xs bg-blue-100 text-blue-700 rounded hover:bg-blue-200"
                  >
                    Create Test Y.Map
                  </button>
                </div>
              )}
            </div>

            <div className="border-t pt-2 text-xs text-gray-500">
              <p>After creating, open Obsidian on this folder and check if the test map persists or gets deleted.</p>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
