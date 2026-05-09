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
