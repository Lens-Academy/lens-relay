import type { Section } from './parseSections';

export interface DocSections {
  docIndex: number;
  compoundDocId: string;
  sections: Section[];
}

export interface MultiDocSection extends Section {
  docIndex: number;
  compoundDocId: string;
}

export function interleaveSections(docs: DocSections[]): MultiDocSection[] {
  const result: MultiDocSection[] = [];
  const indices = new Array(docs.length).fill(0);

  let progress = true;
  while (progress) {
    progress = false;
    for (let d = 0; d < docs.length; d++) {
      const { docIndex, compoundDocId, sections } = docs[d];
      const i = indices[d];
      if (i < sections.length) {
        result.push({ ...sections[i], docIndex, compoundDocId });
        indices[d]++;
        progress = true;
      }
    }
  }

  return result;
}
