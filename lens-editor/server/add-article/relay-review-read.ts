import { bytesToText, fetchBytesWithTimeout } from "../fetch-timeout";

const MCP_TIMEOUT_MS = 30_000;
const MCP_VALIDATION_TIMEOUT_MS = 120_000;
const MCP_MAX_RESPONSE_BYTES = 20 * 1024 * 1024;

interface McpTextContent {
  type: string;
  text?: string;
}

interface McpResponse {
  error?: { code?: number; message?: string };
  result?: {
    isError?: boolean;
    content?: McpTextContent[];
  };
}

export interface RelayReviewReadOptions {
  relayUrl: string;
  token: string;
  signal?: AbortSignal;
}

export interface RelayReviewClient extends RelayReviewReadOptions {
  sessionId: string;
  read(filePath: string, allowPendingSuggestions?: boolean): Promise<string>;
  edit(filePath: string, oldString: string, newString: string): Promise<void>;
  validateContent(acceptDrafts?: boolean): Promise<string>;
  getUrl(filePath: string): Promise<string>;
}

async function callMcp(
  endpoint: string,
  token: string,
  id: number,
  method: string,
  params: Record<string, unknown>,
  signal?: AbortSignal,
  timeoutMs = MCP_TIMEOUT_MS,
): Promise<McpResponse> {
  const response = await fetchBytesWithTimeout(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    timeoutMs,
    maxBytes: MCP_MAX_RESPONSE_BYTES,
    signal,
  });
  const text = bytesToText(response.bytes);
  if (!response.ok) {
    throw new Error(`Relay MCP request failed: ${response.status} ${text}`);
  }
  try {
    return JSON.parse(text) as McpResponse;
  } catch {
    throw new Error("Relay MCP returned invalid JSON");
  }
}

function toolText(response: McpResponse, tool: string): string {
  if (response.error) {
    throw new Error(`Relay MCP ${tool} failed: ${response.error.message ?? "unknown JSON-RPC error"}`);
  }
  const text = response.result?.content?.find((part) => part.type === "text")?.text;
  if (response.result?.isError || text === undefined) {
    throw new Error(`Relay MCP ${tool} failed: ${text ?? "missing text result"}`);
  }
  return text;
}

/** Decode the cat -n representation returned by the Relay MCP read tool.
 * Unnumbered pending-suggestion footer lines are intentionally excluded. */
export function decodeRelayReadOutput(output: string): string {
  const lines: string[] = [];
  for (const line of output.split("\n")) {
    const match = line.match(/^\s*\d+\t(.*)$/);
    if (match) lines.push(match[1]);
  }
  if (lines.length === 0) {
    throw new Error("Relay MCP read returned no numbered document lines");
  }
  return `${lines.join("\n")}\n`;
}

function assertNoPendingSuggestions(output: string): void {
  if (/^\[Pending suggestions\]\s*$/m.test(output)) {
    throw new Error("Relay article has pending suggestions; resolve them before starting another review");
  }
}

/** Read a Relay Markdown document without mutating it. Relay's read tool
 * resolves the path against live folder metadata and returns the accepted view
 * of any pending CriticMarkup suggestions. */
export async function readAcceptedRelayMarkdown(
  filePath: string,
  options: RelayReviewReadOptions,
): Promise<string> {
  if (!options.token) throw new Error("Relay MCP token is required");
  const endpoint = `${options.relayUrl.replace(/\/+$/, "")}/mcp`;

  const sessionResponse = await callMcp(endpoint, options.token, 1, "tools/call", {
    name: "create_session",
    arguments: { name: "Article review CLI", model: "local" },
  }, options.signal);
  const sessionId = toolText(sessionResponse, "create_session").split("\n", 1)[0].trim();
  if (!sessionId) throw new Error("Relay MCP create_session returned an empty session id");

  const readResponse = await callMcp(endpoint, options.token, 2, "tools/call", {
    name: "read",
    arguments: { file_path: filePath, session_id: sessionId },
  }, options.signal);
  const output = toolText(readResponse, "read");
  assertNoPendingSuggestions(output);
  return decodeRelayReadOutput(output);
}

export async function createRelayReviewClient(
  options: RelayReviewReadOptions,
  name = "Article review CLI",
): Promise<RelayReviewClient> {
  if (!options.token) throw new Error("Relay MCP token is required");
  const endpoint = `${options.relayUrl.replace(/\/+$/, "")}/mcp`;
  let nextId = 1;
  const invoke = async (tool: string, args: Record<string, unknown>, timeoutMs = MCP_TIMEOUT_MS) => {
    const response = await callMcp(endpoint, options.token, nextId++, "tools/call", {
      name: tool,
      arguments: args,
    }, options.signal, timeoutMs);
    return toolText(response, tool);
  };
  const sessionId = (await invoke("create_session", { name, model: "article-qc" }))
    .split("\n", 1)[0]
    .trim();
  if (!sessionId) throw new Error("Relay MCP create_session returned an empty session id");
  return {
    ...options,
    sessionId,
    async read(filePath: string, allowPendingSuggestions = false) {
      const output = await invoke("read", { file_path: filePath, session_id: sessionId });
      if (!allowPendingSuggestions) assertNoPendingSuggestions(output);
      return decodeRelayReadOutput(output);
    },
    async edit(filePath: string, oldString: string, newString: string) {
      await invoke("edit", {
        file_path: filePath,
        old_string: oldString,
        new_string: newString,
        session_id: sessionId,
      });
    },
    async validateContent(acceptDrafts = true) {
      return invoke(
        "validate_content",
        { session_id: sessionId, accept_drafts: acceptDrafts },
        MCP_VALIDATION_TIMEOUT_MS,
      );
    },
    async getUrl(filePath: string) {
      return invoke("get_url", { session_id: sessionId, file_path: filePath });
    },
  };
}
