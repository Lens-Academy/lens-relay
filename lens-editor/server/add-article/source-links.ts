import { pageOffersSourceLinks } from "../../shared/external-links";
import type {
  JobLinkBack,
  LinkBackState,
  SourceKind,
  SourceLinkStatus,
} from "../../shared/source-links-contract";
import type { LinkSourceResult } from "../add-video/relay-docs";
import { tokenAllowsFolderName } from "../edit-share-auth";
import type { ShareTokenPayload } from "../share-token";
import type { LibraryEntry } from "./library-index";
import type { ArticleJobView } from "./queue";
import type { ArticleJob } from "./types";
import { normalizeImportKey, sameSource } from "./url-normalize";

/** "human:<name>" or the MCP session's "ai:<model>[:<name>]". Strict, because
 *  `ai:` is what forces the human-text edit policy. */
const ACTOR_RE = /^(?:human|ai):\S/;

/** The shared folder a full relay path is in. */
export function folderOfPath(path: string): string {
  return path.split("/")[0];
}

/** Picks out one page's link-backs. */
export type PageMatcher = (link: Pick<JobLinkBack, "doc_id" | "doc_path">) => boolean;

/** By doc id when the page's is known, so link-backs made before a rename still
 *  match; else by the path they were made with. */
export function pageMatcher(path: string, docId: string | null | undefined): PageMatcher {
  return docId ? (link) => link.doc_id === docId : (link) => link.doc_path === path;
}

/** A link-back request once checked, waiting for its URLs. */
export type LinkBackTemplate = Omit<JobLinkBack, "urls" | "state">;

type LinkBackRefusal = { error: string; status: 400 | 403 | 404 | 502 };

/**
 * Check a `linkBack` and pin it to the page's doc id, so a page moved during
 * the import still gets its links. The route's token only proves access to one
 * folder, while the swap runs with the relay server token, so the folder is
 * checked here.
 */
export async function resolveLinkBack(
  raw: unknown,
  payload: ShareTokenPayload | undefined,
  resolveDocId: (path: string) => Promise<string | null>,
): Promise<LinkBackTemplate | LinkBackRefusal> {
  if (!raw || typeof raw !== "object") {
    return { error: "linkBack must be an object", status: 400 };
  }
  const { path, actor, author, protectHuman } = raw as Record<string, unknown>;
  if (typeof path !== "string" || !path.includes("/")) {
    return { error: "linkBack.path must be a full relay path", status: 400 };
  }
  if (typeof actor !== "string" || !ACTOR_RE.test(actor)) {
    return { error: 'linkBack.actor must start with "human:" or "ai:"', status: 400 };
  }
  if (typeof author !== "string" || !author.trim()) {
    return { error: "linkBack.author is required", status: 400 };
  }
  if (protectHuman !== undefined && typeof protectHuman !== "boolean") {
    return { error: "linkBack.protectHuman must be a boolean", status: 400 };
  }
  if (!pageOffersSourceLinks(path, "")) {
    return {
      error: `Links on ${path} can't be swapped: only Markdown pages outside Lens Edu and _trash can link to the library`,
      status: 400,
    };
  }
  if (!tokenAllowsFolderName(payload, folderOfPath(path))) {
    return { error: "Access denied: this token can't write to that folder", status: 403 };
  }
  let docId: string | null;
  try {
    docId = await resolveDocId(path);
  } catch (error) {
    console.error(`[add-article] could not look up ${path}: ${error}`);
    return { error: `Could not look up ${path} on the relay`, status: 502 };
  }
  if (!docId) return { error: `No page at ${path}`, status: 404 };
  return {
    doc_id: docId,
    doc_path: path,
    actor,
    author,
    protect_human: actor.startsWith("ai:") || protectHuman === true,
  };
}

/** What a swap's counts mean for a link-back. */
export function swapOutcome({ linked, suggested, unswappable }: LinkSourceResult): {
  state: Exclude<LinkBackState, "waiting">;
  error?: string;
} {
  if (linked + suggested + unswappable === 0) return { state: "not_found" };
  const left = unswappable > 0
    ? `${unswappable} ${unswappable === 1 ? "link" : "links"} can't become a wikilink and stayed as written`
    : undefined;
  if (linked > 0) return { state: "linked", ...(left ? { error: left } : {}) };
  if (suggested > 0) return { state: "suggested", ...(left ? { error: left } : {}) };
  return { state: "failed", error: left };
}

/** Whether a link may ride on a job: the same page as the job's URL and as
 *  every link it already carries. `sameSource` isn't transitive, and two links
 *  on one job become the same wikilink. */
export function sameSourceAsJob(url: string, job: ArticleJob): boolean {
  return sameSource(url, job.url) &&
    (job.link_back ?? []).every((link) => link.urls.every((spelling) => sameSource(url, spelling)));
}

/** Jobs by the source they import, oldest first. */
export function jobsBySource(jobs: ArticleJob[]): Map<string, ArticleJob[]> {
  const bySource = new Map<string, ArticleJob[]>();
  for (const job of jobs) {
    const key = normalizeImportKey(job.url);
    const list = bySource.get(key);
    if (list) list.push(job);
    else bySource.set(key, [job]);
  }
  return bySource;
}

function hasDocument(job: ArticleJob): boolean {
  return (job.status === "done" || job.status === "skipped") && !!job.relay_path;
}

function isRunning(job: ArticleJob): boolean {
  return (job.status === "queued" || job.status === "processing") && !job.cancel_requested;
}

/**
 * Where one source stands, from the index and the job list. A running job wins,
 * since it is newer than any scan. A finished job's document counts as in the
 * library even if a scan has not seen it. `failed` is only the latest job's, and
 * a stub doesn't hide it: a failed import usually leaves one behind, and "stub"
 * would read as nothing having been tried.
 *
 * With `page`, jobs are that page's news only if they hold a link-back to it:
 * anyone else's running or failed job is left out, so accepting joins it.
 */
export function sourceLinkStatus(
  url: string,
  kind: SourceKind,
  entry: LibraryEntry | undefined,
  jobs: ArticleJob[],
  view: (job: ArticleJob) => ArticleJobView,
  page?: PageMatcher,
): SourceLinkStatus {
  const forPage = (job: ArticleJob) => (page ? job.link_back?.find(page) : undefined);
  const concerns = (job: ArticleJob) => page === undefined || forPage(job) !== undefined;

  const row = { url, key: normalizeImportKey(url), kind };
  const active = jobs.find((job) => isRunning(job) && concerns(job));
  if (active) {
    const { queue_position, eta_minutes } = view(active);
    return {
      ...row,
      state: active.status === "queued" ? "queued" : "importing",
      job_id: active.id,
      path: active.relay_path ?? entry?.path,
      title: active.title ?? entry?.title,
      queue_position,
      eta_minutes,
    };
  }

  const finished = jobs.findLast((job) => job.status !== "queued" && job.status !== "processing");
  const link = page !== undefined && finished ? forPage(finished) : undefined;
  const settled = { ...row, ...(link ? { link_state: link.state } : {}) };

  if (entry && !entry.stub) return { ...settled, state: "library", path: entry.path, title: entry.title };

  const imported = jobs.filter(hasDocument);
  const full = imported.findLast((job) => job.importMode !== "stub");
  if (full) return { ...settled, state: "library", path: full.relay_path, title: full.title };

  const latest = jobs.at(-1);
  if (latest?.status === "failed" && concerns(latest)) {
    return {
      ...settled,
      state: "failed",
      job_id: latest.id,
      error: latest.error,
      path: latest.relay_path ?? entry?.path,
      title: latest.title ?? entry?.title,
    };
  }
  if (entry) return { ...settled, state: "stub", path: entry.path, title: entry.title };
  const stub = imported.at(-1);
  if (stub) return { ...settled, state: "stub", path: stub.relay_path, title: stub.title };
  return { ...settled, state: "new" };
}
