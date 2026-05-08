import { useLayoutEffect, useRef } from 'react';
import { iconNode } from '../lib/icons';
import type { IconName } from '../lib/icons';

interface IconProps {
  name: IconName;
  className?: string;
}

/**
 * React wrapper around the shared icon module.
 * Uses useLayoutEffect so the SVG is injected before the first paint (no flash).
 * Control size and color via className (e.g. Tailwind "w-4 h-4 text-gray-500").
 */
export function Icon({ name, className }: IconProps) {
  const ref = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const node = iconNode(name);
    if (className) node.setAttribute('class', className);
    el.replaceChildren(node);
  }, [name, className]);

  return <span ref={ref} aria-hidden="true" />;
}
