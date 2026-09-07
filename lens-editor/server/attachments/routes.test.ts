import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { createHash } from "node:crypto";
import { Request as UndiciRequest } from "undici";
import {
  createAttachmentRoutes,
  decodeBase64Strict,
  stemFromUrl,
  MAX_ATTACHMENT_BYTES,
  SOFT_ATTACHMENT_BYTES,
  type AttachmentRouteDeps,
} from "./routes";
import { RelayAttachmentConflictError } from "../add-video/relay-docs";
import { SsrfError } from "../add-article/ssrf";
import { signShareToken, type ShareTokenPayload } from "../share-token";
import { EDU_FOLDER } from "../edit-share-auth";
import limits from "../../shared/attachment-limits.json";

const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
const PNG_SHA = createHash("sha256").update(PNG).digest("hex");

function makeToken(overrides: Partial<ShareTokenPayload> = {}): string {
  return signShareToken({
    purpose: "share",
    role: "edit",
    folder: EDU_FOLDER,
    expiry: Math.floor(Date.now() / 1000) + 3600,
    ...overrides,
  });
}

describe("POST /api/attachments/import", () => {
  let app: Hono;
  let deps: {
    fetchBytes: ReturnType<typeof vi.fn>;
    findByHash: ReturnType<typeof vi.fn>;
    upload: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    deps = {
      fetchBytes: vi.fn(async () => ({ bytes: PNG.buffer.slice(PNG.byteOffset, PNG.byteOffset + PNG.byteLength), contentType: "image/png" })),
      findByHash: vi.fn(async () => null),
      upload: vi.fn(async (_folder: string, path: string) => ({
        doc_id: "relay-uuid-1",
        uuid: "uuid-1",
        path: `Lens Edu${path}`,
        hash: PNG_SHA,
        created: true,
        overwritten: false,
      })),
    };
    app = new Hono();
    app.route("/api/attachments", createAttachmentRoutes(deps as unknown as AttachmentRouteDeps));
  });

  function post(body: unknown, token = makeToken()) {
    return app.request("/api/attachments/import", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
  }

  // ---- auth ----
  it("requires an edit share token on the edu folder", async () => {
    expect((await post({ folder: "Lens Edu", url: "https://x/a.png" }, "garbage")).status).toBe(401);
    expect((await post({ folder: "Lens Edu", url: "https://x/a.png" }, makeToken({ role: "suggest" }))).status).toBe(403);
    expect(
      (await post({ folder: "Lens Edu", url: "https://x/a.png" }, makeToken({ folder: "fbd5eb54-73cc-41b0-ac28-2b93d3b4244e" }))).status,
    ).toBe(403);
    expect(deps.upload).not.toHaveBeenCalled();
  });

  // Prevents: a Lens Edu edit token writing into any other relay folder
  // through the server-token upload (the body's `folder` is caller-chosen).
  it("binds the body folder to the token's folder scope", async () => {
    const resp = await post({ folder: "Lens", url: "https://x/a.png" });
    expect(resp.status).toBe(403);
    expect((await resp.json()).error).toMatch(/folder 'Lens'/);
    expect(deps.fetchBytes).not.toHaveBeenCalled();
    expect(deps.findByHash).not.toHaveBeenCalled();
    expect(deps.upload).not.toHaveBeenCalled();

    // An all-folders token may name any folder.
    const allFolders = makeToken({ folder: "00000000-0000-0000-0000-000000000000" });
    const ok = await post({ folder: "Lens", url: "https://x/a.png" }, allFolders);
    expect(ok.status).toBe(200);
    expect(deps.upload.mock.calls[0][0]).toBe("Lens");
  });

  it("rejects request bodies over the configured limit before parsing", async () => {
    const small = new Hono();
    small.route("/api/attachments", createAttachmentRoutes(deps as unknown as AttachmentRouteDeps, { maxBodyBytes: 1024 }));
    const body = JSON.stringify({ folder: "Lens Edu", stem: "x", content_base64: "A".repeat(4096) });
    // undici's Request is what @hono/node-server hands the app in production;
    // vitest's global Request drops Content-Length and buffers differently.
    const request = (headers: Record<string, string>) =>
      new UndiciRequest("http://editor.test/api/attachments/import", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${makeToken()}`, ...headers },
        body,
      }) as unknown as Request;
    // Declared length (what reqwest/curl send): rejected before any read.
    // (The chunked/no-length path is hono's own stream guard; it cannot be
    // exercised here because vitest's global Request cannot wrap an undici
    // Request, but it returns 413 under plain Node.)
    const resp = await small.fetch(request({ "Content-Length": String(body.length) }));
    expect(resp.status).toBe(413);
    expect(deps.upload).not.toHaveBeenCalled();
  });

  it("uses the limits from the shared contract file", () => {
    expect(MAX_ATTACHMENT_BYTES).toBe(limits.max_bytes);
    expect(SOFT_ATTACHMENT_BYTES).toBe(limits.soft_bytes);
  });

  // ---- validation ----
  it("validates the argument shape before fetching anything", async () => {
    const cases: unknown[] = [
      { url: "https://x/a.png" }, // no folder
      { folder: "Lens Edu" }, // no source
      { folder: "Lens Edu", url: "https://x/a.png", content_base64: "aGk=" },
      { folder: "Lens Edu", url: "ftp://x/a.png" },
      { folder: "Lens Edu", url: "https://x/a.png", file_path: "/fig.png" },
      { folder: "Lens Edu", url: "https://x/a.png", file_path: "/attachments/sub/fig.png" },
      { folder: "Lens Edu", url: "https://x/a.png", file_path: "/attachments/fig.svg" },
      { folder: "Lens Edu", url: "https://x/a.png", file_path: "/attachments/fig.png", stem: "fig" },
      { folder: "Lens Edu", url: "https://x/a.png", stem: "Not Kebab" },
      { folder: "Lens Edu", content_base64: "aGk=" }, // base64 needs a name
      { folder: "Lens Edu", url: "https://x/a.png", overwrite: "yes" },
    ];
    for (const body of cases) {
      const resp = await post(body);
      expect(resp.status, JSON.stringify(body)).toBe(400);
    }
    expect(deps.fetchBytes).not.toHaveBeenCalled();
    expect(deps.upload).not.toHaveBeenCalled();
  });

  // ---- happy paths ----
  it("fetches a url, names the file <stem>-<sha8>.<ext> and uploads it", async () => {
    const resp = await post({ folder: "Lens Edu", url: "https://cdn.example/Fig 1.png", mimetype: "image/jpeg" });
    expect(resp.status).toBe(200);
    const data = await resp.json();
    expect(data.path).toBe(`/attachments/fig-1-${PNG_SHA.slice(0, 8)}.png`);
    expect(data.sha256).toBe(PNG_SHA);
    expect(data.bytes).toBe(PNG.byteLength);
    expect(data.mimetype).toBe("image/png");
    expect(data.created).toBe(true);
    expect(data.overwritten).toBe(false);
    expect(data.deduplicated_from).toBeNull();
    expect(data.uuid).toBe("uuid-1");
    // Advisory mimetype loses to the magic bytes, with a warning.
    expect(data.warnings.join(" ")).toMatch(/image\/jpeg ignored/);
    expect(deps.findByHash).toHaveBeenCalledWith("Lens Edu", PNG_SHA, expect.anything());
    const [folder, path, bytes, mime, , opts] = deps.upload.mock.calls[0];
    expect(folder).toBe("Lens Edu");
    expect(path).toBe(data.path);
    expect(Buffer.from(bytes).equals(PNG)).toBe(true);
    expect(mime).toBe("image/png");
    expect(opts).toEqual({ overwrite: false });
  });

  it("decodes base64 and honours an explicit stem", async () => {
    const resp = await post({ folder: "Lens Edu", content_base64: PNG.toString("base64"), stem: "chart" });
    expect(resp.status).toBe(200);
    const data = await resp.json();
    expect(data.path).toBe(`/attachments/chart-${PNG_SHA.slice(0, 8)}.png`);
    expect(deps.fetchBytes).not.toHaveBeenCalled();
    expect(Buffer.from(deps.upload.mock.calls[0][2]).equals(PNG)).toBe(true);
  });

  it("rejects malformed base64 instead of decoding garbage", async () => {
    const resp = await post({ folder: "Lens Edu", content_base64: "not*base64!", stem: "x" });
    expect(resp.status).toBe(400);
    expect(deps.upload).not.toHaveBeenCalled();
    expect(() => decodeBase64Strict("abc")).not.toThrow(); // padding optional
    expect(() => decodeBase64Strict("a")).toThrow();
    expect(() => decodeBase64Strict("  ")).toThrow();
  });

  // ---- type allowlist ----
  it("rejects svg and non-image bytes with 415, whatever the declared type", async () => {
    deps.fetchBytes.mockResolvedValueOnce({ bytes: SVG.buffer.slice(SVG.byteOffset, SVG.byteOffset + SVG.byteLength), contentType: "image/svg+xml" });
    let resp = await post({ folder: "Lens Edu", url: "https://x/a.svg" });
    expect(resp.status).toBe(415);
    expect((await resp.json()).error).toMatch(/SVG is not accepted/);

    resp = await post({ folder: "Lens Edu", content_base64: Buffer.from("<html>nope</html>").toString("base64"), stem: "x", mimetype: "image/png" });
    expect(resp.status).toBe(415);
    expect(deps.upload).not.toHaveBeenCalled();
  });

  it("requires file_path's extension to match the sniffed type", async () => {
    deps.fetchBytes.mockResolvedValueOnce({ bytes: JPEG.buffer.slice(JPEG.byteOffset, JPEG.byteOffset + JPEG.byteLength), contentType: "" });
    const resp = await post({ folder: "Lens Edu", url: "https://x/a", file_path: "/attachments/fig.png" });
    expect(resp.status).toBe(400);
    expect((await resp.json()).error).toMatch(/use \.jpg/);
    // .jpeg and .jpg are both fine for a jpeg.
    deps.fetchBytes.mockResolvedValueOnce({ bytes: JPEG.buffer.slice(JPEG.byteOffset, JPEG.byteOffset + JPEG.byteLength), contentType: "" });
    expect((await post({ folder: "Lens Edu", url: "https://x/a", file_path: "/attachments/fig.jpeg" })).status).toBe(200);
  });

  // ---- limits ----
  it("enforces the 20 MiB hard limit and warns above the 5 MiB soft limit", async () => {
    const big = Buffer.concat([PNG, Buffer.alloc(SOFT_ATTACHMENT_BYTES)]);
    deps.fetchBytes.mockResolvedValueOnce({ bytes: big.buffer.slice(big.byteOffset, big.byteOffset + big.byteLength), contentType: "image/png" });
    let resp = await post({ folder: "Lens Edu", url: "https://x/big.png" });
    expect(resp.status).toBe(200);
    expect((await resp.json()).warnings.join(" ")).toMatch(/soft limit/);

    const huge = Buffer.concat([PNG, Buffer.alloc(MAX_ATTACHMENT_BYTES)]);
    deps.fetchBytes.mockResolvedValueOnce({ bytes: huge.buffer.slice(huge.byteOffset, huge.byteOffset + huge.byteLength), contentType: "image/png" });
    resp = await post({ folder: "Lens Edu", url: "https://x/huge.png" });
    expect(resp.status).toBe(413);

    deps.fetchBytes.mockRejectedValueOnce(new Error("Response too large: >20971520 bytes"));
    resp = await post({ folder: "Lens Edu", url: "https://x/stream.png" });
    expect(resp.status).toBe(413);

    deps.fetchBytes.mockResolvedValueOnce({ bytes: new ArrayBuffer(0), contentType: "image/png" });
    resp = await post({ folder: "Lens Edu", url: "https://x/empty.png" });
    expect(resp.status).toBe(422);
  });

  it("maps SSRF refusals and fetch failures to client-visible errors", async () => {
    deps.fetchBytes.mockRejectedValueOnce(new SsrfError("Refusing to fetch private address: 10.0.0.1"));
    let resp = await post({ folder: "Lens Edu", url: "https://internal/a.png" });
    expect(resp.status).toBe(400);
    expect((await resp.json()).error).toMatch(/private address/);

    deps.fetchBytes.mockRejectedValueOnce(new Error("Fetch failed: 403 Forbidden"));
    resp = await post({ folder: "Lens Edu", url: "https://blocked/a.png" });
    expect(resp.status).toBe(502);
  });

  // ---- dedup / overwrite / conflict ----
  it("returns the existing path when the folder already has these bytes", async () => {
    deps.findByHash.mockResolvedValueOnce({ path: "/attachments/earlier-1a2b3c4d.png", uuid: "uuid-old", doc_id: "relay-uuid-old", mimetype: "image/png" });
    const resp = await post({ folder: "Lens Edu", url: "https://x/a.png", stem: "again" });
    expect(resp.status).toBe(200);
    const data = await resp.json();
    expect(data.created).toBe(false);
    expect(data.path).toBe("/attachments/earlier-1a2b3c4d.png");
    expect(data.deduplicated_from).toBe("/attachments/earlier-1a2b3c4d.png");
    expect(data.uuid).toBe("uuid-old");
    expect(deps.upload).not.toHaveBeenCalled();
  });

  it("overwrite:true with file_path skips dedup and passes the flag through", async () => {
    deps.findByHash.mockResolvedValueOnce({ path: "/attachments/elsewhere.png", uuid: "u", doc_id: "d", mimetype: "image/png" });
    deps.upload.mockResolvedValueOnce({ doc_id: "relay-uuid-1", uuid: "uuid-1", path: "Lens Edu/attachments/fig.png", hash: PNG_SHA, created: false, overwritten: true });
    const resp = await post({ folder: "Lens Edu", url: "https://x/a.png", file_path: "/attachments/fig.png", overwrite: true });
    expect(resp.status).toBe(200);
    const data = await resp.json();
    expect(data.overwritten).toBe(true);
    expect(data.created).toBe(false);
    expect(data.deduplicated_from).toBeNull();
    expect(deps.findByHash).not.toHaveBeenCalled();
    expect(deps.upload.mock.calls[0][5]).toEqual({ overwrite: true });
  });

  it("maps the relay's 409 to a 409 naming the existing hash", async () => {
    deps.upload.mockRejectedValueOnce(new RelayAttachmentConflictError("/attachments/fig.png", "deadbeef".repeat(8), "taken"));
    const resp = await post({ folder: "Lens Edu", url: "https://x/a.png", file_path: "/attachments/fig.png" });
    expect(resp.status).toBe(409);
    const data = await resp.json();
    expect(data.existing_hash).toBe("deadbeef".repeat(8));
    expect(data.error).toMatch(/overwrite:true/);
  });

  it("reports an unchanged upload (same bytes at the same path) as deduplicated", async () => {
    deps.upload.mockResolvedValueOnce({ doc_id: "", uuid: "uuid-1", path: "Lens Edu/attachments/fig.png", hash: PNG_SHA, created: false, overwritten: false });
    const resp = await post({ folder: "Lens Edu", url: "https://x/a.png", file_path: "/attachments/fig.png" });
    const data = await resp.json();
    expect(data.created).toBe(false);
    expect(data.deduplicated_from).toBe("/attachments/fig.png");
  });
});

describe("stemFromUrl", () => {
  it("kebab-cases the last path segment without its extension", () => {
    expect(stemFromUrl("https://cdn.example/img/Fig_1%20(final).PNG?x=1")).toBe("fig-1-final");
    expect(stemFromUrl("https://cdn.example/")).toBe("image");
    expect(stemFromUrl("not a url")).toBe("image");
    expect(stemFromUrl("https://x/" + "a".repeat(200) + ".png").length).toBeLessThanOrEqual(80);
  });
});
