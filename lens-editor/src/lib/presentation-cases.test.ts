// The editor's copy of the presentation rules (jev-keys.ts, jev-presentation.ts) against the
// platform's (lens-platform core/course_checks/present.py), through a shared case file that the
// platform generates: core/course_checks/tests/make_presentation_cases.py. Copy it here again
// after the platform's rules change.
import { describe, expect, it } from 'vitest';
import cases from './fixtures/presentation_cases.json';
import { refProblem } from './jev-keys';
import { parsePresentation, type Level } from './jev-presentation';

describe('the editor resolves references as the platform does', () => {
  it('every reference case', () => {
    const wrong = cases.refs.filter((c) => (refProblem(c.name, { context: c.context as Level, question: c.question as Level, nest: c.nest as Level[] }) === null) !== c.resolves);
    expect(wrong.slice(0, 5)).toEqual([]);
    expect(cases.refs.length).toBeGreaterThan(1000);
  });
  it('every presentation block', () => {
    for (const c of cases.blocks) {
      let got: { ok: boolean; context?: string; question?: string };
      try { const p = parsePresentation(c.block); got = { ok: true, context: p.context, question: p.question }; } catch { got = { ok: false }; }
      expect(got, JSON.stringify(c.block)).toEqual(c.ok ? { ok: true, context: c.context, question: c.question } : { ok: false });
    }
  });
});
