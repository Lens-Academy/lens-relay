import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import {
  PROVENANCE_ORIGIN,
  humanActor,
  registerClientMapping,
  getRegisteredActor,
  getRegisteredAt,
  ensureRegistration,
  attachProvenanceRegistration,
  classifyPendingPaste,
  pasteOriginOptions,
  carrierClientId,
  isOwnClient,
  getClientActorMap,
} from './provenance';

const T0 = new Date('2026-07-18T10:00:00').getTime();

describe('humanActor', () => {
  it('prefixes and trims display names', () => {
    expect(humanActor('Luc')).toBe('human:Luc');
    expect(humanActor('  Luc  ')).toBe('human:Luc');
  });

  it('falls back for empty names', () => {
    expect(humanActor('')).toBe('human:unknown');
    expect(humanActor('   ')).toBe('human:unknown');
  });
});

describe('registerClientMapping', () => {
  it('writes the canonical PUD layout (ids/ds/meta) under the actor key', () => {
    const doc = new Y.Doc();
    const wrote = registerClientMapping(doc, 'human:Luc', T0);
    expect(wrote).toBe(true);

    const users = doc.getMap('users');
    const entry = users.get('human:Luc') as Y.Map<unknown>;
    expect(entry).toBeInstanceOf(Y.Map);

    const ids = entry.get('ids') as Y.Array<number>;
    expect(ids.toArray()).toEqual([doc.clientID]);

    // `ds` must exist as an (empty) array so canonical PUD readers don't crash,
    // mirroring register_pud_client_id_on_doc in doc_connection.rs.
    const ds = entry.get('ds') as Y.Array<unknown>;
    expect(ds.toArray()).toEqual([]);

    const meta = entry.get('meta') as Y.Map<{ registeredAt: number }>;
    expect(meta.get(String(doc.clientID))).toEqual({ registeredAt: T0 });
  });

  it('is idempotent: re-registering the same clientID neither duplicates nor re-stamps', () => {
    const doc = new Y.Doc();
    registerClientMapping(doc, 'human:Luc', T0);
    const wrote = registerClientMapping(doc, 'human:Luc', T0 + 5000);
    expect(wrote).toBe(false);

    const entry = doc.getMap('users').get('human:Luc') as Y.Map<unknown>;
    expect((entry.get('ids') as Y.Array<number>).toArray()).toEqual([doc.clientID]);
    const meta = entry.get('meta') as Y.Map<{ registeredAt: number }>;
    expect(meta.get(String(doc.clientID))).toEqual({ registeredAt: T0 });
  });

  it('supports multiple clientIDs per actor', () => {
    const doc = new Y.Doc();
    registerClientMapping(doc, 'human:Luc', T0, doc.clientID);
    registerClientMapping(doc, 'human:Luc', T0 + 1, 12345);

    const entry = doc.getMap('users').get('human:Luc') as Y.Map<unknown>;
    expect((entry.get('ids') as Y.Array<number>).toArray()).toEqual([doc.clientID, 12345]);
  });

  it('uses the provenance transaction origin', () => {
    const doc = new Y.Doc();
    let origin: unknown = 'unset';
    doc.on('afterTransaction', (tr: Y.Transaction) => {
      origin = tr.origin;
    });
    registerClientMapping(doc, 'human:Luc', T0);
    expect(origin).toBe(PROVENANCE_ORIGIN);
  });
});

describe('getRegisteredActor / getRegisteredAt', () => {
  it('resolves a clientID to its actor and registration time', () => {
    const doc = new Y.Doc();
    registerClientMapping(doc, 'human:Luc', T0);
    registerClientMapping(doc, 'ai:opus-4.8:luc', T0 + 1, 999);

    expect(getRegisteredActor(doc, doc.clientID)).toBe('human:Luc');
    expect(getRegisteredActor(doc, 999)).toBe('ai:opus-4.8:luc');
    expect(getRegisteredActor(doc, 424242)).toBeNull();

    expect(getRegisteredAt(doc, doc.clientID)).toBe(T0);
    expect(getRegisteredAt(doc, 424242)).toBeNull();
  });

  it('builds a reverse clientID→actor map', async () => {
    const { getClientActorMap } = await import('./provenance');
    const doc = new Y.Doc();
    registerClientMapping(doc, 'human:Luc', T0);
    registerClientMapping(doc, 'ai:opus-4.8:luc', T0, 999);
    const map = getClientActorMap(doc);
    expect(map.get(doc.clientID)).toBe('human:Luc');
    expect(map.get(999)).toBe('ai:opus-4.8:luc');
    expect(map.size).toBe(2);
  });

  it('reads mappings written by a synced peer', () => {
    const a = new Y.Doc();
    registerClientMapping(a, 'human:Luc', T0);

    const b = new Y.Doc();
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    expect(getRegisteredActor(b, a.clientID)).toBe('human:Luc');
  });
});

describe('ensureRegistration', () => {
  it('registers the current clientID when unmapped', () => {
    const doc = new Y.Doc();
    const id = ensureRegistration(doc, 'human:Luc', T0);
    expect(id).toBe(doc.clientID);
    expect(getRegisteredActor(doc, doc.clientID)).toBe('human:Luc');
  });

  it('keeps the same clientID for the same actor on the same local day', () => {
    const doc = new Y.Doc();
    const first = ensureRegistration(doc, 'human:Luc', T0);
    const later = ensureRegistration(doc, 'human:Luc', T0 + 60 * 60 * 1000);
    expect(later).toBe(first);
    expect(doc.clientID).toBe(first);
  });

  it('rotates to a fresh clientID when the display name (actor) changes', () => {
    const doc = new Y.Doc();
    const first = ensureRegistration(doc, 'human:Luc', T0);
    const second = ensureRegistration(doc, 'human:Lucas', T0 + 1000);
    expect(second).not.toBe(first);
    expect(doc.clientID).toBe(second);
    // Old mapping is untouched; new ID maps to the new actor.
    expect(getRegisteredActor(doc, first)).toBe('human:Luc');
    expect(getRegisteredActor(doc, second)).toBe('human:Lucas');
  });

  it('rotates to a fresh clientID on a new local calendar day', () => {
    const doc = new Y.Doc();
    const first = ensureRegistration(doc, 'human:Luc', T0);
    const nextDay = new Date('2026-07-19T09:00:00').getTime();
    const second = ensureRegistration(doc, 'human:Luc', nextDay);
    expect(second).not.toBe(first);
    expect(getRegisteredAt(doc, second)).toBe(nextDay);
  });
});

describe('attachProvenanceRegistration', () => {
  it('registers on the first local content edit', () => {
    const doc = new Y.Doc();
    const detach = attachProvenanceRegistration(doc, () => 'human:Luc', () => T0);

    expect(getRegisteredActor(doc, doc.clientID)).toBeNull();
    doc.getText('contents').insert(0, 'hello');
    expect(getRegisteredActor(doc, doc.clientID)).toBe('human:Luc');
    detach();
  });

  it('does not register remote clients when applying their updates', () => {
    const remote = new Y.Doc();
    remote.getText('contents').insert(0, 'from remote');

    const doc = new Y.Doc();
    const detach = attachProvenanceRegistration(doc, () => 'human:Luc', () => T0);
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(remote));

    expect(getRegisteredActor(doc, remote.clientID)).toBeNull();
    expect(getRegisteredActor(doc, doc.clientID)).toBeNull();
    detach();
  });

  it('does not re-enter on its own registration transaction', () => {
    const doc = new Y.Doc();
    let transactions = 0;
    doc.on('afterTransaction', () => {
      transactions += 1;
    });
    const detach = attachProvenanceRegistration(doc, () => 'human:Luc', () => T0);
    doc.getText('contents').insert(0, 'hi');
    // Exactly two: the edit + one registration; no cascade.
    expect(transactions).toBe(2);
    detach();
  });

  it('stops registering after detach', () => {
    const doc = new Y.Doc();
    const detach = attachProvenanceRegistration(doc, () => 'human:Luc', () => T0);
    detach();
    doc.getText('contents').insert(0, 'hello');
    expect(getRegisteredActor(doc, doc.clientID)).toBeNull();
  });

  it('rotates mid-session when the actor changes, attributing future edits to the new ID', () => {
    let actor = 'human:Luc';
    const doc = new Y.Doc();
    const detach = attachProvenanceRegistration(doc, () => actor, () => T0);

    doc.getText('contents').insert(0, 'one ');
    const firstId = doc.clientID;

    actor = 'human:Lucas';
    doc.getText('contents').insert(4, 'two');
    // The edit that triggered the rotation still went in under the old ID …
    expect(getRegisteredActor(doc, firstId)).toBe('human:Luc');
    // … but the doc now mints under a fresh ID for future edits.
    expect(doc.clientID).not.toBe(firstId);

    doc.getText('contents').insert(7, ' three');
    expect(getRegisteredActor(doc, doc.clientID)).toBe('human:Lucas');
    detach();
  });
});

describe('pasteOriginOptions', () => {
  it('offers the writer, their AI, and a generic Human and AI', () => {
    expect(pasteOriginOptions('  Luc ').map((o) => [o.origin, o.label, o.kind])).toEqual([
      ['self', 'Luc', 'human'],
      ['self-ai', "Luc's AI", 'ai'],
      ['human', 'Human', 'human'],
      ['ai', 'AI', 'ai'],
    ]);
  });

  it('offers only the generic two without a display name', () => {
    expect(pasteOriginOptions(null).map((o) => o.label)).toEqual(['Human', 'AI']);
    expect(pasteOriginOptions('   ').map((o) => o.label)).toEqual(['Human', 'AI']);
  });
});

describe('classifyPendingPaste', () => {
  it.each([
    ['self', 'human:Luc'],
    ['self-ai', 'ai:unknown:Luc'],
    ['human', 'human:unknown'],
    ['ai', 'ai:unknown'],
  ] as const)('records %s as %s', (origin, actor) => {
    const doc = new Y.Doc();
    classifyPendingPaste(doc, 12345, origin, 'Luc', T0);
    expect(getRegisteredActor(doc, 12345)).toBe(actor);
    expect(getRegisteredAt(doc, 12345)).toBe(T0);
  });

  it('falls back to the generic actors when no display name is set', () => {
    const doc = new Y.Doc();
    classifyPendingPaste(doc, 1, 'self', null, T0);
    classifyPendingPaste(doc, 2, 'self-ai', null, T0);
    expect(getRegisteredActor(doc, 1)).toBe('human:unknown');
    expect(getRegisteredActor(doc, 2)).toBe('ai:unknown');
  });
});

describe('carrierClientId', () => {
  it('mints one registered clientID per actor and date, and reuses it', () => {
    const doc = new Y.Doc();
    const a = carrierClientId(doc, 'human:Luc', T0);
    expect(a).not.toBe(doc.clientID);
    expect(getRegisteredActor(doc, a)).toBe('human:Luc');
    expect(getRegisteredAt(doc, a)).toBe(T0);
    expect(carrierClientId(doc, 'human:Luc', T0)).toBe(a);
    expect(carrierClientId(doc, 'human:Luc', T0 + 1)).not.toBe(a);
    expect(isOwnClient(doc, a)).toBe(true);
  });

  it('is own only to the doc instance that minted it, not to a reopened copy', () => {
    const a = new Y.Doc();
    const carrier = carrierClientId(a, 'human:Luc', T0);
    const b = new Y.Doc();
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    expect(isOwnClient(a, carrier)).toBe(true);
    expect(isOwnClient(b, carrier)).toBe(false);
    expect(carrierClientId(b, 'human:Luc', T0)).not.toBe(carrier);
  });

  it('leaves unknown authors unmapped and undated ones undated', () => {
    const doc = new Y.Doc();
    expect(getRegisteredActor(doc, carrierClientId(doc, null, null))).toBeNull();
    const undated = carrierClientId(doc, 'human:Luc', null);
    expect(getRegisteredActor(doc, undated)).toBe('human:Luc');
    expect(getRegisteredAt(doc, undated)).toBeNull();
  });
});

describe('legacy server-registered user keys (Relay.md connections)', () => {
  // Before the server-side fix, a Relay.md connection could register a
  // clientID under its raw user key even when a provenance actor already
  // owned it. Docs with such double registrations exist; resolution must
  // deterministically prefer provenance-prefixed actors.
  function writeEntry(doc: Y.Doc, actor: string, clientID: number) {
    doc.transact(() => {
      const users = doc.getMap('users');
      const entry = new Y.Map();
      const ids = new Y.Array();
      ids.push([clientID]);
      entry.set('ids', ids);
      users.set(actor, entry);
    });
  }

  it('getClientActorMap prefers prefixed actors regardless of entry order', () => {
    const a = new Y.Doc();
    writeEntry(a, 'idheqwn0f6k0xxt', 42);
    writeEntry(a, 'ai:fable-5:Luc', 42);
    expect(getClientActorMap(a).get(42)).toBe('ai:fable-5:Luc');

    const b = new Y.Doc();
    writeEntry(b, 'human:Luc', 42);
    writeEntry(b, 'idheqwn0f6k0xxt', 42);
    expect(getClientActorMap(b).get(42)).toBe('human:Luc');
  });

  it('getRegisteredActor prefers prefixed actors', () => {
    const doc = new Y.Doc();
    writeEntry(doc, 'idheqwn0f6k0xxt', 42);
    writeEntry(doc, 'ai:fable-5:Luc', 42);
    expect(getRegisteredActor(doc, 42)).toBe('ai:fable-5:Luc');
  });

  it('legacy keys still resolve when they are the only claim', () => {
    const doc = new Y.Doc();
    writeEntry(doc, 'idheqwn0f6k0xxt', 42);
    expect(getClientActorMap(doc).get(42)).toBe('idheqwn0f6k0xxt');
    expect(getRegisteredActor(doc, 42)).toBe('idheqwn0f6k0xxt');
  });
});
