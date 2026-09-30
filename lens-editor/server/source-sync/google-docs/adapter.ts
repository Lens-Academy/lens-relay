import { GoogleDocsClient, GoogleHttpError, loadServiceAccount, selectTab } from "./client";
import { convertDocumentTab } from "./to-markdown";
import { googleDocEditUrl, parseGoogleDocUrl } from "./url";
import { PermanentImageError, type SourceAdapter } from "../types";
import limits from "../../../shared/attachment-limits.json";

// Images are fetched a few at a time: a chapter holds 80+ of them.
const IMAGE_CONCURRENCY = 4;
// Hosted URLs are reused across runs, keyed by the image's object id. The
// id is stable while the image stays in the doc; re-checking daily bounds
// how long a replaced image that kept its id could go unnoticed.
const IMAGE_CACHE_MS = 24 * 60 * 60 * 1000;

async function eachLimited<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/** An image that failed for a reason that will not go away by retrying. */
function lasting(err: unknown): boolean {
  return (
    err instanceof PermanentImageError ||
    (err instanceof GoogleHttpError && err.status >= 400 && err.status < 500 && err.status !== 429)
  );
}

/**
 * Google Docs links -> Lens article markdown, via the Docs API.
 * `client` is built on first use, so a server without Google credentials
 * starts normally and each sync run reports the missing key.
 */
export function googleDocAdapter(
  makeClient: () => GoogleDocsClient = () => new GoogleDocsClient(loadServiceAccount()),
): SourceAdapter {
  let client: GoogleDocsClient | null = null;
  const hosted = new Map<string, { url: string; at: number }>();

  return {
    kind: "google-doc",

    matches: (url) => parseGoogleDocUrl(url) !== null,

    async pull(binding, hostImage) {
      const ref = parseGoogleDocUrl(binding.source);
      if (!ref) throw new Error(`not a Google Docs link: ${binding.source}`);
      client ??= makeClient();

      const doc = await client.getDocument(ref.documentId);
      const tab = selectTab(doc, ref.tabId);
      const content = tab.documentTab;
      if (!content) throw new Error(`Google Doc ${ref.documentId} tab ${ref.tabId} has no content`);
      const warnings: string[] = [];
      if (tab.childTabs?.length) warnings.push(`${tab.childTabs.length} child tab(s) of this tab are not synced; bind them separately`);

      // A lasting failure (wrong type, too large, gone) is reported and the image left out. A
      // passing one (network, 5xx, relay) fails the run, so the file keeps its images.
      const urls = new Map<string, string>();
      const passing: string[] = [];
      const now = Date.now();
      await eachLimited(Object.entries(content.inlineObjects ?? {}), IMAGE_CONCURRENCY, async ([id, obj]) => {
        const key = `${binding.target}#${id}`;
        const cached = hosted.get(key);
        if (cached && now - cached.at < IMAGE_CACHE_MS) {
          urls.set(id, cached.url);
          return;
        }
        const contentUri = obj.inlineObjectProperties?.embeddedObject?.imageProperties?.contentUri;
        if (!contentUri) return;
        try {
          const url = await hostImage(await client!.getImage(contentUri, limits.max_bytes));
          urls.set(id, url);
          hosted.set(key, { url, at: now });
        } catch (err) {
          const message = `image ${id}: ${(err as Error).message}`;
          if (lasting(err)) warnings.push(message);
          else passing.push(message);
        }
      });
      if (passing.length) {
        throw new Error(`${passing.length} image(s) failed, so the file is left as it was: ${passing.join("; ")}`);
      }

      const converted = convertDocumentTab(content, { imageUrl: (id) => urls.get(id) ?? null });
      return {
        editUrl: googleDocEditUrl(ref),
        title: converted.title ?? doc.title ?? null,
        description: converted.description,
        body: converted.body,
        warnings: [...warnings, ...converted.warnings],
      };
    },
  };
}
