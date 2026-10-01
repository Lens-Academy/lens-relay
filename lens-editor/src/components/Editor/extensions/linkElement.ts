/**
 * Where a live-preview link opens: http(s) and mailto as written, a URL with no
 * scheme (www.example.org) over https, and null for any other scheme
 * (javascript:, data:, ...), which is then shown as plain text.
 */
export function linkHref(url: string): string | null {
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url)?.[1].toLowerCase();
  if (!scheme) return 'https://' + url;
  return scheme === 'http' || scheme === 'https' || scheme === 'mailto' ? url : null;
}

/**
 * The clickable external link shown in live preview, shared by the inline
 * LinkWidget (livePreview.ts) and table cells (markdownTable.ts).
 */
export function createLinkElement(label: string | Node, url: string): HTMLElement {
  const span = document.createElement('span');
  span.append(label);

  const href = linkHref(url);
  if (!href) return span;

  span.className = 'cm-link-widget';
  const icon = document.createElement('span');
  icon.className = 'cm-link-icon';
  span.appendChild(icon);

  span.style.cursor = 'pointer';
  span.onclick = (e) => {
    e.preventDefault();
    window.open(href, '_blank', 'noopener,noreferrer');
  };

  return span;
}
