import * as Y from 'yjs';
import type { Awareness } from 'y-protocols/awareness';
import { pageOffersSourceLinks, scanExternalLinks, type ExternalLink } from '../../../shared/external-links';
import type {
  ImportResultRow,
  LinkBackRequest,
  SourceLinkStatus,
  SourceLinksCheckResponse,
} from '../../../shared/source-links-contract';
import { getAuthorshipRuns, type AuthorshipRun } from '../../lib/authorship-runs';
import {
  dismissLinkOffers,
  forgetAcceptedLinkOffers,
  markLinkOffersSeen,
  observeLinkOffers,
  readAcceptedLinkOffers,
  readLinkOffers,
  readSeenLinkOffers,
  rememberAcceptedLinkOffers,
  undoLinkOfferDismissal,
} from '../../lib/link-offers';
import { isOwnClient } from '../../lib/provenance';
import { relayHeaders } from '../../lib/relay-api';
import {
  HIDDEN_BAR,
  barModel,
  sourceLabel,
  type BarModel,
  type RowState,
  type RowStep,
  type SourceQueue,
  type SourceRow,
} from './bar-model';
import type { LibraryHit } from './localSwap';

export const SCAN_DEBOUNCE_MS = 1500;
export const POLL_MS = 4000;
const POLL_MAX_MS = 30_000;
/** How long Done stays up. */
export const DONE_CLEARS_MS = 8000;
/** How long an offer outlives its last link, in case the next edit brings one
 *  back: a URL being replaced should not move the page twice. */
export const OFFER_HOLD_MS = 3000;
/** How long a finished job may wait for its link to leave the text before the
 *  bar stops expecting it to (an unswappable link, or a job with no link-back). */
export const SETTLE_MS = 12_000;
/** How long an offer or a failure is on screen before this browser counts it as seen. */
export const OFFER_SEEN_MS = 5000;

const IMPORT_CHUNK = 20; // the server's limit per request
const CHECK_CHUNK = 200;
const CANCEL_CHUNK = 200;
const NO_ANSWER = "The server didn't answer.";

type Phase =
  /** Accepted; the server has not answered yet. */
  | 'sent'
  /** A job is queued or running. */
  | 'active'
  /** The job is over and the link should leave the text any moment. */
  | 'settling'
  | 'done'
  | 'failed';

interface Tracked {
  phase: Phase;
  /** It needed an import, not only the link. */
  imported: boolean;
  id?: string;
  error?: string;
  settleBy?: number;
  /** Its link left the text, and the server has been asked why. */
  gone?: boolean;
  /** Swapped in the open editor, so an undo can bring it back. */
  local?: boolean;
  /** The swap is a pending suggestion. */
  suggested?: boolean;
  /** The job has ended and the server has yet to say what became of the link. */
  awaitingSwap?: boolean;
}

const STATE_OF_PHASE: Record<Phase, RowState> = {
  sent: 'working',
  active: 'working',
  settling: 'working',
  done: 'done',
  failed: 'failed',
};

/** The page's relay path and who is at the keyboard, read when needed. */
export interface SourceLinksContext {
  path: string;
  actor: string;
  /** In Suggesting mode a swap must stay a suggestion, so it is the server's. */
  suggesting: boolean;
  /** Swaps links in the open editor and says which it swapped. */
  swapInPage?: (hits: LibraryHit[]) => string[];
}

/** A link a caret is in or just after: it may still be being written. */
interface HeldLink {
  url: string;
  start: number;
  end: number;
}

/** Where a link's URL is in the text: the part that says which source it is. */
function urlRange(text: string, link: ExternalLink): [number, number] {
  const at = text.indexOf(link.url, link.start);
  return at >= 0 && at + link.url.length <= link.end ? [at, at + link.url.length] : [link.start, link.end];
}

/** Whether any of `[from, to)` was written under one of `mine`'s clientIDs. */
function writtenBy(runs: AuthorshipRun[], from: number, to: number, mine: (client: number) => boolean): boolean {
  // The first run that ends after `from`
  let low = 0;
  let high = runs.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (runs[mid].to <= from) low = mid + 1;
    else high = mid;
  }
  for (let i = low; i < runs.length && runs[i].from < to; i += 1) {
    if (mine(runs[i].client)) return true;
  }
  return false;
}

/** A caret at the start of a link isn't writing it; one inside or at its end may be. */
const writing = (link: { start: number; end: number }, carets: number[]) =>
  carets.some((caret) => link.start < caret && caret <= link.end);

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function stepOf(tracked: Tracked, status: SourceLinkStatus | undefined): RowStep | undefined {
  switch (tracked.phase) {
    case 'sent':
      return tracked.imported ? 'starting' : 'linking';
    case 'settling':
      return 'linking';
    case 'active':
      return status?.state === 'importing' ? 'importing' : 'queued';
    default:
      return undefined;
  }
}

/**
 * The sources of one open document: what its text links to, what the server
 * says of those links, and what has been accepted here. Everything belongs to
 * one document, so opening another starts a new session and nothing carries
 * over. It runs while something is subscribed, and only calls its listeners when
 * the bar would change, so typing costs a timer reset and no renders.
 *
 * Only links this person adds while the page is open are offered, each once: a
 * link already on the page, or added by someone else, an agent or Obsidian, is
 * never offered here. Whose a link is comes from who wrote its URL's characters
 * (Yjs keeps a clientID on every one).
 */
export class SourceLinksSession {
  private readonly doc: Y.Doc;
  private readonly docId: string;
  private readonly text: Y.Text;
  private context: SourceLinksContext = { path: '', actor: 'human:unknown', suggesting: false };
  private readonly listeners = new Set<() => void>();

  /** url → what the server said; null: it said this is not a source. */
  private readonly statuses = new Map<string, SourceLinkStatus | null>();
  private readonly tracked = new Map<string, Tracked>();
  /** url → the clock when it last changed here, so that an answer to a question
   *  asked before then cannot undo the change. */
  private readonly changed = new Map<string, number>();
  private clock = 0;

  /** The URLs the rows are built from. */
  private page: string[] = [];
  /** The URLs of the last scan, kept from `page` until the server has been asked
   *  about the new ones, so a URL being replaced does not blink the bar. */
  private latest: string[] = [];
  /** Where the caret is, once the editor has said. */
  private caret: number | null = null;
  /** Everyone else on the page, whose carets hold links too. */
  private awareness: Awareness | null = null;
  private held: HeldLink[] = [];
  /** Hidden: only a link added since, or a new failure, brings the bar back. */
  private hidden = false;
  /** Failures hidden on this visit, by row key: not shown again on it. */
  private readonly hiddenFailures = new Set<string>();
  /** What this browser had been offered when the page opened. Fixed for the visit
   *  (bar what is answered here), so an offer doesn't vanish while it is up. */
  private seen: Set<string> | null = null;
  /** What this browser accepted on an earlier visit and hasn't seen the end of,
   *  so its progress or failure is shown to the one who asked. Fixed for the visit. */
  private accepted: Set<string> | null = null;
  /** URLs this person added on this visit, the only ones that can be offered. */
  private readonly added = new Set<string>();
  /** URLs that were on the page before, or that someone else added. */
  private readonly known = new Set<string>();
  /** The clientIDs this visit's own edits were written under. */
  private readonly ownClients = new Set<number>();
  /** url → when its offer came on screen. */
  private readonly offeredAt = new Map<string, number>();

  private queue: SourceQueue | null = null;
  private ready = true;
  /** The server refused: this person can't import, so nothing is shown or asked. */
  private blocked = false;

  private running = false;
  private refreshing = false;
  private refreshAgain = false;
  private polling = false;
  private pollFailures = 0;
  private scanTimer: ReturnType<typeof setTimeout> | null = null;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private holdTimer: ReturnType<typeof setTimeout> | null = null;
  private doneTimer: ReturnType<typeof setTimeout> | null = null;
  private seenTimer: ReturnType<typeof setTimeout> | null = null;
  private stopObservingOffers: (() => void) | null = null;

  private model: BarModel = HIDDEN_BAR;
  private modelJson = JSON.stringify(HIDDEN_BAR);

  constructor(doc: Y.Doc, docId: string) {
    this.doc = doc;
    this.docId = docId;
    this.text = doc.getText('contents');
  }

  /** A rename or a new display name applies to a session already running. */
  setContext(context: SourceLinksContext) {
    this.context = context;
  }

  // ── The store ────────────────────────────────────────────────────────

  getModel = (): BarModel => this.model;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    if (this.listeners.size === 1) this.start();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.stop();
    };
  };

  private start() {
    this.running = true;
    this.seen ??= readSeenLinkOffers(this.docId);
    this.accepted ??= readAcceptedLinkOffers(this.docId);
    this.ownClients.add(this.doc.clientID);
    this.text.observe(this.onTextChange);
    this.stopObservingOffers = observeLinkOffers(this.doc, this.publish);
    this.awareness?.on('change', this.onAwarenessChange);
    document.addEventListener('visibilitychange', this.onVisibilityChange);
    this.scan();
  }

  private stop() {
    this.running = false;
    this.text.unobserve(this.onTextChange);
    this.stopObservingOffers?.();
    this.stopObservingOffers = null;
    this.awareness?.off('change', this.onAwarenessChange);
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    for (const timer of [this.scanTimer, this.pollTimer, this.holdTimer, this.doneTimer, this.seenTimer]) {
      if (timer !== null) clearTimeout(timer);
    }
    this.scanTimer = this.pollTimer = this.holdTimer = this.doneTimer = this.seenTimer = null;
    this.offeredAt.clear();
  }

  // ── Following the text ───────────────────────────────────────────────

  private onTextChange = (_event: Y.YTextEvent, transaction: Y.Transaction) => {
    // The clientID turns over on a new day or name, and a local edit writes under the new one
    if (transaction.local) this.ownClients.add(this.doc.clientID);
    if (this.scanTimer !== null) clearTimeout(this.scanTimer);
    this.scanTimer = setTimeout(this.scan, SCAN_DEBOUNCE_MS);
  };

  /** The URLs of the links that can become wikilinks, and those being written. */
  private readPage(): { urls: string[]; held: HeldLink[] } {
    const text = this.text.toString();
    if (!pageOffersSourceLinks(this.context.path, text)) return { urls: [], held: [] };
    const all = scanExternalLinks(text);
    this.sortNewLinks(text, all);
    const links = all.filter((link) => link.swappable);
    const carets = this.carets();
    const written = links.filter((link) => writing(link, carets));
    // A link and its copy elsewhere on the page: the copy is finished
    const held = written.filter((link) => links.every((other) => other.url !== link.url || writing(other, carets)));
    return {
      urls: [...new Set(links.map((link) => link.url))],
      held: held.map(({ url, start, end }) => ({ url, start, end })),
    };
  }

  /**
   * Files each URL not seen before as this person's, if they wrote it on this
   * visit everywhere it is on the page, or as known. Moved or copied text keeps
   * who wrote it (keepAuthorship), so moving an old link doesn't make it new.
   */
  private sortNewLinks(text: string, links: ExternalLink[]) {
    const unsorted = links.filter((link) => !this.known.has(link.url) && !this.added.has(link.url));
    if (unsorted.length === 0) return;
    const runs = getAuthorshipRuns(this.text);
    const mine = (client: number) => this.ownClients.has(client) || isOwnClient(this.doc, client);
    const own = new Map<string, boolean>();
    for (const link of unsorted) {
      const [from, to] = urlRange(text, link);
      own.set(link.url, (own.get(link.url) ?? true) && writtenBy(runs, from, to, mine));
    }
    for (const [url, isOwn] of own) (isOwn ? this.added : this.known).add(url);
  }

  /** This person's link: added on this visit, or accepted on an earlier one. */
  private isMine(url: string): boolean {
    return this.added.has(url) || !!this.accepted?.has(url);
  }

  /** Every caret on the page: this person's and everyone else's. */
  private carets(): number[] {
    const carets = this.caret === null ? [] : [this.caret];
    const { awareness } = this;
    if (!awareness) return carets;
    for (const [clientId, state] of awareness.getStates()) {
      const head = (state as { cursor?: { head?: unknown } } | null)?.cursor?.head;
      if (clientId === awareness.clientID || head == null) continue;
      try {
        const at = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(head), this.doc);
        if (at?.type === this.text) carets.push(at.index);
      } catch {
        // A cursor from a version this one can't read: no caret
      }
    }
    return carets;
  }

  private isHeld(url: string): boolean {
    return this.held.some((link) => link.url === url);
  }

  private readLatest() {
    const { urls, held } = this.readPage();
    this.latest = urls;
    this.held = held;
  }

  private scan = () => {
    if (this.scanTimer !== null) clearTimeout(this.scanTimer);
    this.scanTimer = null;
    this.readLatest();
    void this.refresh();
  };

  /** Where the caret is now. Only a held link's release is worth a scan. */
  setCaret = (pos: number) => {
    this.caret = pos;
    this.releaseHeld();
  };

  /** Everyone else's carets, from the page's awareness. */
  setAwareness(awareness: Awareness | null) {
    if (awareness === this.awareness) return;
    if (this.running) this.awareness?.off('change', this.onAwarenessChange);
    this.awareness = awareness;
    if (this.running) awareness?.on('change', this.onAwarenessChange);
  }

  private onAwarenessChange = () => this.releaseHeld();

  private releaseHeld() {
    if (this.held.length === 0 || this.scanTimer !== null || !this.running) return;
    const carets = this.carets();
    if (this.held.some((link) => !writing(link, carets))) this.scan();
  }

  /** Asks about URLs the server has not seen, then shows the page as scanned. */
  private async refresh() {
    if (this.refreshing) {
      this.refreshAgain = true;
      return;
    }
    this.refreshing = true;
    do {
      this.refreshAgain = false;
      const unseen = this.latest.filter((url) => !this.statuses.has(url) && !this.isHeld(url));
      if (unseen.length > 0 && !this.blocked) await this.ask(unseen);
    } while (this.refreshAgain);
    this.refreshing = false;
    if (this.running) this.commit();
  }

  /** Moves the rows onto the last scan. */
  private commit(force = false) {
    const wouldHide = this.model.kind === 'offer' && barModel(this.rowsFor(this.latest), this.queue).kind === 'hidden';
    if (wouldHide && !force) {
      this.holdTimer ??= setTimeout(this.endHold, OFFER_HOLD_MS);
      return;
    }
    if (this.holdTimer !== null) {
      clearTimeout(this.holdTimer);
      this.holdTimer = null;
    }
    this.page = this.latest;

    const onPage = new Set(this.latest);
    let askWhy = false;
    for (const [url, tracked] of this.tracked) {
      if (onPage.has(url)) {
        // An undo brought it back: it was answered, so it is left as it is
        if (tracked.local) this.tracked.delete(url);
        continue;
      }
      if (tracked.phase === 'settling' && !tracked.awaitingSwap) tracked.phase = 'done';
      else if (tracked.phase === 'failed') this.tracked.delete(url); // nothing left to fix
      else if (tracked.phase === 'active' && !tracked.gone) {
        // The link went: swapped by a finished job, or deleted while one runs.
        tracked.gone = true;
        askWhy = true;
      }
    }
    this.publish();
    if (askWhy) void this.poll();
    else this.schedulePoll();
  }

  private endHold = () => {
    this.holdTimer = null;
    // Still mid-edit: decide at the next pause, not while the next URL is typed
    if (this.scanTimer !== null) this.holdTimer = setTimeout(this.endHold, OFFER_HOLD_MS);
    else this.commit(true);
  };

  // ── Asking the server ────────────────────────────────────────────────

  /** False when the server could not be reached or refused. */
  private async ask(urls: string[]): Promise<boolean> {
    for (const chunk of chunks(urls, CHECK_CHUNK)) {
      const askedAt = this.clock;
      try {
        const response = await fetch('/api/add-article/links/check', {
          method: 'POST',
          headers: relayHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ urls: chunk, path: this.context.path }),
        });
        if (response.status === 401 || response.status === 403) {
          this.blocked = true;
          return false;
        }
        if (!response.ok) return false;
        const body = (await response.json()) as SourceLinksCheckResponse;
        if (!Array.isArray(body?.links)) return false;
        this.applyAnswer(chunk, body, askedAt);
      } catch {
        return false;
      }
    }
    return true;
  }

  private applyAnswer(urls: string[], answer: SourceLinksCheckResponse, askedAt: number) {
    this.ready = answer.ready !== false;
    this.rememberQueue(answer.queue);
    const links = new Map(answer.links.map((link) => [link.url, link]));
    for (const url of urls) {
      if ((this.changed.get(url) ?? 0) > askedAt) continue;
      const link = links.get(url) ?? null;
      this.statuses.set(url, link);
      this.follow(url, link);
    }
  }

  /** Keeps a job's progress in step with what the server says of its URL. */
  private follow(url: string, link: SourceLinkStatus | null) {
    const tracked = this.tracked.get(url);
    if (tracked?.phase === 'sent') return;
    if (link?.state === 'queued' || link?.state === 'importing') {
      // Someone else's import, or one of a link that was turned down here, isn't news
      if (!tracked && (!this.isMine(url) || readLinkOffers(this.doc).has(url))) return;
      this.tracked.set(url, { imported: true, gone: tracked?.gone, phase: 'active', id: link.job_id });
      return;
    }
    if (tracked?.phase !== 'active' && tracked?.phase !== 'settling') return;
    if (link?.state === 'library') {
      this.followSwap(url, tracked, link);
      return;
    }
    // Failed, stopped elsewhere, or not a source after all: the status says so
    this.tracked.delete(url);
  }

  /** The job has ended. What matters now is whether a link really changed. */
  private followSwap(url: string, tracked: Tracked, link: SourceLinkStatus) {
    const { link_state: outcome } = link;
    if (outcome === 'linked' || outcome === 'suggested') {
      tracked.phase = 'done';
      tracked.suggested = outcome === 'suggested';
      tracked.awaitingSwap = false;
      return;
    }
    if (outcome === 'not_found' || outcome === 'failed') {
      // Deleted during the import, so nothing to say; or it is on offer again
      this.tracked.delete(url);
      return;
    }
    tracked.awaitingSwap = outcome === 'waiting';
    if (!tracked.awaitingSwap && !this.latest.includes(url)) {
      // A server with nothing to say of this page's link: the text is the evidence
      tracked.phase = 'done';
    } else if (tracked.phase === 'active') {
      tracked.phase = 'settling';
      tracked.settleBy = Date.now() + SETTLE_MS;
    }
  }

  private needsPoll(): boolean {
    if (this.blocked) return false;
    if (this.unconfirmed().length > 0) return true;
    return [...this.tracked.values()].some(({ phase }) => phase === 'active' || phase === 'settling');
  }

  /** While the index loads, the page's sources are to be asked about again. */
  private unconfirmed(): string[] {
    return this.ready ? [] : this.latest.filter((url) => this.statuses.get(url) !== null);
  }

  private schedulePoll() {
    if (this.pollTimer !== null || !this.running || !this.needsPoll()) return;
    if (document.visibilityState === 'hidden') return;
    const delay = Math.min(POLL_MS * 2 ** this.pollFailures, POLL_MAX_MS);
    this.pollTimer = setTimeout(() => void this.poll(), delay);
  }

  private async poll() {
    if (this.pollTimer !== null) clearTimeout(this.pollTimer);
    this.pollTimer = null;
    if (this.polling || !this.running || !this.needsPoll()) return;
    this.polling = true;
    // A swap's change may be waiting on the debounce, behind someone typing
    this.readLatest();
    const active = [...this.tracked]
      .filter(([, { phase, awaitingSwap }]) => phase === 'active' || awaitingSwap)
      .map(([url]) => url);
    const reached = await this.ask([...new Set([...active, ...this.unconfirmed()])]);
    this.polling = false;
    // A blip keeps what is on screen and tries again, more slowly
    this.pollFailures = reached ? 0 : this.pollFailures + 1;
    if (!this.running) return;
    const now = Date.now();
    for (const [url, tracked] of this.tracked) {
      if (tracked.phase === 'settling' && now >= (tracked.settleBy ?? 0)) this.tracked.delete(url);
    }
    this.commit();
  }

  private onVisibilityChange = () => {
    if (document.visibilityState === 'hidden') {
      if (this.pollTimer !== null) clearTimeout(this.pollTimer);
      this.pollTimer = null;
    } else {
      void this.poll();
    }
    // An offer on a hidden page isn't on screen
    this.offeredAt.clear();
    this.watchOffers();
  };

  // ── Rows and the bar ─────────────────────────────────────────────────

  private offerState(url: string, status: SourceLinkStatus | undefined, dismissed: boolean): RowState | null {
    if (!status || dismissed) return null;
    // A failure is news to whoever asked for the import, once
    if (status.state === 'failed') return this.isMine(url) ? 'failed' : null;
    // While the index loads, `new` is unconfirmed: wait rather than offer
    if (!this.ready || this.isHeld(url) || !this.added.has(url) || this.seen?.has(url)) return null;
    if (status.state === 'library') return 'library';
    return status.state === 'new' || status.state === 'stub' ? 'new' : null;
  }

  private rowsFor(page: string[]): SourceRow[] {
    if (this.blocked) return [];
    const dismissed = readLinkOffers(this.doc);
    const rows = new Map<string, SourceRow>();
    for (const url of new Set([...page, ...this.tracked.keys()])) {
      const tracked = this.tracked.get(url);
      const status = this.statuses.get(url) ?? undefined;
      const state = tracked ? STATE_OF_PHASE[tracked.phase] : this.offerState(url, status, dismissed.has(url));
      if (!state) continue;
      const jobId = tracked?.id ?? status?.job_id;
      const key = status?.key ?? url;
      const row = rows.get(key);
      if (row) {
        row.urls.push(url);
        if (jobId && !row.jobIds.includes(jobId)) row.jobIds.push(jobId);
        continue;
      }
      rows.set(key, {
        key,
        url,
        urls: [url],
        kind: status?.kind ?? 'article',
        label: status?.state === 'library' && status.title ? status.title : sourceLabel(url),
        libraryPath: status?.state === 'library' ? status.path : undefined,
        state,
        step: tracked && stepOf(tracked, status),
        imported: tracked?.imported,
        suggested: tracked?.suggested,
        jobIds: jobId ? [jobId] : [],
        error: tracked?.error ?? (state === 'failed' ? status?.error : undefined),
        etaMinutes: tracked?.phase === 'active' ? status?.eta_minutes : undefined,
      });
    }
    return [...rows.values()];
  }

  private publish = () => {
    const next = this.visibleModel();
    const json = JSON.stringify(next);
    if (json !== this.modelJson) {
      this.model = next;
      this.modelJson = json;
      this.listeners.forEach((listener) => listener());
    }
    if (next.kind === 'done') {
      if (this.running) this.doneTimer ??= setTimeout(this.clearDone, DONE_CLEARS_MS);
    } else if (this.doneTimer !== null) {
      clearTimeout(this.doneTimer);
      this.doneTimer = null;
    }
    this.watchOffers();
  };

  /** The bar, less what Hide put away. */
  private visibleModel(): BarModel {
    const rows = this.rowsFor(this.page).filter((row) => !(row.state === 'failed' && this.hiddenFailures.has(row.key)));
    const model = barModel(rows, this.queue);
    if (!this.hidden) return model;
    // What was on offer at Hide is answered, so an offer now is of a link added since
    if (model.kind !== 'offer' && model.kind !== 'failed') return HIDDEN_BAR;
    this.hidden = false;
    return model;
  }

  /** Hides the bar until a link is added or something fails. Only this person:
   *  what was on offer is answered. */
  hide = () => {
    const rows = this.rowsFor(this.page);
    this.answer(rows.filter((row) => row.state === 'new' || row.state === 'library').flatMap((row) => row.urls));
    const failed = rows.filter((row) => row.state === 'failed');
    for (const row of failed) this.hiddenFailures.add(row.key);
    forgetAcceptedLinkOffers(this.docId, failed.flatMap((row) => row.urls));
    this.hidden = true;
    this.publish();
  };

  /** Keeps time on the offers and failures on screen. */
  private watchOffers() {
    const shown = this.model.kind === 'offer' || this.model.kind === 'failed';
    const onOffer = new Set(shown ? this.model.dismissUrls : []);
    for (const url of this.offeredAt.keys()) {
      if (!onOffer.has(url)) this.offeredAt.delete(url);
    }
    if (this.running && document.visibilityState !== 'hidden') {
      for (const url of onOffer) {
        if (!this.offeredAt.has(url)) this.offeredAt.set(url, Date.now());
      }
    }
    if (this.offeredAt.size === 0) {
      if (this.seenTimer !== null) clearTimeout(this.seenTimer);
      this.seenTimer = null;
    } else if (this.seenTimer === null) {
      const next = Math.min(...this.offeredAt.values()) + OFFER_SEEN_MS;
      this.seenTimer = setTimeout(this.recordSeen, Math.max(0, next - Date.now()));
    }
  }

  private recordSeen = () => {
    this.seenTimer = null;
    const now = Date.now();
    const due = [...this.offeredAt].filter(([, at]) => now - at >= OFFER_SEEN_MS).map(([url]) => url);
    if (due.length > 0) {
      markLinkOffersSeen(this.docId, due);
      forgetAcceptedLinkOffers(this.docId, due);
    }
    // Still on offer, but counted: this timer has no more to do for them
    for (const url of due) this.offeredAt.set(url, Number.POSITIVE_INFINITY);
    const waiting = [...this.offeredAt.values()].filter(Number.isFinite);
    if (waiting.length > 0) {
      this.seenTimer = setTimeout(this.recordSeen, Math.max(0, Math.min(...waiting) + OFFER_SEEN_MS - now));
    }
  };

  private clearDone = () => {
    this.doneTimer = null;
    this.forgetFinished();
    this.publish();
  };

  private forgetFinished() {
    const done: string[] = [];
    for (const [url, { phase }] of this.tracked) {
      if (phase === 'done') done.push(url);
      if (phase === 'done' || phase === 'failed') this.tracked.delete(url);
    }
    // Linked: the same link written again on this visit isn't offered
    for (const url of done) this.seen?.add(url);
    forgetAcceptedLinkOffers(this.docId, done);
  }

  // ── What the person does ─────────────────────────────────────────────

  /** Imports and links the URLs still in the text. */
  accept = (urls: string[]) => {
    const onPage = new Set(this.readPage().urls);
    const listed = urls.filter((url) => onPage.has(url));
    this.submit(listed);
    // Nothing left of what was on offer: the bar was only being held up
    if (listed.length === 0) this.commit(true);
  };

  /** Leaves these out for this person, for good, and for nobody else. */
  setAside = (urls: string[]) => {
    this.answer(urls);
    this.publish();
  };

  /** Not offered to this person again, on this visit or the next. */
  private answer(urls: string[]) {
    if (urls.length === 0) return;
    markLinkOffersSeen(this.docId, urls);
    this.seen ??= new Set();
    for (const url of urls) this.seen.add(url);
  }

  /** The right-click: whatever was decided about this link before, even Hide. */
  importSource = (url: string) => {
    undoLinkOfferDismissal(this.doc, url);
    this.hidden = false;
    this.submit([url]);
  };

  /** Whether the right-click may offer this link. */
  canImport = (url: string): boolean => {
    if (this.blocked || this.statuses.get(url) === null) return false;
    return pageOffersSourceLinks(this.context.path, this.text.toString());
  };

  dismiss = (urls: string[]) => {
    this.forgetFinished();
    forgetAcceptedLinkOffers(this.docId, urls);
    dismissLinkOffers(this.doc, urls, this.author());
    this.publish();
  };

  retry = () => {
    const withoutJob: string[] = [];
    for (const row of this.model.rows) {
      if (row.state !== 'failed') continue;
      const [id] = row.jobIds;
      if (!id) {
        withoutJob.push(...row.urls);
        continue;
      }
      for (const url of row.urls) this.tracked.set(url, { phase: 'sent', imported: true });
      rememberAcceptedLinkOffers(this.docId, row.urls);
      void this.retryJob(id, row.urls);
    }
    this.submit(withoutJob);
    this.publish();
  };

  /** Stops every running import of the page's sources. */
  stopImports = async () => {
    const ids = new Set<string>();
    for (const { phase, id } of this.tracked.values()) {
      if (phase === 'active' && id) ids.add(id);
    }
    const stopped = new Set<string>();
    for (const chunk of chunks([...ids], CANCEL_CHUNK)) {
      try {
        const response = await fetch('/api/add-article/cancel', {
          method: 'POST',
          headers: relayHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ ids: chunk, path: this.context.path }),
        });
        if (!response.ok) continue;
        const body = (await response.json()) as {
          results?: Array<{ id: string; cancelled?: boolean; detached?: boolean }>;
        };
        for (const result of body.results ?? []) {
          // Detached: the job goes on for someone else, and has let go of this page
          if (result.cancelled || result.detached) stopped.add(result.id);
        }
      } catch {
        // The next poll shows it still running
      }
    }
    const stoppedUrls: string[] = [];
    for (const [url, { id }] of this.tracked) {
      if (!id || !stopped.has(id)) continue;
      this.tracked.delete(url);
      this.statuses.delete(url);
      this.changed.set(url, ++this.clock);
      stoppedUrls.push(url);
    }
    // Stopped is an answer: not offered again, to this person
    forgetAcceptedLinkOffers(this.docId, stoppedUrls);
    this.answer(stoppedUrls);
    // What a stopped source is now is the server's to say
    await this.refresh();
  };

  private author(): string {
    return this.context.actor.slice('human:'.length);
  }

  private submit(urls: string[]) {
    const fresh = urls.filter((url) => {
      const phase = this.tracked.get(url)?.phase;
      return phase === undefined || phase === 'done' || phase === 'failed';
    });
    if (fresh.length === 0) return;
    // Asked for again: its next failure is news
    for (const url of fresh) this.hiddenFailures.delete(this.statuses.get(url)?.key ?? url);
    const swapped = this.swapInPage(fresh);
    for (const url of swapped) {
      // Linked: an undo that brings it back doesn't ask again
      this.seen?.add(url);
      this.changed.set(url, ++this.clock);
      this.tracked.set(url, { phase: 'done', imported: false, local: true });
    }
    if (swapped.size > 0) this.readLatest();
    const rest = fresh.filter((url) => !swapped.has(url));
    // Its progress and its failure are this person's news on their next visit too
    rememberAcceptedLinkOffers(this.docId, rest);
    for (const url of rest) {
      this.tracked.set(url, { phase: 'sent', imported: this.statuses.get(url)?.state !== 'library' });
    }
    this.publish();
    if (rest.length > 0) void this.send(rest);
  }

  /** Swaps what the library has in the open editor, as one edit. */
  private swapInPage(urls: string[]): Set<string> {
    const { suggesting, swapInPage } = this.context;
    if (suggesting || !swapInPage) return new Set();
    const hits = new Map<string, LibraryHit>();
    for (const url of urls) {
      const status = this.statuses.get(url);
      if (status?.state !== 'library' || !status.path) continue;
      const hit = hits.get(status.path);
      if (hit) hit.urls.push(url);
      else hits.set(status.path, { urls: [url], path: status.path, title: status.title });
    }
    return new Set(hits.size > 0 ? swapInPage([...hits.values()]) : []);
  }

  /** Runs to the end even if the page is left: the person asked for all of it. */
  private async send(urls: string[]) {
    const { path, actor, suggesting } = this.context;
    const linkBack: LinkBackRequest = {
      path,
      actor,
      author: this.author(),
      ...(suggesting ? { protectHuman: true } : {}),
    };
    for (const chunk of chunks(urls, IMPORT_CHUNK)) {
      const answer = await this.postImport(chunk, linkBack);
      chunk.forEach((url, index) => this.settleAccepted(url, answer.rows[index], answer.error));
      this.publish();
    }
    this.schedulePoll();
  }

  /** One row per URL, in request order; a refusal of the request has no rows. */
  private async postImport(urls: string[], linkBack: LinkBackRequest): Promise<{ rows: ImportResultRow[]; error?: string }> {
    try {
      const response = await fetch('/api/add-article', {
        method: 'POST',
        headers: relayHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ urls, importMode: 'article', linkBack }),
      });
      const body = (await response.json()) as { results?: ImportResultRow[]; queue?: SourceQueue; error?: string };
      if (!response.ok) return { rows: [], error: body.error };
      this.rememberQueue(body.queue);
      return { rows: body.results ?? [] };
    } catch {
      return { rows: [] };
    }
  }

  private rememberQueue(queue: SourceQueue | undefined) {
    if (!queue) return;
    const { workers, avg_job_minutes, queued, processing } = queue;
    this.queue = { workers, avg_job_minutes, queued, processing };
  }

  /** What the server said of one accepted URL. */
  private settleAccepted(url: string, row: ImportResultRow | undefined, refusal?: string) {
    this.changed.set(url, ++this.clock);
    const tracked = this.tracked.get(url);
    if (!tracked) return;
    const before = this.statuses.get(url);
    const remember = (update: Partial<SourceLinkStatus>) =>
      this.statuses.set(url, { url, key: url, kind: 'article', state: 'new', ...before, ...update });
    switch (row?.status) {
      case 'linked':
      case 'suggested':
        // Swapped at once: the library had it, whatever was guessed before asking
        tracked.phase = 'done';
        tracked.imported = false;
        tracked.suggested = row.status === 'suggested';
        remember({ state: 'library', path: row.path ?? before?.path, title: row.title ?? before?.title });
        break;
      case 'queued':
      case 'already_queued':
        tracked.phase = 'active';
        tracked.id = row.id;
        remember({
          state: 'queued',
          job_id: row.id,
          queue_position: row.queue_position,
          eta_minutes: row.eta_minutes,
          error: undefined,
        });
        break;
      case 'link_failed':
        // Someone else's swap got there first: the link left, as was wanted
        if (!this.readPage().urls.includes(url)) {
          tracked.phase = 'done';
          break;
        }
        tracked.phase = 'failed';
        tracked.error = row.error ?? NO_ANSWER;
        break;
      default:
        tracked.phase = 'failed';
        tracked.error = row?.error ?? refusal ?? NO_ANSWER;
    }
  }

  private async retryJob(jobId: string, urls: string[]) {
    let id: string | undefined;
    try {
      const response = await fetch(`/api/add-article/${encodeURIComponent(jobId)}/retry`, {
        method: 'POST',
        headers: relayHeaders(),
      });
      // 409: someone got there first, and the answer names the running job
      if (response.ok || response.status === 409) id = ((await response.json()) as { id?: string }).id;
    } catch {
      // Stays failed
    }
    for (const url of urls) {
      this.settleAccepted(url, id ? { url, status: 'queued', id } : undefined);
    }
    this.publish();
    this.schedulePoll();
  }
}
