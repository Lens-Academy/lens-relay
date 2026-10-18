import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import * as Y from 'yjs';
import { NavigationContext } from '../../contexts/NavigationContext';
import { __embedDocsTesting } from '../../lib/embed-docs';
import { MAX_ANCESTORS, MAX_CHILD_CANDIDATES, MAX_COUNT_FILES } from '../../lib/concept-graph';
import { useConceptGraph } from './useConceptGraph';

afterEach(() => {
  __embedDocsTesting.reset();
});

const md = (id: string) => ({ id, type: 'markdown' as const, version: 0 });
const fm = (...parents: string[]) =>
  `---\nparent-concepts:\n${parents.map((p) => `  - "[[${p}]]"`).join('\n')}\n---\n# x\n`;

describe('useConceptGraph', () => {
  it('reads ancestors level by level, keeps only real children, and walks below', async () => {
    // tm ⊂ low ⊂ protocols ⊂ control, tm ⊂ mon; high links low in its text only;
    // an article links low.
    const texts: Record<string, string> = {
      control: '# AI Control\n',
      protocols: fm('AI Control'),
      mon: '# Monitoring\n',
      tm: fm('Low-stakes control', 'Monitoring'),
      high: `${fm('Control protocols')}Contrast [[Low-stakes control]].\n`,
    };
    __embedDocsTesting.setReader(async (fullId) => {
      const id = Object.keys(texts).find((k) => fullId.endsWith(`-${k}`));
      return id ? texts[id] : '';
    });
    const folder = new Y.Doc();
    const backlinks = folder.getMap<string[]>('backlinks_v0');
    backlinks.set('low', ['tm', 'high', 'article']);
    backlinks.set('protocols', ['low', 'high']);
    backlinks.set('control', ['protocols']);
    backlinks.set('mon', ['tm']);
    const metadata = {
      '/Lens Edu/Concepts/AI Control.md': md('control'),
      '/Lens Edu/Concepts/Control protocols.md': md('protocols'),
      '/Lens Edu/Concepts/Low-stakes control.md': md('low'),
      '/Lens Edu/Concepts/High-stakes control.md': md('high'),
      '/Lens Edu/Concepts/Monitoring.md': md('mon'),
      '/Lens Edu/Concepts/Trusted monitoring.md': md('tm'),
      '/Lens Edu/articles/a.md': md('article'),
    };
    const wrapper = ({ children }: { children: ReactNode }) => createElement(NavigationContext.Provider, {
      value: { metadata, folderDocs: new Map([['Lens Edu', folder]]), folderNames: ['Lens Edu'], errors: new Map(), onNavigate: vi.fn(), justCreatedRef: { current: false } },
    }, children);
    const ytext = new Y.Doc().getText('contents');
    ytext.insert(0, fm('Control protocols'));

    const { result } = renderHook(
      () => useConceptGraph('low', '/Lens Edu/Concepts/Low-stakes control.md', ytext, true),
      { wrapper },
    );
    await waitFor(() => expect(result.current.ancestors.main).toEqual(['control', 'protocols']));
    await waitFor(() => expect(result.current.below.counts.has('tm')).toBe(true));
    expect(result.current.below.children).toEqual(['tm']); // not high (text link), not the article
    expect(result.current.below.counts.get('tm')).toEqual({ count: 0, more: false });

    // Typing outside the frontmatter keeps the same parents object (no recompute).
    const before = result.current.own;
    ytext.insert(ytext.length, 'More text.\n');
    await new Promise((r) => setTimeout(r, 10));
    expect(result.current.own).toBe(before);

    // The opened file's parents follow its live text.
    ytext.insert(ytext.toString().indexOf('---\n# x'), '  - "[[Monitoring]]"\n');
    await waitFor(() => expect(result.current.own.parents).toEqual(['protocols', 'mon']));
    expect(new Set(result.current.ancestors.nodes)).toEqual(new Set(['protocols', 'control', 'mon']));
  });

  it('reads a capped number of files in a large folder, and nothing below while collapsed', async () => {
    // 300 concepts under "hub", each with 3 children of its own.
    const texts = new Map<string, string>();
    const metadata: Record<string, ReturnType<typeof md>> = { '/Lens Edu/Concepts/Hub.md': md('hub') };
    const folder = new Y.Doc();
    const backlinks = folder.getMap<string[]>('backlinks_v0');
    const spokes: string[] = [];
    for (let i = 0; i < 300; i++) {
      const s = `s${i}`;
      spokes.push(s);
      metadata[`/Lens Edu/Concepts/S${i}.md`] = md(s);
      texts.set(s, fm('Hub'));
      const kids: string[] = [];
      for (let j = 0; j < 3; j++) {
        const k = `k${i}_${j}`;
        kids.push(k);
        metadata[`/Lens Edu/Concepts/K${i}_${j}.md`] = md(k);
        texts.set(k, fm(`S${i}`));
      }
      backlinks.set(s, kids);
    }
    backlinks.set('hub', spokes);
    const read = new Set<string>();
    __embedDocsTesting.setReader(async (fullId) => {
      const key = fullId.slice(fullId.lastIndexOf('-') + 1);
      read.add(key);
      return texts.get(key) ?? '';
    });
    const wrapper = ({ children }: { children: ReactNode }) => createElement(NavigationContext.Provider, {
      value: { metadata, folderDocs: new Map([['Lens Edu', folder]]), folderNames: ['Lens Edu'], errors: new Map(), onNavigate: vi.fn(), justCreatedRef: { current: false } },
    }, children);
    const ytext = new Y.Doc().getText('contents');
    ytext.insert(0, '# Hub\n');

    const collapsed = renderHook(() => useConceptGraph('hub', '/Lens Edu/Concepts/Hub.md', ytext, false), { wrapper });
    await new Promise((r) => setTimeout(r, 50));
    expect(read.size).toBe(0);
    collapsed.unmount();

    const { result } = renderHook(() => useConceptGraph('hub', '/Lens Edu/Concepts/Hub.md', ytext, true), { wrapper });
    await waitFor(() => expect(result.current.below.pendingCounts).toBe(0));
    await waitFor(() => expect(result.current.below.counts.size).toBeGreaterThan(0));
    expect(result.current.below.candidatesCut).toBe(300 - MAX_CHILD_CANDIDATES);
    expect(result.current.below.children).toHaveLength(MAX_CHILD_CANDIDATES);
    expect(read.size).toBe(MAX_CHILD_CANDIDATES + MAX_COUNT_FILES);
    expect(read.size).toBeLessThanOrEqual(MAX_ANCESTORS + MAX_CHILD_CANDIDATES + MAX_COUNT_FILES);
    // 80 children, 50 count files: the first 50 are counted from one file each, the rest are "+?".
    expect([...result.current.below.counts.values()].filter((c) => c.count === null)).toHaveLength(MAX_CHILD_CANDIDATES - MAX_COUNT_FILES);
  });
});
