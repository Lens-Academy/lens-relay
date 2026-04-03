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
