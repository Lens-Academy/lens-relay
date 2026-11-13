/**
 * Preview the AI Safety Atlas course sync by hand, against a copy of Lens Edu
 * on disk and a saved copy of the Docs:
 *
 *   npx tsx scripts/atlas-sync.ts --content <dir> --docs <dump.json> --config <course.json>
 *     [--images <dir>] [--apply] [--force] [--approve <revision>]
 *
 * --content is a directory holding Lens Edu's files (a copy of
 * lens-edu-relay), or a directory with a "Lens Edu" folder in it. A git
 * checkout of a Lens Edu repository is refused unless --allow-checkout is
 * given: --apply would change it, and a commit from it would bypass the
 * relay.
 * --docs is `{ "<docId>": <Docs API document, all tabs> }`.
 * --config is one course, as in ATLAS_SYNC_COURSES
 * (scripts/atlas-sync.config.example.json is the real course).
 * --images is a directory with manifest.json,
 * `{ "<docId>": { "<inlineObjectId>": { "file": "<path in the directory>" } } }`;
 * without it, articles are written without their images. Images are made
 * WebP as the server makes them (server/source-sync/atlas/images.ts).
 *
 * Without --apply the run reports what it would write, move and retire, and
 * changes no course file; images are still stored in <content>/attachments.
 * With --apply it changes the copy, so Lens's content validator can be run
 * on the result. Run it twice with --apply to see that a second run of the
 * same Docs writes nothing.
 *
 * It never reads Google or writes to a relay: the course is synced only by
 * the production server.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseAtlasCourses } from "../server/source-sync/atlas/config";
import type { AtlasDocs } from "../server/source-sync/atlas/snapshot";
import { logAtlasReport, syncAtlasCourse } from "../server/source-sync/atlas/sync";
import type { DocsDocument } from "../server/source-sync/google-docs/docs-types";
import { dirCourseFiles } from "../server/source-sync/iliad/dir-course-files";
import { PermanentImageError } from "../server/source-sync/types";

const USAGE =
  "usage: npx tsx scripts/atlas-sync.ts --content <dir> --docs <dump.json> --config <course.json> [--images <dir>] [--apply] [--force] [--approve <revision>] [--allow-checkout]";
const args = process.argv.slice(2);
const value = (flag: string) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
const [content, dump, configFile, images] = ["--content", "--docs", "--config", "--images"].map(value);
if (!content || !dump || !configFile) {
  console.error(USAGE);
  process.exit(1);
}

try {
  const [config] = parseAtlasCourses(`[${await readFile(configFile, "utf8")}]`);
  const top = config.course.slice(0, config.course.indexOf("/"));
  const root = existsSync(join(content, top)) ? join(content, top) : content;
  if (!args.includes("--allow-checkout")) {
    for (const dir of new Set([content, root])) {
      let remotes = "";
      try {
        remotes = execFileSync("git", ["-C", dir, "remote", "-v"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      } catch {
        // not a git checkout
      }
      if (/lens-edu/i.test(remotes)) throw new Error(`${dir} is a git checkout of a Lens Edu repository; run on a copy, or pass --allow-checkout`);
    }
  }
  const documents = JSON.parse(await readFile(dump, "utf8")) as Record<string, DocsDocument>;
  const manifest = images ? (JSON.parse(await readFile(join(images, "manifest.json"), "utf8")) as Record<string, Record<string, { file: string }>>) : {};

  const docs: AtlasDocs = {
    async getDocument(id) {
      const document = documents[id];
      if (!document) throw new Error(`Google Doc ${id} is not in ${dump}`);
      return document;
    },
    async getImage({ docId, inlineObjectId }) {
      const entry = manifest[docId]?.[inlineObjectId];
      if (!entry) throw new PermanentImageError(images ? `not in ${join(images, "manifest.json")}` : "no --images given");
      return new Uint8Array(await readFile(join(images!, entry.file)));
    },
  };

  const report = await syncAtlasCourse(
    config,
    { files: dirCourseFiles(root, top), docs },
    { dryRun: !args.includes("--apply"), force: args.includes("--force"), approvedRetirement: value("--approve") },
  );
  logAtlasReport(report, console);
  for (const move of report.moved) console.log(`  moved    ${move.from} -> ${move.to}`);
  for (const path of report.written) console.log(`  written  ${path}`);
  for (const path of report.retired) console.log(`  retired  ${path}`);
  if (!args.includes("--apply")) console.log(`(dry run: nothing written under ${root} but attachments/; add --apply to write)`);
} catch (err) {
  console.error(`[atlas-sync] failed: ${(err as Error).message}`);
  process.exit(1);
}
