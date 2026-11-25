import { FRAME_HEAD, GROUPED_LAYOUTS, MAP_GROUPINGS, MAP_LAYOUTS, type GroupBy, type MapBundle, type MapFrame, type MapLayoutChoice, type MapLayoutKind, type StoredChoice } from '../../lib/idea-map-layouts';
import { LINK_KINDS, type LinkKinds } from '../../lib/idea-map-links';
import { topicColours } from './ideaLook';

const LABEL = 'flex items-center gap-1 rounded bg-white/90 pl-1.5 text-xs text-gray-500';
const SELECT = 'rounded border border-gray-200 bg-white py-1 pl-1.5 pr-1 text-sm text-gray-600 hover:bg-gray-50';

/**
 * How the map is drawn: the layout, for the layouts in groups what makes a
 * group, and which links are drawn.
 */
export function MapLayoutSwitch({ choice, topics, implied, onChoose }: {
  choice: MapLayoutChoice;
  /** Some concept has a topic: "Topic (yours)" can be chosen. */
  topics: boolean;
  /** How many links a chain of Requires says already (what "Hide implied links" hides). */
  implied: number;
  onChoose: (change: StoredChoice) => void;
}) {
  const layout = MAP_LAYOUTS.find((known) => known.key === choice.layout);
  const grouping = MAP_GROUPINGS.find((known) => known.key === choice.groupBy);
  return (
    <>
      <label className={LABEL}>
        Layout
        <select
          className={SELECT}
          value={choice.layout}
          title={layout?.hint}
          data-testid="map-layout"
          onChange={(e) => onChoose({ layout: e.target.value as MapLayoutKind })}
        >
          {MAP_LAYOUTS.map((known) => <option key={known.key} value={known.key} title={known.hint}>{known.label}</option>)}
        </select>
      </label>
      {GROUPED_LAYOUTS.includes(choice.layout) && (
        <label className={LABEL}>
          Group by
          <select
            className={SELECT}
            value={choice.groupBy}
            title={grouping && 'hint' in grouping ? grouping.hint : undefined}
            data-testid="map-group-by"
            onChange={(e) => onChoose({ groupBy: e.target.value as GroupBy })}
          >
            {MAP_GROUPINGS.map((known) => (
              <option key={known.key} value={known.key} disabled={known.key === 'topic' && !topics} title={known.key === 'topic' && !topics ? 'No concept has a topic yet: give one in "Edit"' : 'hint' in known ? known.hint : undefined}>
                {known.label}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className={LABEL}>
        Links
        <select
          className={SELECT}
          value={choice.links}
          data-testid="map-links"
          onChange={(e) => onChoose({ links: e.target.value as LinkKinds })}
        >
          {LINK_KINDS.map((known) => <option key={known.key} value={known.key}>{known.label}</option>)}
        </select>
      </label>
      <label
        className={`${LABEL} cursor-pointer py-1 pr-1.5`}
        title={`With A → B → C, the link A → C says nothing new: it is left out. ${implied === 0 ? 'This map has no such link.' : `This map has ${implied}.`}`}
      >
        <input type="checkbox" checked={choice.hideImplied} data-testid="map-hide-implied" onChange={(e) => onChoose({ hideImplied: e.target.checked })} />
        Hide implied links{implied > 0 && <span className="tabular-nums text-gray-400">({implied})</span>}
      </label>
    </>
  );
}

/**
 * The outlines of the groups, behind the boxes. A label keeps about its size
 * on the screen while the map is zoomed out, as far as its frame has room.
 * A topic has its own calm colour, the same in every layout.
 */
export function MapFrames({ frames, zoom }: { frames: readonly MapFrame[]; zoom: number }) {
  const size = Math.min(Math.max(13 / zoom, 13), 26);
  const small = Math.min(Math.max(11 / zoom, 11), 15);
  return (
    <>
      {frames.map((frame) => {
        const colours = frame.tone === undefined ? null : topicColours(frame.tone);
        return (
          <div
            key={frame.key}
            data-frame={frame.label}
            className={`absolute overflow-hidden rounded-xl border px-3 ${colours ? '' : 'border-gray-300 bg-white'}`}
            style={{ left: frame.x, top: frame.y, width: frame.width, height: frame.height, ...(colours ? { background: colours.fill, borderColor: colours.edge } : {}) }}
          >
            <div className="flex items-baseline gap-2 text-gray-700" style={{ fontSize: size, lineHeight: '32px', height: 32, ...(colours ? { color: colours.text } : {}) }} title={frame.label}>
              <span className="min-w-0 truncate font-semibold">{frame.label}</span>
              <span className="shrink-0 opacity-60">{frame.count}</span>
            </div>
            {frame.note && (
              <div className="truncate text-gray-400" style={{ fontSize: small, lineHeight: `${FRAME_HEAD - 36}px` }} title={frame.note}>{frame.note}</div>
            )}
          </div>
        );
      })}
    </>
  );
}

/**
 * The arrows from group to group: each stands for all the links between the
 * concepts of two groups, thicker for more, with their number on it. They
 * lie over the frames (and under the boxes) and let the frames show through,
 * so an arrow that has to pass a third group can be followed across it.
 */
export function MapBundles({ bundles, width, height, zoom, faint }: {
  bundles: readonly MapBundle[];
  width: number;
  height: number;
  zoom: number;
  /** The links of one concept stand out just now: the arrows step back. */
  faint: boolean;
}) {
  const size = Math.min(Math.max(11 / zoom, 11), 20);
  // As thick on the screen whatever the zoom, within bounds: neither a hair on the whole map nor a beam close up
  const thick = Math.min(Math.max(0.6 / zoom, 0.5), 2);
  return (
    <svg className="pointer-events-none absolute inset-0 overflow-visible" width={width} height={height} aria-hidden="true">
      <defs>
        <marker id="idea-map-bundle" viewBox="0 0 6 6" refX="4.5" refY="3" markerWidth="3" markerHeight="3" orient="auto">
          <path d="M0,0 L6,3 L0,6 z" className="fill-gray-500" />
        </marker>
      </defs>
      {bundles.map((bundle) => (
        <path key={`${bundle.from}>${bundle.to}`} d={bundle.d} data-bundle={bundle.count} className="fill-none stroke-gray-500" strokeOpacity={faint ? 0.1 : 0.35} strokeWidth={(1.5 + Math.sqrt(bundle.count) * 1.5) * thick} markerEnd="url(#idea-map-bundle)" />
      ))}
      {bundles.map((bundle) => (
        <g key={`${bundle.from}>${bundle.to}`} opacity={faint ? 0.25 : 1}>
          <circle cx={bundle.x} cy={bundle.y} r={size * 0.95} className="fill-white stroke-gray-300" />
          <text x={bundle.x} y={bundle.y} dy="0.35em" textAnchor="middle" fontSize={size} className="fill-gray-600">{bundle.count}</text>
        </g>
      ))}
    </svg>
  );
}
