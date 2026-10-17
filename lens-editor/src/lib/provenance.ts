/**
 * Provenance: clientID → actor registration (Yjs PermanentUserData layout).
 *
 * Every Y.Text item permanently carries the clientID of the Y.Doc instance
 * that created it. Attribution therefore reduces to mapping clientIDs to
 * actors in the top-level "users" Y.Map of each content doc, using the same
 * layout the relay server writes in doc_connection.rs
 * (users.<actor> = { ids: Y.Array<number>, ds: Y.Array, meta: Y.Map }):
 *
 *   - `ids`:  clientIDs owned by this actor
 *   - `ds`:   kept empty; exists so canonical PUD readers don't crash
 *   - `meta`: String(clientID) → { registeredAt } — our extension, used to
 *             date text at session granularity (see docs/plans/
 *             2026-07-18-provenance-design.md)
 *
 * Actor keys: `human:<display name>` | `ai:<model>:<behalf>`. Unmapped
 * clientIDs render as "unknown".
 *
 * Registration happens lazily on the first local edit, so read-only viewers
 * never write mappings. The clientID rotates on display-name change and on
 * local calendar-day boundaries, which is what makes per-run dating possible:
 * one clientID never spans more than one (actor, day) pair.
 */
import * as Y from 'yjs';

export const PROVENANCE_ORIGIN = 'provenance-registration';

const USERS_MAP_KEY = 'users';

export function humanActor(displayName: string): string {
  const trimmed = displayName.trim();
  return `human:${trimmed || 'unknown'}`;
}

/** A human or an AI whose name or model we don't know (the paste popover's
 *  generic "Human" / "AI" answers). */
export const GENERIC_HUMAN_ACTOR = 'human:unknown';
export const GENERIC_AI_ACTOR = 'ai:unknown';

/** "<name>'s AI": an AI of unknown model writing on behalf of `displayName`. */
export function aiOnBehalfActor(displayName: string): string {
  const trimmed = displayName.trim();
  return trimmed ? `ai:unknown:${trimmed}` : GENERIC_AI_ACTOR;
}

function usersMap(doc: Y.Doc): Y.Map<unknown> {
  return doc.getMap(USERS_MAP_KEY);
}

function idsOf(entry: unknown): Y.Array<unknown> | null {
  if (!(entry instanceof Y.Map)) return null;
  const ids = entry.get('ids');
  return ids instanceof Y.Array ? ids : null;
}

/**
 * Actors written by the provenance layer. The relay's server-driven PUD
 * registration also writes raw Relay.md user IDs (no prefix) into the same
 * map; where both claim a clientID, resolution must deterministically prefer
 * the provenance actor — Y.Map iteration order is not a stable tiebreaker.
 */
function isProvenanceActor(actor: string): boolean {
  return actor.startsWith('human:') || actor.startsWith('ai:');
}

function entryHasClientId(entry: unknown, clientID: number): boolean {
  const ids = idsOf(entry);
  if (!ids) return false;
  for (const id of ids) {
    if (Number(id) === clientID) return true;
  }
  return false;
}

/** Resolve a clientID to its registered actor key, or null if unmapped.
 *  Provenance-prefixed actors win over legacy raw user keys. */
export function getRegisteredActor(doc: Y.Doc, clientID: number): string | null {
  const users = usersMap(doc);
  let fallback: string | null = null;
  for (const [actor, entry] of users.entries()) {
    if (!entryHasClientId(entry, clientID)) continue;
    if (isProvenanceActor(actor)) return actor;
    fallback ??= actor;
  }
  return fallback;
}

/** Build the reverse lookup clientID → actor key for the whole doc.
 *  Provenance-prefixed actors win over legacy raw user keys. */
export function getClientActorMap(doc: Y.Doc): Map<number, string> {
  const result = new Map<number, string>();
  const users = usersMap(doc);
  for (const [actor, entry] of users.entries()) {
    const ids = idsOf(entry);
    if (!ids) continue;
    for (const id of ids) {
      const key = Number(id);
      const existing = result.get(key);
      if (existing === undefined || (isProvenanceActor(actor) && !isProvenanceActor(existing))) {
        result.set(key, actor);
      }
    }
  }
  return result;
}

/** Registration timestamp (epoch ms) for a clientID, or null if unknown.
 *  Reads meta from the same entry getRegisteredActor would resolve to. */
export function getRegisteredAt(doc: Y.Doc, clientID: number): number | null {
  const users = usersMap(doc);
  let entryForActor: Y.Map<unknown> | null = null;
  for (const [actor, entry] of users.entries()) {
    if (!entryHasClientId(entry, clientID)) continue;
    if (isProvenanceActor(actor)) {
      entryForActor = entry as Y.Map<unknown>;
      break;
    }
    entryForActor ??= entry as Y.Map<unknown>;
  }
  if (!entryForActor) return null;
  const meta = entryForActor.get('meta');
  if (!(meta instanceof Y.Map)) return null;
  const record = meta.get(String(clientID)) as { registeredAt?: number } | undefined;
  return typeof record?.registeredAt === 'number' ? record.registeredAt : null;
}

/**
 * Register a clientID under an actor. Idempotent: a clientID already
 * registered (to any actor) is left untouched. Returns whether it wrote.
 * `now` null registers the actor without a date (text of unknown date).
 */
export function registerClientMapping(
  doc: Y.Doc,
  actor: string,
  now: number | null,
  clientID: number = doc.clientID
): boolean {
  if (getRegisteredActor(doc, clientID) !== null) return false;

  doc.transact(() => {
    const users = usersMap(doc);
    let entry = users.get(actor);
    if (!(entry instanceof Y.Map)) {
      entry = users.set(actor, new Y.Map());
    }
    const map = entry as Y.Map<unknown>;

    let ids = map.get('ids');
    if (!(ids instanceof Y.Array)) {
      ids = map.set('ids', new Y.Array());
    }
    (ids as Y.Array<number>).push([clientID]);

    if (!(map.get('ds') instanceof Y.Array)) {
      map.set('ds', new Y.Array());
    }

    let meta = map.get('meta');
    if (!(meta instanceof Y.Map)) {
      meta = map.set('meta', new Y.Map());
    }
    if (now !== null) (meta as Y.Map<unknown>).set(String(clientID), { registeredAt: now });
  }, PROVENANCE_ORIGIN);

  return true;
}

function sameLocalDay(a: number, b: number): boolean {
  return new Date(a).toDateString() === new Date(b).toDateString();
}

export function freshClientId(doc: Y.Doc): number {
  let id: number;
  do {
    id = Math.floor(Math.random() * 0xffffffff) >>> 0;
  } while (doc.store.clients.has(id));
  return id;
}

/**
 * ClientIDs awaiting user classification (paste popover). While an ID is
 * pending, the lazy registration hook must not claim it for the human actor —
 * the popover decides (or it stays unmapped/unknown).
 */
const pendingClassification = new Set<number>();

export function markPendingClassification(clientID: number): void {
  pendingClassification.add(clientID);
}

export function resolvePendingClassification(clientID: number): void {
  pendingClassification.delete(clientID);
}

export function isPendingClassification(clientID: number): boolean {
  return pendingClassification.has(clientID);
}

export type PasteOrigin = 'self' | 'self-ai' | 'human' | 'ai';

export interface PasteOriginOption {
  origin: PasteOrigin;
  label: string;
  kind: 'human' | 'ai';
  /** The writer's name, for "self-ai": shown truncatable, with a fixed "'s AI". */
  name?: string;
}

/**
 * Answers for the paste popover: the writer's own name and "<name>'s AI"
 * ("Luc" / "Luc's AI"), then a generic "Human" and "AI" for someone else's
 * text or text of unknown origin. Without a display name only the generic
 * two remain, since the writer's own answer would be the generic human.
 */
export function pasteOriginOptions(displayName: string | null): PasteOriginOption[] {
  const name = displayName?.trim() || null;
  const generic: PasteOriginOption[] = [
    { origin: 'human', label: 'Human', kind: 'human' },
    { origin: 'ai', label: 'AI', kind: 'ai' },
  ];
  if (!name) return generic;
  return [
    { origin: 'self', label: name, kind: 'human' },
    { origin: 'self-ai', label: `${name}'s AI`, kind: 'ai', name },
    ...generic,
  ];
}

export function pasteOriginActor(origin: PasteOrigin, displayName: string | null): string {
  switch (origin) {
    case 'self': return humanActor(displayName ?? '');
    case 'self-ai': return aiOnBehalfActor(displayName ?? '');
    case 'human': return GENERIC_HUMAN_ACTOR;
    case 'ai': return GENERIC_AI_ACTOR;
  }
}

/**
 * Record the popover's answer for a pending paste: map the paste's temporary
 * clientID to the actor of the chosen answer. "self" uses `displayName`, the
 * same DisplayNameContext value the lazy registration path uses, so the
 * answer and ordinary typing land under the same actor key.
 */
export function classifyPendingPaste(
  doc: Y.Doc,
  pasteId: number,
  origin: PasteOrigin,
  displayName: string | null,
  now: number = Date.now()
): void {
  registerClientMapping(doc, pasteOriginActor(origin, displayName), now, pasteId);
}

/**
 * ClientIDs this doc instance minted to re-insert existing text under its
 * original author (moved lines, pasted copies): one per (actor, date), so
 * each resolves to the same actor and registration date as the text it
 * carries. Only this Y.Doc instance ever writes under them, which is what
 * makes reusing them safe (a clientID shared by two writers corrupts the doc).
 */
const carriers = new WeakMap<Y.Doc, Map<string, number>>();

/** Extra clientIDs this Y.Doc instance minted and writes under (carriers and
 *  paste IDs). Per instance: a doc opened again is a new Y.Doc that receives
 *  text under the old instance's IDs, and must not write under them. */
const ownClients = new WeakMap<Y.Doc, Set<number>>();

/** Record that this Y.Doc instance minted `clientID` to write under. */
export function claimClientId(doc: Y.Doc, clientID: number): void {
  let ids = ownClients.get(doc);
  if (!ids) ownClients.set(doc, (ids = new Set()));
  ids.add(clientID);
}

/** Whether this doc instance may write under `clientID` itself: its own
 *  session ID, or an ID it minted (a carrier, a paste's ID). */
export function isOwnClient(doc: Y.Doc, clientID: number): boolean {
  return clientID === doc.clientID || !!ownClients.get(doc)?.has(clientID);
}

/**
 * A clientID to write text under so it resolves to `actor` (null: unknown,
 * left unmapped) dated `at` (null: undated). Registers it on first use.
 */
export function carrierClientId(doc: Y.Doc, actor: string | null, at: number | null): number {
  let byKey = carriers.get(doc);
  if (!byKey) carriers.set(doc, (byKey = new Map()));
  const key = `${actor ?? ''}\u0000${at ?? ''}`;
  const existing = byKey.get(key);
  if (existing !== undefined) return existing;

  const id = freshClientId(doc);
  if (actor !== null) registerClientMapping(doc, actor, at, id);
  byKey.set(key, id);
  claimClientId(doc, id);
  return id;
}

/**
 * Make sure the doc's current clientID is registered to `actor` for the
 * current local day; rotate to a fresh clientID when the actor or day has
 * changed. Returns the clientID future edits will mint under.
 */
export function ensureRegistration(doc: Y.Doc, actor: string, now: number): number {
  const current = doc.clientID;
  const registered = getRegisteredActor(doc, current);

  if (registered === null) {
    registerClientMapping(doc, actor, now, current);
    return current;
  }

  const at = getRegisteredAt(doc, current);
  if (registered === actor && at !== null && sameLocalDay(at, now)) {
    return current;
  }

  const next = freshClientId(doc);
  doc.clientID = next;
  registerClientMapping(doc, actor, now, next);
  return next;
}

/**
 * Attach lazy registration to a doc: on each local content transaction,
 * ensure the current clientID is mapped (rotating on actor/day change).
 * Returns a detach function.
 */
export function attachProvenanceRegistration(
  doc: Y.Doc,
  getActor: () => string,
  now: () => number = Date.now
): () => void {
  // Fast path: skip the users-map scan when nothing changed since last check.
  let verified: { clientID: number; actor: string; at: number } | null = null;

  const handler = (tr: Y.Transaction) => {
    if (!tr.local) return;
    if (tr.origin === PROVENANCE_ORIGIN) return;
    if (tr.changed.size === 0) return;
    // Paste-classification transactions run under a temporary clientID that
    // the popover (not this hook) is responsible for mapping.
    if (isPendingClassification(doc.clientID)) return;

    const actor = getActor();
    const ts = now();
    if (
      verified &&
      verified.clientID === doc.clientID &&
      verified.actor === actor &&
      sameLocalDay(verified.at, ts)
    ) {
      return;
    }
    const clientID = ensureRegistration(doc, actor, ts);
    verified = { clientID, actor, at: ts };
  };

  doc.on('afterTransaction', handler);
  return () => doc.off('afterTransaction', handler);
}
