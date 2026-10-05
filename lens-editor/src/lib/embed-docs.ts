/**
 * Documents shown inside another document through `![[...]]` embeds.
 *
 * An embed starts as a read-only snapshot: the file is read once (connect,
 * sync, read, disconnect) and the connection is gone again. Reads run only
 * when an embed scrolls into view, at most MAX_PARALLEL_READS at a time, so a
 * lens that embeds ten files opens as fast as one that embeds none.
 *
 * Clicking an embed opens it live (a real CRDT connection, editable in
 * place). Only one embed is live at a time across the tab: opening another
 * ends the current one, which falls back to its snapshot.
 */
import { connectDoc, teardownProvider, type DocConnection } from '../hooks/useDocConnection';
import { readDocumentText } from './relay-api';

export const MAX_PARALLEL_READS = 3;
/** A snapshot older than this is read again when its embed comes into view. */
export const SNAPSHOT_TTL_MS = 30_000;

type Reader = (fullDocId: string) => Promise<string>;
type Connector = (fullDocId: string) => Promise<DocConnection>;

let reader: Reader = readDocumentText;
let connector: Connector = connectDoc;

const snapshots = new Map<string, { text: string; at: number }>();
const inflight = new Map<string, Promise<string>>();
const snapshotListeners = new Map<string, Set<(text: string) => void>>();
let running = 0;
const waiting: Array<() => void> = [];

async function withReadSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= MAX_PARALLEL_READS) {
    await new Promise<void>((resolve) => waiting.push(resolve));
  }
  running++;
  try {
    return await fn();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

/** The last snapshot of `fullDocId`, if any (possibly stale). */
export function cachedSnapshot(fullDocId: string): string | undefined {
  return snapshots.get(fullDocId)?.text;
}

/** Record the current text of `fullDocId` and tell every embed showing it. */
export function setSnapshot(fullDocId: string, text: string, now = Date.now()): void {
  snapshots.set(fullDocId, { text, at: now });
  for (const listener of snapshotListeners.get(fullDocId) ?? []) listener(text);
}

/** Be told whenever a new snapshot of `fullDocId` is recorded. */
export function onSnapshot(fullDocId: string, listener: (text: string) => void): () => void {
  let set = snapshotListeners.get(fullDocId);
  if (!set) snapshotListeners.set(fullDocId, (set = new Set()));
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0) snapshotListeners.delete(fullDocId);
  };
}

/**
 * The text of `fullDocId`: the cached snapshot while it is fresh, otherwise
 * one read (shared by every embed of the same file that asks meanwhile).
 */
export function readSnapshot(fullDocId: string, now = Date.now()): Promise<string> {
  const cached = snapshots.get(fullDocId);
  if (cached && now - cached.at < SNAPSHOT_TTL_MS) return Promise.resolve(cached.text);
  const pending = inflight.get(fullDocId);
  if (pending) return pending;
  const read = withReadSlot(() => reader(fullDocId))
    .then((text) => {
      setSnapshot(fullDocId, text);
      return text;
    })
    .finally(() => inflight.delete(fullDocId));
  inflight.set(fullDocId, read);
  return read;
}

export interface LiveEmbed {
  fullDocId: string;
  connection: DocConnection;
}

let live: { fullDocId: string; owner: object; connection: DocConnection | null; onEnd: () => void } | null = null;

/**
 * Open `fullDocId` live for `owner` (the embed asking), ending whichever embed
 * was live before (its `onEnd` runs). Resolves to null when another open or a
 * close overtook this one before it connected.
 */
export async function openLive(fullDocId: string, owner: object, onEnd: () => void): Promise<LiveEmbed | null> {
  closeLive();
  const entry = { fullDocId, owner, connection: null as DocConnection | null, onEnd };
  live = entry;
  const connection = await connector(fullDocId);
  if (live !== entry) {
    teardownProvider(connection.provider);
    connection.doc.destroy();
    return null;
  }
  entry.connection = connection;
  return { fullDocId, connection };
}

/** End the live embed (only if `owner` holds it, when given). */
export function closeLive(owner?: object): void {
  if (!live || (owner && live.owner !== owner)) return;
  const ended = live;
  live = null;
  if (ended.connection) {
    setSnapshot(ended.fullDocId, ended.connection.doc.getText('contents').toString());
    teardownProvider(ended.connection.provider);
    ended.connection.doc.destroy();
  }
  ended.onEnd();
}

/** Whether `owner` is the live embed (or is connecting). */
export function isLive(owner: object): boolean {
  return live?.owner === owner;
}

/** Test hooks. */
export const __embedDocsTesting = {
  setReader(fn: Reader) { reader = fn; },
  setConnector(fn: Connector) { connector = fn; },
  reset() {
    closeLive();
    reader = readDocumentText;
    connector = connectDoc;
    snapshots.clear();
    inflight.clear();
    snapshotListeners.clear();
    running = 0;
    waiting.length = 0;
  },
  get running() { return running; },
};
