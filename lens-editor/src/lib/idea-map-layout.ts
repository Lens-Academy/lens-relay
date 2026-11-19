/**
 * What a drawing of the concept map is made of (boxes, links, lines, sizes),
 * shared by the layouts (lib/idea-map-layouts and the files it draws with),
 * and a guess at a box's height before the page has measured it.
 */

export interface MapSizes {
  /** Every box is this wide; a name wraps inside it. */
  nodeWidth: number;
  /** Between two columns. */
  gapX: number;
  /** Between two boxes of a column. */
  gapY: number;
  /** Around the whole map. */
  margin: number;
}

export interface MapBox {
  key: string;
  column: number;
  x: number;
  y: number;
  height: number;
}

export interface MapEdge {
  /** The idea that comes first. */
  from: string;
  /** The idea that needs it. */
  to: string;
  helpful: boolean;
}

export interface MapLine extends MapEdge {
  /** An SVG path. */
  d: string;
}

export interface MapLayout {
  boxes: MapBox[];
  lines: MapLine[];
  width: number;
  height: number;
}

/**
 * About how many lines `name` takes when it wraps at `perLine` characters
 * (words stay whole; a word longer than a line is cut). Used until the box
 * is measured.
 */
export function wrappedLines(name: string, perLine: number): number {
  let lines = 1;
  let used = 0;
  for (const word of name.trim().split(/\s+/)) {
    const length = word.length;
    if (length === 0) continue;
    if (used > 0 && used + 1 + length <= perLine) {
      used += 1 + length;
      continue;
    }
    if (used > 0) lines += 1;
    lines += Math.floor((length - 1) / perLine);
    used = ((length - 1) % perLine) + 1;
  }
  return lines;
}
