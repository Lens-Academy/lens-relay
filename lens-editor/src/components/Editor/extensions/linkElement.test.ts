import { describe, it, expect, vi } from 'vitest';
import { createLinkElement, linkHref } from './linkElement';

describe('linkHref', () => {
  it('opens http(s) and mailto as written and prefixes https:// when there is no scheme', () => {
    expect(linkHref('https://a.org/x')).toBe('https://a.org/x');
    expect(linkHref('HTTP://a.org')).toBe('HTTP://a.org');
    expect(linkHref('mailto:a@b.com')).toBe('mailto:a@b.com');
    expect(linkHref('www.example.org')).toBe('https://www.example.org');
  });

  it('refuses other schemes', () => {
    expect(linkHref('javascript:alert(1)')).toBeNull();
    expect(linkHref('data:text/html,hi')).toBeNull();
  });
});

describe('createLinkElement', () => {
  it('opens in a new tab without giving the page a handle on the editor', () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    createLinkElement('x', 'https://a.org').click();
    expect(open).toHaveBeenCalledWith('https://a.org', '_blank', 'noopener,noreferrer');
    open.mockRestore();
  });

  it('renders a refused link as plain text', () => {
    const el = createLinkElement('x', 'javascript:alert(1)');
    expect(el.className).toBe('');
    expect(el.textContent).toBe('x');
  });
});
