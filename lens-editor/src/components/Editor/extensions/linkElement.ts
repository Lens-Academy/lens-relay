/**
 * Where a live-preview link opens: http(s) and mailto as written, a scheme-less
 * email address (GFM autolinks <a@b.org> and a@b.org) as mailto:, any other URL
 * with no scheme (www.example.org) over https, and null for any other scheme
 * (javascript:, data:, ...), which is then shown as plain text.
 */
export function linkHref(url: string): string | null {
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url)?.[1].toLowerCase();
  if (!scheme) return /^[^/]*@[^/]*$/.test(url) ? 'mailto:' + url : 'https://' + url;
  return scheme === 'http' || scheme === 'https' || scheme === 'mailto' ? url : null;
}

/**
 * Whether a link leaves the editor for the web: an http(s) URL, written with
 * its scheme or as www.…, on another host. Email addresses, links to this
 * editor and relative paths don't.
 */
export function isExternalUrl(url: string): boolean {
  const match = /^(?:https?:\/\/|www\.)([^/?#]*)/i.exec(url);
  if (!match) return false;
  const host = match[1].replace(/^[^@]*@/, '').toLowerCase();
  return host !== '' && host !== window.location.host.toLowerCase();
}

/**
 * The clickable external link shown in live preview, shared by the inline
 * LinkWidget (livePreview.ts) and table cells (markdownTable.ts). A
 * [text](url) link to the web ends in the external-link icon; a bare URL
 * or <autolink> shows its address already, so it gets none.
 */
export function createLinkElement(label: string | Node, url: string, isMarkdownLink: boolean): HTMLElement {
  const span = document.createElement('span');
  span.append(label);

  const href = linkHref(url);
  if (!href) return span;

  span.className = 'cm-link-widget';
  if (isMarkdownLink && isExternalUrl(url)) {
    const icon = document.createElement('span');
    icon.className = 'cm-link-external-icon';
    icon.setAttribute('aria-hidden', 'true');
    span.appendChild(icon);
  }
  span.style.cursor = 'pointer';
  span.onclick = (e) => {
    e.preventDefault();
    window.open(href, '_blank', 'noopener,noreferrer');
  };

  return span;
}
