import { describe, it, expect, vi } from 'vitest';
import { createLinkElement, isExternalUrl, linkHref } from './linkElement';

describe('linkHref', () => {
  it('opens http(s) and mailto as written and prefixes https:// when there is no scheme', () => {
    expect(linkHref('https://a.org/x')).toBe('https://a.org/x');
    expect(linkHref('HTTP://a.org')).toBe('HTTP://a.org');
    expect(linkHref('mailto:a@b.com')).toBe('mailto:a@b.com');
    expect(linkHref('www.example.org')).toBe('https://www.example.org');
  });

  it('opens a scheme-less email address as mailto:', () => {
    expect(linkHref('foo@bar.com')).toBe('mailto:foo@bar.com');
    expect(linkHref('www.example.org/@user')).toBe('https://www.example.org/@user');
  });

  it('refuses other schemes', () => {
    expect(linkHref('javascript:alert(1)')).toBeNull();
    expect(linkHref('data:text/html,hi')).toBeNull();
  });
});

describe('isExternalUrl', () => {
  it('is true for http(s) and www. links to another host', () => {
    expect(isExternalUrl('https://a.org/x')).toBe(true);
    expect(isExternalUrl('HTTP://a.org')).toBe(true);
    expect(isExternalUrl('www.example.org')).toBe(true);
  });

  it('is false for email, relative and same-host links', () => {
    expect(isExternalUrl('mailto:a@b.com')).toBe(false);
    expect(isExternalUrl('a@b.com')).toBe(false);
    expect(isExternalUrl('Syllabus.md')).toBe(false);
    expect(isExternalUrl('#heading')).toBe(false);
    expect(isExternalUrl(`${window.location.protocol}//${window.location.host}/doc`)).toBe(false);
  });
});

describe('createLinkElement', () => {
  it('opens in a new tab without giving the page a handle on the editor', () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    createLinkElement('x', 'https://a.org').click();
    expect(open).toHaveBeenCalledWith('https://a.org', '_blank', 'noopener,noreferrer');
    open.mockRestore();
  });

  it('shows the external-link icon after a [text](url) web link, without adding text', () => {
    const el = createLinkElement('x', 'https://a.org', true);
    expect(el.className).toBe('cm-link-widget');
    expect(el.lastElementChild?.className).toBe('cm-link-external-icon');
    expect(el.lastElementChild?.getAttribute('aria-hidden')).toBe('true');
    expect(el.textContent).toBe('x');
  });

  it('shows no icon after a bare URL or autolink, which shows its address already', () => {
    const el = createLinkElement('https://a.org', 'https://a.org');
    expect(el.className).toBe('cm-link-widget');
    expect(el.querySelector('.cm-link-external-icon')).toBeNull();
  });

  it('shows no icon after an email or relative link', () => {
    for (const url of ['mailto:a@b.com', 'a@b.com', 'Syllabus.md']) {
      const el = createLinkElement('x', url, true);
      expect(el.className).toBe('cm-link-widget');
      expect(el.querySelector('.cm-link-external-icon')).toBeNull();
    }
  });

  it('renders a refused link as plain text', () => {
    const el = createLinkElement('x', 'javascript:alert(1)');
    expect(el.className).toBe('');
    expect(el.textContent).toBe('x');
  });
});
