import { fetchBytesWithTimeout, bytesToText } from "../fetch-timeout";
import type { PdfPageImage } from "./pdf-images";

/**
 * Hosted PDF→Markdown parsing via the Datalab Marker API — real Markdown
 * structure (headings, tables, math), scanned-PDF OCR, and figure images in
 * the text flow. Selected purely by DATALAB_API_KEY being set; without a key
 * (or on any provider error) the caller falls back to local unpdf extraction,
 * so the parser is an upgrade, never a gate. Async API: submit, poll a check
 * URL until complete. Output reduces to markdown with `![[__pdfimg_N__]]`
 * placeholders + an images array, so the pipeline's existing upload-and-embed
 * step works unchanged.
 */

const DATALAB_API_URL = "https://www.datalab.to/api/v1/convert";

const SUBMIT_TIMEOUT_MS = 120_000; // upload
const POLL_TIMEOUT_MS = 30_000; // one Datalab status poll
const POLL_INTERVAL_MS = 2_000;
const POLL_BUDGET_MS = 6 * 60_000; // total Datalab wait before falling back

export type PdfProviderName = "datalab";

export interface ProviderParse {
  provider: PdfProviderName;
  /** Markdown body with `![[__pdfimg_N__]]` placeholders where figures sit. */
  body: string;
  /** Figure bytes, index-aligned with the placeholders. */
  images: PdfPageImage[];
}

/** Datalab when its key is set; null ⇒ local extraction. */
export function configuredPdfProvider(): PdfProviderName | null {
  return process.env.DATALAB_API_KEY ? "datalab" : null;
}

function mimeFromName(name: string): string {
  if (/\.jpe?g$/i.test(name)) return "image/jpeg";
  if (/\.webp$/i.test(name)) return "image/webp";
  if (/\.gif$/i.test(name)) return "image/gif";
  return "image/png";
}

/** Strip a data-URL prefix if present; return raw base64 payload. */
function rawBase64(b64: string): string {
  const m = b64.match(/^data:[^;]+;base64,(.*)$/s);
  return m ? m[1] : b64;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Replace a provider's own image references (`![…](<name>)`) with our
 * `![[__pdfimg_N__]]` placeholders and return the referenced images in
 * placeholder order. Unreferenced images are dropped — a figure the markdown
 * never cites is usually a background/decoration crop.
 */
export function substituteImageRefs(
  markdown: string,
  images: Array<{ name: string; base64: string }>,
): { body: string; images: PdfPageImage[] } {
  let body = markdown;
  const used: PdfPageImage[] = [];
  for (const img of images) {
    // A blank name would build a regex matching ANY empty `![]()` ref and
    // hijack stray image syntax in the body.
    if (!img.name || !img.name.trim()) continue;
    const ref = new RegExp(
      `!\\[[^\\]]*\\]\\(\\s*${escapeRegExp(img.name)}\\s*\\)`,
      "g",
    );
    if (!ref.test(body)) continue;
    const placeholder = `![[__pdfimg_${used.length}__]]`;
    body = body.replace(ref, placeholder);
    let bytes: Buffer;
    try {
      bytes = Buffer.from(rawBase64(img.base64), "base64");
    } catch {
      body = body.split(placeholder).join(""); // undecodable — drop the figure
      continue;
    }
    if (bytes.length === 0) {
      body = body.split(placeholder).join("");
      continue;
    }
    used.push({
      png: bytes,
      mime: mimeFromName(img.name),
      yTop: 0,
      width: 0,
      height: 0,
    });
  }
  return { body: body.replace(/\n{3,}/g, "\n\n").trim(), images: used };
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error("Aborted"));
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal?.reason ?? new Error("Aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

interface DatalabResult {
  status?: string;
  success?: boolean;
  error?: string;
  markdown?: string;
  images?: Record<string, string>;
  request_check_url?: string;
}

/** Datalab Marker: multipart submit, then poll the check URL until complete. */
async function parseWithDatalab(
  bytes: ArrayBuffer,
  signal?: AbortSignal,
): Promise<ProviderParse> {
  const apiKey = process.env.DATALAB_API_KEY!;

  const form = new FormData();
  form.append(
    "file",
    new Blob([new Uint8Array(bytes)], { type: "application/pdf" }),
    "document.pdf",
  );
  form.append("output_format", "markdown");

  const submit = await fetchBytesWithTimeout(DATALAB_API_URL, {
    method: "POST",
    headers: { "X-Api-Key": apiKey },
    body: form,
    timeoutMs: SUBMIT_TIMEOUT_MS,
    signal,
  });
  if (!submit.ok) {
    throw new Error(
      `Datalab submit failed: ${submit.status} ${bytesToText(submit.bytes).slice(0, 300)}`,
    );
  }
  const submitted = JSON.parse(bytesToText(submit.bytes)) as DatalabResult;
  if (submitted.success === false || !submitted.request_check_url) {
    throw new Error(`Datalab rejected the document: ${submitted.error || "no check URL"}`);
  }

  const deadline = Date.now() + POLL_BUDGET_MS;
  for (;;) {
    await abortableSleep(POLL_INTERVAL_MS, signal);
    const poll = await fetchBytesWithTimeout(submitted.request_check_url, {
      headers: { "X-Api-Key": apiKey },
      timeoutMs: POLL_TIMEOUT_MS,
      signal,
    });
    if (!poll.ok) {
      throw new Error(`Datalab poll failed: ${poll.status}`);
    }
    const result = JSON.parse(bytesToText(poll.bytes)) as DatalabResult;
    // Any terminal status other than complete/processing is an error — fail
    // NOW with Datalab's own message instead of spinning the full poll budget
    // and discarding the reason behind a generic timeout.
    if (
      result.success === false ||
      (result.status && !["complete", "processing"].includes(result.status))
    ) {
      throw new Error(
        `Datalab parse failed (status=${result.status ?? "?"}): ${result.error || "unknown error"}`,
      );
    }
    if (result.status === "complete") {
      // success===false is already handled by the terminal-status guard above.
      const markdown = (result.markdown || "").trim();
      if (!markdown) throw new Error("Datalab returned an empty document");
      const { body, images } = substituteImageRefs(
        markdown,
        Object.entries(result.images || {}).map(([name, base64]) => ({
          name,
          base64,
        })),
      );
      return { provider: "datalab", body, images };
    }
    if (Date.now() > deadline) {
      throw new Error(`Datalab parse still processing after ${POLL_BUDGET_MS / 60_000} min`);
    }
  }
}


/**
 * Parse a PDF with Datalab. Throws on provider errors — the caller
 * (extractPdfSmart) logs and falls back to local extraction.
 */
export async function parsePdfWithProvider(
  bytes: ArrayBuffer,
  signal?: AbortSignal,
): Promise<ProviderParse> {
  return parseWithDatalab(bytes, signal);
}
