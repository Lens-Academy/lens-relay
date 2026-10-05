import { describe, it, expect } from 'vitest';
import { embedLineTarget, parseQuestionFile } from './questionFile';

describe('parseQuestionFile', () => {
  it('reads the type and fields of the question', () => {
    const q = parseQuestionFile('#### Question: Choice\nid:: abc\ncontent:: Why?\noptions::\n- [x] A\n- [ ] B\n');
    expect(q?.type).toBe('Choice');
    expect(q?.fields.get('content')).toBe('Why?');
    expect(q?.fields.get('options')).toBe('- [x] A\n- [ ] B');
  });

  it('treats a bare header as Open and skips frontmatter', () => {
    const q = parseQuestionFile('---\ntags: [question]\n---\n#### Question\ncontent:: Hi\n');
    expect(q?.type).toBe('Open');
    expect(q?.fields.get('content')).toBe('Hi');
  });

  it('stops at the next segment', () => {
    const q = parseQuestionFile('#### Question\ncontent:: Hi\n#### Text\ncontent:: not mine\n');
    expect(q?.fields.get('content')).toBe('Hi');
  });

  it('is null for a file without a question', () => {
    expect(parseQuestionFile('# Notes\nsome text')).toBeNull();
  });
});

describe('embedLineTarget', () => {
  it('finds the target of a line that is only an embed', () => {
    expect(embedLineTarget('![[../Questions/Foo]]')).toBe('../Questions/Foo');
    expect(embedLineTarget('  ![[Foo#Part|Shown]]  ')).toBe('Foo');
  });

  it('ignores embeds that share their line', () => {
    expect(embedLineTarget('source:: ![[../Lenses/X]]')).toBeNull();
    expect(embedLineTarget('see ![[Foo]] here')).toBeNull();
    expect(embedLineTarget('[[Foo]]')).toBeNull();
  });
});
