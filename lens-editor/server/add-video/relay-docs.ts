function getRelayConfig() {
  const url = process.env.RELAY_URL || 'http://relay-server:8080';
  const token = process.env.RELAY_SERVER_TOKEN || '';
  return { url, token };
}

/**
 * Create or update a document in Relay via the internal HTTP API.
 * Uses POST /doc/upsert — creates if new, replaces content if exists.
 */
async function upsertRelayDoc(
  filePath: string,
  content: string
): Promise<{ doc_id: string; path: string; created: boolean }> {
  const { url, token } = getRelayConfig();

  // Split "Folder Name/sub/path/file.md" into folder + path
  const slashIdx = filePath.indexOf('/');
  if (slashIdx === -1) {
    throw new Error(`Invalid file path (no folder): ${filePath}`);
  }
  const folder = filePath.slice(0, slashIdx);
  const path = '/' + filePath.slice(slashIdx + 1);

  const resp = await fetch(`${url}/doc/upsert`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ folder, path, content }),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Relay upsert failed: ${resp.status} ${text}`);
  }

  return resp.json();
}

/** Create a new document in Relay */
export async function createRelayDoc(
  filePath: string,
  content: string
): Promise<void> {
  await upsertRelayDoc(filePath, content);
}

/** Update an existing document with new content */
export async function updateRelayDoc(
  filePath: string,
  _oldContent: string,
  newContent: string
): Promise<void> {
  await upsertRelayDoc(filePath, newContent);
}

/**
 * Check which paths already exist in a relay folder.
 * Returns a map of path → boolean.
 */
export async function checkRelayDocsExist(
  paths: string[]
): Promise<Record<string, boolean>> {
  if (paths.length === 0) return {};

  const { url, token } = getRelayConfig();

  // All paths share the same folder prefix — extract from first path
  const slashIdx = paths[0].indexOf('/');
  if (slashIdx === -1) {
    throw new Error(`Invalid file path (no folder): ${paths[0]}`);
  }
  const folder = paths[0].slice(0, slashIdx);

  // Strip folder prefix from all paths, add leading /
  const relPaths = paths.map((p) => {
    const idx = p.indexOf('/');
    return '/' + p.slice(idx + 1);
  });

  const resp = await fetch(`${url}/doc/check`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ folder, paths: relPaths }),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Relay check failed: ${resp.status} ${text}`);
  }

  const data = (await resp.json()) as { exists: Record<string, boolean> };

  // Re-map back to full paths (folder/path)
  const result: Record<string, boolean> = {};
  for (let i = 0; i < paths.length; i++) {
    result[paths[i]] = data.exists[relPaths[i]] ?? false;
  }
  return result;
}
