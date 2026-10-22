import { describe, expect, it } from 'vitest';
import { keyHint, keyRuns, PLATFORM_SHAPE, refProblem, refSyntax, renameRef, type Shape } from './jev-keys';
import { LEVELS } from './jev-presentation';

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

describe('renaming', () => {
      it('renames references to the old question level', () => {
    expect(renameRef('Does `paragraph` use a term `paragraph` never explains? Not `section`.', 'paragraph', 'sentence'))
      .toBe('Does `sentence` use a term `sentence` never explains? Not `section`.');
  });
});

