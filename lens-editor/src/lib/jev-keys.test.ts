import { describe, expect, it } from 'vitest';
import { fillRefs, keyHint, keyRuns, PLATFORM_SHAPE, refProblem, refSyntax, renameRef, type Shape } from './jev-keys';
import { LEVELS, parseDoc, within } from './jev-present';

const docPara: Shape = { context: 'document', question: 'paragraph', nest: [...LEVELS] };
const lineAsk: Shape = { context: 'document', question: 'line', nest: [...LEVELS] };

describe('references in a check, under the presentation (Lauren, 2026-10-22)', () => {
  it('flags a written number as the wrong syntax', () => {
    expect(refProblem('line_{}', lineAsk)).toMatch(/write `line`/);
    expect(refProblem('paragraph_3', docPara)).toMatch(/write `paragraph`/);
  });
  it('flags a unit finer than the one asked about', () => {
    expect(refProblem('line', docPara)).toMatch(/finer than the paragraph/);
  });
  it('flags a unit coarser than what jev sees (each paragraph alone)', () => {
    expect(refProblem('section', PLATFORM_SHAPE)).toMatch(/jev sees only one paragraph/);
    expect(refProblem('paragraph', PLATFORM_SHAPE)).toBeNull();
  });
  it('flags a level whose nesting is off, and accepts it when on', () => {
    expect(refProblem('paragraph', lineAsk)).toBeNull();
    expect(refProblem('paragraph', { ...lineAsk, nest: [] })).toMatch(/nesting by paragraph is off/);
    expect(refProblem('document', { ...lineAsk, nest: [] })).toBeNull();
  });
  it('flags names that are not units, and leaves plain text alone', () => {
    const runs = keyRuns('Does `paragraph` use `foo` here?', docPara);
    expect(runs.map((r) => [r.t, !!r.problem])).toEqual([['Does ', false], ['`paragraph`', false], [' use ', false], ['`foo`', true], [' here?', false]]);
  });
  it('asks for the unit asked about to be named', () => {
    expect(keyHint('Is it bad?', docPara)).toMatch(/`paragraph`/);
    expect(keyHint('Is `paragraph` bad?', docPara)).toBeUndefined();
  });
  it('describes the syntax under the fields', () => {
    expect(refSyntax(PLATFORM_SHAPE)).toBe('`paragraph` is the paragraph asked about; jev is shown it alone, under that name.');
    expect(refSyntax({ context: 'document', question: 'sentence', nest: ['paragraph'] })).toBe('`sentence` is the sentence asked about; `paragraph`, `document` the ones around it. jev is sent each as its numbered key, such as `sentence_12`.');
  });
});

describe('what jev is sent', () => {
  const d = parseDoc('# A\n\nOne. Two.\n\nThree.\n');
  const two = within(d, 'sentence')[1];
  it('fills each resolvable reference with its key, leaving the rest', () => {
    const s: Shape = { context: 'document', question: 'sentence', nest: ['paragraph'] };
    expect(fillRefs('Does `sentence` of `paragraph` in `document` use `line` or `section`?', two, s))
      .toBe('Does `sentence_1` of `paragraph_0` in `document` use `line` or `section`?');
  });
  it('leaves the words as they are when the unit is shown alone', () => {
    const p = within(d, 'paragraph')[0];
    expect(fillRefs('Is `paragraph` bad?', p, PLATFORM_SHAPE)).toBe('Is `paragraph` bad?');
  });
  it('renames references to the old question level', () => {
    expect(renameRef('Does `paragraph` use a term `paragraph` never explains? Not `section`.', 'paragraph', 'sentence'))
      .toBe('Does `sentence` use a term `sentence` never explains? Not `section`.');
  });
});

describe('references to units the JSON leaves out (Assay, #195)', () => {
  it("in a lens file the lens is the document, so `lens` names the document", () => {
    const d = parseDoc('#### Text\ncontent:: One. Two.\n');
    const s: Shape = { context: 'document', question: 'sentence', nest: [...LEVELS] };
    expect(fillRefs('`sentence` in `section` of `lens` and `submodule`', within(d, 'sentence')[1], s))
      .toBe('`sentence_1` in `section_0` of `document` and `document`');
  });
  it('a module keeps its lens keys', () => {
    const d = parseDoc('## Lens: A\n#### Text\ncontent:: One.\n\n## Lens: B\n#### Text\ncontent:: Two.\n');
    const s: Shape = { context: 'document', question: 'paragraph', nest: [...LEVELS] };
    expect(fillRefs('`paragraph` of `lens`', within(d, 'paragraph')[1], s)).toBe('`paragraph_1` of `lens_1`');
  });
});
