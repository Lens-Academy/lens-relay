import path from 'node:path/posix';
import {
  parseModuleLinkEntries,
  parseSourceTargets,
} from '../add-article/eval/wikilink.ts';
import type {
  PromotionCurriculumIndex,
  PromotionCurriculumMembership,
  PromotionFileChange,
} from './types.ts';

export interface PromotionTreeSnapshot {
  paths: Set<string>;
  markdown: Map<string, string>;
}

interface ScopeGraph {
  courses: Map<string, { label: string; modulePaths: string[] }>;
  modules: Map<string, { label: string; coursePaths: Set<string> }>;
  memberships: Map<string, PromotionCurriculumMembership>;
}

function displayFilename(filePath: string): string {
  return path.basename(filePath).replace(/\.md$/i, '');
}

function frontmatterTitle(markdown: string | undefined): string | null {
  if (!markdown?.startsWith('---')) return null;
  const end = markdown.indexOf('\n---', 3);
  if (end === -1) return null;
  const match = markdown.slice(3, end).match(/^title:\s*(.+?)\s*$/m);
  if (!match) return null;
  const value = match[1].trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1).trim() || null;
  }
  return value || null;
}

/** Resolve Relay/Obsidian links into repository-relative paths. */
export function resolveCurriculumTarget(fromPath: string, rawTarget: string): string | null {
  let target = rawTarget.split('|')[0].trim().replace(/\\/g, '/');
  target = target.replace(/^\/+/, '');
  if (/^Lens Edu\//i.test(target)) target = target.slice('Lens Edu/'.length);
  if (!target) return null;

  const resolved = target.startsWith('../') || target.startsWith('./')
    ? path.normalize(path.join(path.dirname(fromPath), target))
    : path.normalize(target);
  if (!resolved || resolved === '.' || resolved === '..' || resolved.startsWith('../')) return null;
  if (/\.(?:md|json)$/i.test(resolved)) return resolved;
  return `${resolved}.md`;
}

function addMembership(
  memberships: Map<string, { coursePaths: Set<string>; modulePaths: Set<string> }>,
  filePath: string,
  coursePath?: string,
  modulePath?: string,
): void {
  const membership = memberships.get(filePath) ?? { coursePaths: new Set<string>(), modulePaths: new Set<string>() };
  if (coursePath) membership.coursePaths.add(coursePath);
  if (modulePath) membership.modulePaths.add(modulePath);
  memberships.set(filePath, membership);
}

function buildScopeGraph(snapshot: PromotionTreeSnapshot): ScopeGraph {
  const edges = new Map<string, Set<string>>();
  for (const [filePath, markdown] of snapshot.markdown) {
    const targets = new Set<string>();
    for (const rawTarget of parseSourceTargets(markdown)) {
      const target = resolveCurriculumTarget(filePath, rawTarget);
      if (!target || !snapshot.paths.has(target)) continue;
      targets.add(target);
      if (target.startsWith('video_transcripts/') && target.endsWith('.md')) {
        const timestampsPath = target.replace(/\.md$/i, '.timestamps.json');
        if (snapshot.paths.has(timestampsPath)) targets.add(timestampsPath);
      }
    }
    edges.set(filePath, targets);
  }

  const courseModules = new Map<string, { label: string; modules: Array<{ path: string; alias: string | null }> }>();
  for (const [coursePath, markdown] of snapshot.markdown) {
    if (!/^courses\/[^/]+\.md$/i.test(coursePath)) continue;
    const modules = parseModuleLinkEntries(markdown)
      .map(link => ({ path: resolveCurriculumTarget(coursePath, link.target), alias: link.alias }))
      .filter((entry): entry is { path: string; alias: string | null } => !!entry.path);
    courseModules.set(coursePath, {
      label: frontmatterTitle(markdown) ?? displayFilename(coursePath),
      modules,
    });
  }

  const rawMemberships = new Map<string, { coursePaths: Set<string>; modulePaths: Set<string> }>();
  const modules = new Map<string, { label: string; coursePaths: Set<string> }>();

  const descendants = (root: string): Set<string> => {
    const visited = new Set<string>();
    const pending = [root];
    while (pending.length > 0) {
      const current = pending.pop()!;
      if (visited.has(current) || !snapshot.paths.has(current)) continue;
      visited.add(current);
      for (const child of edges.get(current) ?? []) pending.push(child);
    }
    return visited;
  };

  for (const [coursePath, course] of courseModules) {
    addMembership(rawMemberships, coursePath, coursePath);
    for (const imported of descendants(coursePath)) addMembership(rawMemberships, imported, coursePath);

    for (const moduleEntry of course.modules) {
      const modulePath = moduleEntry.path;
      const moduleRecord = modules.get(modulePath) ?? {
        label: frontmatterTitle(snapshot.markdown.get(modulePath)) ?? moduleEntry.alias ?? displayFilename(modulePath),
        coursePaths: new Set<string>(),
      };
      moduleRecord.coursePaths.add(coursePath);
      modules.set(modulePath, moduleRecord);
      for (const imported of descendants(modulePath)) {
        addMembership(rawMemberships, imported, coursePath, modulePath);
      }
    }
  }

  const memberships = new Map<string, PromotionCurriculumMembership>();
  for (const [filePath, membership] of rawMemberships) {
    memberships.set(filePath, {
      coursePaths: [...membership.coursePaths].sort(),
      modulePaths: [...membership.modulePaths].sort(),
    });
  }

  return {
    courses: new Map([...courseModules].map(([coursePath, course]) => [coursePath, {
      label: course.label,
      modulePaths: course.modules.map(module => module.path),
    }])),
    modules,
    memberships,
  };
}

function unionMemberships(...memberships: Array<PromotionCurriculumMembership | undefined>): PromotionCurriculumMembership {
  const coursePaths = new Set<string>();
  const modulePaths = new Set<string>();
  for (const membership of memberships) {
    for (const coursePath of membership?.coursePaths ?? []) coursePaths.add(coursePath);
    for (const modulePath of membership?.modulePaths ?? []) modulePaths.add(modulePath);
  }
  return { coursePaths: [...coursePaths].sort(), modulePaths: [...modulePaths].sort() };
}

export function buildPromotionCurriculumIndex(
  staging: PromotionTreeSnapshot,
  production: PromotionTreeSnapshot,
  changes: PromotionFileChange[],
): PromotionCurriculumIndex {
  const stagingGraph = buildScopeGraph(staging);
  const productionGraph = buildScopeGraph(production);
  const renameMap = new Map(
    changes.filter(change => change.status === 'renamed' && change.oldPath)
      .map(change => [change.oldPath!, change.path]),
  );
  const canonical = (value: string) => renameMap.get(value) ?? value;

  const memberships: Record<string, PromotionCurriculumMembership> = {};
  const usedCourses = new Set<string>();
  const usedModules = new Set<string>();
  for (const change of changes) {
    const membership = change.status === 'deleted'
      ? productionGraph.memberships.get(change.path)
      : change.status === 'renamed'
        ? unionMemberships(
            stagingGraph.memberships.get(change.path),
            change.oldPath ? productionGraph.memberships.get(change.oldPath) : undefined,
          )
        : stagingGraph.memberships.get(change.path);
    if (!membership) continue;
    const normalized = {
      coursePaths: [...new Set(membership.coursePaths.map(canonical))].sort(),
      modulePaths: [...new Set(membership.modulePaths.map(canonical))].sort(),
    };
    if (normalized.coursePaths.length === 0 && normalized.modulePaths.length === 0) continue;
    memberships[change.path] = normalized;
    normalized.coursePaths.forEach(coursePath => usedCourses.add(coursePath));
    normalized.modulePaths.forEach(modulePath => usedModules.add(modulePath));
  }

  const courseRecord = (coursePath: string) => stagingGraph.courses.get(coursePath) ?? productionGraph.courses.get(coursePath);
  const moduleRecord = (modulePath: string) => stagingGraph.modules.get(modulePath) ?? productionGraph.modules.get(modulePath);

  return {
    courses: [...usedCourses].map(coursePath => {
      const course = courseRecord(coursePath);
      return {
        path: coursePath,
        label: course?.label ?? displayFilename(coursePath),
        modulePaths: [...new Set((course?.modulePaths ?? []).map(canonical).filter(modulePath => usedModules.has(modulePath)))].sort(),
      };
    }).sort((a, b) => a.label.localeCompare(b.label)),
    modules: [...usedModules].map(modulePath => {
      const module = moduleRecord(modulePath);
      return {
        path: modulePath,
        label: module?.label ?? displayFilename(modulePath),
        coursePaths: [...new Set([...(module?.coursePaths ?? [])].map(canonical).filter(coursePath => usedCourses.has(coursePath)))].sort(),
      };
    }).sort((a, b) => a.label.localeCompare(b.label)),
    memberships,
  };
}
