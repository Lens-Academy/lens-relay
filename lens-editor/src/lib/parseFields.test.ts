import { describe, it, expect } from 'vitest';
import { parseFields, parseFrontmatterFields } from './parseFields';

describe('parseFields', () => {
  it('extracts single-line fields', () => {
    const text = 'content:: Hello world\nfrom:: "start text"';
    const fields = parseFields(text);
    expect(fields.get('content')).toBe('Hello world');
    expect(fields.get('from')).toBe('start text');
  });

  it('strips surrounding quotes from values', () => {
    const text = 'from:: "some quoted value"\nto:: "another"';
    const fields = parseFields(text);
    expect(fields.get('from')).toBe('some quoted value');
    expect(fields.get('to')).toBe('another');
  });

  it('extracts multi-line field values', () => {
    const text = 'instructions::\nLine 1\nLine 2\nLine 3';
    const fields = parseFields(text);
    expect(fields.get('instructions')).toBe('Line 1\nLine 2\nLine 3');
  });

  it('stops multi-line value at next field', () => {
    const text = 'content::\nParagraph one\nParagraph two\nfrom:: "anchor"';
    const fields = parseFields(text);
    expect(fields.get('content')).toBe('Paragraph one\nParagraph two');
    expect(fields.get('from')).toBe('anchor');
  });

  it('extracts wikilink from source field', () => {
    const text = 'source:: [[../Lenses/AI Control]]';
    const fields = parseFields(text);
    expect(fields.get('source')).toBe('[[../Lenses/AI Control]]');
  });

  it('extracts transclusion wikilink', () => {
    const text = 'source:: ![[../Learning Outcomes/Some LO]]';
    const fields = parseFields(text);
    expect(fields.get('source')).toBe('![[../Learning Outcomes/Some LO]]');
  });

  it('handles empty field value', () => {
    const text = 'from:: ""';
    const fields = parseFields(text);
    expect(fields.get('from')).toBe('');
  });

  it('returns empty map for text with no fields', () => {
    const text = 'Just some plain text\nwith no fields';
    const fields = parseFields(text);
    expect(fields.size).toBe(0);
  });

  it('handles optional boolean field', () => {
    const text = 'optional:: true\nsource:: [[../Lenses/Foo]]';
    const fields = parseFields(text);
    expect(fields.get('optional')).toBe('true');
  });

  it('handles field on first line after header', () => {
    const text = '#### Text\ncontent::\nSome text here';
    const fields = parseFields(text);
    expect(fields.get('content')).toBe('Some text here');
  });

  it('handles multi-line content with blank lines', () => {
    const text = 'content::\nParagraph one\n\nParagraph two\n\nParagraph three';
    const fields = parseFields(text);
    expect(fields.get('content')).toBe('Paragraph one\n\nParagraph two\n\nParagraph three');
  });

  it('extracts source on same line with newline-separated wikilink', () => {
    const text = 'source::\n![[../Lenses/AI Control]]';
    const fields = parseFields(text);
    expect(fields.get('source')).toBe('![[../Lenses/AI Control]]');
  });
});

describe('parseFrontmatterFields', () => {
  it('extracts YAML single-colon fields', () => {
    const text = '---\ntitle: Test Title\ntldr: Some summary here\nslug: test\n---\n';
    const fields = parseFrontmatterFields(text);
    expect(fields.get('tldr')).toBe('Some summary here');
    expect(fields.get('title')).toBe('Test Title');
    expect(fields.get('slug')).toBe('test');
  });

  it('handles quoted YAML values', () => {
    const text = '---\ntldr: "A quoted value"\n---\n';
    const fields = parseFrontmatterFields(text);
    expect(fields.get('tldr')).toBe('A quoted value');
  });
});

describe('content-processor integration', () => {
  it('parseWikilink import works', async () => {
    const { parseWikilink } = await import('lens-content-processor/dist/parser/wikilink.js');
    const result = parseWikilink('[[../Lenses/AI Control]]');
    expect(result).not.toBeNull();
    expect(result!.path).toBe('../Lenses/AI Control');
  });
});
