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
 *   source:: [[../articles/<file>]]
 *
 * The single source-only segment means "include the whole article/video". The
 * source is a RELATIVE wikilink (contains "/") with NO `.md` extension and no
 * `|alias` — the form the content-processor / Obsidian resolve (a trailing `.md`
 * breaks resolution). The lens lives in a sibling folder of the imported doc
 * (Lens Edu/Lenses ↔ Lens Edu/articles).
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

export interface LensDocOptions {
  title: string;
  /** Segment header — "Article" or "Video". */
  segment: "Article" | "Video";
  /** Relative path to the target doc, e.g. "../articles/foo.md". A trailing
   *  `.md` is stripped for the wikilink. */
  source: string;
  /** Lens id (UUID). Generated when omitted. */
  id?: string;
}

/** Render a minimal whole-document lens. */
export function generateLensMarkdown(opts: LensDocOptions): string {
  const id = opts.id ?? randomUUID();
  // Canonical lens wikilink: the relative path WITHOUT the `.md` extension and
  // WITHOUT a `|alias`. The content-processor / Obsidian resolve the
  // extensionless form (a trailing `.md` breaks resolution), and a whole-document
  // lens needs no display label.
  const target = opts.source.replace(/\.md$/i, "");
  return [
    "---",
    `id: ${id}`,
    `title: ${yamlQuote(opts.title)}`,
    "---",
    "",
    `#### ${opts.segment}`,
    `source:: [[${target}]]`,
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

  // The content-processor requires a RELATIVE wikilink (must contain "/"). If
  // the lens and doc folders are co-located (e.g. via RELAY_LENS_FOLDER),
  // relative() yields a bare filename — prefix "./" so the invariant holds.
  const rel = path.posix.relative(lensFolder, opts.docPath);
  const source = rel.includes("/") ? rel : `./${rel}`;
  await createRelayDoc(
    lensPath,
    generateLensMarkdown({ title: opts.title, segment: opts.segment, source }),
  );
  return lensPath;
}
