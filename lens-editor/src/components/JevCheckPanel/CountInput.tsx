import { useState } from 'react';

/** A count box: what is typed is the box's own until it is a whole number from 1, which is then
 *  saved; an empty or partial entry stays while typing and gives way to the saved count on leaving
 *  (Lauren, 2026-10-26: "can't backspace sample down to empty"). */
export function CountInput({ value, max, onValue }: { value: number; max: number; onValue: (n: number) => void }) {
  const [typed, setTyped] = useState<string | null>(null);
  return (
    <input type="number" min={1} max={max} value={typed ?? String(value)} onBlur={() => setTyped(null)}
      onChange={(e) => { setTyped(e.target.value); const x = Number(e.target.value); if (Number.isInteger(x) && x >= 1) onValue(x); }}
      className="ml-1 w-20 rounded border border-gray-200 px-1.5 py-0.5" />
  );
}
