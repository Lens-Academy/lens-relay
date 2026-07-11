import { describe, expect, it } from 'vitest';
import { getWorkspacePorts, parseWorkspaceName } from './workspace-ports.mjs';

describe('parseWorkspaceName', () => {
  it.each([
    ['ws1', { number: 1, suffix: '', suffixOffset: 0, label: 'ws1' }],
    ['ws1a', { number: 1, suffix: 'a', suffixOffset: 1, label: 'ws1a' }],
    ['ws2b', { number: 2, suffix: 'b', suffixOffset: 2, label: 'ws2b' }],
    ['lens-editor-ws3c', { number: 3, suffix: 'c', suffixOffset: 3, label: 'ws3c' }],
  ])('parses %s', (name, expected) => {
    expect(parseWorkspaceName(name)).toEqual(expected);
  });

  it('falls back to ws1 for an unrelated directory', () => {
    expect(parseWorkspaceName('lens-editor')).toEqual({
      number: 1,
      suffix: '',
      suffixOffset: 0,
      label: 'ws1',
    });
  });
});

describe('getWorkspacePorts', () => {
  it('assigns persistent ws1 ports', () => {
    expect(getWorkspacePorts('ws1')).toEqual({
      workspace: { number: 1, suffix: '', suffixOffset: 0, label: 'ws1' },
      vite: 5173,
      relay: 8090,
      discordBridge: 8050,
      utilityBase: 9100,
    });
  });

  it('adds the ephemeral suffix offset to each service lane', () => {
    expect(getWorkspacePorts('ws2b')).toEqual({
      workspace: { number: 2, suffix: 'b', suffixOffset: 2, label: 'ws2b' },
      vite: 5275,
      relay: 8192,
      discordBridge: 8152,
      utilityBase: 9200,
    });
  });
});
