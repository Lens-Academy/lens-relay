// @vitest-environment node -- real Node fetch/undici; the config's environmentMatchGlobs is ignored by vitest 4, so server tests otherwise run in happy-dom, whose fetch ignores `dispatcher`.
import { describe, it, expect, vi } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

// The up-front check passes, as when a rebinding host's first DNS answer is
// public; only the connect-time check stands between us and the server.
vi.mock("./ssrf", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./ssrf")>()),
  assertPublicUrl: vi.fn(async () => {}),
}));

import { fetchRawBytes } from "./fetch";

describe("fetchRawBytes and DNS rebinding", () => {
  // Prevents: article/image/attachment fetches connecting to whatever a
  // second DNS answer says, after the first answer passed the SSRF check
  it("refuses to connect when the name resolves to a private address", async () => {
    let hits = 0;
    const server = createServer((_req, res) => {
      hits += 1;
      res.end("internal");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;
    try {
      await expect(fetchRawBytes(`http://localhost:${port}/`)).rejects.toThrow();
      expect(hits).toBe(0);
    } finally {
      server.close();
    }
  });
});
