/**
 * Preview the Iliad course sync by hand, against a copy of Lens Edu on disk:
 *
 *   npx tsx scripts/iliad-sync.ts --content <dir> [--source <dir>] [--apply] [--force]
 *
 * <dir> for --content holds Lens Edu's files (a checkout of lens-edu-relay).
 * Without --apply the run reports what it would write, move and retire, and
 * changes no course file; figures are still drawn into <dir>/attachments.
 * With --apply it changes the copy, so Lens's content validator can be run
 * on the result. --source reads the site from a directory instead (its
 * schedule.yaml, <slug>.mdx files and uploads/ folder of figures).
 *
 * It never writes to a relay: the course is synced only by the production
 * server, so a machine with production credentials cannot overwrite it from
 * a terminal.
 */

import { dirCourseFiles } from "../server/source-sync/iliad/dir-course-files";
import { snapshotFromDir } from "../server/source-sync/iliad/snapshot";
import { logReport, syncCourse } from "../server/source-sync/iliad/sync";

const args = process.argv.slice(2);
const value = (flag: string) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
const content = value("--content");
if (!content) {
  console.error("usage: npx tsx scripts/iliad-sync.ts --content <dir> [--source <dir>] [--apply] [--force]");
  process.exit(1);
}

const sourceDir = value("--source");
const snapshot = sourceDir ? await snapshotFromDir(sourceDir) : null;
try {
  const report = await syncCourse({
    files: dirCourseFiles(content),
    source: snapshot ? { commit: async () => snapshot.commit, snapshot: async () => snapshot } : undefined,
    dryRun: !args.includes("--apply"),
    force: args.includes("--force"),
  });
  logReport(report, console);
  for (const move of report.moved) console.log(`  moved    ${move.from} -> ${move.to}`);
  for (const path of report.written) console.log(`  written  ${path}`);
  for (const path of report.retired) console.log(`  retired  ${path}`);
} catch (err) {
  console.error(`[iliad-sync] failed: ${(err as Error).message}`);
  process.exit(1);
}
