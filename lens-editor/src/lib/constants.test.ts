import { describe, expect, it } from 'vitest';
import { FOLDERS } from './constants';

describe('production folder constants', () => {
  it('includes Lens Edu Private in the production folder list', () => {
    expect(FOLDERS).toContainEqual({
      id: '24027431-24c0-42c2-9f8f-04ed0dd458aa',
      name: 'Lens Edu Private',
    });
  });
});
