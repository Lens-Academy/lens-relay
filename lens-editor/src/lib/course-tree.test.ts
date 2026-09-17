import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import {
  courseChildrenFromText,
  findCourseAncestors,
  firstWikilink,
  leadingWikilink,
  isCoursePath,
  listCourses,
} from './course-tree';
import type { FolderMetadata } from '../hooks/useFolderMetadata';

const md = (id: string) => ({ id, type: 'markdown' as const, version: 0 });

const metadata: FolderMetadata = {
  '/Lens Edu/courses/Demo Course.md': md('c1'),
  '/Lens Edu/courses/Other Course.md': md('c2'),
  '/Lens Edu/_trash/courses/Old Course.md': md('c9'),
  '/Lens Edu/modules/Demo Module.md': md('m1'),
  '/Lens Edu/Lenses/Demo Lens.md': md('l1'),
  '/Lens Edu/Learning Outcomes/Demo Outcome.md': md('o1'),
  '/Lens Edu/articles/demo-article.md': md('a1'),
  '/Lens Edu/surveys/Demo Survey.md': md('s1'),
  '/Lens Edu Private/courses/Private Course.md': md('c3'),
  '/Lens/Welcome.md': md('w1'),
};

describe('wikilink helpers', () => {
  it('takes the first link and drops the embed bang', () => {
    expect(firstWikilink('![[../modules/A|Alias]] {>>note<<}')).toBe('[[../modules/A|Alias]]');
    expect(firstWikilink('no link')).toBeNull();
  });

  it('leadingWikilink ignores links buried in prose but not comments in front', () => {
    expect(leadingWikilink('  [[../surveys/S]] {>>c<<}')).toBe('[[../surveys/S]]');
    expect(leadingWikilink('{>>check<<} [[../surveys/S]]')).toBe('[[../surveys/S]]');
    expect(leadingWikilink('Read [[../Lenses/X]] first')).toBeNull();
  });
});

describe('listCourses', () => {
  it('finds courses/*.md in every shared folder, skipping the trash', () => {
    expect(isCoursePath('/Lens Edu/_trash/courses/Old Course.md')).toBe(false);
    const courses = listCourses(metadata);
    expect(courses.map(c => c.label)).toEqual(['Demo Course', 'Other Course', 'Private Course']);
    expect(courses[0]).toMatchObject({ kind: 'course', uuid: 'c1', path: '/Lens Edu/courses/Demo Course.md' });
  });
});

describe('courseChildrenFromText', () => {
  it('turns a course file into module and meeting nodes with their survey links', () => {
    const text = `---
slug: demo
---
application-survey:: [[../surveys/Demo Survey]]

# Module: [[../modules/Demo Module|Demo Module]]

# Meeting: Kick-off
meeting-doc-template:: https://docs.google.com/x
survey:: {>>check<<} [[../surveys/Demo Survey#top]] {>>comment<<}

# Module: [[../modules/Missing Module]]
`;
    const nodes = courseChildrenFromText(text, '/Lens Edu/courses/Demo Course.md', metadata);
    expect(nodes.map(n => [n.kind, n.field ?? null, n.label, n.uuid ?? null, !!n.unresolved])).toEqual([
      ['link', 'application-survey', 'Demo Survey', 's1', false],
      ['module', null, 'Demo Module', 'm1', false],
      ['meeting', null, 'Kick-off', null, false],
      ['module', null, 'Missing Module', null, true],
    ]);
    expect(nodes[2].children.map(n => [n.field, n.uuid])).toEqual([['survey', 's1']]);
  });

  it('turns a module into lens and outcome nodes, nesting an inline lens over its article', () => {
    const text = `---
title: Demo Module
---

# Lens: Welcome
id:: abc

#### Text
content::
Hello, see [[../Lenses/Demo Lens]] later.

#### Article
source:: [[../articles/demo-article]]

# Lens:
optional:: true
source:: ![[../Lenses/Demo Lens]]

# Learning Outcome:
source:: ![[../Learning Outcomes/Demo Outcome]]

# Lens: Empty inline

# Page: Video overview
source:: [[../articles/demo-article]]
`;
    const nodes = courseChildrenFromText(text, '/Lens Edu/modules/Demo Module.md', metadata);
    expect(nodes.map(n => [n.kind, n.label, n.uuid ?? null])).toEqual([
      ['lens', 'Welcome', null],
      ['lens', 'Demo Lens', 'l1'],
      ['outcome', 'Demo Outcome', 'o1'],
      ['page', 'Video overview', 'a1'],
    ]);
    expect(nodes[0].children.map(n => [n.kind, n.uuid])).toEqual([['article', 'a1']]);
  });

  it('groups an outcome\'s suggested lenses under their heading and keeps the test out', () => {
    const text = `---
learning-outcome: "Explain X"
---

## Test:
What is X?

# Suggested Lenses:
## Lens:
source:: [[../Lenses/Demo Lens]]
`;
    const nodes = courseChildrenFromText(text, '/Lens Edu/Learning Outcomes/Demo Outcome.md', metadata);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({ kind: 'group', label: 'Suggested Lenses' });
    expect(nodes[0].children.map(n => [n.kind, n.uuid])).toEqual([['lens', 'l1']]);
  });

  it('returns nothing for a leaf article', () => {
    expect(courseChildrenFromText('---\ntitle: A\n---\n\nPlain prose with [[../Lenses/Demo Lens]].', '/Lens Edu/articles/demo-article.md', metadata)).toEqual([]);
  });
});

describe('findCourseAncestors', () => {
  function folderDoc(backlinks: Record<string, string[]>): Y.Doc {
    const doc = new Y.Doc();
    const map = doc.getMap<string[]>('backlinks_v0');
    for (const [target, sources] of Object.entries(backlinks)) map.set(target, sources);
    return doc;
  }

  it('collects every ancestor up to the course, including prose mentions', () => {
    const doc = folderDoc({ m1: ['c1'], l1: ['m1', 'o1'], o1: ['m1'], a1: ['l1', 'c2'] });
    expect(findCourseAncestors('a1', [doc], metadata)).toEqual(new Set(['a1', 'l1', 'c2', 'm1', 'o1', 'c1']));
    expect(findCourseAncestors('c1', [doc], metadata)).toEqual(new Set(['c1']));
  });

  it('ignores trashed sources and gives up when no course links in', () => {
    const doc = folderDoc({ m1: ['c9'], w1: [] });
    expect(findCourseAncestors('m1', [doc], metadata)).toBeNull();
    expect(findCourseAncestors('w1', [doc], metadata)).toBeNull();
    expect(findCourseAncestors('unknown', [doc], metadata)).toBeNull();
  });

  it('survives link cycles', () => {
    const doc = folderDoc({ m1: ['l1'], l1: ['m1'] });
    expect(findCourseAncestors('l1', [doc], metadata)).toBeNull();
  });
});
