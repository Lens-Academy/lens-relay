function getRelayConfig() {
  const url = process.env.RELAY_URL || 'http://relay-server:8080';
  const token = process.env.RELAY_SERVER_TOKEN || '';
  return { url, token };
}

/**
 * Send a JSON-RPC request (has `id`, expects response).
 */
async function mcpRequest(
  method: string,
  params: Record<string, unknown>,
  transportSessionId?: string
): Promise<{ result: unknown; transportSessionId?: string }> {
  const { url, token } = getRelayConfig();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  };
  if (transportSessionId) {
    headers['mcp-session-id'] = transportSessionId;
  }

  const resp = await fetch(`${url}/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now(),
      method,
      params,
    }),
  });

  if (!resp.ok) {
    throw new Error(`MCP request failed: ${resp.status} ${resp.statusText}`);
  }

  const data = (await resp.json()) as {
    result?: unknown;
    error?: { message: string };
  };
  if (data.error) {
    throw new Error(`MCP error: ${data.error.message}`);
  }

  const respSessionId =
    typeof resp.headers?.get === 'function'
      ? resp.headers.get('mcp-session-id')
      : undefined;

  return {
    result: data.result,
    transportSessionId: respSessionId || transportSessionId,
  };
}

/**
 * Send a JSON-RPC notification (no `id`, no response expected).
 */
async function mcpNotify(
  method: string,
  params: Record<string, unknown>,
  transportSessionId: string
): Promise<void> {
  const { url, token } = getRelayConfig();
  await fetch(`${url}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      'mcp-session-id': transportSessionId,
    },
    // No `id` field — this is a notification, not a request
    body: JSON.stringify({
      jsonrpc: '2.0',
      method,
      params,
    }),
  });
}

/**
 * Establish a full MCP session:
 *   1. initialize → get transport session ID
 *   2. notifications/initialized → mark session ready
 *   3. create_session tool → get session_id for tool arguments
 */
async function establishSession(): Promise<{
  transportSessionId: string;
  sessionId: string;
}> {
  // 1. Initialize
  const init = await mcpRequest('initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'add-video', version: '1.0' },
  });
  const transportSessionId = init.transportSessionId;
  if (!transportSessionId) {
    throw new Error('MCP initialize did not return a session ID');
  }

  // 2. Send notifications/initialized (required before tool calls)
  await mcpNotify('notifications/initialized', {}, transportSessionId);

  // 3. Call create_session tool to get session_id for tool arguments
  const session = await mcpRequest(
    'tools/call',
    { name: 'create_session', arguments: {} },
    transportSessionId
  );
  const resultContent = session.result as {
    content?: Array<{ type: string; text: string }>;
  };
  const sessionId =
    resultContent?.content?.[0]?.text || transportSessionId;

  return { transportSessionId, sessionId };
}

/** Create a new document in Relay via MCP create tool */
export async function createRelayDoc(
  filePath: string,
  content: string
): Promise<void> {
  const { transportSessionId, sessionId } = await establishSession();

  await mcpRequest(
    'tools/call',
    {
      name: 'create',
      arguments: { file_path: filePath, content, session_id: sessionId },
    },
    transportSessionId
  );
}

/**
 * Update an existing document: establish session, read (required), then edit.
 * Uses actual document content for the edit match (not the expected content)
 * to handle any CRDT drift.
 */
export async function updateRelayDoc(
  filePath: string,
  _oldContent: string,
  newContent: string
): Promise<void> {
  const { transportSessionId, sessionId } = await establishSession();

  // Read (required before edit — session tracks read docs)
  const readResult = await mcpRequest(
    'tools/call',
    {
      name: 'read',
      arguments: { file_path: filePath, session_id: sessionId },
    },
    transportSessionId
  );

  // Extract actual content from read result (format: "     1\tcontent")
  const readContent = readResult.result as {
    content?: Array<{ type: string; text: string }>;
  };
  const rawText = readContent?.content?.[0]?.text || '';
  // Strip line number prefixes and trailing metadata (pending suggestions etc.)
  const lines = rawText.split('\n');
  const contentLines: string[] = [];
  for (const line of lines) {
    // Match lines starting with optional spaces + digits + tab
    const match = line.match(/^\s*\d+\t(.*)/);
    if (match) {
      contentLines.push(match[1]);
    }
  }
  const actualContent = contentLines.join('\n');

  // Edit using actual content as old_string (handles CRDT drift)
  await mcpRequest(
    'tools/call',
    {
      name: 'edit',
      arguments: {
        file_path: filePath,
        old_string: actualContent,
        new_string: newContent,
        session_id: sessionId,
      },
    },
    transportSessionId
  );
}
