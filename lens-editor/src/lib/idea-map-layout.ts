/**
 * Where the boxes and lines of the drawn concept map go. Pure: the columns
 * come from `mapColumns` (lib/idea-map), the height of each box from the
 * page (measured, so a long name that wraps onto several lines gets the room
 * it takes).
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

/** A curve that leaves and arrives level. */
const bend = (x1: number, y1: number, x2: number, y2: number) => {
  const reach = (x2 - x1) / 2;
  return ` C${x1 + reach},${y1} ${x2 - reach},${y2} ${x2},${y2}`;
};

/**
 * Columns from left (what comes first) to right, each centred on the
 * tallest, its boxes stacked by their own heights. A line between
 * neighbouring columns is one curve; a longer one passes the columns between
 * through the nearest gap between two boxes, never behind a box.
 */
export function layoutMap(
  columns: readonly (readonly string[])[],
  edges: readonly MapEdge[],
  heightOf: (key: string) => number,
  sizes: MapSizes,
): MapLayout {
  const { nodeWidth, gapX, gapY, margin } = sizes;
  const heights = columns.map((keys) => keys.map(heightOf));
  const columnHeight = heights.map((list) => list.reduce((sum, h) => sum + h, 0) + Math.max(0, list.length - 1) * gapY);
  const tallest = Math.max(0, ...columnHeight);
  const left = (column: number) => margin + column * (nodeWidth + gapX);

  const at = new Map<string, MapBox>();
  const boxes: MapBox[] = [];
  /** Per column: the heights at which a line can pass between two boxes. */
  const gaps: number[][] = [];
  columns.forEach((keys, column) => {
    let y = margin + (tallest - columnHeight[column]) / 2;
    const passes = [y - gapY / 2];
    keys.forEach((key, row) => {
      const box = { key, column, x: left(column), y, height: heights[column][row] };
      at.set(key, box);
      boxes.push(box);
      y += box.height + gapY;
      passes.push(y - gapY / 2);
    });
    gaps.push(passes);
  });

  /** The gap of `column` nearest to height `y`: between two boxes, or free space above or below them. */
  const gapNear = (column: number, y: number) => {
    const passes = gaps[column];
    if (y <= passes[0] || y >= passes[passes.length - 1]) return y;
    return passes.reduce((best, pass) => (Math.abs(pass - y) < Math.abs(best - y) ? pass : best));
  };

  const path = (from: string, to: string): string => {
    const a = at.get(from)!;
    const b = at.get(to)!;
    const ay = a.y + a.height / 2;
    const by = b.y + b.height / 2;
    const right = a.x + nodeWidth;
    if (a.column >= b.column) {
      // Only inside a circle of requirements: round the right-hand side
      const out = right + gapX / 2;
      return from === to
        ? `M${right},${ay - 6} C${out},${ay - 14} ${out},${ay + 14} ${right},${ay + 6}`
        : `M${right},${ay} C${out},${ay} ${out},${by} ${b.x + nodeWidth},${by}`;
    }
    let d = `M${right},${ay}`;
    let x = right;
    let y = ay;
    for (let column = a.column + 1; column < b.column; column++) {
      const passX = left(column);
      const passY = gapNear(column, ay + ((by - ay) * (passX + nodeWidth / 2 - right)) / (b.x - right));
      d += `${bend(x, y, passX, passY)} L${passX + nodeWidth},${passY}`;
      x = passX + nodeWidth;
      y = passY;
    }
    return d + bend(x, y, b.x, by);
  };

  return {
    boxes,
    lines: edges.filter((edge) => at.has(edge.from) && at.has(edge.to)).map((edge) => ({ ...edge, d: path(edge.from, edge.to) })),
    width: columns.length === 0 ? 0 : left(columns.length - 1) + nodeWidth + margin,
    height: tallest + 2 * margin,
  };
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
