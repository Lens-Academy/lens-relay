import { FRAME_HEAD, MAP_GROUPINGS, MAP_LAYOUTS, type GroupBy, type MapFrame, type MapLayoutChoice, type MapLayoutKind } from '../../lib/idea-map-layouts';

const LABEL = 'flex items-center gap-1 rounded bg-white/90 pl-1.5 text-xs text-gray-500';
const SELECT = 'rounded border border-gray-200 bg-white py-1 pl-1.5 pr-1 text-sm text-gray-600 hover:bg-gray-50';

/** How the map is drawn: the layout, and for "Groups" what makes a group. */
export function MapLayoutSwitch({ choice, onChoose }: { choice: MapLayoutChoice; onChoose: (next: MapLayoutChoice) => void }) {
  return (
    <>
      <label className={LABEL}>
        Layout
        <select
          className={SELECT}
          value={choice.layout}
          title={MAP_LAYOUTS.find((layout) => layout.key === choice.layout)?.hint}
          data-testid="map-layout"
          onChange={(e) => onChoose({ ...choice, layout: e.target.value as MapLayoutKind })}
        >
          {MAP_LAYOUTS.map((layout) => <option key={layout.key} value={layout.key} title={layout.hint}>{layout.label}</option>)}
        </select>
      </label>
      {choice.layout === 'groups' && (
        <label className={LABEL}>
          Group by
          <select
            className={SELECT}
            value={choice.groupBy}
            data-testid="map-group-by"
            onChange={(e) => onChoose({ ...choice, groupBy: e.target.value as GroupBy })}
          >
            {MAP_GROUPINGS.map((grouping) => <option key={grouping.key} value={grouping.key}>{grouping.label}</option>)}
          </select>
        </label>
      )}
    </>
  );
}

/**
 * The outlines of the groups, behind the boxes. A label keeps about its size
 * on the screen while the map is zoomed out, as far as its frame has room.
 */
export function MapFrames({ frames, zoom }: { frames: readonly MapFrame[]; zoom: number }) {
  const size = Math.min(Math.max(13 / zoom, 13), 26);
  const small = Math.min(Math.max(11 / zoom, 11), 15);
  return (
    <>
      {frames.map((frame) => (
        <div
          key={frame.key}
          data-frame={frame.label}
          className="absolute overflow-hidden rounded-lg border border-gray-300 bg-white/70 px-3"
          style={{ left: frame.x, top: frame.y, width: frame.width, height: frame.height }}
        >
          <div className="flex items-baseline gap-2 text-gray-700" style={{ fontSize: size, lineHeight: '32px', height: 32 }} title={frame.label}>
            <span className="min-w-0 truncate font-medium">{frame.label}</span>
            <span className="shrink-0 text-gray-400">{frame.count}</span>
          </div>
          {frame.note && (
            <div className="truncate text-gray-400" style={{ fontSize: small, lineHeight: `${FRAME_HEAD - 36}px` }} title={frame.note}>{frame.note}</div>
          )}
        </div>
      ))}
    </>
  );
}
