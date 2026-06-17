import { randomUUID } from "node:crypto";
import * as path from "node:path";
import { createRelayDoc, checkRelayDocsExist } from "./add-video/relay-docs";

/**
 * Auto-create a "lens" wrapping a freshly-imported article or video, so the
 * curator can drop it straight into a module without the manual lens-creation
 * step (Asana 1215689584721257).
 *
 * A lens is a flat markdown doc the content-processor understands:
 *   ---
 *   id: <uuid>
 *   title: <display title>
 *   ---
 *
 *   #### Article
 *   source:: [[../articles/<file>.md|<display title>]]
 *
 * The single source-only segment means "include the whole article/video". The
 * source must be a RELATIVE wikilink (contain "/"), which it is — the lens lives
 * in a sibling folder of the imported doc (Lens Edu/Lenses ↔ Lens Edu/articles).
 */

function relayLensFolder(): string {
  return process.env.RELAY_LENS_FOLDER || "Lens Edu/Lenses";
}

/** YAML double-quote a scalar (escape quotes/backslashes; collapse newlines). */
function yamlQuote(s: string): string {
  return (
    '"' +
    s
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/[\r\n\t]+/g, " ") +
    '"'
  );
}

/** Sanitize a display label so it can't break the [[path|label]] wikilink. */
function wikilinkLabel(s: string): string {
  return s.replace(/[[\]|]/g, "").replace(/\s+/g, " ").trim();
}

export interface LensDocOptions {
  title: string;
  /** Segment header — "Article" or "Video". */
  segment: "Article" | "Video";
  /** Relative wikilink target, e.g. "../articles/foo.md". */
  source: string;
  /** Lens id (UUID). Generated when omitted. */
  id?: string;
}

/** Render a minimal whole-document lens. */
export function generateLensMarkdown(opts: LensDocOptions): string {
  const id = opts.id ?? randomUUID();
  return [
    "---",
    `id: ${id}`,
    `title: ${yamlQuote(opts.title)}`,
    "---",
    "",
    `#### ${opts.segment}`,
    `source:: [[${opts.source}|${wikilinkLabel(opts.title)}]]`,
    "",
  ].join("\n");
}

/**
 * Create a lens for an imported doc, unless one of the same name already exists.
 * The lens path mirrors the imported doc's basename in the Lenses folder, and
 * the source is the wikilink-relative path from the Lenses folder to the doc.
 * Returns the lens path, or null when it already existed.
 */
export async function maybeCreateLens(opts: {
  /** Relay path of the imported doc, e.g. "Lens Edu/articles/foo.md". */
  docPath: string;
  title: string;
  segment: "Article" | "Video";
}): Promise<string | null> {
  const lensFolder = relayLensFolder();
  const base = path.posix.basename(opts.docPath).replace(/\.md$/i, "");
  const lensPath = `${lensFolder}/${base}.md`;

  const exists = await checkRelayDocsExist([lensPath]);
  if (exists[lensPath]) return null;

  const source = path.posix.relative(lensFolder, opts.docPath);
  await createRelayDoc(
    lensPath,
    generateLensMarkdown({ title: opts.title, segment: opts.segment, source }),
  );
  return lensPath;
}
