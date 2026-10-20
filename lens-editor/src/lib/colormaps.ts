// Perceptual colour maps as piecewise-linear stops (matplotlib values at 0, 0.25, 0.5, 0.75, 1).
const STOPS = {
  inferno: ['#000004', '#57106e', '#bc3754', '#f98e09', '#fcffa4'],
  viridis: ['#440154', '#3b528b', '#21918c', '#5ec962', '#fde725'],
  magma: ['#000004', '#51127c', '#b73779', '#fc8961', '#fcfdbf'],
  gray: ['#000000', '#404040', '#808080', '#bfbfbf', '#ffffff'],
} as const;

export type ColormapName = keyof typeof STOPS;

const hex = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

function ramp(stops: readonly string[]) {
  const rgb = stops.map(hex);
  return (p: number) => {
    const x = Math.min(1, Math.max(0, p)) * (rgb.length - 1);
    const i = Math.min(rgb.length - 2, Math.floor(x));
    const t = x - i;
    const c = rgb[i].map((a, k) => Math.round(a + (rgb[i + 1][k] - a) * t));
    return `rgb(${c.join(',')})`;
  };
}

export const COLORMAPS: Record<ColormapName, (p: number) => string> = Object.fromEntries(
  Object.entries(STOPS).map(([k, v]) => [k, ramp(v)]),
) as Record<ColormapName, (p: number) => string>;
