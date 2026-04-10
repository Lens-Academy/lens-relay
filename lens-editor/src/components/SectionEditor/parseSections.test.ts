import { describe, it, expect } from 'vitest';
import { parseSections } from './parseSections';

describe('parseSections', () => {
  it('returns empty for empty string', () => {
    expect(parseSections('')).toEqual([]);
  });

  it('parses frontmatter', () => {
    const text = '---\ntitle: Test\nslug: test\n---\n# Hello\nContent';
    const sections = parseSections(text);
    expect(sections[0].type).toBe('frontmatter');
    expect(sections[0].from).toBe(0);
    expect(sections[0].content).toContain('title: Test');
  });

  it('parses heading sections', () => {
    const text = '# Welcome\nHello world\n\n# Features\nStuff here';
    const sections = parseSections(text);
    expect(sections).toHaveLength(2);
    expect(sections[0].label).toBe('Welcome');
    expect(sections[0].from).toBe(0);
    expect(sections[1].label).toBe('Features');
    expect(sections[1].from).toBe(text.indexOf('# Features'));
  });

  it('section ranges cover the entire document with no gaps', () => {
    const text = '---\nid: test\n---\n# Welcome\nHello\n\n## Features\nStuff\n\n## Links\nMore';
    const sections = parseSections(text);
    // Verify no gaps between sections
    for (let i = 0; i < sections.length - 1; i++) {
      expect(sections[i].to).toBe(sections[i + 1].from);
    }
    // First section starts at 0, last ends at text.length
    expect(sections[0].from).toBe(0);
    expect(sections[sections.length - 1].to).toBe(text.length);
  });

  it('classifies #### Video/Text/Chat correctly', () => {
    const text = '#### Video\nsource:: foo\n#### Text\ncontent\n#### Chat\ninstructions';
    const sections = parseSections(text);
    expect(sections.map(s => s.type)).toEqual(['video', 'text', 'chat']);
  });

  it('classifies lens/test/LO references', () => {
    const text = '## Lens:\nsource:: foo\n## Test:\nq1\n## Learning Outcome:\nsrc';
    const sections = parseSections(text);
    expect(sections.map(s => s.type)).toEqual(['lens-ref', 'test-ref', 'lo-ref']);
    // Labels should have trailing colon stripped
    expect(sections[0].label).toBe('Lens');
    expect(sections[1].label).toBe('Test');
    expect(sections[2].label).toBe('Learning Outcome');
  });

  it('skips header-like lines on their own line inside frontmatter', () => {
    const text = '---\n# Fake Header\nslug: test\n---\n# Real Header\nContent';
    const sections = parseSections(text);
    expect(sections[0].type).toBe('frontmatter');
    expect(sections[1].type).toBe('heading');
    expect(sections[1].label).toBe('Real Header');
    // The "# Fake Header" inside frontmatter must not create a section
    expect(sections).toHaveLength(2);
  });

  it('covers whitespace-only gaps between frontmatter and headers', () => {
    const text = '---\nid: test\n---\n\n\n# Welcome\nHello';
    const sections = parseSections(text);
    // No gaps — frontmatter should extend to cover the blank lines
    expect(sections[0].from).toBe(0);
    expect(sections[0].to).toBe(text.indexOf('# Welcome'));
    expect(sections[sections.length - 1].to).toBe(text.length);
    for (let i = 0; i < sections.length - 1; i++) {
      expect(sections[i].to).toBe(sections[i + 1].from);
    }
  });

  it('covers gap when document starts with blank lines before header', () => {
    const text = '\n\n# Welcome\nHello\n\n## Features\nStuff';
    const sections = parseSections(text);
    expect(sections[0].from).toBe(0);
    expect(sections[sections.length - 1].to).toBe(text.length);
    for (let i = 0; i < sections.length - 1; i++) {
      expect(sections[i].to).toBe(sections[i + 1].from);
    }
  });

  it('handles document with only content and no headers', () => {
    const text = 'Just some plain text\nwith multiple lines';
    const sections = parseSections(text);
    expect(sections).toHaveLength(1);
    expect(sections[0].type).toBe('body');
    expect(sections[0].from).toBe(0);
    expect(sections[0].to).toBe(text.length);
  });

  it('handles CRLF line endings', () => {
    const text = '# Welcome\r\nHello world\r\n\r\n# Features\r\nStuff here';
    const sections = parseSections(text);
    expect(sections).toHaveLength(2);
    expect(sections[0].label).toBe('Welcome');
    expect(sections[1].label).toBe('Features');
    // No gaps
    for (let i = 0; i < sections.length - 1; i++) {
      expect(sections[i].to).toBe(sections[i + 1].from);
    }
    expect(sections[sections.length - 1].to).toBe(text.length);
  });

  it('handles document with only frontmatter', () => {
    const text = '---\ntitle: Test\nslug: test\n---\n';
    const sections = parseSections(text);
    expect(sections).toHaveLength(1);
    expect(sections[0].type).toBe('frontmatter');
    expect(sections[0].from).toBe(0);
    expect(sections[0].to).toBe(text.length);
  });

  it('handles single line document with no headers', () => {
    const text = 'Just one line';
    const sections = parseSections(text);
    expect(sections).toHaveLength(1);
    expect(sections[0].type).toBe('body');
    expect(sections[0].to).toBe(text.length);
  });

  it('handles consecutive headers with no content between them', () => {
    const text = '# First\n# Second\n# Third\n';
    const sections = parseSections(text);
    expect(sections).toHaveLength(3);
    expect(sections[0].label).toBe('First');
    expect(sections[0].content).toBe('# First\n');
    expect(sections[1].label).toBe('Second');
    expect(sections[2].label).toBe('Third');
    // No gaps
    for (let i = 0; i < sections.length - 1; i++) {
      expect(sections[i].to).toBe(sections[i + 1].from);
    }
  });

  it('handles header-like content inside frontmatter', () => {
    const text = '---\ntitle: # Not a header\n---\n# Real Header\nContent';
    const sections = parseSections(text);
    // The # inside frontmatter should NOT create a section
    expect(sections[0].type).toBe('frontmatter');
    expect(sections[1].type).toBe('heading');
    expect(sections[1].label).toBe('Real Header');
  });

  it('classifies module and meeting headers', () => {
    const text = '# Module: Introduction\nContent\n# Meeting: Standup\nNotes';
    const sections = parseSections(text);
    expect(sections[0].type).toBe('module-ref');
    expect(sections[1].type).toBe('meeting-ref');
  });

  it('classifies submodule headers', () => {
    const text = '# Submodule: Welcome\nContent\n# Submodule: Testing\nMore';
    const sections = parseSections(text);
    expect(sections.map(s => s.type)).toEqual(['submodule', 'submodule']);
    expect(sections[0].label).toBe('Welcome');
    expect(sections[1].label).toBe('Testing');
  });

  it('classifies page headers at different levels', () => {
    const text = '# Page: Welcome\nContent\n## Page: Details\nMore';
    const sections = parseSections(text);
    expect(sections.map(s => s.type)).toEqual(['page', 'page']);
    expect(sections[0].label).toBe('Welcome');
  });

  it('classifies question sections', () => {
    const text = '#### Question\ncontent:: What is AI?';
    const sections = parseSections(text);
    expect(sections[0].type).toBe('question');
  });

  it('classifies video-excerpt sections', () => {
    const text = '#### Video-excerpt\nto:: 14:49';
    const sections = parseSections(text);
    expect(sections[0].type).toBe('video-excerpt');
  });

  it('classifies article-excerpt sections', () => {
    const text = '#### Article-excerpt\nfrom:: "start"\nto:: "end"';
    const sections = parseSections(text);
    expect(sections[0].type).toBe('article-excerpt');
  });

  it('classifies ## Text and ## Chat at non-#### levels', () => {
    const text = '## Text\ncontent:: Hello\n## Chat\ninstructions:: Help';
    const sections = parseSections(text);
    expect(sections.map(s => s.type)).toEqual(['text', 'chat']);
  });

  it('classifies ### Text in modules', () => {
    const text = '### Text\ncontent:: Some framing text';
    const sections = parseSections(text);
    expect(sections[0].type).toBe('text');
  });

  it('handles CriticMarkup-wrapped Chat headers', () => {
    const text = '#### {--{"author":"AI","timestamp":123}@@Chat: Old Title--}{++{"author":"AI","timestamp":123}@@Chat++}\ninstructions:: Help';
    const sections = parseSections(text);
    expect(sections[0].type).toBe('chat');
    expect(sections[0].label).toBe('Chat');
  });

  it('classifies ### Article: and ### Video: as article-ref and video-ref', () => {
    const text = '### Article: Some Article\nsource:: [[../articles/foo]]\n### Video: Some Video\nsource:: [[../video_transcripts/bar]]';
    const sections = parseSections(text);
    expect(sections.map(s => s.type)).toEqual(['article-ref', 'video-ref']);
    expect(sections[0].label).toBe('Some Article');
    expect(sections[1].label).toBe('Some Video');
  });

  it('classifies mixed edu sections in a lens', () => {
    const text = [
      '### Article: Some Article',
      'source:: [[../articles/foo]]',
      '#### Text',
      'content:: Framing text',
      '#### Article-excerpt',
      'from:: "start"',
      'to:: "end"',
      '#### Chat',
      'instructions:: Help the user',
    ].join('\n');
    const sections = parseSections(text);
    expect(sections.map(s => s.type)).toEqual([
      'article-ref', 'text', 'article-excerpt', 'chat',
    ]);
  });

  it('classifies mixed edu sections in a module', () => {
    const text = [
      '# Submodule: Welcome',
      '## Page: Intro',
      '### Text',
      'content:: Hello',
      '# Learning Outcome:',
      'source:: ![[../LO/Test]]',
    ].join('\n');
    const sections = parseSections(text);
    expect(sections.map(s => s.type)).toEqual([
      'submodule', 'page', 'text', 'lo-ref',
    ]);
  });

  it('assigns heading level to each section', () => {
    const text =
      '---\nid: x\n---\n' +
      '# Lens: Welcome\n' +
      '#### Text\ncontent::\nhi\n' +
      '# Learning Outcome:\nsource:: foo\n' +
      '## Submodule: A\n' +
      '## Lens:\nsource:: bar\n';
    const sections = parseSections(text);
    expect(sections[0].type).toBe('frontmatter');
    expect(sections[0].level).toBe(0);
    expect(sections.find(s => s.type === 'lens-ref')?.level).toBe(1); // first lens-ref occurrence (# Lens: Welcome)
    expect(sections.find(s => s.type === 'text')?.level).toBe(4);
    expect(sections.find(s => s.type === 'lo-ref')?.level).toBe(1);
    expect(sections.find(s => s.type === 'submodule')?.level).toBe(2);
  });

  it('assigns level 0 to a body section', () => {
    const sections = parseSections('Hello world');
    expect(sections).toHaveLength(1);
    expect(sections[0].type).toBe('body');
    expect(sections[0].level).toBe(0);
  });
});
