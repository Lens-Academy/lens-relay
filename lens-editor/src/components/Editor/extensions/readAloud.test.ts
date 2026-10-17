import { afterEach, describe, expect, it, vi } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { markdown } from '@codemirror/lang-markdown';
import { getReadAloud, readAloud } from './readAloud';

vi.mock('../../../lib/read-aloud/api', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../lib/read-aloud/api')>()),
  readAloudAvailable: () => Promise.resolve(true),
}));

const DOC = 'First sentence here. Second one.\n\nAnother paragraph.';

function setup(playing: boolean) {
  const view = new EditorView({
    state: EditorState.create({ doc: DOC, selection: { anchor: 0 }, extensions: [markdown(), readAloud()] }),
    parent: document.body,
  });
  const controller = getReadAloud(view)!;
  vi.spyOn(controller.engine, 'isPlaying', 'get').mockReturnValue(playing);
  const play = vi.spyOn(controller.engine, 'play').mockImplementation(() => {});
  // happy-dom has no layout: every point maps to "Second one."
  vi.spyOn(view, 'posAtCoords').mockReturnValue(DOC.indexOf('one'));
  // CodeMirror's own click handling (cursor placement) asks this one.
  const cmClick = vi.spyOn(view, 'posAndSideAtCoords').mockReturnValue({ pos: DOC.indexOf('one'), assoc: 1 });
  const line = view.contentDOM.querySelector('.cm-line')!;
  const press = (x: number, y: number) => {
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y });
    line.dispatchEvent(down);
    return down;
  };
  const release = (x: number, y: number) =>
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0, clientX: x, clientY: y }));
  return { view, play, press, release, cmClick };
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('read-aloud clicks in the Markdown editor', () => {
  it('leaves clicks to the editor when audio is not playing', () => {
    const { view, play, press, release, cmClick } = setup(false);
    press(10, 10);
    release(10, 10);
    expect(cmClick).toHaveBeenCalled();
    expect(play).not.toHaveBeenCalled();
    view.destroy();
  });

  it('jumps to the clicked sentence while playing, without moving the cursor', () => {
    const { view, play, press, release, cmClick } = setup(true);
    const down = press(10, 10);
    release(11, 10);
    expect(down.defaultPrevented).toBe(true);
    expect(cmClick).not.toHaveBeenCalled();
    expect(play).toHaveBeenCalledWith(1);
    expect(view.state.selection.main.head).toBe(0);
    view.destroy();
  });

  it('does not jump on a drag', () => {
    const { view, play, press, release } = setup(true);
    press(10, 10);
    release(60, 10);
    expect(play).not.toHaveBeenCalled();
    view.destroy();
  });
});
