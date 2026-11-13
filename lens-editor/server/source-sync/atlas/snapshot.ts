/**
 * Step 1 of the Atlas sync: read each chapter tab through the Docs API, tell
 * a changed chapter from an unchanged one, and host the images of the
 * chapters whose articles the run writes.
 *
 * A chapter that cannot be read (the Doc is gone or not shared, the network
 * failed) is left out of the run, not the whole course: the run keeps its
 * files as they are and reads it again later.
 *
 * Neither a revision nor the image cache sees an image's bytes: the Docs API
 * gives only a download link, new on every read. An image replaced under
 * the same object with the same size, crop and source is therefore not
 * seen until its chapter is converted again with the cache expired (24 h);
 * any change to the object's properties changes the chapter's revision and
 * the image's cache key, so it is hosted again.
 */

import { createHash } from "node:crypto";
import { hostTabImages, type HostedImages } from "../google-docs/adapter";
import { selectTab, type GoogleDocsClient } from "../google-docs/client";
import type { DocsDocument, DocumentTab, InlineObject } from "../google-docs/docs-types";
import type { CourseFiles } from "../iliad/types";
import { PermanentImageError } from "../types";
import { chapterRef } from "./config";
import { hostable, toWebp, type ToWebp } from "./images";
import type { AtlasCourseConfig, AtlasSnapshot, ChapterSource } from "./types";

/** What the sync reads the Docs through: the Docs API in production, a saved dump in tests and the dry run. */
export interface AtlasDocs {
  getDocument(documentId: string): Promise<DocsDocument>;
  /** Bytes of an inline image of a chapter tab; `contentUri` is the tab's download link for it, valid about 30 minutes. */
  getImage(image: { docId: string; inlineObjectId: string; contentUri: string }): Promise<Uint8Array>;
}

/**
 * The most an image may be to be downloaded. Above the relay's 20 MiB limit,
 * which is for what is hosted: the Docs have GIFs of 22 and 35.5 MB that
 * are a few MB as WebP (images.ts).
 */
export const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;

export function googleAtlasDocs(client: GoogleDocsClient): AtlasDocs {
  return {
    getDocument: (documentId) => client.getDocument(documentId),
    async getImage({ contentUri }) {
      try {
        return await client.getImage(contentUri, MAX_DOWNLOAD_BYTES);
      } catch (err) {
        // A size the sync will never take: the article is written without the image, and the run warns.
        if (/Response too large/.test((err as Error).message)) throw new PermanentImageError(`over ${MAX_DOWNLOAD_BYTES / 1024 / 1024} MB, too large to download`);
        throw err;
      }
    },
  };
}

/**
 * A tab's revision, or an inline object's: a hash of its JSON without the
 * image download links, which change on every read. The Docs API gives
 * `revisionId` only to editors, and the sync reads as a viewer.
 */
export function tabRevision(tab: DocumentTab | InlineObject): string {
  const json = JSON.stringify(tab, (key, value: unknown) => (key === "contentUri" ? undefined : value));
  return createHash("sha256").update(json).digest("hex").slice(0, 16);
}

/**
 * One value for the state of all of a course's chapters, in order, for the
 * log and for telling a run that is blocked from one that is not. A chapter
 * that was not read counts as "unread".
 */
export function combinedRevision(revisions: (string | null)[]): string {
  return createHash("sha256").update(revisions.map((revision) => revision ?? "unread").join("\n")).digest("hex").slice(0, 12);
}

/** A configured chapter the run could not read, and why. */
export interface UnreadChapter {
  docId: string;
  url: string;
  reason: string;
}

/** Every configured chapter that could be read, in order, and the ones that could not. */
export async function readChapters(config: AtlasCourseConfig, docs: AtlasDocs): Promise<{ chapters: ChapterSource[]; unread: UnreadChapter[] }> {
  const read = await Promise.all(
    config.chapters.map(async ({ doc }): Promise<ChapterSource | UnreadChapter> => {
      const { docId, tabId, url } = chapterRef(doc);
      try {
        const tab = selectTab(await docs.getDocument(docId), tabId).documentTab;
        if (!tab) throw new Error(`tab ${tabId} has no content`);
        return { docId, url, tab, revision: tabRevision(tab) };
      } catch (err) {
        return { docId, url, reason: (err as Error).message };
      }
    }),
  );
  return {
    chapters: read.filter((chapter): chapter is ChapterSource => "tab" in chapter),
    unread: read.filter((chapter): chapter is UnreadChapter => !("tab" in chapter)),
  };
}

/**
 * Host the images of the chapters given, each under its own file-name stem
 * ("atlas-capabilities"), made small first (images.ts). The relay names an
 * image by the hash of what it is given, and the conversion gives the same
 * bytes for the same image, so an image hosted again is stored once.
 *
 * A chapter with an image that failed for a passing reason (network, 5xx,
 * the relay) is returned in `failed`: the run writes none of its articles,
 * so they keep their images. An image that can never be hosted is reported
 * and left out.
 */
export async function hostImages(
  hosting: { source: ChapterSource; stem: string }[],
  docs: AtlasDocs,
  files: CourseFiles,
  hosted: HostedImages,
  convert: ToWebp = toWebp,
): Promise<AtlasSnapshot & { failed: UnreadChapter[] }> {
  const urls = new Map<string, Map<string, string>>();
  const warnings: string[] = [];
  const failed: UnreadChapter[] = [];
  for (const { source, stem } of hosting) {
    const images = await hostTabImages(
      source.tab,
      async (contentUri, inlineObjectId) =>
        hostable(await docs.getImage({ docId: source.docId, inlineObjectId, contentUri }), convert, (warning) => warnings.push(`${stem}: image ${inlineObjectId} ${warning}`)),
      (bytes) => files.hostImage(bytes, stem),
      hosted,
      (id) => `${source.docId}#${id}#${tabRevision(source.tab.inlineObjects?.[id] ?? {})}`,
    );
    urls.set(source.docId, images.urls);
    warnings.push(...images.lasting.map((warning) => `${stem}: ${warning}; the article is written without it`));
    if (images.passing.length) failed.push({ docId: source.docId, url: source.url, reason: `${images.passing.length} image(s) could not be hosted: ${images.passing.join("; ")}` });
  }
  return { imageUrl: (docId, id) => urls.get(docId)?.get(id) ?? null, warnings, failed };
}
