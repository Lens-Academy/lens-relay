import { describe, expect, it } from 'vitest';
import { wrappedLines } from './idea-map-layout';

describe('wrappedLines', () => {
  it('counts the lines a name takes when it wraps at whole words', () => {
    expect(wrappedLines('Corrigibility', 24)).toBe(1);
    expect(wrappedLines('We are on the path to building ASI', 24)).toBe(2);
    expect(wrappedLines('Building ASI without extreme caution will wipe out humanity', 24)).toBe(3);
    // A word longer than a line is cut
    expect(wrappedLines('Pneumonoultramicroscopicsilicovolcanoconiosis', 24)).toBe(2);
    expect(wrappedLines('a Pneumonoultramicroscopicsilicovolcanoconiosis b', 24)).toBe(3);
    expect(wrappedLines('', 24)).toBe(1);
  });
});
