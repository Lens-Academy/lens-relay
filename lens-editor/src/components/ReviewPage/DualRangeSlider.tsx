import { SLIDER_MAX, sliderToMs, msToSlider, formatAgo, isFullRange } from './timeFilter';

export function DualRangeSlider({ fromAgo, toAgo, onChange }: {
  fromAgo: number;
  toAgo: number;
  onChange: (fromAgo: number, toAgo: number) => void;
}) {
  // Invert: slider 0 = max ago (left = past), slider MAX = 0ms ago (right = now)
  const fromPos = SLIDER_MAX - msToSlider(fromAgo);
  const toPos = SLIDER_MAX - msToSlider(toAgo);

  const leftPct = (Math.min(fromPos, toPos) / SLIDER_MAX) * 100;
  const rightPct = 100 - (Math.max(fromPos, toPos) / SLIDER_MAX) * 100;

  const full = isFullRange(fromAgo, toAgo);
  const thumbBase = `absolute inset-x-0 w-full appearance-none bg-transparent pointer-events-none
    [&::-webkit-slider-thumb]:pointer-events-auto [&::-webkit-slider-thumb]:appearance-none
    [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:rounded-full
    [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-white
    [&::-webkit-slider-thumb]:shadow [&::-webkit-slider-thumb]:cursor-pointer
    [&::-moz-range-thumb]:pointer-events-auto [&::-moz-range-thumb]:appearance-none
    [&::-moz-range-thumb]:w-3.5 [&::-moz-range-thumb]:h-3.5 [&::-moz-range-thumb]:rounded-full
    [&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-white
    [&::-moz-range-thumb]:shadow [&::-moz-range-thumb]:cursor-pointer`;
  const thumbClass = full
    ? `${thumbBase} [&::-webkit-slider-thumb]:bg-gray-400 [&::-moz-range-thumb]:bg-gray-400`
    : `${thumbBase} [&::-webkit-slider-thumb]:bg-blue-500 [&::-moz-range-thumb]:bg-blue-500`;

  return (
    <div className="flex items-center gap-3 flex-1 min-w-0">
      <span className="text-gray-500 whitespace-nowrap shrink-0 w-16 text-right">{formatAgo(fromAgo)}</span>
      <div className="relative flex-1 h-6 flex items-center">
        <div className="absolute inset-x-0 h-1 bg-gray-200 rounded-full" />
        <div
          className={`absolute h-1 rounded-full ${full ? 'bg-gray-300' : 'bg-blue-400'}`}
          style={{ left: `${leftPct}%`, right: `${rightPct}%` }}
        />
        {/* From slider (older end = left side) */}
        <input
          type="range"
          min={0}
          max={SLIDER_MAX}
          value={fromPos}
          onChange={e => {
            const pos = Number(e.target.value);
            const newFrom = sliderToMs(SLIDER_MAX - pos);
            onChange(Math.max(newFrom, toAgo), toAgo);
          }}
          className={thumbClass}
          style={{ zIndex: fromPos >= toPos ? 1 : 2 }}
        />
        {/* To slider (newer end = right side) */}
        <input
          type="range"
          min={0}
          max={SLIDER_MAX}
          value={toPos}
          onChange={e => {
            const pos = Number(e.target.value);
            const newTo = sliderToMs(SLIDER_MAX - pos);
            onChange(fromAgo, Math.min(newTo, fromAgo));
          }}
          className={thumbClass}
          style={{ zIndex: toPos >= fromPos ? 1 : 2 }}
        />
      </div>
      <span className="text-gray-500 whitespace-nowrap shrink-0 w-16">{formatAgo(toAgo)}</span>
    </div>
  );
}
