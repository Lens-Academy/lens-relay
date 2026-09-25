/**
 * The runtime contract for HTML documents rendered by the HtmlEditor preview,
 * modelled on Claude artifacts: a sandboxed page that loads code only from a
 * few pinned CDNs, gets well-known libraries through an import map, and must
 * work at phone width. The author-facing guide is the relay document
 * `Lens/AI Guide/HTML Pages`; the relay's static page check
 * (`crates/relay/src/mcp/tools/html_check.rs`) mirrors SCRIPT_HOSTS and
 * IMPORT_MAP's keys, so keep all three in sync.
 */

/** Hosts a page may load scripts (and module imports) from. */
export const SCRIPT_HOSTS = [
  'https://esm.sh',
  'https://esm.run',
  'https://ga.jspm.io',
  'https://cdn.jsdelivr.net',
  'https://cdnjs.cloudflare.com',
  'https://unpkg.com',
  'https://cdn.tailwindcss.com',
  'https://code.jquery.com',
] as const;

/** Hosts a page may load stylesheets from (plus inline styles). */
export const STYLE_HOSTS = [
  'https://fonts.googleapis.com',
  'https://cdn.jsdelivr.net',
  'https://cdnjs.cloudflare.com',
  'https://unpkg.com',
] as const;

/** Hosts a page may load font files from (plus data: URIs). */
export const FONT_HOSTS = [
  'https://fonts.gstatic.com',
  'https://cdn.jsdelivr.net',
  'https://cdnjs.cloudflare.com',
  'https://unpkg.com',
] as const;

/**
 * A portability rule, not a security boundary: inline and eval'd code run,
 * and fetch/img/frame are open. The sandbox (opaque origin, no top
 * navigation) is what keeps a page away from the editor; note the page shares
 * a realm with the bridge, so it can read the nonce and forge bridge
 * messages, and the parent must treat every message as untrusted.
 *
 * Scripts, styles and fonts come only from the pinned CDNs so a page never
 * depends on an arbitrary host. Images, media, frames and fetch/XHR stay open:
 * internal pages routinely show attachments from the relay or GitHub and read
 * public JSON. Violations are reported to the editor by the bridge.
 */
export const PAGE_CSP = [
  "default-src 'none'",
  `script-src 'unsafe-inline' 'unsafe-eval' blob: ${SCRIPT_HOSTS.join(' ')}`,
  `style-src 'unsafe-inline' ${STYLE_HOSTS.join(' ')}`,
  `font-src data: ${FONT_HOSTS.join(' ')}`,
  'img-src * data: blob:',
  'media-src * data: blob:',
  'connect-src * data: blob:',
  'frame-src *',
  `worker-src blob: ${SCRIPT_HOSTS.join(' ')}`,
].join('; ');

const REACT = '19.3.0';

/**
 * Bare specifiers a page's `<script type="module">` can import without a
 * build step. React-ecosystem packages come from esm.sh with react marked
 * external, so every import resolves to the single `react` entry below (two
 * React copies would break hooks). Everything else uses jsDelivr's ESM build.
 * Versions are pinned; bump them deliberately and update the guide.
 */
export const IMPORT_MAP: Readonly<Record<string, string>> = {
  'react': `https://esm.sh/react@${REACT}`,
  'react/jsx-runtime': `https://esm.sh/react@${REACT}/jsx-runtime`,
  'react-dom': `https://esm.sh/react-dom@${REACT}?external=react`,
  'react-dom/client': `https://esm.sh/react-dom@${REACT}/client?external=react`,
  'htm': 'https://esm.sh/htm@3.1.1',
  'htm/react': 'https://esm.sh/htm@3.1.1/react?external=react',
  'recharts': 'https://esm.sh/recharts@3.10.1?external=react,react-dom',
  'lucide-react': 'https://esm.sh/lucide-react@1.48.0?external=react',
  'd3': 'https://cdn.jsdelivr.net/npm/d3@7.9.0/+esm',
  // One build for both names: the auto build re-exports everything and
  // registers all controllers; two builds would be two Chart registries.
  'chart.js': 'https://cdn.jsdelivr.net/npm/chart.js@4.5.1/auto/+esm',
  'chart.js/auto': 'https://cdn.jsdelivr.net/npm/chart.js@4.5.1/auto/+esm',
  'three': 'https://cdn.jsdelivr.net/npm/three@0.186.1/build/three.module.js',
  'three/addons/': 'https://cdn.jsdelivr.net/npm/three@0.186.1/examples/jsm/',
  'lodash-es': 'https://cdn.jsdelivr.net/npm/lodash-es@4.18.1/+esm',
  'mathjs': 'https://cdn.jsdelivr.net/npm/mathjs@15.2.0/+esm',
  'papaparse': 'https://cdn.jsdelivr.net/npm/papaparse@5.7.0/+esm',
  'marked': 'https://cdn.jsdelivr.net/npm/marked@18.0.14/+esm',
  'katex': 'https://cdn.jsdelivr.net/npm/katex@0.18.9/+esm',
  'mermaid': 'https://cdn.jsdelivr.net/npm/mermaid@12.0.0/+esm',
};

const PAGE_IMPORT_MAP_RE = /<script\b[^>]*\btype\s*=\s*["']?importmap\b/i;

/** Pages that bring their own import map keep it; browsers only reliably
 *  honour the first map, so ours is left out rather than merged. */
export function hasOwnImportMap(source: string): boolean {
  return PAGE_IMPORT_MAP_RE.test(source);
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

/** JSON inside a <script> must not contain a literal `</script`. */
function scriptSafeJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

export interface RuntimeHeadOptions {
  bridgeSource: string;
  /** Per-viewer localStorage contents to seed the page's storage shim with. */
  storageSeed?: Record<string, string> | null;
}

/** Everything the editor adds in front of the author's markup. */
export function runtimeHead(source: string, options: RuntimeHeadOptions): string {
  const parts = [
    `<meta http-equiv="Content-Security-Policy" content="${escapeAttr(PAGE_CSP)}">`,
  ];
  if (!hasOwnImportMap(source)) {
    parts.push(`<script type="importmap" data-lens-runtime>${scriptSafeJson({ imports: IMPORT_MAP })}</script>`);
  }
  if (options.storageSeed && Object.keys(options.storageSeed).length > 0) {
    parts.push(`<script>window.__lensStorageSeed=${scriptSafeJson(options.storageSeed)};</script>`);
  }
  parts.push(`<script>${options.bridgeSource}</script>`);
  // Error line numbers count the injected lines; the bridge subtracts them so
  // problems point at the author's own source lines.
  const injectedLines = parts.join('').split('\n').length - 1;
  return `<script>window.__lensLineOffset=${injectedLines};</script>${parts.join('')}`;
}

// Only a <head> in the leading prologue counts: a "<head>" in a later comment,
// script string or comment body must never receive the runtime.
const SKIP = String.raw`(?:\s|<!--[\s\S]*?-->)*`;
const HEAD_OPEN_RE = new RegExp(
  String.raw`^${SKIP}(?:<!doctype\b[^>]*>${SKIP})?(?:<html\b[^>]*>${SKIP})?<head\b[^>]*>`,
  'i',
);
const LEADING_PROLOGUE_RE = /^(?:\s|<!--[\s\S]*?-->)*<!doctype\b[^>]*>(?:\s*<html\b[^>]*>)?/i;
const LEADING_HTML_RE = /^(?:\s|<!--[\s\S]*?-->)*<html\b[^>]*>/i;

/**
 * Build the iframe srcdoc: the runtime head goes right after `<head>` when the
 * page has one, otherwise after a leading `<!doctype>`/`<html>`, otherwise at
 * the very start. Never before the doctype: anything in front of it puts the
 * page in quirks mode.
 */
export function buildSrcDoc(source: string, options: RuntimeHeadOptions): string {
  const head = runtimeHead(source, options);
  const headMatch = HEAD_OPEN_RE.exec(source);
  if (headMatch) {
    const at = headMatch[0].length;
    return `${source.slice(0, at)}${head}${source.slice(at)}`;
  }
  const prologue = LEADING_PROLOGUE_RE.exec(source) ?? LEADING_HTML_RE.exec(source);
  if (prologue) {
    const at = prologue[0].length;
    return `${source.slice(0, at)}${head}${source.slice(at)}`;
  }
  return `${head}${source}`;
}
