import { describe, expect, it } from 'vitest';
import { CONTROL_ROOM, MIN_ZOOM, wholeView } from './mapView';

describe('wholeView', () => {
  it('shows a wide map as wide as the frame, in the middle of the room under the controls', () => {
    const { view, whole } = wholeView(1000, 648, 2000, 400);
    expect(view.k).toBe(0.5);
    expect(view.x).toBe(0);
    // 600 of room, 200 of map
    expect(view.y).toBe(CONTROL_ROOM + 200);
    expect(whole).toBe(true);
  });

  it('keeps a tall map below the row of controls', () => {
    const { view, whole } = wholeView(1000, 648, 500, 1200);
    expect(view.k).toBe(0.5);
    expect(view.y).toBe(CONTROL_ROOM);
    expect(view.x).toBe(375);
    expect(whole).toBe(true);
  });

  it('never draws a small map larger than life', () => {
    const { view } = wholeView(1000, 648, 200, 100);
    expect(view.k).toBe(1);
    expect(view.x).toBe(400);
    expect(view.y).toBe(CONTROL_ROOM + 250);
  });

  it('gets smaller with the frame: the side panel opened', () => {
    const wide = wholeView(1200, 800, 2400, 600).view;
    const narrow = wholeView(800, 800, 2400, 600).view;
    expect(wide.k).toBe(0.5);
    expect(narrow.k).toBeCloseTo(1 / 3, 6);
    expect(2400 * narrow.k + narrow.x).toBeLessThanOrEqual(800 + 1e-6);
  });

  it('says so when the smallest zoom does not show all of it', () => {
    const { view, whole } = wholeView(600, 448, 10000, 400);
    expect(view.k).toBe(MIN_ZOOM);
    expect(whole).toBe(false);
  });
});
