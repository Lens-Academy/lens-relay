/**
 * The clickable external link shown in live preview, shared by the inline
 * LinkWidget (livePreview.ts) and table cells (markdownTable.ts).
 */
export function createLinkElement(text: string, url: string): HTMLElement {
  const span = document.createElement('span');
  span.className = 'cm-link-widget';
  span.textContent = text;

  const icon = document.createElement('span');
  icon.className = 'cm-link-icon';
  span.appendChild(icon);

  span.style.cursor = 'pointer';
  span.onclick = (e) => {
    e.preventDefault();
    // Prepend https:// if URL doesn't have a protocol
    window.open(/^https?:\/\//i.test(url) ? url : 'https://' + url, '_blank');
  };

  return span;
}
