import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeRelayReadOutput, readAcceptedRelayMarkdown } from "./relay-review-read";

afterEach(() => vi.unstubAllGlobals());

describe("decodeRelayReadOutput", () => {
  it("preserves document lines and excludes the pending-suggestion footer", () => {
    const output = [
      "     1\t---",
      "     2\ttitle: A",
      "     3\t---",
      "     4\t",
      "     5\tAccepted body",
      "",
      "[Pending suggestions]",
      "- one replacement",
    ].join("\n");
    expect(decodeRelayReadOutput(output)).toBe("---\ntitle: A\n---\n\nAccepted body\n");
  });
});

describe("readAcceptedRelayMarkdown", () => {
  it("uses authenticated read-only MCP calls and returns the accepted document", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: { content: [{ type: "text", text: "review-session\norientation" }] },
      })))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        result: { content: [{ type: "text", text: "     1\t---\n     2\ttitle: Live\n     3\t---\n     4\tBody" }] },
      })));
    vi.stubGlobal("fetch", fetchMock);

    await expect(readAcceptedRelayMarkdown("Lens Edu/articles/a.md", {
      relayUrl: "https://relay.example/",
      token: "secret",
    })).resolves.toBe("---\ntitle: Live\n---\nBody\n");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [url, init] of fetchMock.mock.calls) {
      expect(url).toBe("https://relay.example/mcp");
      expect(init.headers.Authorization).toBe("Bearer secret");
      expect(init.method).toBe("POST");
    }
    const readRequest = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(readRequest.params).toEqual({
      name: "read",
      arguments: { file_path: "Lens Edu/articles/a.md", session_id: "review-session" },
    });
  });

  it("surfaces Relay tool errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: { isError: true, content: [{ type: "text", text: "denied" }] },
    }))));
    await expect(readAcceptedRelayMarkdown("Lens Edu/articles/a.md", {
      relayUrl: "https://relay.example",
      token: "secret",
    })).rejects.toThrow("denied");
  });
});
