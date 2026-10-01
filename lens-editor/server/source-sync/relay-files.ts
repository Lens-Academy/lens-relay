/**
 * SyncFiles over the relay's server-token HTTP API -- the same authenticated
 * path the article importer writes through, never storage directly.
 */

import { posix } from "node:path";
import { createRelayDoc, readRelayDocText, resolveRelayDocIdByPath } from "../add-video/relay-docs";
import { attachmentPublicUrl } from "../attachments/public-url";
import { defaultAttachmentRouteDeps, importAttachment } from "../attachments/routes";
import { PermanentImageError, type SyncFiles } from "./types";

/** "Lens Edu/articles/Chapter 1 - Capabilities.md" -> "chapter-1-capabilities" (attachment name stem). */
function stemOf(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/, "");
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60).replace(/-$/, "") || "synced";
}

/** Relay failures named as the relay's (not Google's), with the path. */
async function relay<T>(what: string, path: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (err) {
    const message = (err as Error).message;
    // A 404 on write usually means the top-level folder name is wrong.
    const hint = what === "writing" && / 404\b/.test(message) ? ` (does the top-level folder "${path.split("/")[0]}" exist?)` : "";
    throw new Error(`Relay: ${what} "${path}" failed: ${message}${hint}`);
  }
}

export function relayFiles(): SyncFiles {
  const unpublishedFolders = new Set<string>();

  return {
    read: (path) =>
      relay("reading", path, async () => {
        const id = await resolveRelayDocIdByPath(path);
        return id ? readRelayDocText(id) : null;
      }),

    write: (path, content) => relay("writing", path, () => createRelayDoc(path, content)),

    async hostImage(targetPath, bytes) {
      const folder = targetPath.slice(0, targetPath.indexOf("/"));
      let path: string;
      try {
        // The MCP import_attachment path: type and size checks, dedup by content, hashed name.
        ({ path } = await importAttachment(
          { folder, content_base64: Buffer.from(bytes).toString("base64"), stem: stemOf(targetPath) },
          defaultAttachmentRouteDeps(),
          () => true,
        ));
      } catch (err) {
        // 413/415/422: too large, not an image type Lens hosts, or empty -- retrying will not help.
        const status = (err as { status?: number }).status;
        if (status === 413 || status === 415 || status === 422) throw new PermanentImageError((err as Error).message);
        throw new Error(`Relay: hosting an image failed: ${(err as Error).message}`);
      }

      // Lens (and the editor preview) render only absolute image URLs: the
      // folder's public mirror. A folder without one gets a relative path,
      // which only a local test folder should ever need.
      const publicUrl = attachmentPublicUrl(folder, path);
      if (publicUrl) return publicUrl;
      if (!unpublishedFolders.has(folder)) {
        unpublishedFolders.add(folder);
        console.warn(`[source-sync] "${folder}" has no public attachment URL (ATTACHMENT_PUBLIC_URLS); images will not display`);
      }
      return posix.relative(posix.dirname(targetPath.slice(folder.length)), path);
    },
  };
}
