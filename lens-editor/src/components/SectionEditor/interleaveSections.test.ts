import { describe, it, expect } from 'vitest';
import { interleaveSections, type DocSections } from './interleaveSections';
import type { Section } from './parseSections';

function makeSection(type: string, label: string, from: number, to: number): Section {
  return { type, label, from, to, content: `content of ${label}` };
}

describe('interleaveSections', () => {
  it('single doc returns all sections in order with doc metadata', () => {
    const input: DocSections[] = [{
      docIndex: 0,
      compoundDocId: 'relay-doc0',
      sections: [
        makeSection('frontmatter', 'Frontmatter', 0, 20),
        makeSection('video', 'Video', 20, 50),
      ],
    }];
    const result = interleaveSections(input);
    expect(result).toHaveLength(2);
    expect(result[0].label).toBe('Frontmatter');
    expect(result[0].docIndex).toBe(0);
    expect(result[0].compoundDocId).toBe('relay-doc0');
    expect(result[1].label).toBe('Video');
  });

  it('two docs interleave round-robin', () => {
    const input: DocSections[] = [
      {
        docIndex: 0, compoundDocId: 'relay-doc0',
        sections: [
          makeSection('frontmatter', 'A-FM', 0, 10),
          makeSection('video', 'A-Video', 10, 30),
          makeSection('text', 'A-Text', 30, 50),
        ],
      },
      {
        docIndex: 1, compoundDocId: 'relay-doc1',
        sections: [
          makeSection('frontmatter', 'B-FM', 0, 15),
          makeSection('text', 'B-Text', 15, 40),
        ],
      },
    ];
    const result = interleaveSections(input);
    expect(result.map(s => s.label)).toEqual(['A-FM', 'B-FM', 'A-Video', 'B-Text', 'A-Text']);
    expect(result[0].docIndex).toBe(0);
    expect(result[1].docIndex).toBe(1);
    expect(result[4].docIndex).toBe(0);
  });

  it('empty doc array returns empty', () => {
    expect(interleaveSections([])).toEqual([]);
  });

  it('doc with zero sections is skipped', () => {
    const input: DocSections[] = [
      { docIndex: 0, compoundDocId: 'relay-doc0', sections: [makeSection('text', 'A-Text', 0, 10)] },
      { docIndex: 1, compoundDocId: 'relay-doc1', sections: [] },
    ];
    const result = interleaveSections(input);
    expect(result).toHaveLength(1);
    expect(result[0].label).toBe('A-Text');
  });

  it('three docs interleave correctly', () => {
    const input: DocSections[] = [
      { docIndex: 0, compoundDocId: 'd0', sections: [makeSection('text', 'A1', 0, 10), makeSection('text', 'A2', 10, 20)] },
      { docIndex: 1, compoundDocId: 'd1', sections: [makeSection('text', 'B1', 0, 10)] },
      { docIndex: 2, compoundDocId: 'd2', sections: [makeSection('text', 'C1', 0, 10), makeSection('text', 'C2', 10, 20)] },
    ];
    const result = interleaveSections(input);
    expect(result.map(s => s.label)).toEqual(['A1', 'B1', 'C1', 'A2', 'C2']);
  });
});
