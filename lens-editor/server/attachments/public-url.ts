/**
 * Public raw URL of an attachment once relay-git-sync has pushed it.
 *
 * The mapping folder -> raw base URL comes from ATTACHMENT_PUBLIC_URLS
 * (`Folder=https://base;Other=https://base2`), the same variable the relay
 * reads for the MCP import_attachment reply. Without it the historical
 * `Lens Edu` -> lens-edu-staging mapping applies, so imports keep producing
 * the URLs they always have.
 */

export const PUBLIC_URLS_ENV = "ATTACHMENT_PUBLIC_URLS";

const DEFAULT_PUBLIC_URLS =
  "Lens Edu=https://raw.githubusercontent.com/Lens-Academy/lens-edu-staging/staging";

/** Parse `Folder=https://base;Other=https://base2` into a map. */
export function parsePublicUrlMap(raw: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const entry of raw.split(";")) {
    const eq = entry.indexOf("=");
    if (eq === -1) continue;
    const folder = entry.slice(0, eq).trim();
    const base = entry.slice(eq + 1).trim().replace(/\/+$/, "");
    if (folder && base) out.set(folder, base);
  }
  return out;
}

/** Raw base URL for a top-level relay folder, or null when unpublished. */
export function publicBaseUrlForFolder(folder: string): string | null {
  const raw = process.env[PUBLIC_URLS_ENV]?.trim() || DEFAULT_PUBLIC_URLS;
  return parsePublicUrlMap(raw).get(folder) ?? null;
}

/** Public URL for an in-folder path (`/attachments/x.png`), or null when the
 *  folder has no public base. Path segments are percent-encoded. */
export function attachmentPublicUrl(folder: string, inFolderPath: string): string | null {
  const base = publicBaseUrlForFolder(folder);
  if (!base) return null;
  const encoded = inFolderPath
    .replace(/^\/+/, "")
    .split("/")
    .map(encodeURIComponent)
    .join("/");
  return `${base}/${encoded}`;
}
