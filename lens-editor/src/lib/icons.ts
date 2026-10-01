/**
 * Shared icon module — usable in both React components and raw DOM contexts
 * (e.g. CM6 widgets where JSX isn't available).
 *
 * Each icon is built once via createElementNS and cached. Callers receive a
 * cloneNode(true) so mutations don't affect the cache.
 *
 * Usage:
 *   - CM6 widgets / raw DOM: iconNode('copy')
 *   - React components:      <Icon name="copy" className="w-4 h-4" />
 */

const NS = 'http://www.w3.org/2000/svg';

type SvgChild = SVGElement;

// Each builder returns the child elements for a 24×24 viewBox icon.
// Size is intentionally omitted from the SVG root so callers control it via CSS.
const ICON_BUILDERS: Record<string, () => SvgChild[]> = {
  copy: () => {
    const rect = document.createElementNS(NS, 'rect');
    rect.setAttribute('x', '9');
    rect.setAttribute('y', '9');
    rect.setAttribute('width', '13');
    rect.setAttribute('height', '13');
    rect.setAttribute('rx', '2');
    rect.setAttribute('ry', '2');

    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', 'M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1');

    return [rect, path];
  },

  check: () => {
    const poly = document.createElementNS(NS, 'polyline');
    poly.setAttribute('points', '20 6 9 17 4 12');
    return [poly];
  },
};

// Lucide icons given as [tag, attributes] children (used by the editor's callouts).
type IconPart = [string, Record<string, string>];
const path = (d: string): IconPart => ['path', { d }];
const CIRCLE: IconPart = ['circle', { cx: '12', cy: '12', r: '10' }];
const PART_ICONS: Record<string, IconPart[]> = {
  pencil: [path('M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z'), path('m15 5 4 4')],
  'clipboard-list': [['rect', { x: '8', y: '2', width: '8', height: '4', rx: '1' }], path('M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2'), path('M12 11h4'), path('M12 16h4'), path('M8 11h.01'), path('M8 16h.01')],
  info: [CIRCLE, path('M12 16v-4'), path('M12 8h.01')],
  'circle-check': [CIRCLE, path('m9 12 2 2 4-4')],
  flame: [path('M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z')],
  'circle-help': [CIRCLE, path('M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3'), path('M12 17h.01')],
  'triangle-alert': [path('m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3'), path('M12 9v4'), path('M12 17h.01')],
  x: [path('M18 6 6 18'), path('m6 6 12 12')],
  zap: [path('M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z')],
  list: [path('M3 6h.01'), path('M3 12h.01'), path('M3 18h.01'), path('M8 6h13'), path('M8 12h13'), path('M8 18h13')],
  quote: [path('M17 6H3'), path('M21 12H8'), path('M21 18H8'), path('M3 12v6')],
};
for (const [name, parts] of Object.entries(PART_ICONS)) {
  ICON_BUILDERS[name] = () => parts.map(([tag, attrs]) => {
    const el = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    return el;
  });
}

export type IconName = keyof typeof ICON_BUILDERS;

function buildSvg(name: IconName): SVGSVGElement {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  for (const child of ICON_BUILDERS[name]()) {
    svg.appendChild(child);
  }
  return svg;
}

const svgCache = new Map<IconName, SVGSVGElement>();

/**
 * Returns a cloned SVG DOM node for the named icon.
 * Intended for raw DOM contexts such as CM6 widget toDOM() methods.
 * Control size via CSS on the element or a parent (e.g. width/height or font-size).
 */
export function iconNode(name: IconName): SVGSVGElement {
  let cached = svgCache.get(name);
  if (!cached) {
    cached = buildSvg(name);
    svgCache.set(name, cached);
  }
  return cached.cloneNode(true) as SVGSVGElement;
}
