/** Where the drawn map stands in its frame: moved by x and y, zoomed by k. */
export interface MapView { x: number; y: number; k: number }

export const MIN_ZOOM = 0.15;
export const MAX_ZOOM = 2;
export const clampZoom = (k: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, k));

/**
 * The height at the top of the frame that the row of controls (Layout, Group
 * by, zoom, Fit) lies over: a map that is shown whole starts below it, so the
 * row covers no box and no label of a group.
 */
export const CONTROL_ROOM = 48;

/**
 * The view that shows a map of `width` x `height` whole in a frame of
 * `frameWidth` x `frameHeight`: as large as fits (never larger than life),
 * in the middle of the room under the controls. `whole` is false when even
 * the smallest zoom does not show all of it.
 */
export function wholeView(frameWidth: number, frameHeight: number, width: number, height: number): { view: MapView; whole: boolean } {
  const room = Math.max(frameHeight - CONTROL_ROOM, 1);
  const k = clampZoom(Math.min(frameWidth / width, room / height, 1));
  return {
    view: { k, x: (frameWidth - width * k) / 2, y: CONTROL_ROOM + (room - height * k) / 2 },
    whole: width * k <= frameWidth + 0.5 && height * k <= room + 0.5,
  };
}
