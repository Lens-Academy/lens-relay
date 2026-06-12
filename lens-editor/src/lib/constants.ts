import type { FolderConfig } from '../hooks/useMultiFolderMetadata';

// VITE_LOCAL_RELAY=true routes requests to a local relay-server via Vite proxy
const USE_LOCAL_RELAY = import.meta.env.VITE_LOCAL_RELAY === 'true';

// Use R2 (production) data with local relay? Set VITE_LOCAL_R2=true
const USE_LOCAL_R2 = USE_LOCAL_RELAY && import.meta.env.VITE_LOCAL_R2 === 'true';

// Relay server ID — switches between production and local test IDs
export const RELAY_ID = (USE_LOCAL_RELAY && !USE_LOCAL_R2)
  ? 'a0000000-0000-4000-8000-000000000000'
  : 'cb696037-0f72-4e93-8717-4e433129d789';

// The Lens Edu folder UUID — gated on by the editor (add-article/add-video
// routes and their page guards) and seeded into local dev. Single source of
// truth for the literal.
export const EDU_FOLDER_ID = 'ea4015da-24af-4d9d-ac49-8c902cb17121';

// Folder configuration
export const FOLDERS: FolderConfig[] = (USE_LOCAL_RELAY && !USE_LOCAL_R2)
  ? [
      { id: 'b0000001-0000-4000-8000-000000000001', name: 'Relay Folder 1' },
      { id: 'b0000002-0000-4000-8000-000000000002', name: 'Relay Folder 2' },
      // Real Lens Edu folder, seeded by setup-local-relay.mjs. Present so
      // imported articles (written to Lens Edu/articles) show in the sidebar.
      { id: EDU_FOLDER_ID, name: 'Lens Edu' },
    ]
  : [
      { id: 'fbd5eb54-73cc-41b0-ac28-2b93d3b4244e', name: 'Lens' },
      { id: EDU_FOLDER_ID, name: 'Lens Edu' },
      { id: '24027431-24c0-42c2-9f8f-04ed0dd458aa', name: 'Lens Edu Private' },
    ];

// Default document short UUID (first 8 chars — used only in URL redirect)
export const DEFAULT_DOC_UUID = (USE_LOCAL_RELAY && !USE_LOCAL_R2) ? 'c0000001' : '76c3e654';
