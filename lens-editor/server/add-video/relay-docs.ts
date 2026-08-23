import * as Y from "yjs";
import { fetchBytesWithTimeout, bytesToText } from "../fetch-timeout";

// The relay server is known to occasionally hang while background tasks keep
// running. Without a deadline, one hung relay call blocks its import job forever
// (and, in add-article, wedges the serialized write lock for ALL later jobs).
const RELAY_CHECK_TIMEOUT_MS = 30_000;
const RELAY_WRITE_TIMEOUT_MS = 60_000; // upserts/attachments carry larger payloads

function getRelayConfig() {
  const url = process.env.RELAY_URL || "http://relay-server:8080";
  const token = process.env.RELAY_SERVER_TOKEN || "";
  return { url, token };
}

/** Relay folder video transcripts live in, e.g. "Lens Edu/video_transcripts". */
export function relayTranscriptFolder(): string {
  return process.env.RELAY_TRANSCRIPT_FOLDER || "Lens Edu/video_transcripts";
}

/** Editor URL a relay document at this path opens under. */
export function editorOpenUrl(docPath: string): string {
  const editorBase =
    process.env.EDITOR_BASE_URL || "https://editor.lensacademy.org";
  return `${editorBase}/open/${encodeURI(docPath)}`;
}

/**
 * Create or update a document in Relay via the internal HTTP API.
 * Uses POST /doc/upsert — creates if new, replaces content if exists.
 */
async function upsertRelayDoc(
  filePath: string,
  content: string,
  signal?: AbortSignal,
): Promise<{ doc_id: string; path: string; created: boolean }> {
  const { url, token } = getRelayConfig();

  // Split "Folder Name/sub/path/file.md" into folder + path
  const slashIdx = filePath.indexOf("/");
  if (slashIdx === -1) {
    throw new Error(`Invalid file path (no folder): ${filePath}`);
  }
  const folder = filePath.slice(0, slashIdx);
  const path = "/" + filePath.slice(slashIdx + 1);

  const resp = await fetchBytesWithTimeout(`${url}/doc/upsert`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ folder, path, content }),
    timeoutMs: RELAY_WRITE_TIMEOUT_MS,
    signal,
  });

  if (!resp.ok) {
    throw new Error(
      `Relay upsert failed: ${resp.status} ${bytesToText(resp.bytes)}`,
    );
  }

  return JSON.parse(bytesToText(resp.bytes)) as {
    doc_id: string;
    path: string;
    created: boolean;
  };
}

/**
 * Create or replace a document and return its relay doc id.
 *
 * The id is what makes the document readable again later (see
 * readRelayDocText), which is how a background pass can tell whether the
 * document it wrote is still the one in the relay.
 */
export async function upsertRelayDocReturningId(
  filePath: string,
  content: string,
  signal?: AbortSignal,
): Promise<string> {
  const { doc_id } = await upsertRelayDoc(filePath, content, signal);
  return doc_id;
}

/**
 * Read a document's current markdown back out of the relay.
 *
 * Documents are Y.Docs, so this mints a doc-scoped token, pulls the encoded
 * state and reads the `contents` Y.Text -- the same round-trip the editor
 * does over websocket.
 */
export async function readRelayDocText(
  docId: string,
  signal?: AbortSignal,
): Promise<string> {
  const { url, token } = getRelayConfig();

  const authResp = await fetchBytesWithTimeout(`${url}/doc/${docId}/auth`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ authorization: "full" }),
    timeoutMs: RELAY_WRITE_TIMEOUT_MS,
    signal,
  });
  if (!authResp.ok) {
    throw new Error(`Relay doc auth failed: ${authResp.status}`);
  }
  const auth = JSON.parse(bytesToText(authResp.bytes)) as {
    baseUrl: string;
    token: string;
  };

  const docResp = await fetchBytesWithTimeout(`${auth.baseUrl}/as-update`, {
    headers: { Authorization: `Bearer ${auth.token}` },
    timeoutMs: RELAY_WRITE_TIMEOUT_MS,
    signal,
  });
  if (!docResp.ok) {
    throw new Error(`Relay doc read failed: ${docResp.status}`);
  }

  const doc = new Y.Doc();
  Y.applyUpdate(doc, new Uint8Array(docResp.bytes));
  const text = doc.getText("contents").toString();
  doc.destroy();
  return text;
}

/** Create a new document in Relay */
export async function createRelayDoc(
  filePath: string,
  content: string,
  signal?: AbortSignal,
): Promise<void> {
  await upsertRelayDoc(filePath, content, signal);
}

/** Update an existing document with new content */
export async function updateRelayDoc(
  filePath: string,
  _oldContent: string,
  newContent: string,
  signal?: AbortSignal,
): Promise<void> {
  await upsertRelayDoc(filePath, newContent, signal);
}

/**
 * Check which paths already exist in a relay folder.
 * Returns a map of path → boolean.
 */
export async function checkRelayDocsExist(
  paths: string[],
  signal?: AbortSignal,
): Promise<Record<string, boolean>> {
  if (paths.length === 0) return {};

  const { url, token } = getRelayConfig();

  // All paths share the same folder prefix — extract from first path
  const slashIdx = paths[0].indexOf("/");
  if (slashIdx === -1) {
    throw new Error(`Invalid file path (no folder): ${paths[0]}`);
  }
  const folder = paths[0].slice(0, slashIdx);

  // Strip folder prefix from all paths, add leading /
  const relPaths = paths.map((p) => {
    const idx = p.indexOf("/");
    return "/" + p.slice(idx + 1);
  });

  const resp = await fetchBytesWithTimeout(`${url}/doc/check`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ folder, paths: relPaths }),
    timeoutMs: RELAY_CHECK_TIMEOUT_MS,
    signal,
  });

  if (!resp.ok) {
    throw new Error(
      `Relay check failed: ${resp.status} ${bytesToText(resp.bytes)}`,
    );
  }

  const data = JSON.parse(bytesToText(resp.bytes)) as {
    exists: Record<string, boolean>;
  };

  // Re-map back to full paths (folder/path)
  const result: Record<string, boolean> = {};
  for (let i = 0; i < paths.length; i++) {
    result[paths[i]] = data.exists[relPaths[i]] ?? false;
  }
  return result;
}

/**
 * Check which video IDs already have documents on the relay.
 * Searches document frontmatter for YouTube URLs containing each video ID.
 * Returns a map of video_id → matched relative path (or null if not found).
 */
export async function checkRelayVideoIds(
  videoIds: string[],
  signal?: AbortSignal,
): Promise<Record<string, string | null>> {
  if (videoIds.length === 0) return {};

  const { url, token } = getRelayConfig();

  const relayFolder = relayTranscriptFolder();
  const slashIdx = relayFolder.indexOf("/");
  const folder = slashIdx !== -1 ? relayFolder.slice(0, slashIdx) : relayFolder;
  const subfolder =
    slashIdx !== -1 ? relayFolder.slice(slashIdx + 1) : undefined;

  const resp = await fetchBytesWithTimeout(`${url}/doc/check-video-ids`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ folder, subfolder, video_ids: videoIds }),
    timeoutMs: RELAY_CHECK_TIMEOUT_MS,
    signal,
  });

  if (!resp.ok) {
    throw new Error(
      `Relay check-video-ids failed: ${resp.status} ${bytesToText(resp.bytes)}`,
    );
  }

  const data = JSON.parse(bytesToText(resp.bytes)) as {
    found: Record<string, string | null>;
  };
  return data.found;
}

/**
 * Check which source URLs already have an article document on the relay.
 * Matches the `source_url` frontmatter field (normalized) — the URL-based
 * duplicate check the add-article importer uses. Returns a map of source_url →
 * matched relative path (or null if not found).
 */
export async function checkRelayArticleUrls(
  sourceUrls: string[],
  signal?: AbortSignal,
): Promise<{
  found: Record<string, string | null>;
  stubs: Record<string, { path: string; content: string } | null>;
}> {
  if (sourceUrls.length === 0) return { found: {}, stubs: {} };

  const { url, token } = getRelayConfig();

  const relayFolder = process.env.RELAY_ARTICLE_FOLDER || "Lens Edu/articles";
  const slashIdx = relayFolder.indexOf("/");
  const folder = slashIdx !== -1 ? relayFolder.slice(0, slashIdx) : relayFolder;
  const subfolder =
    slashIdx !== -1 ? relayFolder.slice(slashIdx + 1) : undefined;

  const resp = await fetchBytesWithTimeout(`${url}/doc/check-source-urls`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ folder, subfolder, source_urls: sourceUrls }),
    timeoutMs: RELAY_CHECK_TIMEOUT_MS,
    signal,
  });

  if (!resp.ok) {
    throw new Error(
      `Relay check-source-urls failed: ${resp.status} ${bytesToText(resp.bytes)}`,
    );
  }

  const data = JSON.parse(bytesToText(resp.bytes)) as {
    found: Record<string, string | null>;
    stubs?: Record<string, { path: string; content: string } | null>;
  };
  return { found: data.found, stubs: data.stubs ?? {} };
}

/**
 * Upload a binary attachment (e.g. a figure image extracted from a PDF) to the
 * relay and register it as a `filemeta_v0` "image" entry, so markdown can embed
 * it via `![[/attachments/x.png]]`. `folder` is the relay folder's top segment
 * (e.g. "Lens Edu"); `inFolderPath` is the path within it (e.g.
 * "/attachments/x.png"). Create-only: an existing path is a no-op success.
 */
export async function createRelayAttachment(
  folder: string,
  inFolderPath: string,
  data: Uint8Array,
  mimetype: string,
  signal?: AbortSignal,
): Promise<void> {
  const { url, token } = getRelayConfig();
  const qs = new URLSearchParams({ folder, path: inFolderPath, mimetype });

  const resp = await fetchBytesWithTimeout(
    `${url}/doc/attachment?${qs.toString()}`,
    {
      method: "POST",
      headers: {
        "Content-Type": mimetype,
        Authorization: `Bearer ${token}`,
      },
      body: data,
      timeoutMs: RELAY_WRITE_TIMEOUT_MS,
      signal,
    },
  );

  if (!resp.ok) {
    throw new Error(
      `Relay attachment upload failed: ${resp.status} ${bytesToText(resp.bytes)}`,
    );
  }
}
