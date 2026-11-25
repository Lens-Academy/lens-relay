/**
 * SVG attachments are sanitized before they are stored: no script, event
 * handlers, foreignObject or references outside the file (hrefs and CSS
 * url() other than `#id` or data: images). Learners see them through <img>,
 * which runs no script anyway; this keeps the stored file safe wherever else
 * it is opened. One function for the server (jsdom window) and the browser.
 */
import createDOMPurify from 'dompurify';

const LOCAL_HREF = /^\s*(#|data:image\/(png|jpeg|gif|webp)[;,])/i;
// CSS escapes (`\75 rl(`) could hide a url(), so any backslash counts too.
const EXTERNAL_CSS = /@import|\\|url\(\s*['"]?\s*(?!#|data:)/i;

type SvgWindow = Window & { XMLSerializer: typeof XMLSerializer };

const instances = new WeakMap<object, ReturnType<typeof createDOMPurify>>();

function purifier(win: SvgWindow) {
  let purify = instances.get(win);
  if (!purify) {
    purify = createDOMPurify(win as never);
    purify.addHook('uponSanitizeElement', (node) => {
      if (node.nodeName.toLowerCase() === 'style' && EXTERNAL_CSS.test(node.textContent ?? '')) {
        node.textContent = '';
      }
    });
    purify.addHook('afterSanitizeAttributes', (node) => {
      for (const name of ['href', 'xlink:href']) {
        const value = node.getAttribute(name);
        if (value !== null && !LOCAL_HREF.test(value)) node.removeAttribute(name);
      }
      // style, fill, filter, mask, clip-path, marker-*: no url() outside the file.
      for (const { name, value } of Array.from(node.attributes)) {
        if (EXTERNAL_CSS.test(value)) node.removeAttribute(name);
      }
    });
    instances.set(win, purify);
  }
  return purify;
}

/** Sanitized SVG text, or null when the input holds no <svg> root. */
export function sanitizeSvg(text: string, win: SvgWindow): string | null {
  const fragment = purifier(win).sanitize(text, {
    USE_PROFILES: { svg: true, svgFilters: true },
    ADD_TAGS: ['use'],
    RETURN_DOM_FRAGMENT: true,
  });
  const svg = fragment.querySelector('svg');
  if (!svg) return null;
  // The HTML parser keeps SVG's camelCase names; serialize as XML so the
  // result is a standalone .svg file.
  return new win.XMLSerializer().serializeToString(svg);
}
