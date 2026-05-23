import { describe, it, expect } from 'vitest';
import { makeNonce, validateEnvelope, type Envelope, type BridgeToParent } from './protocol';

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
});
