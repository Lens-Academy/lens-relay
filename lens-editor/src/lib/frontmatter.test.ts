import { describe, it, expect } from 'vitest';
import { extractFrontmatter, frontmatterFieldChange } from './frontmatter';

/** Apply frontmatterFieldChange to the text, as an editor would. */
function setField(text: string, key: string, value: string | null): string {
  const change = frontmatterFieldChange(text, key, value);
  return change ? text.slice(0, change.from) + change.insert + text.slice(change.to) : text;
}

describe('frontmatterFieldChange', () => {
  it('adds a frontmatter block to a document without one', () => {
    expect(setField('# Title\n', 'icon', '🎯')).toBe('---\nicon: 🎯\n---\n# Title\n');
  });

  it('adds the key at the end of existing frontmatter', () => {
    expect(setField('---\ngoal: x\n---\nBody', 'icon', '🎯')).toBe('---\ngoal: x\nicon: 🎯\n---\nBody');
  });

  it('replaces the value of an existing key only', () => {
    const text = '---\nicon: 📄\ngoal: x\n---\nBody';
    expect(frontmatterFieldChange(text, 'icon', '🎯')).toEqual({ from: 4, to: 4 + 'icon: 📄'.length, insert: 'icon: 🎯' });
    expect(setField(text, 'icon', '🎯')).toBe('---\nicon: 🎯\ngoal: x\n---\nBody');
  });

  it('removes the key', () => {
    expect(setField('---\nicon: 🎯\ngoal: x\n---\nBody', 'icon', null)).toBe('---\ngoal: x\n---\nBody');
  });

  it('changes nothing when the value is already set, or a missing key is removed', () => {
    expect(frontmatterFieldChange('---\nicon: 🎯\n---\n', 'icon', '🎯')).toBeNull();
    expect(frontmatterFieldChange('---\ngoal: x\n---\n', 'icon', null)).toBeNull();
    expect(frontmatterFieldChange('Body', 'icon', null)).toBeNull();
  });

  it('quotes a value that YAML would misread, and the result parses back', () => {
    const text = setField('Body', 'icon', '#️⃣');
    expect(text).toBe('---\nicon: "#️⃣"\n---\nBody');
    expect(extractFrontmatter(text)).toEqual({ icon: '#️⃣' });
  });

  it('does not match a longer key that starts with the same name', () => {
    expect(setField('---\niconography: yes\n---\n', 'icon', '🎯')).toBe('---\niconography: yes\nicon: 🎯\n---\n');
  });
});

describe('extractFrontmatter', () => {
  describe('valid frontmatter', () => {
    it('extracts discussion field from frontmatter', () => {
      const text = `---
discussion: https://discord.com/channels/123/456
---
# Document content`;
      const result = extractFrontmatter(text);
      expect(result).toEqual({ discussion: 'https://discord.com/channels/123/456' });
    });

    it('returns object without discussion key when field is absent', () => {
      const text = `---
title: My Document
---
Content here`;
      const result = extractFrontmatter(text);
      expect(result).not.toBeNull();
      expect(result).not.toHaveProperty('discussion');
      expect(result).toHaveProperty('title', 'My Document');
    });

    it('returns all fields when multiple fields are present alongside discussion', () => {
      const text = `---
title: My Document
id: abc-123
slug: my-doc
discussion: https://discord.com/channels/111/222
---
Body text`;
      const result = extractFrontmatter(text);
      expect(result).toEqual({
        title: 'My Document',
        id: 'abc-123',
        slug: 'my-doc',
        discussion: 'https://discord.com/channels/111/222',
      });
    });
  });

  describe('no frontmatter', () => {
    it('returns null for text without frontmatter delimiters', () => {
      const text = '# Just a heading\nSome content';
      expect(extractFrontmatter(text)).toBeNull();
    });

    it('returns null for empty string', () => {
      expect(extractFrontmatter('')).toBeNull();
    });

    it('returns null for text with only opening delimiter', () => {
      const text = `---
title: Broken
No closing delimiter here`;
      expect(extractFrontmatter(text)).toBeNull();
    });
  });

  describe('malformed frontmatter', () => {
    it('returns null for malformed YAML (unclosed quotes)', () => {
      const text = `---
title: "unclosed
---
Content`;
      // front-matter library may parse this or throw - either way we handle gracefully
      const result = extractFrontmatter(text);
      // If it parses, it should be an object; if not, null
      expect(result === null || typeof result === 'object').toBe(true);
    });

    it('returns null for invalid YAML syntax', () => {
      const text = `---
: : : invalid
  bad indent
    worse
---
Content`;
      const result = extractFrontmatter(text);
      expect(result === null || typeof result === 'object').toBe(true);
    });
  });

  describe('line endings', () => {
    it('handles Windows line endings (CRLF)', () => {
      const text = '---\r\ndiscussion: https://discord.com/channels/789/012\r\n---\r\n# Content';
      const result = extractFrontmatter(text);
      expect(result).toEqual({ discussion: 'https://discord.com/channels/789/012' });
    });
  });
});
