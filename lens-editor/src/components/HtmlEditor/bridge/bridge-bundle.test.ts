import { describe, expect, it } from 'vitest';
import { BRIDGE_SOURCE } from 'virtual:bridge-bundle';

describe('virtual:bridge-bundle', () => {
  it('exports a non-empty IIFE source string', () => {
    expect(BRIDGE_SOURCE.length).toBeGreaterThan(500);
  });

  it('does not contain bare ES module imports', () => {
    expect(BRIDGE_SOURCE).not.toMatch(/^\s*import /m);
  });

  it('bundle installs the bridge when evaluated', () => {
    const calls: Array<[string, unknown]> = [];
    const fakeWin = {
      addEventListener: (name: string, listener: unknown) => calls.push([name, listener]),
      clearTimeout: () => {},
      document: {
        addEventListener: () => {},
        body: {
          appendChild: () => {},
        },
        createElement: () => ({
          setAttribute: () => {},
          style: {},
        }),
        createTreeWalker: () => ({
          nextNode: () => null,
        }),
        getElementById: () => null,
      },
      MutationObserver: class {
        observe() {}
        disconnect() {}
      },
      parent: {
        postMessage: () => {},
      },
    } as unknown as Window & typeof globalThis;

    expect(() => new Function('window', BRIDGE_SOURCE)(fakeWin)).not.toThrow();
    expect(calls.some(([name]) => name === 'message')).toBe(true);
  });
});
