import {
  listRelayFrontmatters,
  relayArticleFolder,
  relayTranscriptFolder,
  type RelayDocFrontmatter,
} from "../add-video/relay-docs";
import { extractVideoInput } from "../add-video/video-url";
import { frontmatterText, parseFrontmatter } from "../yaml";
import { ARTICLE_STUB, VIDEO_STUB } from "./stub";
import { normalizeImportKey, normalizeUrlForDedup, sameSource } from "./url-normalize";

/** Data older than this is served while a new scan runs. */
const STALE_MS = 15 * 60_000;
/** Wait after a failed scan: a poll must not rescan a relay that is down. */
const FAILED_SCAN_RETRY_MS = 60_000;

const STUB_TAGS: string[] = [ARTICLE_STUB.tag, VIDEO_STUB.tag];

export interface LibraryEntry {
  /** Full relay path, e.g. "Lens Edu/articles/x.md". */
  path: string;
  title?: string;
  /** A page with no text yet, which a full import fills in. */
  stub: boolean;
  /** The URL it was imported from: `source_url`, or a transcript's `url`. */
  sourceUrl: string;
}

export interface LibraryDocs {
  articles: RelayDocFrontmatter[];
  transcripts: RelayDocFrontmatter[];
}

interface LibraryIndexOptions {
  /** Reads the library. Default: the relay, except in tests. */
  load?: () => Promise<LibraryDocs>;
  staleMs?: number;
  failedScanRetryMs?: number;
}

function hasStubTag(tags: unknown): boolean {
  const list = Array.isArray(tags)
    ? tags
    : typeof tags === "string"
      ? tags.split(",").map((tag) => tag.trim())
      : [];
  return list.some((tag) => STUB_TAGS.includes(tag));
}

interface StoredSource {
  key: string;
  sourceUrl: string;
}

function articleSource(fields: Record<string, unknown>): StoredSource | null {
  const sourceUrl = frontmatterText(fields.source_url);
  return sourceUrl ? { key: normalizeUrlForDedup(sourceUrl), sourceUrl } : null;
}

/** Transcripts keep their link in `url` (add-video/export.ts). */
function transcriptSource(fields: Record<string, unknown>): StoredSource | null {
  const sourceUrl = frontmatterText(fields.url);
  const video = sourceUrl ? extractVideoInput(sourceUrl) : null;
  return video && sourceUrl ? { key: `yt:${video.video_id}`, sourceUrl } : null;
}

/** The index's entries for a scan. One bad document costs only that document;
 *  where a source has a stub and a full copy, the full copy wins. */
export function buildLibraryEntries(docs: LibraryDocs): {
  entries: Map<string, LibraryEntry>;
  unreadable: number;
} {
  const entries = new Map<string, LibraryEntry>();
  let unreadable = 0;
  const addDocs = (
    list: RelayDocFrontmatter[],
    sourceOf: (fields: Record<string, unknown>) => StoredSource | null,
  ) => {
    for (const { path, frontmatter } of list) {
      if (!frontmatter || path.includes("/_trash/")) continue;
      const fields = parseFrontmatter(frontmatter);
      if (!fields) {
        unreadable += 1;
        continue;
      }
      const source = sourceOf(fields);
      if (!source) continue;
      const stub = hasStubTag(fields.tags);
      const current = entries.get(source.key);
      if (!current || (current.stub && !stub)) {
        entries.set(source.key, {
          path,
          title: frontmatterText(fields.title),
          stub,
          sourceUrl: source.sourceUrl,
        });
      }
    }
  };
  addDocs(docs.articles, articleSource);
  addDocs(docs.transcripts, transcriptSource);
  return { entries, unreadable };
}

async function scanRelayLibrary(): Promise<LibraryDocs> {
  // One after the other: each scan can load every document it touches.
  const articles = await listRelayFrontmatters(relayArticleFolder());
  const transcripts = await listRelayFrontmatters(relayTranscriptFolder());
  return { articles, transcripts };
}

/**
 * What the library holds, by source. The relay scans and this decides, because
 * the URL spelling rules live in TypeScript; a scan is too slow to run per
 * lookup, so its result is kept here and refreshed behind the callers' backs.
 */
export class LibraryIndex {
  private entries = new Map<string, LibraryEntry>();
  /** Added since the running scan began, so it may not have seen them. */
  private added = new Map<string, LibraryEntry>();
  private loadedAt: number | null = null;
  private failedAt: number | null = null;
  private scanning = false;
  private readonly load: (() => Promise<LibraryDocs>) | null;
  private readonly staleMs: number;
  private readonly failedScanRetryMs: number;

  constructor(options: LibraryIndexOptions = {}) {
    // Tests never reach a relay by accident, even with RELAY_URL exported.
    this.load = options.load ?? (process.env.NODE_ENV === "test" ? null : scanRelayLibrary);
    this.staleMs = options.staleMs ?? STALE_MS;
    this.failedScanRetryMs = options.failedScanRetryMs ?? FAILED_SCAN_RETRY_MS;
  }

  /** Starts a scan if the data is missing or stale, and never waits for it.
   *  False until a first scan has finished: the index knows too little to say
   *  a source is new. */
  ensureLoaded(): boolean {
    const now = Date.now();
    const stale = this.loadedAt === null || now - this.loadedAt >= this.staleMs;
    const backingOff = this.failedAt !== null && now - this.failedAt < this.failedScanRetryMs;
    if (stale && !backingOff) this.scan();
    return this.loadedAt !== null;
  }

  /** The library's copy of this exact page. An answer here can rewrite a link
   *  at once, so a dedup key alone isn't enough (`sameSource`); a miss goes to
   *  an ordinary job. */
  lookup(url: string): LibraryEntry | undefined {
    const entry = this.entries.get(normalizeImportKey(url));
    return entry && sameSource(url, entry.sourceUrl) ? entry : undefined;
  }

  /** A finished import, shown at once rather than after the next scan. */
  add({ url, ...entry }: Omit<LibraryEntry, "sourceUrl"> & { url: string }): void {
    const key = normalizeImportKey(url);
    const added = { ...entry, title: entry.title ?? this.entries.get(key)?.title, sourceUrl: url };
    this.entries.set(key, added);
    this.added.set(key, added);
  }

  private scan(): void {
    const load = this.load;
    if (!load || this.scanning) return;
    this.scanning = true;
    this.added.clear();
    void Promise.resolve()
      .then(load)
      .then((docs) => {
        const { entries, unreadable } = buildLibraryEntries(docs);
        for (const [key, entry] of this.added) entries.set(key, entry);
        this.entries = entries;
        this.loadedAt = Date.now();
        this.failedAt = null;
        console.log(
          `[add-article] library index: ${entries.size} sources` +
            (unreadable ? `, ${unreadable} documents with unreadable frontmatter` : ""),
        );
      })
      .catch((error) => {
        this.failedAt = Date.now();
        console.error(`[add-article] library index scan failed, keeping what it had: ${error}`);
      })
      .finally(() => {
        this.scanning = false;
      });
  }
}

let shared: LibraryIndex | undefined;

/** The index the queue and the routes share. */
export function sharedLibraryIndex(): LibraryIndex {
  return (shared ??= new LibraryIndex());
}
