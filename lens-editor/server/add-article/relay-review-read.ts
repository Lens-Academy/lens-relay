import { bytesToText, fetchBytesWithTimeout } from "../fetch-timeout";

const MCP_TIMEOUT_MS = 30_000;
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

async function callMcp(
  endpoint: string,
  token: string,
  id: number,
  method: string,
  params: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<McpResponse> {
  const response = await fetchBytesWithTimeout(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    timeoutMs: MCP_TIMEOUT_MS,
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
  return decodeRelayReadOutput(toolText(readResponse, "read"));
}
