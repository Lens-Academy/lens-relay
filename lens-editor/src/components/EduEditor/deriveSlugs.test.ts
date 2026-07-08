import { describe, it, expect } from 'vitest';
import { parseSections } from '../SectionEditor/parseSections';
import { deriveEduSlugs } from './deriveSlugs';

const courseDoc = parseSections(
  '---\nslug: demo-course\n---\n# Module: [[../modules/Demo Module|Demo Module]]\n',
);
const moduleDoc = parseSections(
  '---\nslug: demo-module\n---\n# Lens: Welcome\n#### Text\ncontent::\nhi\n',
);
const emptyCourseDoc = parseSections('---\nslug: demo-course\n---\n## Notes\n');

describe('deriveEduSlugs', () => {
  it('returns course and module slugs in course mode', () => {
    expect(deriveEduSlugs(courseDoc, moduleDoc, '/courses/Demo Course.md')).toEqual({
      isCourseMode: true,
      courseSlug: 'demo-course',
      moduleSlug: 'demo-module',
    });
  });

  it('returns only the module slug for a standalone module doc', () => {
    expect(deriveEduSlugs(moduleDoc, [], '/modules/Demo Module.md')).toEqual({
      isCourseMode: false,
      moduleSlug: 'demo-module',
    });
  });

  it('recognizes module docs under a multi-folder prefix', () => {
    expect(deriveEduSlugs(moduleDoc, [], 'Lens Edu/modules/Demo Module.md')).toEqual({
      isCourseMode: false,
      moduleSlug: 'demo-module',
    });
  });

  // Prevents: a course doc with no module-refs yet (new/empty course) being
  // classified as a module, shipping its course slug as moduleSlug and
  // rendering a 404 link to /module/<course-slug>.
  it('returns no moduleSlug for a course doc without module refs', () => {
    expect(deriveEduSlugs(emptyCourseDoc, [], '/courses/Demo Course.md')).toEqual({
      isCourseMode: false,
      moduleSlug: undefined,
    });
  });

  // Prevents: any slugged doc outside a modules folder (notes, drafts)
  // producing a /module/<slug> link to a page that doesn't exist.
  it('returns no moduleSlug for docs outside a modules folder', () => {
    expect(deriveEduSlugs(moduleDoc, [], '/notes/foo.md')).toEqual({
      isCourseMode: false,
      moduleSlug: undefined,
    });
  });

  // Prevents: course mode with the selected module doc not yet connected
  // inventing a moduleSlug from the course doc's own frontmatter.
  it('returns no moduleSlug in course mode before the module doc loads', () => {
    expect(deriveEduSlugs(courseDoc, [], '/courses/Demo Course.md')).toEqual({
      isCourseMode: true,
      courseSlug: 'demo-course',
      moduleSlug: undefined,
    });
  });
});
