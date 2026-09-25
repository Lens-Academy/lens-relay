import { describe, it, expect } from 'vitest';
import { buildSrcDoc, hasOwnImportMap, IMPORT_MAP, PAGE_CSP } from './page-runtime';

const opts = { bridgeSource: '/*bridge*/' };

describe('buildSrcDoc', () => {
  it('inserts the runtime right after <head>', () => {
    const out = buildSrcDoc('<!doctype html><html><head><title>t</title></head><body></body></html>', opts);
    expect(out.startsWith('<!doctype html><html><head><script>window.__lensLineOffset=0;</script><meta http-equiv="Content-Security-Policy"')).toBe(true);
    expect(out.indexOf('/*bridge*/')).toBeLessThan(out.indexOf('<title>'));
    const multiline = buildSrcDoc('<head></head>', { bridgeSource: 'a\nb\nc' });
    expect(multiline).toContain('window.__lensLineOffset=2;');
  });

  it('never puts anything in front of the doctype (that would force quirks mode)', () => {
    const out = buildSrcDoc('<!DOCTYPE html>\n<table><tr><td>x</td></tr></table>', opts);
    expect(out.startsWith('<!DOCTYPE html>')).toBe(true);
    const withHtml = buildSrcDoc('<!-- note -->\n<!doctype html>\n<html lang="en"><body>x</body></html>', opts);
    expect(withHtml.startsWith('<!-- note -->\n<!doctype html>\n<html lang="en"><script>window.__lensLineOffset')).toBe(true);
  });

  it('prepends the runtime to a bare fragment', () => {
    const out = buildSrcDoc('<h1>Hi</h1>', opts);
    expect(out.startsWith('<script>window.__lensLineOffset=0;</script><meta http-equiv="Content-Security-Policy"')).toBe(true);
    expect(out.endsWith('<h1>Hi</h1>')).toBe(true);
  });

  it('ignores a "<head>" that is not in the leading prologue', () => {
    const inComment = buildSrcDoc('<!-- put meta tags in <head> -->\n<!doctype html><html><head><title>t</title></head></html>', opts);
    expect(inComment.indexOf('Content-Security-Policy')).toBeGreaterThan(inComment.indexOf('<head>', 30));
    const inScript = buildSrcDoc('<p>x</p><script>const t = "<head></head>";</script>', opts);
    expect(inScript.startsWith('<script>window.__lensLineOffset')).toBe(true);
    expect(inScript).toContain('const t = "<head></head>";');
  });

  it('does not mistake <header> for <head>', () => {
    const out = buildSrcDoc('<header>top</header>', opts);
    expect(out.endsWith('<header>top</header>')).toBe(true);
  });

  it('adds the shared import map unless the page brings its own', () => {
    expect(buildSrcDoc('<p>x</p>', opts)).toContain('<script type="importmap" data-lens-runtime>');
    const own = '<script type="importmap">{"imports":{"a":"https://esm.sh/a"}}</script><p>x</p>';
    expect(hasOwnImportMap(own)).toBe(true);
    expect(buildSrcDoc(own, opts).match(/type="importmap"/g)).toHaveLength(1);
  });

  it('seeds storage only when there is something to seed, escaping </script>', () => {
    expect(buildSrcDoc('<p>x</p>', { ...opts, storageSeed: {} })).not.toContain('__lensStorageSeed');
    const out = buildSrcDoc('<p>x</p>', { ...opts, storageSeed: { k: '</script><b>' } });
    expect(out).toContain('window.__lensStorageSeed={"k":"\\u003c/script>\\u003cb>"}');
  });
});

describe('runtime contract', () => {
  it('pins every import map entry to an exact version', () => {
    for (const [name, url] of Object.entries(IMPORT_MAP)) {
      expect(url, name).toMatch(/@\d+\.\d+\.\d+/);
    }
  });

  it('shares one React: every React-ecosystem package marks react external', () => {
    for (const name of ['react-dom', 'react-dom/client', 'htm/react', 'recharts', 'lucide-react']) {
      expect(IMPORT_MAP[name], name).toMatch(/external=react/);
    }
  });

  it('limits scripts to the CDN allowlist but leaves images and data open', () => {
    expect(PAGE_CSP).toContain("default-src 'none'");
    expect(PAGE_CSP).toMatch(/script-src [^;]*https:\/\/esm\.sh/);
    expect(PAGE_CSP).not.toMatch(/script-src [^;]*\bhttps:(?!\/\/)/);
    expect(PAGE_CSP).toContain('img-src * data: blob:');
    expect(PAGE_CSP).toContain('connect-src * data: blob:');
  });
});
