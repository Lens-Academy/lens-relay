import { describe, it, expect } from 'vitest';
import { utf8ByteToUtf16Offset } from './text-offsets';

describe('utf8ByteToUtf16Offset', () => {
  it('is identity for ASCII text', () => {
    expect(utf8ByteToUtf16Offset('hello world', 6)).toBe(6);
  });

  it('accounts for 2-byte characters (umlauts)', () => {
    // 'ü' = 2 bytes, 1 UTF-16 unit
    expect(utf8ByteToUtf16Offset('über', 3)).toBe(2);
  });

  it('accounts for 3-byte characters (curly quotes)', () => {
    // '’' (right single quote) = 3 bytes, 1 UTF-16 unit
    expect(utf8ByteToUtf16Offset('don’t stop', 7)).toBe(5);
  });

  it('accounts for 4-byte characters (emoji, surrogate pairs)', () => {
    // '🎉' = 4 bytes, 2 UTF-16 units
    expect(utf8ByteToUtf16Offset('🎉x', 4)).toBe(2);
  });

  it('clamps offsets past the end of the text', () => {
    expect(utf8ByteToUtf16Offset('abc', 100)).toBe(3);
  });

  it('handles offset zero', () => {
    expect(utf8ByteToUtf16Offset('über', 0)).toBe(0);
  });
});
