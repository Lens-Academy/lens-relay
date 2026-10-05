import { describe, expect, it } from 'vitest';
import { buildPromotionCurriculumIndex, resolveCurriculumTarget, type PromotionTreeSnapshot } from './curriculum.ts';
import type { PromotionFileChange } from './types.ts';

function snapshot(files: Record<string, string>): PromotionTreeSnapshot {
  return { paths: new Set(Object.keys(files)), markdown: new Map(Object.entries(files).filter(([p]) => p.endsWith('.md'))) };
}

function change(path: string, status: PromotionFileChange['status'] = 'modified', oldPath: string | null = null): PromotionFileChange {
  return { path, oldPath, status, additions: 1, deletions: 1, isBinary: false };
}

describe('resolveCurriculumTarget', () => {
  it('normalizes relative, vault-root, alias, and extension-free links', () => {
    expect(resolveCurriculumTarget('modules/M.md', '../Lenses/L')).toBe('Lenses/L.md');
    expect(resolveCurriculumTarget('modules/M.md', 'Lens Edu/articles/A|Alias')).toBe('articles/A.md');
    expect(resolveCurriculumTarget('modules/M.md', '../../outside')).toBeNull();
  });

  it('finds an .html widget for an extension-free link, preferring an .md twin', () => {
    const paths = new Set(['widgets/rings.html', 'widgets/twin.md', 'widgets/twin.html']);
    expect(resolveCurriculumTarget('Lenses/L.md', '../widgets/rings', paths)).toBe('widgets/rings.html');
    expect(resolveCurriculumTarget('Lenses/L.md', '../widgets/twin', paths)).toBe('widgets/twin.md');
    expect(resolveCurriculumTarget('Lenses/L.md', '../widgets/twin.html', paths)).toBe('widgets/twin.html');
    expect(resolveCurriculumTarget('Lenses/L.md', '../widgets/missing', paths)).toBe('widgets/missing.md');
  });
});

describe('buildPromotionCurriculumIndex', () => {
  it('builds recursive many-to-many course and module scopes with transcript companions', () => {
    const staging = snapshot({
      'courses/Course One.md': '---\ntitle: Course One\n---\n# Module: [[../modules/Module A|Friendly A]]',
      'courses/Course Two.md': '# Module: [[../modules/Module B]]',
      'modules/Module A.md': '# Learning Outcome:\nsource:: [[../Learning Outcomes/LO]]',
      'modules/Module B.md': '# Lens:\nsource:: [[../Lenses/Shared]]',
      'Learning Outcomes/LO.md': 'source::\n[[../Lenses/Shared]]',
      'Lenses/Shared.md': 'source:: [[../video_transcripts/Clip]]',
      'video_transcripts/Clip.md': 'Transcript',
      'video_transcripts/Clip.timestamps.json': '[]',
    });
    const changes = [
      change('courses/Course One.md'),
      change('modules/Module A.md'),
      change('Lenses/Shared.md'),
      change('video_transcripts/Clip.md'),
      change('video_transcripts/Clip.timestamps.json'),
    ];

    const result = buildPromotionCurriculumIndex(staging, snapshot({}), changes);

    expect(result.courses.map(course => course.label)).toEqual(['Course One', 'Course Two']);
    expect(result.modules.find(module => module.path === 'modules/Module A.md')?.label).toBe('Friendly A');
    expect(result.memberships['Lenses/Shared.md']).toEqual({
      coursePaths: ['courses/Course One.md', 'courses/Course Two.md'],
      modulePaths: ['modules/Module A.md', 'modules/Module B.md'],
    });
    expect(result.memberships['video_transcripts/Clip.timestamps.json']).toEqual(
      result.memberships['video_transcripts/Clip.md'],
    );
  });

  it('puts an .html widget in the courses and modules of the lenses that use it', () => {
    const staging = snapshot({
      'courses/C.md': '# Module: [[../modules/M]]',
      'modules/M.md': '# Lens:\nsource:: [[../Lenses/L]]',
      'Lenses/L.md': '#### Widget\nsource:: [[../widgets/rings]]',
      'widgets/rings.html': '<!--lens-widget\ntitle: Rings\n-->\n<!doctype html>',
    });
    const result = buildPromotionCurriculumIndex(staging, snapshot({}), [change('widgets/rings.html')]);
    expect(result.memberships['widgets/rings.html']).toEqual({
      coursePaths: ['courses/C.md'],
      modulePaths: ['modules/M.md'],
    });
  });

  it('finds courses grouped in subfolders of courses/', () => {
    const staging = snapshot({
      'courses/live/C.md': '---\ntitle: Grouped\n---\n# Module: [[../../modules/M]]',
      'modules/M.md': '# Lens:\nsource:: [[../Lenses/L]]',
      'Lenses/L.md': 'Text',
    });
    const result = buildPromotionCurriculumIndex(staging, snapshot({}), [change('Lenses/L.md')]);
    expect(result.courses.map(course => course.label)).toEqual(['Grouped']);
    expect(result.memberships['Lenses/L.md']).toEqual({
      coursePaths: ['courses/live/C.md'],
      modulePaths: ['modules/M.md'],
    });
  });

  it('terminates cycles and ignores missing targets', () => {
    const staging = snapshot({
      'courses/C.md': '# Module: [[../modules/M]]',
      'modules/M.md': 'source:: [[../Lenses/A]]',
      'Lenses/A.md': 'source:: [[../modules/M]]\nsource:: [[../missing/X]]',
    });
    const result = buildPromotionCurriculumIndex(staging, snapshot({}), [change('Lenses/A.md')]);
    expect(result.memberships['Lenses/A.md']?.modulePaths).toEqual(['modules/M.md']);
  });

  it('uses production membership for deletions and unions both sides of renames', () => {
    const production = snapshot({
      'courses/C.md': '# Module: [[../modules/Old]]',
      'modules/Old.md': 'source:: [[../Lenses/Deleted]]\nsource:: [[../Lenses/Old Name]]',
      'Lenses/Deleted.md': 'old',
      'Lenses/Old Name.md': 'old',
    });
    const staging = snapshot({
      'courses/C.md': '# Module: [[../modules/Old]]',
      'modules/Old.md': 'source:: [[../Lenses/New Name]]',
      'Lenses/New Name.md': 'new',
    });
    const result = buildPromotionCurriculumIndex(staging, production, [
      change('Lenses/Deleted.md', 'deleted'),
      change('Lenses/New Name.md', 'renamed', 'Lenses/Old Name.md'),
    ]);
    expect(result.memberships['Lenses/Deleted.md']?.coursePaths).toEqual(['courses/C.md']);
    expect(result.memberships['Lenses/New Name.md']?.modulePaths).toEqual(['modules/Old.md']);
  });

  it('canonicalizes renamed course and module identities', () => {
    const production = snapshot({
      'courses/Old Course.md': '# Module: [[../modules/Old Module]]',
      'modules/Old Module.md': 'source:: [[../Lenses/L]]',
      'Lenses/L.md': 'lens',
    });
    const staging = snapshot({
      'courses/New Course.md': '# Module: [[../modules/New Module]]',
      'modules/New Module.md': 'source:: [[../Lenses/L]]',
      'Lenses/L.md': 'lens',
    });
    const changes = [
      change('courses/New Course.md', 'renamed', 'courses/Old Course.md'),
      change('modules/New Module.md', 'renamed', 'modules/Old Module.md'),
      change('Lenses/L.md'),
    ];
    const result = buildPromotionCurriculumIndex(staging, production, changes);
    expect(result.courses.map(course => course.path)).toEqual(['courses/New Course.md']);
    expect(result.modules.map(module => module.path)).toEqual(['modules/New Module.md']);
    expect(result.memberships['Lenses/L.md']).toEqual({
      coursePaths: ['courses/New Course.md'],
      modulePaths: ['modules/New Module.md'],
    });
  });
});
