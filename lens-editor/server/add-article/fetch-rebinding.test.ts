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
import { SsrfError } from "./ssrf";

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
      // localhost: the name path (lookup); 127.0.0.1: the literal-IP path.
      for (const url of [`http://localhost:${port}/`, `http://127.0.0.1:${port}/`]) {
        const err = await fetchRawBytes(url).catch((e: unknown) => e);
        expect(err, url).toBeInstanceOf(SsrfError);
      }
      expect(hits).toBe(0);
    } finally {
      server.close();
    }
  });
});
