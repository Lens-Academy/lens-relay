import type { Section } from '../SectionEditor/parseSections';
import { getFrontmatterField } from '../../lib/parseFields';

/**
 * Course/module classification and frontmatter slugs for course-scoped
 * platform links.
 *
 * A doc with module-ref sections is a course: its own slug is the course slug
 * and the module slug comes from the selected module doc (undefined until that
 * doc has loaded). Otherwise the doc's slug counts as a module slug only when
 * the doc lives in a modules folder — an empty course, or any other slugged
 * doc, must not produce /module/<slug> links.
 */
export function deriveEduSlugs(
  docSections: Section[],
  selectedModuleSections: Section[],
  sourcePath: string | undefined,
): { isCourseMode: boolean; courseSlug?: string; moduleSlug?: string } {
  const isCourseMode = docSections.some(s => s.type === 'module-ref');
  if (isCourseMode) {
    return {
      isCourseMode,
      courseSlug: getFrontmatterField(docSections, 'slug'),
      moduleSlug: getFrontmatterField(selectedModuleSections, 'slug'),
    };
  }
  const isModuleDoc = sourcePath?.split('/').includes('modules') ?? false;
  return {
    isCourseMode,
    moduleSlug: isModuleDoc ? getFrontmatterField(docSections, 'slug') : undefined,
  };
}
