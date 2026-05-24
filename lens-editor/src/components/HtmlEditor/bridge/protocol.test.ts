import { describe, it, expect } from 'vitest';
import { makeNonce, validateEnvelope, type Envelope, type BridgeToParent, type ParentToBridge } from './protocol';

describe('makeNonce', () => {
  it('returns a 32-char hex string', () => {
    const n = makeNonce();
    expect(n).toMatch(/^[0-9a-f]{32}$/);
  });
  it('produces distinct nonces', () => {
    expect(makeNonce()).not.toBe(makeNonce());
  });
});

describe('validateEnvelope', () => {
  const goodMsg: BridgeToParent = { type: 'click-captured', payload: { fingerprint: { before: '', after: '', tag: 'p', ancestorPath: [], clickRect: { x: 0, y: 0, w: 0, h: 0 } } } };

  it('accepts envelopes whose nonce matches the expected nonce', () => {
    const env: Envelope<BridgeToParent> = { nonce: 'abc', message: goodMsg };
    expect(validateEnvelope(env, 'abc')).toEqual(goodMsg);
  });

  it('rejects envelopes whose nonce does not match', () => {
    const env: Envelope<BridgeToParent> = { nonce: 'wrong', message: goodMsg };
    expect(validateEnvelope(env, 'expected')).toBeNull();
  });

  it('rejects envelopes that are not objects', () => {
    expect(validateEnvelope('not an envelope' as unknown as Envelope<BridgeToParent>, 'x')).toBeNull();
    expect(validateEnvelope(null as unknown as Envelope<BridgeToParent>, 'x')).toBeNull();
  });

  it('rejects envelopes missing the message field', () => {
    expect(validateEnvelope({ nonce: 'x' } as unknown as Envelope<BridgeToParent>, 'x')).toBeNull();
  });

  it('accepts contextual placement request envelopes', () => {
    const msg: BridgeToParent = {
      type: 'placement-requested',
      payload: {
        trigger: 'contextmenu',
        fingerprint: {
          before: '',
          after: 'Hello',
          tag: 'p',
          ancestorPath: [{ tag: 'p', index: 0 }],
          clickRect: { x: 10, y: 20, w: 100, h: 18 },
        },
        point: { x: 10, y: 20 },
        scroll: { x: 0, y: 140 },
      },
    };
    const env: Envelope<BridgeToParent> = { nonce: 'n', message: msg };
    expect(validateEnvelope(env, 'n')).toEqual(msg);
  });

  it('accepts scroll-state bridge messages', () => {
    const msg: BridgeToParent = {
      type: 'scroll-state',
      payload: { x: 0, y: 140, scrollWidth: 900, clientWidth: 300, scrollHeight: 2000, clientHeight: 500, layoutVersion: 1 },
    };
    const env: Envelope<BridgeToParent> = { nonce: 'n', message: msg };
    expect(validateEnvelope(env, 'n')).toEqual(msg);
  });

  it('accepts restore-scroll parent messages', () => {
    const msg: ParentToBridge = {
      type: 'restore-scroll',
      payload: { x: 0, y: 140 },
    };
    const env: Envelope<ParentToBridge> = { nonce: 'n', message: msg };
    expect(validateEnvelope(env, 'n')).toEqual(msg);
  });

  it('accepts restore-scroll-ratio parent messages', () => {
    const msg: ParentToBridge = {
      type: 'restore-scroll-ratio',
      payload: { xRatio: 0, yRatio: 0.5 },
    };
    const env: Envelope<ParentToBridge> = { nonce: 'n', message: msg };
    expect(validateEnvelope(env, 'n')).toEqual(msg);
  });

  it('accepts comments-rendered with rects, baselineScrollY, layoutVersion', () => {
    const msg: BridgeToParent = {
      type: 'comments-rendered',
      payload: {
        found: ['a'],
        orphaned: ['b'],
        rects: [{ id: 'a', y: 100, x: 0, w: 12, h: 12 }],
        baselineScrollY: 50,
        layoutVersion: 3,
      },
    };
    const env: Envelope<BridgeToParent> = { nonce: 'n', message: msg };
    expect(validateEnvelope(env, 'n')).toEqual(msg);
  });

  it('accepts scroll-state with layoutVersion', () => {
    const msg: BridgeToParent = {
      type: 'scroll-state',
      payload: { x: 0, y: 140, scrollWidth: 900, clientWidth: 300, scrollHeight: 2000, clientHeight: 500, layoutVersion: 7 },
    };
    const env: Envelope<BridgeToParent> = { nonce: 'n', message: msg };
    expect(validateEnvelope(env, 'n')).toEqual(msg);
  });

  it('accepts set-focused-comment with an id', () => {
    const msg: ParentToBridge = { type: 'set-focused-comment', payload: { id: 'abc' } };
    const env: Envelope<ParentToBridge> = { nonce: 'n', message: msg };
    expect(validateEnvelope(env, 'n')).toEqual(msg);
  });

  it('accepts set-focused-comment with id: null (clear focus)', () => {
    const msg: ParentToBridge = { type: 'set-focused-comment', payload: { id: null } };
    const env: Envelope<ParentToBridge> = { nonce: 'n', message: msg };
    expect(validateEnvelope(env, 'n')).toEqual(msg);
  });
});
