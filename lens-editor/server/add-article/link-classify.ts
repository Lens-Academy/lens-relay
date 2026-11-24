import rules from "../../shared/external-link-rules.json";
import type { SourceKind } from "../../shared/source-links-contract";
import { extractVideoInput, isYouTubeUrl } from "../add-video/video-url";

/**
 * Whether an external link is a source the library could hold: the
 * classification rules of docs/plans/2026-11-02-import-and-link-sources.md, in
 * order, first match wins. Tested against shared/external-link-cases.json.
 */
export function classifySourceLink(url: string): SourceKind | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;

  const host = parsed.hostname.toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
  if (rules.skip_hosts.some((skip) => host === skip || host.endsWith(`.${skip}`))) return null;

  if (isYouTubeUrl(url)) return extractVideoInput(url) ? "video" : null;

  const path = parsed.pathname.toLowerCase();
  if (rules.skip_extensions.some((extension) => path.endsWith(extension))) return null;
  if (path === "/" && !parsed.search) return null;
  return "article";
}
