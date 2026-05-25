import { describe, it, expect } from 'vitest';
import { renamePreservingExtension } from './filename-utils';

describe('renamePreservingExtension', () => {
  it('preserves .md extension when the user types no extension', () => {
    expect(renamePreservingExtension('note.md', 'note2')).toBe('note2.md');
  });

  it('preserves .html extension when the user types no extension', () => {
    expect(renamePreservingExtension('page.html', 'page2')).toBe('page2.html');
  });

  it('uses the typed extension when the user supplies one', () => {
    expect(renamePreservingExtension('note.md', 'note2.html')).toBe('note2.html');
  });

  it('returns the new name verbatim if neither old nor new has an extension', () => {
    expect(renamePreservingExtension('readme', 'changelog')).toBe('changelog');
  });

  it('ignores leading dots in dotfiles (treats them as no extension)', () => {
    expect(renamePreservingExtension('.gitignore', '.npmignore')).toBe('.npmignore');
  });

  it('treats dotfiles with multiple dots as extensionless', () => {
    expect(renamePreservingExtension('.env.local', 'env')).toBe('env');
  });

  it('treats only the last segment of a multi-dot extension', () => {
    expect(renamePreservingExtension('archive.tar.gz', 'backup')).toBe('backup.gz');
  });

  it('the typed extension wins even if it differs from the old extension', () => {
    expect(renamePreservingExtension('page.html', 'page2.md')).toBe('page2.md');
  });
});
