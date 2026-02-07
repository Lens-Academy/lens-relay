import { useState } from 'react';
import { RelayProvider } from './providers/RelayProvider';
import { Sidebar } from './components/Sidebar';
import { EditorArea } from './components/Layout';
import { AwarenessInitializer } from './components/AwarenessInitializer/AwarenessInitializer';
import { DisconnectionModal } from './components/DisconnectionModal/DisconnectionModal';
import { NavigationContext } from './contexts/NavigationContext';
import { useMultiFolderMetadata, type FolderConfig } from './hooks/useMultiFolderMetadata';

// Local relay-server uses test IDs, production uses real Relay IDs
const USE_LOCAL_RELAY = import.meta.env.VITE_LOCAL_RELAY === 'true';

// Relay server ID (from CLAUDE.md)
export const RELAY_ID = USE_LOCAL_RELAY
  ? 'a0000000-0000-4000-8000-000000000000'
  : 'cb696037-0f72-4e93-8717-4e433129d789';

// Folder configuration
const FOLDERS: FolderConfig[] = USE_LOCAL_RELAY
  ? [
      { id: 'b0000001-0000-4000-8000-000000000001', name: 'Relay Folder 1' },
      { id: 'b0000002-0000-4000-8000-000000000002', name: 'Relay Folder 2' },
    ]
  : [
      { id: 'fbd5eb54-73cc-41b0-ac28-2b93d3b4244e', name: 'Lens' },
      { id: 'ea4015da-24af-4d9d-ac49-8c902cb17121', name: 'Lens Edu' },
    ];

// Default document to show on load
const DOC_UUID = USE_LOCAL_RELAY
  ? 'c0000001-0000-4000-8000-000000000001'
  : '76c3e654-0e77-4538-962f-1b419647206e';
const DEFAULT_DOC_ID = `${RELAY_ID}-${DOC_UUID}`;

export function App() {
  const [activeDocId, setActiveDocId] = useState<string>(DEFAULT_DOC_ID);

  // Use multi-folder metadata hook
  const { metadata, folderDocs, errors } = useMultiFolderMetadata(FOLDERS);
  const folderNames = FOLDERS.map(f => f.name);

  return (
    <NavigationContext.Provider value={{ metadata, folderDocs, folderNames, errors, onNavigate: setActiveDocId }}>
      <div className="h-screen flex bg-gray-50">
        {/* Sidebar is OUTSIDE the key boundary - stays mounted across document switches */}
        <Sidebar activeDocId={activeDocId} onSelectDocument={setActiveDocId} />

        {/* Only EditorArea remounts on doc change via key prop */}
        <RelayProvider key={activeDocId} docId={activeDocId}>
          <AwarenessInitializer />
          <EditorArea currentDocId={activeDocId} />
          <DisconnectionModal />
        </RelayProvider>
      </div>
    </NavigationContext.Provider>
  );
}
