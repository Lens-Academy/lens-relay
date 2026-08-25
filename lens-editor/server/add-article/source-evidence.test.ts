import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  bytes: new Uint8Array(),
  via: "pdf" as string,
  fetchRawBytes: vi.fn(),
  extractPdfSmart: vi.fn(),
}));

vi.mock("./fetch", async () => {
  const actual = await vi.importActual<typeof import("./fetch")>("./fetch");
  return { ...actual, fetchRawBytes: mocks.fetchRawBytes };
});

vi.mock("./pdf", () => ({
  extractPdfSmart: mocks.extractPdfSmart,
}));

import { buildSourceEvidence, writeSourceEvidence } from "./source-evidence";
import { sourceReviewDigest } from "./review-digest";

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  vi.clearAllMocks();
});

describe("PDF source evidence retention", () => {
  it.each(["pdf-datalab", "pdf"])("preserves byte-identical evidence through %s extraction", async (via) => {
    const fixturePath = path.join(
      process.cwd(),
      "server/add-article/eval/fixtures-pdf/needforbias-1980/article.pdf",
    );
    mocks.bytes = new Uint8Array(await fs.readFile(fixturePath));
    mocks.via = via;
    mocks.fetchRawBytes.mockImplementation(async () => ({
      bytes: mocks.bytes.buffer.slice(mocks.bytes.byteOffset, mocks.bytes.byteOffset + mocks.bytes.byteLength),
      contentType: "application/pdf",
      finalUrl: "https://example.org/article.pdf",
    }));
    mocks.extractPdfSmart.mockImplementation(async (bytes: ArrayBuffer) => {
      expect(bytes.byteLength).toBeGreaterThan(0);
      // Reproduce pdf.js ownership semantics: the extraction copy is detached.
      structuredClone(bytes, { transfer: [bytes] });
      return {
        body: "A retained PDF article body with enough source text for review.",
        meta: { title: "PDF", author: ["Author"], source_url: "https://example.org/article.pdf", published: "2020-01-01", description: "" },
        siteName: "",
        via: mocks.via,
        linkedOut: false,
        assessment: { score: 1, flags: [] },
        images: [],
      };
    });

    const evidence = await buildSourceEvidence("https://example.org/article.pdf");
    expect(evidence.pdf?.byteLength).toBe(mocks.bytes.byteLength);
    expect(evidence.pdf?.equals(Buffer.from(mocks.bytes))).toBe(true);
    expect(evidence.manifest.source_digest).toBe(sourceReviewDigest(Buffer.from(mocks.bytes)));
    expect(evidence.manifest.source_digest).not.toBe(sourceReviewDigest(Buffer.alloc(0)));

    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-evidence-"));
    tempDirs.push(workDir);
    await writeSourceEvidence(workDir, evidence);
    const retained = await fs.readFile(path.join(workDir, "evidence/source.pdf"));
    expect(retained.byteLength).toBeGreaterThan(0);
    expect(retained.equals(Buffer.from(mocks.bytes))).toBe(true);
  });
});
