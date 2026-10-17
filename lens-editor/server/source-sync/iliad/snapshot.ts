/**
 * Read the Iliad course as it is published now: the Snapshot one run works
 * from.
 *
 * Two places hold it. The built worksheets (MDX, with their figures) exist
 * only on the site: Iliad's CI publishes them to GitHub Pages and they are
 * not on the repo's main branch. The teaching order exists only in the
 * repo's schedule.yaml. Every page of the site names the commit it was built
 * from in its footer, so the schedule is read at that commit and the two
 * halves describe one state.
 *
 * A snapshot is all or nothing. When the site and the schedule disagree, or
 * a request fails, the read throws one error that says what was wrong; the
 * caller skips the run and the course keeps the state it had.
 */

import { readFile, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import { bytesToText, fetchBytesWithTimeout, type FetchBytesResult } from "../../fetch-timeout";
import { PermanentImageError } from "../types";
import type { Cluster, Snapshot, Worksheet } from "./types";

export const SITE = "https://iliad-intensive.org";
const REPO = "iliad-team/iliad-intensive";
const COMMIT_LINK = new RegExp(`https://github\\.com/${REPO}/commit/([0-9a-f]{40})`, "g");

// Cloudflare, in front of some hosts, turns away a request with no ordinary User-Agent.
const USER_AGENT = "Mozilla/5.0 (compatible; LensAcademy-source-sync/1.0; +https://lensacademy.org)";
const REQUEST_TIMEOUT_MS = 30_000;
// The largest worksheet is 0.4 MB of MDX and the largest figure a 4 MB SVG.
const MAX_TEXT_BYTES = 10 * 1024 * 1024;
const MAX_ASSET_BYTES = 30 * 1024 * 1024;
/** Worksheets fetched at once. */
const PARALLEL = 6;

/**
 * How far apart the Last-Modified of two files of one deploy may be. GitHub
 * Pages stamps every file with the time of the deploy, also the files the
 * deploy did not change, and all within about a second. Its CDN keeps each
 * URL for up to 10 minutes and ignores query strings, so after a deploy the
 * home page and a worksheet can come from different deploys. Reading the
 * commit twice does not show that (the second read is the same cached
 * answer); different stamps do.
 *
 * The check is only as good as the header. When some files carry it and
 * others do not, the read fails. When no file carries it, nothing was
 * checked, and the snapshot says so in `warnings`.
 */
const SAME_DEPLOY_MS = 60_000;

/** `fetchBytesWithTimeout`, or a stand-in for it in tests. */
export type FetchBytes = typeof fetchBytesWithTimeout;

/** The commit the published site was built from: one request, for the poll. */
export async function publishedCommit(fetchBytes: FetchBytes = fetchBytesWithTimeout): Promise<string> {
  return homeCommit(await get(fetchBytes, `${SITE}/`, MAX_TEXT_BYTES));
}

/** The whole published course. About 31 requests; figures are fetched later, through `asset`. */
export async function readSnapshot(fetchBytes: FetchBytes = fetchBytesWithTimeout): Promise<Snapshot> {
  /** The Last-Modified of each file read from the site, or null where it had none. */
  const stamps: (number | null)[] = [];
  const site = async (path: string, maxBytes: number): Promise<SiteFile | null> => {
    const file = await get(fetchBytes, SITE + path, maxBytes);
    if (file) stamps.push(file.deployedAt);
    return file;
  };

  const commit = homeCommit(await site("/", MAX_TEXT_BYTES));
  const scheduleUrl = `https://raw.githubusercontent.com/${REPO}/${commit}/schedule.yaml`;
  const schedule = await get(fetchBytes, scheduleUrl, MAX_TEXT_BYTES);
  if (!schedule) throw new Error(`Iliad: ${scheduleUrl} does not exist`);

  const { worksheets, problems } = await assemble(schedule.text(), async (slug) => {
    const part = encodeURIComponent(slug);
    return (await site(`/downloads/${part}/${part}.mdx`, MAX_TEXT_BYTES))?.text() ?? null;
  });

  const after = homeCommit(await site("/", MAX_TEXT_BYTES));
  if (after !== commit) problems.push(`the site was rebuilt during the read (commit ${commit.slice(0, 7)} became ${after.slice(0, 7)})`);

  const stamped = stamps.filter((stamp) => stamp !== null);
  const warnings: string[] = [];
  /** The time of the deploy all files read are from, when their stamps show it. */
  let deploy: { first: number; last: number } | null = null;
  if (stamped.length === 0) {
    warnings.push(`${SITE} sent no Last-Modified header, so it was not checked that every file read is from one deploy of the site`);
  } else if (stamped.length < stamps.length) {
    problems.push(`${stamps.length - stamped.length} of the ${stamps.length} files read came without a Last-Modified header, so it cannot be checked that all are from one deploy`);
  } else {
    deploy = { first: Math.min(...stamped), last: Math.max(...stamped) };
    if (deploy.last - deploy.first > SAME_DEPLOY_MS) {
      problems.push(`the files read come from more than one deploy of the site (${isoTime(deploy.first)} to ${isoTime(deploy.last)})`);
    }
  }
  failOn(problems, commit);

  return {
    commit,
    worksheets,
    warnings,
    deployedAt: deploy && new Date(deploy.last),
    /**
     * A figure. A failure that can pass by itself (the network, a timeout, a
     * 5xx, a figure from another deploy) fails the run. One that stays until
     * Iliad changes the figure (a 404, a figure over the size limit) is a
     * PermanentImageError: the lens links to the figure, and the run goes on.
     */
    async asset(sitePath) {
      const url = new URL(sitePath, SITE);
      if (!sitePath.startsWith("/") || url.origin !== SITE) throw new PermanentImageError(`Iliad: ${sitePath} is not a path on ${SITE}`);
      let resp: FetchBytesResult;
      try {
        resp = await fetchBytes(url.href, { timeoutMs: REQUEST_TIMEOUT_MS, maxBytes: MAX_ASSET_BYTES, headers: { "User-Agent": USER_AGENT } });
      } catch (err) {
        const message = `Iliad: ${url.href}: ${(err as Error).message}`;
        throw /too large/i.test((err as Error).message) ? new PermanentImageError(message) : new Error(message);
      }
      if (!resp.ok) {
        const passing = resp.status >= 500 || resp.status === 408 || resp.status === 429;
        throw passing ? new Error(`Iliad: ${url.href} answered ${resp.status}`) : new PermanentImageError(`Iliad: ${url.href} answered ${resp.status}`);
      }
      const file = { bytes: new Uint8Array(resp.bytes), deployedAt: stampOf(resp) };
      if (deploy && file.deployedAt === null) {
        throw new Error(`Iliad: ${sitePath} came without a Last-Modified header, so it cannot be checked that it is from the deploy of the snapshot`);
      }
      if (deploy && file.deployedAt !== null && (file.deployedAt > deploy.last + SAME_DEPLOY_MS || file.deployedAt < deploy.first - SAME_DEPLOY_MS)) {
        throw new Error(`Iliad: ${sitePath} comes from another deploy of the site (${isoTime(file.deployedAt)}) than the snapshot (${isoTime(deploy.first)})`);
      }
      return file.bytes;
    },
  };
}

/**
 * The same from a directory holding `schedule.yaml` and one `<slug>.mdx` per
 * worksheet, for tests and a dry run. `asset("/uploads/x/y.svg")` reads
 * `<dir>/uploads/x/y.svg`.
 */
export async function snapshotFromDir(dir: string, commit = "local"): Promise<Snapshot> {
  const root = resolve(dir);
  /** When each file of the course read was last changed. */
  const changed: number[] = [];
  const read = async (...segments: string[]) => {
    const path = resolve(root, ...segments);
    try {
      const bytes = await readFile(path);
      changed.push((await stat(path)).mtimeMs);
      return bytes;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  };

  const schedule = await read("schedule.yaml");
  if (!schedule) throw new Error(`Iliad: ${root} has no schedule.yaml`);
  const { worksheets, problems } = await assemble(schedule.toString("utf8"), async (slug) => (await read(`${slug}.mdx`))?.toString("utf8") ?? null);
  failOn(problems, commit);

  return {
    commit,
    worksheets,
    // A directory is one state: there is nothing its reader could not check.
    warnings: [],
    // The state is as old as the newest of its files.
    deployedAt: new Date(Math.max(...changed)),
    async asset(sitePath) {
      const path = resolve(root, `.${sep}${sitePath}`);
      const bytes = path.startsWith(root + sep) ? await readFile(path).catch(() => null) : null;
      // As on the site: a figure that is not there stays missing until the source changes.
      if (!bytes) throw new PermanentImageError(`Iliad: ${sitePath} is not a file in ${root}`);
      return new Uint8Array(bytes);
    },
  };
}

// ----------------------------------------------------------------- requests

interface SiteFile {
  bytes: Uint8Array;
  text(): string;
  /** Last-Modified as a time, or null when the host sent none. */
  deployedAt: number | null;
}

/** GET a file. Null for a 404; any other failure throws, naming the URL. */
async function get(fetchBytes: FetchBytes, url: string, maxBytes: number): Promise<SiteFile | null> {
  let resp: FetchBytesResult;
  try {
    resp = await fetchBytes(url, { timeoutMs: REQUEST_TIMEOUT_MS, maxBytes, headers: { "User-Agent": USER_AGENT } });
  } catch (err) {
    throw new Error(`Iliad: ${url}: ${(err as Error).message}`);
  }
  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error(`Iliad: ${url} answered ${resp.status}`);
  return { bytes: new Uint8Array(resp.bytes), text: () => bytesToText(resp.bytes), deployedAt: stampOf(resp) };
}

/** A response's Last-Modified as a time, or null when it has none. */
function stampOf(resp: FetchBytesResult): number | null {
  const modified = Date.parse(resp.headers.get("last-modified") ?? "");
  return Number.isNaN(modified) ? null : modified;
}

function homeCommit(home: SiteFile | null): string {
  const commits = new Set([...(home?.text() ?? "").matchAll(COMMIT_LINK)].map((m) => m[1]));
  if (commits.size !== 1) {
    throw new Error(`Iliad: ${SITE}/ names ${commits.size} source commits; its footer should link to exactly one`);
  }
  return [...commits][0];
}

function isoTime(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19) + "Z";
}

function failOn(problems: string[], commit: string): void {
  if (problems.length) throw new Error(`Iliad snapshot at ${commit.slice(0, 7)} is inconsistent: ${problems.join("; ")}`);
}

// ----------------------------------------------------------------- schedule

/** One worksheet's place in schedule.yaml. */
interface Scheduled {
  slug: string;
  cluster: Cluster;
  dayCode: string;
  dayTitle: string;
  code: string;
  /** The day's own `slides:`, which the site shows while no worksheet of the day supplies a deck. */
  daySlides: string | null;
}

/**
 * Every listed worksheet in taught order: the order of `clusters`, of a
 * cluster's `days`, and of a day's `worksheets`. A day with several
 * worksheets numbers them from that order (D.3.1, D.3.2); a day with one is
 * never numbered. Only the shape this reader depends on is checked: the
 * file was valid for Iliad's build at this commit.
 */
function scheduled(yamlText: string): Scheduled[] {
  const bad = (what: string): never => {
    throw new Error(`Iliad: schedule.yaml ${what}`);
  };
  const text = (value: unknown, what: string): string =>
    typeof value === "string" || typeof value === "number" ? String(value) : bad(`has ${what}`);
  const list = (value: unknown, what: string): unknown[] => (value == null ? [] : Array.isArray(value) ? value : bad(`has ${what}`));

  let doc: { clusters?: unknown } | null;
  try {
    doc = parseYaml(yamlText);
  } catch (err) {
    return bad(`is not valid YAML: ${(err as Error).message.split("\n")[0]}`);
  }
  if (!Array.isArray(doc?.clusters)) return bad("has no list of clusters");

  const sheets: Scheduled[] = [];
  for (const c of doc.clusters as Record<string, unknown>[]) {
    const id = text(c?.id, "a cluster without an id");
    const cluster: Cluster = {
      id,
      label: text(c.label, `no label for cluster ${id}`),
      urlSlug: text(c.urlSlug, `no urlSlug for cluster ${id}`),
    };
    for (const d of list(c.days, `days of cluster ${id} that are not a list`) as Record<string, unknown>[]) {
      const dayCode = text(d?.code, `a day without a code in cluster ${id}`);
      const dayTitle = text(d.title, `no title for day ${dayCode}`);
      const slugs = list(d.worksheets, `worksheets of day ${dayCode} that are not a list`);
      slugs.forEach((value, i) => {
        const slug = text(value, `a worksheet of day ${dayCode} that is not a name`);
        // A slug becomes a URL segment and a file name.
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(slug)) bad(`names a worksheet "${slug}" on day ${dayCode}, which is not a folder name`);
        if (sheets.some((s) => s.slug === slug)) bad(`lists worksheet ${slug} twice`);
        sheets.push({
          slug,
          cluster,
          dayCode,
          dayTitle,
          code: slugs.length > 1 ? `${dayCode}.${i + 1}` : dayCode,
          daySlides: typeof d.slides === "string" ? d.slides : null,
        });
      });
    }
  }
  return sheets;
}

// --------------------------------------------------------------- worksheets

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/**
 * Join the schedule with each worksheet's built MDX. Everything that makes
 * the two disagree is collected, so one error can name it all.
 */
async function assemble(
  scheduleYaml: string,
  readMdx: (slug: string) => Promise<string | null>,
): Promise<{ worksheets: Worksheet[]; problems: string[] }> {
  const sheets = scheduled(scheduleYaml);
  const files: (string | null)[] = [];
  for (let i = 0; i < sheets.length; i += PARALLEL) {
    files.push(...(await Promise.all(sheets.slice(i, i + PARALLEL).map((s) => readMdx(s.slug)))));
  }

  const problems: string[] = [];
  const worksheets: Worksheet[] = [];
  for (const [i, sheet] of sheets.entries()) {
    const file = files[i];
    const where = `${sheet.slug} (${sheet.code})`;
    if (file == null) {
      problems.push(`${where} is in schedule.yaml but has no built MDX`);
      continue;
    }
    const match = FRONTMATTER.exec(file);
    let fm: Record<string, unknown> | null = null;
    try {
      fm = match && parseYaml(match[1]);
    } catch {
      /* reported below */
    }
    if (!match || !fm || typeof fm !== "object") {
      problems.push(`${where}: the built MDX has no readable frontmatter`);
      continue;
    }
    if (String(fm.day) !== sheet.dayCode || String(fm.cluster) !== sheet.cluster.id) {
      problems.push(
        `${where}: the built MDX is for day ${fm.day} of cluster ${fm.cluster}, schedule.yaml has it on day ${sheet.dayCode} of cluster ${sheet.cluster.id}`,
      );
    }
    if (typeof fm.title !== "string" || !fm.title.trim()) {
      problems.push(`${where}: the built MDX has no title`);
      continue;
    }
    worksheets.push({
      slug: sheet.slug,
      cluster: sheet.cluster,
      dayCode: sheet.dayCode,
      dayTitle: sheet.dayTitle,
      code: sheet.code,
      title: fm.title.trim(),
      summary: typeof fm.summary === "string" && fm.summary.trim() ? fm.summary.trim() : null,
      contributors: Array.isArray(fm.contributors) ? fm.contributors.map(String) : [],
      slides: deckUrl(fm.slides),
      pageUrl: `${SITE}/${sheet.cluster.urlSlug}/${sheet.slug}/`,
      mdx: file.slice(match[0].length),
    });
  }

  // The day's own deck stands in only while none of its worksheets has one, as on the site.
  for (const sheet of sheets) {
    if (!sheet.daySlides) continue;
    const ofDay = worksheets.filter((w) => w.dayCode === sheet.dayCode);
    if (ofDay.every((w) => w.slides === null)) for (const w of ofDay) w.slides = sheet.daySlides;
  }
  return { worksheets, problems };
}

/** A worksheet's `slides:` is a URL, or `{ url, title }`. */
function deckUrl(slides: unknown): string | null {
  const url = slides && typeof slides === "object" ? (slides as { url?: unknown }).url : slides;
  return typeof url === "string" && url.trim() ? url.trim() : null;
}
