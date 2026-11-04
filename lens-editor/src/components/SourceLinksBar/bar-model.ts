import type { SourceKind, SourceLinksCheckResponse } from '../../../shared/source-links-contract';

/**
 * What the sources bar says and offers, from where the page's sources stand.
 * Pure: the table in docs/plans/2026-11-02-import-and-link-sources.md, "Editor".
 */

export type SourceQueue = SourceLinksCheckResponse['queue'];

export type RowState = 'new' | 'library' | 'working' | 'failed' | 'done';

/** Where a working row has got to. */
export type RowStep = 'starting' | 'queued' | 'importing' | 'linking';

/** One source on the page. Spellings of one source share a row. */
export interface SourceRow {
  key: string;
  /** The first spelling: what the row opens. */
  url: string;
  /** Every spelling on the page. */
  urls: string[];
  kind: SourceKind;
  label: string;
  state: RowState;
  step?: RowStep;
  /** Done rows: whether an import was needed, or only the link. */
  imported?: boolean;
  /** Done rows: the swap is a pending suggestion. */
  suggested?: boolean;
  jobIds: string[];
  error?: string;
  etaMinutes?: number;
}

export interface BarModel {
  kind: 'hidden' | 'offer' | 'working' | 'failed' | 'done';
  text: string;
  /** Said to screen readers; leaves out what changes with every poll. */
  announce: string;
  /** What the list under the bar shows. */
  rows: SourceRow[];
  /** The main button, if one click can do it. */
  primary?: { label: string; urls: string[] };
  /** Offer states with more than one source. */
  canChoose?: boolean;
  /** Running jobs can be stopped. */
  canStop?: boolean;
  /** What Dismiss writes to link_offers_v0. */
  dismissUrls?: string[];
  queue?: SourceQueue | null;
}

export const HIDDEN_BAR: BarModel = { kind: 'hidden', text: '', announce: '', rows: [] };

/** Above this many new sources the bar asks the person to pick first. */
export const ONE_CLICK_LIMIT = 10;

/** What fits on the line beside the rest of the sentence and two buttons. */
const LABEL_MAX = 40;

function sources(count: number): string {
  return `${count} source${count === 1 ? '' : 's'}`;
}

/** The bar's distance from the top of the page, and from the caret. */
export const BAR_TOP_PX = 8;
const CARET_GAP_PX = 6;

/**
 * How far down the bar has to sit to stay off the caret: it floats over the page,
 * and the text can't move to make room. It stays on the page.
 */
export function barOffset(
  caret: { top: number; bottom: number },
  barTop: number,
  barHeight: number,
  pageBottom: number,
): number {
  if (caret.bottom <= barTop || caret.top >= barTop + barHeight) return 0;
  return Math.max(0, Math.min(caret.bottom + CARET_GAP_PX - barTop, pageBottom - barHeight - barTop));
}

/** Host and path, for a URL that has no title. */
export function sourceLabel(url: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/$/, '');
    return `${parsed.hostname.replace(/^www\./, '')}${path}${parsed.search}`;
  } catch {
    return url;
  }
}

function shortened(label: string): string {
  return label.length > LABEL_MAX ? `${label.slice(0, LABEL_MAX - 1)}…` : label;
}

/** Minutes until `count` new imports finish, behind what is queued already. */
export function estimateMinutes(count: number, queue: SourceQueue): number {
  const workers = Math.max(1, queue.workers);
  return queue.avg_job_minutes * (Math.ceil(count / workers) + Math.ceil(queue.queued / workers));
}

/** "about 8 min", "about 1 h 20 min". Past an hour, to the nearest 5 minutes. */
export function formatEstimate(minutes: number): string {
  const whole = Math.max(1, Math.round(minutes));
  if (whole < 60) return `about ${whole} min`;
  const rounded = Math.round(whole / 5) * 5;
  const hours = Math.floor(rounded / 60);
  const rest = rounded % 60;
  return rest ? `about ${hours} h ${rest} min` : `about ${hours} h`;
}

function urlsOf(rows: SourceRow[]): string[] {
  return rows.flatMap((row) => row.urls);
}

function workingModel(rows: SourceRow[], working: SourceRow[], queue: SourceQueue | null): BarModel {
  const count = working.length;
  const details = rows.filter((row) => row.state === 'working' || row.state === 'failed' || row.state === 'done');
  const base = { kind: 'working' as const, rows: details, queue };
  if (working.every((row) => row.step === 'linking')) {
    const text = `Linking ${sources(count)}.`;
    return { ...base, text, announce: text };
  }
  const server = Math.max(0, ...working.map((row) => row.etaMinutes ?? 0));
  const minutes = server > 0 ? server : queue ? estimateMinutes(count, queue) : null;
  const estimate = minutes ? `, ${formatEstimate(minutes)}` : '';
  return {
    ...base,
    text: `Importing ${sources(count)}${estimate}. You can keep working or close this page.`,
    announce: `Importing ${sources(count)}. You can keep working or close this page.`,
    canStop: working.some((row) => row.jobIds.length > 0 && row.step !== 'linking'),
  };
}

/** `rows` here are all new or in the library. */
function offerModel(rows: SourceRow[], queue: SourceQueue | null): BarModel {
  const urls = urlsOf(rows);
  const offer = (text: string, primary?: BarModel['primary'], canChoose = true): BarModel => ({
    kind: 'offer',
    text,
    announce: text,
    rows,
    primary,
    canChoose,
    dismissUrls: urls,
    queue,
  });

  const fresh = rows.filter((row) => row.state === 'new').length;
  const inLibrary = rows.length - fresh;
  if (rows.length === 1) {
    const label = shortened(rows[0].label);
    return fresh === 1
      ? offer(`${label} isn't in the library yet.`, { label: 'Import and link', urls }, false)
      : offer(`${label} is already in the library.`, { label: 'Use library copy', urls }, false);
  }
  if (fresh === 0) {
    return offer(`${sources(rows.length)} on this page are already in the library.`, {
      label: 'Use library copies',
      urls,
    });
  }
  const oneClick = fresh > ONE_CLICK_LIMIT ? undefined : { label: 'Import and link', urls };
  if (inLibrary === 0) {
    return offer(`${sources(rows.length)} on this page aren't in the library yet.`, oneClick);
  }
  const verb = inLibrary === 1 ? 'is' : 'are';
  return offer(
    `${sources(rows.length)} on this page: ${inLibrary} ${verb} in the library, ${fresh} can be imported.`,
    oneClick,
  );
}

export function barModel(rows: SourceRow[], queue: SourceQueue | null): BarModel {
  const working = rows.filter((row) => row.state === 'working');
  if (working.length > 0) return workingModel(rows, working, queue);

  const failed = rows.filter((row) => row.state === 'failed');
  const done = rows.filter((row) => row.state === 'done');
  if (failed.length > 0) {
    const text = `${sources(failed.length)} couldn't be imported.`;
    return {
      kind: 'failed',
      text,
      announce: text,
      rows: [...failed, ...done],
      dismissUrls: urlsOf(failed),
      queue,
    };
  }
  if (done.length > 0) {
    const verb = done.some((row) => row.suggested) ? 'suggested' : 'linked';
    const text = done.some((row) => row.imported)
      ? `${sources(done.length)} imported and ${verb}.`
      : `${sources(done.length)} ${verb}.`;
    return { kind: 'done', text, announce: text, rows: [], queue };
  }
  return rows.length > 0 ? offerModel(rows, queue) : HIDDEN_BAR;
}
