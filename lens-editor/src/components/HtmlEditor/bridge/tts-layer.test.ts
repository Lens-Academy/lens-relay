import { afterEach, describe, expect, it, vi } from 'vitest';
import { installTtsLayer } from './tts-layer';
import type { BridgeToParent } from './protocol';

function install(html: string) {
  document.body.innerHTML = html;
  const posted: BridgeToParent[] = [];
  const layer = installTtsLayer(window, { post: m => posted.push(m), commentMode: () => false });
  return { layer, posted };
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.useRealTimers();
});

describe('installTtsLayer', () => {
  it('sends the page text as sentences, block by block', () => {
    const { layer, posted } = install(`
      <h1>Why it is hard</h1>
      <p>Models learn from <strong>data</strong>. They are
         <em>hard</em> to inspect.</p>
      <ul><li>First item</li><li>Second item</li></ul>
      <script>var x = "not read."</script>
      <pre>code();</pre>
      <button>Click me</button>
      <div hidden>Hidden text.</div>
      <p aria-hidden="true">Decoration.</p>`);
    layer.sendUnits(false);
    expect(posted).toEqual([{
      type: 'tts-units',
      payload: {
        units: [
          { text: 'Why it is hard', pauseBefore: 0.3 },
          { text: 'Models learn from data.', pauseBefore: 0.3 },
          { text: 'They are hard to inspect.', pauseBefore: 0 },
          { text: 'First item', pauseBefore: 0.3 },
          { text: 'Second item', pauseBefore: 0.3 },
        ],
      },
    }]);
    layer.cleanup();
  });

  it('re-sends the sentences when the page changes while listening', async () => {
    vi.useFakeTimers();
    const { layer, posted } = install('<p>One.</p>');
    layer.sendUnits(false);
    layer.setState({ enabled: true, open: true, playing: true });
    await vi.advanceTimersByTimeAsync(400);
    posted.length = 0;
    document.body.insertAdjacentHTML('beforeend', '<p>Two.</p>');
    await vi.advanceTimersByTimeAsync(400);
    expect(posted).toEqual([{ type: 'tts-units', payload: { units: [{ text: 'One.', pauseBefore: 0.3 }, { text: 'Two.', pauseBefore: 0.3 }] } }]);
    layer.cleanup();
  });

  it('asks to start at the first sentence in view', () => {
    const { layer, posted } = install('<p>First.</p><p>Second.</p>');
    layer.sendUnits(true);
    expect(posted[0]).toMatchObject({ type: 'tts-units', payload: { play: 0 } });
    layer.cleanup();
  });

  it('forwards the player shortcuts while the player is open, instead of scrolling', () => {
    const { layer, posted } = install('<p id="p">One.</p><button id="b">Go</button><input id="i">');
    const press = (id: string, init: KeyboardEventInit) => {
      const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
      document.getElementById(id)!.dispatchEvent(event);
      return event;
    };

    // Closed: the page keeps its keys.
    expect(press('p', { code: 'Space', key: ' ' }).defaultPrevented).toBe(false);
    expect(posted).toEqual([]);

    layer.setState({ enabled: true, open: true, playing: false });
    expect(press('p', { code: 'Space', key: ' ' }).defaultPrevented).toBe(true);
    press('p', { key: '>' });
    press('p', { key: '[' });
    expect(posted).toEqual([
      { type: 'tts-key', payload: { key: 'toggle' } },
      { type: 'tts-key', payload: { key: 'faster' } },
      { type: 'tts-key', payload: { key: 'prev' } },
    ]);

    // Fields, focused controls, modifiers and keys the page used stay the page's.
    posted.length = 0;
    expect(press('i', { code: 'Space', key: ' ' }).defaultPrevented).toBe(false);
    expect(press('b', { code: 'Space', key: ' ' }).defaultPrevented).toBe(false);
    press('p', { key: 'ArrowRight', ctrlKey: true });
    document.getElementById('p')!.addEventListener('keydown', e => e.preventDefault(), { once: true });
    press('p', { code: 'Space', key: ' ' });
    expect(posted).toEqual([]);
    layer.cleanup();
  });
});
