function getRelayConfig() {
  const url = process.env.RELAY_URL || 'http://relay-server:8080';
  const token = process.env.RELAY_SERVER_TOKEN || '';
  const mcpKey = process.env.MCP_API_KEY || '';
  return { url, token, mcpKey };
}

async function mcpCall(
  method: string,
  params: Record<string, unknown>,
  sessionId?: string
): Promise<{ result: unknown; sessionId?: string }> {
  const { url, mcpKey } = getRelayConfig();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${mcpKey}`,
  };
  if (sessionId) {
    headers['mcp-session-id'] = sessionId;
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
    throw new Error(`MCP call failed: ${resp.status} ${resp.statusText}`);
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
    sessionId: respSessionId || sessionId,
  };
}

/** Create a new document in Relay via MCP create tool */
export async function createRelayDoc(
  filePath: string,
  content: string
): Promise<void> {
  await mcpCall('tools/call', {
    name: 'create',
    arguments: { file_path: filePath, content },
  });
}

/** Update an existing document: initialize session, read (required), then edit */
export async function updateRelayDoc(
  filePath: string,
  oldContent: string,
  newContent: string
): Promise<void> {
  // Initialize session
  const init = await mcpCall('initialize', {
    protocolVersion: '2025-03-26',
    clientInfo: { name: 'add-video', version: '1.0' },
  });
  const sessionId = init.sessionId;

  // Read (required before edit)
  await mcpCall(
    'tools/call',
    {
      name: 'read',
      arguments: { file_path: filePath, session_id: sessionId },
    },
    sessionId
  );

  // Edit
  await mcpCall(
    'tools/call',
    {
      name: 'edit',
      arguments: {
        file_path: filePath,
        old_string: oldContent,
        new_string: newContent,
        session_id: sessionId,
      },
    },
    sessionId
  );
}
