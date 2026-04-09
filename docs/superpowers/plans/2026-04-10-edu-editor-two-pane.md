# Edu Editor Two-Pane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current Edu Editor's "click LO to expand, click lens to edit" left nav with a two-pane layout where the left pane is a structural tree + inline LO-definition editor and the right pane is a generalized content editor that renders any lens, inline lens, or LO test as lens-like content.

**Architecture:** Add `level` to `Section`, introduce a pure `getSubtreeRange` helper, add a `useLODocs` hook that eagerly fetches every LO referenced by a module, extract the existing `LensPanel` section renderers into a new `ContentPanel` that accepts a `{ full-doc | subtree }` scope, and build a new `ModuleTreeEditor` that drives the right pane via a `ContentScope` selection state owned by `EduEditor`. Delete the obsolete `LensPanel` and `ModulePanel`.

**Tech Stack:** React 19, vitest, `@testing-library/react`, Y.Doc via `@y-sweet/client`, CodeMirror 6, TypeScript, Tailwind.

**Design reference:** `docs/superpowers/specs/2026-04-10-edu-editor-editable-nav-design.md`

**Testing style:** Unit+1 (shallow integration). Use real `Y.Doc` and `Y.Text` instances. Mock `useDocConnection` at the module level (following the existing pattern in `src/components/SectionEditor/useMultiDocSections.test.ts`). Never assert on mock behavior.

**Version control:** This repo uses non-colocated `jj`. Each task ends with `jj commit -m "..."` which describes the current working-copy change and starts a new empty change. Run `jj st` before each commit to sanity-check the diff.

---

## File Structure

**Create:**
- `src/components/EduEditor/getSubtreeRange.ts` — pure helper that computes `[from, toExclusive)` section indices for a subtree rooted at a given index, based on heading level.
- `src/components/EduEditor/getSubtreeRange.test.ts`
- `src/components/EduEditor/useLODocs.ts` — React hook; eagerly connects to every LO referenced by a module's sections, observes each LO's `contents` Y.Text, returns a keyed map.
- `src/components/EduEditor/useLODocs.test.ts`
- `src/components/EduEditor/ContentPanel.tsx` — generalized right-pane editor; accepts `ContentScope`.
- `src/components/EduEditor/ContentPanel.test.tsx`
- `src/components/EduEditor/ContentPanel/renderers/TextRenderer.tsx`
- `src/components/EduEditor/ContentPanel/renderers/ChatRenderer.tsx`
- `src/components/EduEditor/ContentPanel/renderers/VideoRenderer.tsx`
- `src/components/EduEditor/ContentPanel/renderers/ArticleRenderer.tsx`
- `src/components/EduEditor/ContentPanel/renderers/QuestionRenderer.tsx`
- `src/components/EduEditor/ContentPanel/renderers/HeadingRenderer.tsx`
- `src/components/EduEditor/ContentPanel/renderers/index.ts`
- `src/components/EduEditor/ModuleTreeEditor.tsx` — left pane.
- `src/components/EduEditor/ModuleTreeEditor.test.tsx`
- `src/components/EduEditor/ModuleTreeEditor/ModuleHeader.tsx`
- `src/components/EduEditor/ModuleTreeEditor/LoCard.tsx`
- `src/components/EduEditor/ModuleTreeEditor/LoDefinition.tsx`
- `src/components/EduEditor/ModuleTreeEditor/TreeEntry.tsx`

**Modify:**
- `src/components/SectionEditor/parseSections.ts` — add `level: number` to the `Section` interface and populate it.
- `src/components/SectionEditor/parseSections.test.ts` — add assertions on `level`.
- `src/components/EduEditor/EduEditor.tsx` — swap panels, own `ContentScope | null` selection state.

**Delete:**
- `src/components/EduEditor/LensPanel.tsx`
- `src/components/EduEditor/ModulePanel.tsx`

---

## Task 1: Add `level` to Section

**Files:**
- Modify: `src/components/SectionEditor/parseSections.ts`
- Modify: `src/components/SectionEditor/parseSections.test.ts`

- [ ] **Step 1: Write the failing test**

Add this test to `src/components/SectionEditor/parseSections.test.ts` at the end of the `describe('parseSections', ...)` block:

```ts
  it('assigns heading level to each section', () => {
    const text =
      '---\nid: x\n---\n' +
      '# Lens: Welcome\n' +
      '#### Text\ncontent::\nhi\n' +
      '# Learning Outcome:\nsource:: foo\n' +
      '## Submodule: A\n' +
      '## Lens:\nsource:: bar\n';
    const sections = parseSections(text);
    const byType: Record<string, number> = {};
    sections.forEach(s => { byType[s.type] = s.level; });
    expect(sections[0].type).toBe('frontmatter');
    expect(sections[0].level).toBe(0);
    expect(byType['lens-ref']).toBe(1); // first lens-ref occurrence (# Lens: Welcome)
    expect(sections.find(s => s.type === 'text')?.level).toBe(4);
    expect(sections.find(s => s.type === 'lo-ref')?.level).toBe(1);
    expect(sections.find(s => s.type === 'submodule')?.level).toBe(2);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd lens-editor && npx vitest run src/components/SectionEditor/parseSections.test.ts`
Expected: FAIL with `Property 'level' does not exist on type 'Section'` (compile error), or an `undefined` comparison failing the assertion.

- [ ] **Step 3: Add `level` field to the Section interface and populate it**

In `src/components/SectionEditor/parseSections.ts`, modify the `Section` interface (lines 9–20):

```ts
export interface Section {
  /** Section type: 'frontmatter', 'video', 'text', 'chat', 'heading', or 'unknown' */
  type: string;
  /** Human-readable label */
  label: string;
  /** Heading level (1–4). 0 for frontmatter and body. */
  level: number;
  /** Start character offset (inclusive) */
  from: number;
  /** End character offset (exclusive) */
  to: number;
  /** The raw text content of this section */
  content: string;
}
```

In the same file, set `level: 0` when pushing the frontmatter section:

```ts
      sections.push({
        type: 'frontmatter',
        label: 'Frontmatter',
        level: 0,
        from: 0,
        to,
        content: text.slice(0, to),
      });
```

Set `level: 0` when pushing the body-only branch (no headers case):

```ts
      sections.push({
        type: 'body',
        label: 'Content',
        level: 0,
        from: pos,
        to: text.length,
        content: text.slice(pos, text.length),
      });
```

Set `level: 0` when pushing the gap-before-first-header body section:

```ts
      sections.push({
        type: 'body',
        label: 'Content',
        level: 0,
        from: pos,
        to: headers[0].from,
        content: text.slice(pos, headers[0].from),
      });
```

Set `level: header.level` when pushing header-derived sections (around line 116):

```ts
    sections.push({
      type,
      label,
      level: header.level,
      from: header.from,
      to: nextFrom,
      content: sectionContent,
    });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd lens-editor && npx vitest run src/components/SectionEditor/parseSections.test.ts`
Expected: PASS all tests.

- [ ] **Step 5: Run full typecheck to ensure nothing else broke**

Run: `cd lens-editor && npx tsc --noEmit`
Expected: clean output (no errors).

- [ ] **Step 6: Commit**

```bash
jj st
cd /home/penguin/code/lens-relay/ws3 && jj commit -m "feat(edu-editor): add level field to parsed sections"
```

---

## Task 2: Pure `getSubtreeRange` helper

**Files:**
- Create: `lens-editor/src/components/EduEditor/getSubtreeRange.ts`
- Create: `lens-editor/src/components/EduEditor/getSubtreeRange.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `lens-editor/src/components/EduEditor/getSubtreeRange.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { getSubtreeRange } from './getSubtreeRange';
import type { Section } from '../SectionEditor/parseSections';

function section(level: number, type = 'heading', label = ''): Section {
  return { type, label, level, from: 0, to: 0, content: '' };
}

describe('getSubtreeRange', () => {
  it('returns [index, index+1) for a leaf with no children', () => {
    const sections = [section(1), section(1)];
    expect(getSubtreeRange(sections, 0)).toEqual([0, 1]);
  });

  it('includes strictly deeper siblings as children', () => {
    // # Lens: Welcome (level 1)
    //   #### Text      (level 4)
    //   #### Question  (level 4)
    // # Learning Outcome:  (level 1)
    const sections = [section(1), section(4), section(4), section(1)];
    expect(getSubtreeRange(sections, 0)).toEqual([0, 3]);
  });

  it('stops at a same-level sibling', () => {
    // ## Lens (2)
    //   #### Text (4)
    // ## Test (2)
    const sections = [section(2), section(4), section(2)];
    expect(getSubtreeRange(sections, 0)).toEqual([0, 2]);
  });

  it('stops at a shallower sibling', () => {
    // ## Test (2)
    //   #### Question (4)
    // # Learning Outcome (1)
    const sections = [section(2), section(4), section(1)];
    expect(getSubtreeRange(sections, 0)).toEqual([0, 2]);
  });

  it('runs to the end when no later sibling exists', () => {
    const sections = [section(1), section(4), section(4)];
    expect(getSubtreeRange(sections, 0)).toEqual([0, 3]);
  });

  it('handles a root at the last index', () => {
    const sections = [section(1), section(1)];
    expect(getSubtreeRange(sections, 1)).toEqual([1, 2]);
  });

  it('ignores deeper sections when root is already deep', () => {
    // # (1)
    // ## (2)  <- root here
    // #### (4)
    // ## (2)
    const sections = [section(1), section(2), section(4), section(2)];
    expect(getSubtreeRange(sections, 1)).toEqual([1, 3]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd lens-editor && npx vitest run src/components/EduEditor/getSubtreeRange.test.ts`
Expected: FAIL with "Cannot find module './getSubtreeRange'".

- [ ] **Step 3: Implement `getSubtreeRange`**

Create `lens-editor/src/components/EduEditor/getSubtreeRange.ts`:

```ts
import type { Section } from '../SectionEditor/parseSections';

/**
 * Given a flat list of sections and the index of a root section,
 * return [from, toExclusive) covering the root and all descendants —
 * i.e., every following section whose level is strictly greater than
 * the root's level, until the first section with level <= root's level.
 */
export function getSubtreeRange(
  sections: Section[],
  rootIndex: number,
): [number, number] {
  const root = sections[rootIndex];
  const rootLevel = root.level;
  let end = rootIndex + 1;
  while (end < sections.length && sections[end].level > rootLevel) {
    end++;
  }
  return [rootIndex, end];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd lens-editor && npx vitest run src/components/EduEditor/getSubtreeRange.test.ts`
Expected: PASS all 7 cases.

- [ ] **Step 5: Commit**

```bash
jj st
cd /home/penguin/code/lens-relay/ws3 && jj commit -m "feat(edu-editor): add getSubtreeRange helper"
```

---

## Task 3: `useLODocs` hook

**Files:**
- Create: `lens-editor/src/components/EduEditor/useLODocs.ts`
- Create: `lens-editor/src/components/EduEditor/useLODocs.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `lens-editor/src/components/EduEditor/useLODocs.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import * as Y from 'yjs';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { Section } from '../SectionEditor/parseSections';
import { RELAY_ID } from '../../lib/constants';

const mockConnections = new Map<string, { doc: Y.Doc; provider: { destroy: () => void } }>();

vi.mock('../../hooks/useDocConnection', () => ({
  useDocConnection: () => ({
    getOrConnect: vi.fn(async (docId: string) => {
      if (mockConnections.has(docId)) return mockConnections.get(docId)!;
      const doc = new Y.Doc();
      const provider = { destroy: vi.fn() };
      const conn = { doc, provider };
      mockConnections.set(docId, conn);
      return conn;
    }),
    disconnect: vi.fn(),
    disconnectAll: vi.fn(),
  }),
}));

vi.mock('../../contexts/NavigationContext', () => ({
  useNavigation: () => ({
    metadata: {
      'modules/cognitive.md': { id: 'fc1c3de9-6429-45fd-913f-76a032180d50' },
      'Learning Outcomes/LO-One.md': { id: 'lo-one-uuid' },
      'Learning Outcomes/LO-Two.md': { id: 'lo-two-uuid' },
    },
  }),
}));

// Import after mocks are set up
const { useLODocs } = await import('./useLODocs');

function seedLODoc(uuid: string, contents: string) {
  const doc = new Y.Doc();
  doc.getText('contents').insert(0, contents);
  mockConnections.set(`${RELAY_ID}-${uuid}`, {
    doc,
    provider: { destroy: vi.fn() },
  });
  return doc;
}

function loRef(source: string): Section {
  return {
    type: 'lo-ref',
    label: 'Learning Outcome',
    level: 1,
    from: 0,
    to: 0,
    content: `# Learning Outcome:\nsource:: ${source}\n`,
  };
}

afterEach(() => { mockConnections.clear(); });

describe('useLODocs', () => {
  it('returns empty when module has no LO refs', async () => {
    const { result } = renderHook(() => useLODocs([], 'modules/cognitive.md'));
    expect(result.current).toEqual({});
  });

  it('fetches each LO referenced by the module', async () => {
    seedLODoc('lo-one-uuid', '---\nlearning-outcome: "Explain X"\n---\n## Lens:\nsource:: [[../Lenses/A]]\n');
    seedLODoc('lo-two-uuid', '---\nlearning-outcome: "Analyze Y"\n---\n## Test:\n');

    const sections: Section[] = [
      loRef('[[../Learning Outcomes/LO-One]]'),
      loRef('[[../Learning Outcomes/LO-Two]]'),
    ];

    const { result } = renderHook(() => useLODocs(sections, 'modules/cognitive.md'));

    await waitFor(() => {
      expect(Object.keys(result.current).sort()).toEqual(['lo-one-uuid', 'lo-two-uuid']);
    });

    expect(result.current['lo-one-uuid'].title).toBe('LO-One');
    expect(result.current['lo-one-uuid'].sections.length).toBeGreaterThan(0);
    expect(result.current['lo-one-uuid'].frontmatter.get('learning-outcome')).toBe('Explain X');
  });

  it('updates when an LO\'s Y.Text changes', async () => {
    const doc = seedLODoc('lo-one-uuid', '---\nlearning-outcome: "Old"\n---\n');

    const sections: Section[] = [loRef('[[../Learning Outcomes/LO-One]]')];

    const { result } = renderHook(() => useLODocs(sections, 'modules/cognitive.md'));

    await waitFor(() => {
      expect(result.current['lo-one-uuid']?.frontmatter.get('learning-outcome')).toBe('Old');
    });

    act(() => {
      const text = doc.getText('contents');
      text.delete(0, text.length);
      text.insert(0, '---\nlearning-outcome: "New definition"\n---\n');
    });

    await waitFor(() => {
      expect(result.current['lo-one-uuid'].frontmatter.get('learning-outcome')).toBe('New definition');
    });
  });

  it('deduplicates when multiple refs resolve to the same LO uuid', async () => {
    seedLODoc('lo-one-uuid', '---\nlearning-outcome: "X"\n---\n');

    const sections: Section[] = [
      loRef('[[../Learning Outcomes/LO-One]]'),
      loRef('[[../Learning Outcomes/LO-One]]'),
    ];

    const { result } = renderHook(() => useLODocs(sections, 'modules/cognitive.md'));

    await waitFor(() => {
      expect(Object.keys(result.current)).toEqual(['lo-one-uuid']);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd lens-editor && npx vitest run src/components/EduEditor/useLODocs.test.ts`
Expected: FAIL with "Cannot find module './useLODocs'".

- [ ] **Step 3: Implement the hook**

Create `lens-editor/src/components/EduEditor/useLODocs.ts`:

```ts
import { useEffect, useState, useRef } from 'react';
import * as Y from 'yjs';
import type { Section } from '../SectionEditor/parseSections';
import { parseSections } from '../SectionEditor/parseSections';
import { parseFields, parseFrontmatterFields } from '../../lib/parseFields';
import { resolveWikilinkToUuid } from '../../lib/resolveDocPath';
import { useDocConnection } from '../../hooks/useDocConnection';
import { useNavigation } from '../../contexts/NavigationContext';
import { RELAY_ID } from '../../lib/constants';

export interface LODocEntry {
  loPath: string;
  sections: Section[];
  frontmatter: Map<string, string>;
  title: string;
}

export function useLODocs(
  moduleSections: Section[],
  modulePath: string,
): Record<string, LODocEntry> {
  const { getOrConnect } = useDocConnection();
  const { metadata } = useNavigation();
  const [docs, setDocs] = useState<Record<string, LODocEntry>>({});
  const observersRef = useRef<Map<string, { ytext: Y.Text; handler: () => void }>>(new Map());

  // Collect unique uuids referenced by lo-ref sections in the module
  const uuids: string[] = [];
  for (const section of moduleSections) {
    if (section.type !== 'lo-ref') continue;
    const fields = parseFields(section.content);
    const sourceField = fields.get('source');
    if (!sourceField) continue;
    const uuid = resolveWikilinkToUuid(sourceField.trim(), modulePath, metadata);
    if (uuid && !uuids.includes(uuid)) uuids.push(uuid);
  }
  const uuidsKey = uuids.join('|');

  useEffect(() => {
    let cancelled = false;

    async function load() {
      for (const uuid of uuids) {
        if (cancelled) return;
        const compoundId = `${RELAY_ID}-${uuid}`;
        const { doc } = await getOrConnect(compoundId);
        if (cancelled) return;

        const ytext = doc.getText('contents');

        // Build initial entry and publish it
        const update = () => {
          const text = ytext.toString();
          const sections = parseSections(text);
          const fmSection = sections.find(s => s.type === 'frontmatter');
          const frontmatter = fmSection
            ? parseFrontmatterFields(fmSection.content)
            : new Map<string, string>();
          const loPath =
            Object.entries(metadata).find(([, m]) => m.id === uuid)?.[0] ?? '';
          const title = titleFromPath(loPath);
          setDocs(prev => ({ ...prev, [uuid]: { loPath, sections, frontmatter, title } }));
        };

        update();
        ytext.observe(update);

        // Save observer so we can tear it down on unmount or uuids change
        const prev = observersRef.current.get(uuid);
        if (prev) prev.ytext.unobserve(prev.handler);
        observersRef.current.set(uuid, { ytext, handler: update });
      }

      // Remove observers and entries for uuids no longer present
      if (cancelled) return;
      const activeSet = new Set(uuids);
      for (const [uuid, { ytext, handler }] of observersRef.current.entries()) {
        if (!activeSet.has(uuid)) {
          ytext.unobserve(handler);
          observersRef.current.delete(uuid);
          setDocs(prev => {
            const next = { ...prev };
            delete next[uuid];
            return next;
          });
        }
      }
    }

    load();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uuidsKey, modulePath]);

  useEffect(() => {
    return () => {
      for (const { ytext, handler } of observersRef.current.values()) {
        ytext.unobserve(handler);
      }
      observersRef.current.clear();
    };
  }, []);

  return docs;
}

function titleFromPath(path: string): string {
  if (!path) return 'Learning Outcome';
  const file = path.split('/').pop() ?? path;
  return file.replace(/\.md$/, '');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd lens-editor && npx vitest run src/components/EduEditor/useLODocs.test.ts`
Expected: PASS all 4 cases.

- [ ] **Step 5: Run typecheck**

Run: `cd lens-editor && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
jj st
cd /home/penguin/code/lens-relay/ws3 && jj commit -m "feat(edu-editor): add useLODocs hook"
```

---

## Task 4: Extract section renderers

**Files:**
- Create: `lens-editor/src/components/EduEditor/ContentPanel/renderers/TextRenderer.tsx`
- Create: `lens-editor/src/components/EduEditor/ContentPanel/renderers/ChatRenderer.tsx`
- Create: `lens-editor/src/components/EduEditor/ContentPanel/renderers/VideoRenderer.tsx`
- Create: `lens-editor/src/components/EduEditor/ContentPanel/renderers/ArticleRenderer.tsx`
- Create: `lens-editor/src/components/EduEditor/ContentPanel/renderers/QuestionRenderer.tsx`
- Create: `lens-editor/src/components/EduEditor/ContentPanel/renderers/HeadingRenderer.tsx`
- Create: `lens-editor/src/components/EduEditor/ContentPanel/renderers/index.ts`

This task is a pure extraction with no new behavior; the tests that validate it come in Task 5 (`ContentPanel` rendering a full lens doc must match the old `LensPanel` output). We still commit here to keep the refactor atomic.

- [ ] **Step 1: Create `TextRenderer.tsx`**

```tsx
import ReactMarkdown from 'react-markdown';

interface TextRendererProps {
  content: string;
  onStartEdit: () => void;
}

export function TextRenderer({ content, onStartEdit }: TextRendererProps) {
  return (
    <div
      className="mb-7 relative group cursor-pointer hover:outline hover:outline-2 hover:outline-blue-300/30 hover:outline-offset-1 rounded-md"
      onClick={onStartEdit}
    >
      <div className="absolute -top-2 -right-2 bg-blue-500 text-white text-[10px] px-2 py-0.5 rounded font-medium opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
        click to edit
      </div>
      <div
        className="text-[15px] leading-[1.75] text-gray-900 prose prose-sm max-w-none"
        style={{ fontFamily: "'DM Sans', sans-serif" }}
      >
        <ReactMarkdown>{content}</ReactMarkdown>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Create `ChatRenderer.tsx`**

```tsx
import { TutorInstructions } from '../../TutorInstructions';

interface ChatRendererProps {
  title: string;
  instructions: string;
  onStartEdit: () => void;
}

export function ChatRenderer({ title, instructions, onStartEdit }: ChatRendererProps) {
  return <TutorInstructions title={title} instructions={instructions} onEdit={onStartEdit} />;
}
```

- [ ] **Step 3: Create `VideoRenderer.tsx`**

```tsx
import { VideoExcerptEmbed } from '../../VideoExcerptEmbed';

interface VideoRendererProps {
  fromTime?: string;
  toTime?: string;
  videoSourceWikilink: string;
  lensSourcePath: string;
}

export function VideoRenderer(props: VideoRendererProps) {
  return <VideoExcerptEmbed {...props} />;
}
```

- [ ] **Step 4: Create `ArticleRenderer.tsx`**

```tsx
import { ArticleEmbed } from '../../ArticleEmbed';

interface ArticleRendererProps {
  fromAnchor?: string;
  toAnchor?: string;
  articleSourceWikilink: string;
  lensSourcePath: string;
}

export function ArticleRenderer(props: ArticleRendererProps) {
  return <ArticleEmbed {...props} />;
}
```

- [ ] **Step 5: Create `QuestionRenderer.tsx`**

```tsx
interface QuestionRendererProps {
  content: string;
  assessmentInstructions?: string;
  enforceVoice?: string;
  maxChars?: string;
  onStartEdit: () => void;
}

export function QuestionRenderer({
  content,
  assessmentInstructions,
  enforceVoice,
  maxChars,
  onStartEdit,
}: QuestionRendererProps) {
  return (
    <div
      className="mb-7 p-4 bg-white rounded-lg border border-[#e8e5df] relative group cursor-pointer hover:outline hover:outline-2 hover:outline-blue-300/30 hover:outline-offset-1"
      onClick={onStartEdit}
    >
      <div className="absolute -top-2 -right-2 bg-blue-500 text-white text-[10px] px-2 py-0.5 rounded font-medium opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
        click to edit
      </div>
      <div className="flex items-center gap-2 mb-2">
        <span className="text-[10px] uppercase tracking-wider text-orange-700 font-semibold">Question</span>
        {enforceVoice === 'true' && (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-100 text-purple-600">voice</span>
        )}
        {maxChars && (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-500">max {maxChars} chars</span>
        )}
      </div>
      <div className="text-sm text-gray-700 mb-2">{content}</div>
      {assessmentInstructions && (
        <div className="mt-2 pt-2 border-t border-gray-100">
          <div className="text-[10px] uppercase tracking-wider text-gray-400 font-semibold mb-1">Assessment Instructions</div>
          <div className="text-xs text-gray-500 leading-relaxed">{assessmentInstructions}</div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 6: Create `HeadingRenderer.tsx`**

```tsx
interface HeadingRendererProps {
  label: string;
  onStartEdit: () => void;
}

export function HeadingRenderer({ label, onStartEdit }: HeadingRendererProps) {
  return (
    <div
      className="mb-4 relative group cursor-pointer hover:outline hover:outline-2 hover:outline-blue-300/30 hover:outline-offset-1 rounded"
      onClick={onStartEdit}
    >
      <div className="absolute -top-2 -right-2 bg-blue-500 text-white text-[10px] px-2 py-0.5 rounded font-medium opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
        click to edit
      </div>
      <div style={{ fontFamily: "'Newsreader', serif", fontSize: '18px', fontWeight: 600, color: '#1a1a1a' }}>
        {label}
      </div>
    </div>
  );
}
```

- [ ] **Step 7: Create `index.ts` barrel**

```ts
export { TextRenderer } from './TextRenderer';
export { ChatRenderer } from './ChatRenderer';
export { VideoRenderer } from './VideoRenderer';
export { ArticleRenderer } from './ArticleRenderer';
export { QuestionRenderer } from './QuestionRenderer';
export { HeadingRenderer } from './HeadingRenderer';
```

- [ ] **Step 8: Typecheck**

Run: `cd lens-editor && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 9: Commit**

```bash
jj st
cd /home/penguin/code/lens-relay/ws3 && jj commit -m "refactor(edu-editor): extract section renderers"
```

---

## Task 5: `ContentPanel` with `full-doc` scope (replaces `LensPanel`)

**Files:**
- Create: `lens-editor/src/components/EduEditor/ContentPanel.tsx`
- Create: `lens-editor/src/components/EduEditor/ContentPanel.test.tsx`

`ContentPanel` consumes the renderers extracted in Task 4. This task covers only the `full-doc` scope (the existing `LensPanel` behavior) so the refactor is atomic. Subtree scope is added in Task 6.

- [ ] **Step 1: Write the failing test**

Create `lens-editor/src/components/EduEditor/ContentPanel.test.tsx`:

```tsx
import { describe, it, expect, vi, afterEach } from 'vitest';
import * as Y from 'yjs';
import { render, waitFor, screen } from '@testing-library/react';
import { NavigationContext } from '../../contexts/NavigationContext';
import { RELAY_ID } from '../../lib/constants';
import React from 'react';

const mockConnections = new Map<string, { doc: Y.Doc; provider: { destroy: () => void } }>();

vi.mock('../../hooks/useDocConnection', () => ({
  useDocConnection: () => ({
    getOrConnect: vi.fn(async (docId: string) => {
      if (mockConnections.has(docId)) return mockConnections.get(docId)!;
      const doc = new Y.Doc();
      const conn = { doc, provider: { destroy: vi.fn() } };
      mockConnections.set(docId, conn);
      return conn;
    }),
    disconnect: vi.fn(),
    disconnectAll: vi.fn(),
  }),
}));

// Stub ArticleEmbed and VideoExcerptEmbed so they don't try to network-fetch
vi.mock('../EduEditor/ArticleEmbed', () => ({
  ArticleEmbed: () => React.createElement('div', { 'data-testid': 'article-embed' }, 'article embed'),
}));
vi.mock('../EduEditor/VideoExcerptEmbed', () => ({
  VideoExcerptEmbed: () => React.createElement('div', { 'data-testid': 'video-embed' }, 'video embed'),
}));

// Keep the CM mount a no-op in tests (mountRef exists, but no real editor)
vi.mock('../../hooks/useSectionEditor', () => ({
  useSectionEditor: () => ({ mountRef: React.createRef<HTMLDivElement>() }),
}));

const { ContentPanel } = await import('./ContentPanel');

function navWrapper(children: React.ReactNode) {
  return React.createElement(
    NavigationContext.Provider,
    { value: { metadata: { 'Lenses/PASTA.md': { id: 'lens-pasta-uuid' } }, viewingSuggestions: false, toggleSuggestions: () => {}, isReadOnly: false } as any },
    children,
  );
}

function seedLensDoc(uuid: string, contents: string) {
  const doc = new Y.Doc();
  doc.getText('contents').insert(0, contents);
  mockConnections.set(`${RELAY_ID}-${uuid}`, {
    doc,
    provider: { destroy: vi.fn() },
  });
}

afterEach(() => { mockConnections.clear(); });

describe('ContentPanel (full-doc scope)', () => {
  it('renders a lens doc with text and question sections', async () => {
    seedLensDoc(
      'lens-pasta-uuid',
      '---\ntitle: PASTA\n---\n' +
      '#### Text\ncontent::\nPASTA is a framework.\n' +
      '#### Question\ncontent:: Why does it matter?\n',
    );

    render(
      navWrapper(
        React.createElement(ContentPanel, {
          scope: {
            kind: 'full-doc',
            docId: `${RELAY_ID}-lens-pasta-uuid`,
            docName: 'PASTA',
            docPath: 'Lenses/PASTA.md',
          },
        }),
      ),
    );

    await waitFor(() => {
      expect(screen.getByText(/PASTA is a framework\./)).toBeInTheDocument();
    });
    expect(screen.getByText(/Why does it matter\?/)).toBeInTheDocument();
  });

  it('shows a placeholder when scope is null', () => {
    render(
      navWrapper(
        React.createElement(ContentPanel, { scope: null }),
      ),
    );
    expect(screen.getByText(/pick a lens/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd lens-editor && npx vitest run src/components/EduEditor/ContentPanel.test.tsx`
Expected: FAIL with "Cannot find module './ContentPanel'".

- [ ] **Step 3: Implement `ContentPanel` (full-doc scope only)**

Create `lens-editor/src/components/EduEditor/ContentPanel.tsx`:

```tsx
import { useEffect, useState, useRef } from 'react';
import * as Y from 'yjs';
import { parseSections, type Section } from '../SectionEditor/parseSections';
import { parseFields, parseFrontmatterFields } from '../../lib/parseFields';
import { useDocConnection } from '../../hooks/useDocConnection';
import { useSectionEditor } from '../../hooks/useSectionEditor';
import { useNavigation } from '../../contexts/NavigationContext';
import { PowerToolbar } from './PowerToolbar';
import {
  TextRenderer,
  ChatRenderer,
  VideoRenderer,
  ArticleRenderer,
  QuestionRenderer,
  HeadingRenderer,
} from './ContentPanel/renderers';
import { RELAY_ID } from '../../lib/constants';

export type ContentScope =
  | { kind: 'full-doc'; docId: string; docName: string; docPath: string }
  | {
      kind: 'subtree';
      docId: string;
      docName: string;
      docPath: string;
      rootSectionIndex: number;
      breadcrumb: string;
    };

interface ContentPanelProps {
  scope: ContentScope | null;
}

export function ContentPanel({ scope }: ContentPanelProps) {
  const { getOrConnect } = useDocConnection();
  const { metadata } = useNavigation();
  const [sections, setSections] = useState<Section[]>([]);
  const [synced, setSynced] = useState(false);
  const [frontmatter, setFrontmatter] = useState<Map<string, string>>(new Map());
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const ytextRef = useRef<Y.Text | null>(null);

  const activeSection =
    editingIndex !== null
      ? parseSections(ytextRef.current?.toString() ?? '')[editingIndex] ?? null
      : null;

  const { mountRef } = useSectionEditor({
    ytext: ytextRef.current,
    sectionFrom: activeSection?.from ?? 0,
    sectionTo: activeSection?.to ?? 0,
    active: editingIndex !== null,
  });

  useEffect(() => {
    if (!scope) {
      setSynced(false);
      setSections([]);
      setFrontmatter(new Map());
      ytextRef.current = null;
      return;
    }

    let cancelled = false;

    async function connect() {
      const { doc } = await getOrConnect(scope!.docId);
      if (cancelled) return;

      const ytext = doc.getText('contents');
      ytextRef.current = ytext;

      const update = () => {
        const text = ytext.toString();
        const parsed = parseSections(text);
        setSections(parsed);

        const fmSection = parsed.find(s => s.type === 'frontmatter');
        if (fmSection) setFrontmatter(parseFrontmatterFields(fmSection.content));
      };

      setSynced(true);
      update();
      ytext.observe(update);

      return () => { ytext.unobserve(update); };
    }

    setSynced(false);
    setSections([]);
    setEditingIndex(null);
    const cleanupPromise = connect();
    return () => {
      cancelled = true;
      cleanupPromise.then(cleanup => cleanup?.());
    };
  }, [scope?.docId, getOrConnect]);

  if (!scope) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-gray-400 text-center px-10">
        <div className="text-xl text-gray-500 mb-2" style={{ fontFamily: "'Newsreader', serif" }}>
          Pick a lens
        </div>
        <div className="text-sm max-w-xs">
          Click a lens title on the left to open it here. Editing module pages and learning outcomes happens in the left pane.
        </div>
      </div>
    );
  }

  if (!synced) {
    return (
      <div className="flex items-center justify-center h-48 text-gray-400 text-sm">
        Loading {scope.docName}&hellip;
      </div>
    );
  }

  const tldr = frontmatter.get('tldr');

  // Visible slice of sections
  const visible = sections.map((s, i) => ({ section: s, index: i }));

  return (
    <div>
      <PowerToolbar lensFileName={`${scope.docName}.md`} />

      {tldr && (
        <div className="mb-6 p-3 bg-white rounded-lg border border-[#e8e5df] text-[13px] text-gray-500 leading-relaxed">
          <strong className="text-[#b87018]">TL;DR:</strong> {tldr}
        </div>
      )}

      {visible.map(({ section, index }) => {
        if (section.type === 'frontmatter') return null;

        const fields = parseFields(section.content);

        if (editingIndex === index) {
          return (
            <div
              key={index}
              className="mb-7 rounded-lg border-2 border-blue-400 bg-white overflow-hidden"
            >
              <div className="flex items-center justify-between px-4 py-2 bg-blue-50 border-b border-blue-200">
                <span className="font-medium text-sm text-blue-700">{section.label}</span>
                <button
                  onClick={() => setEditingIndex(null)}
                  className="text-xs px-2 py-1 bg-blue-100 hover:bg-blue-200 text-blue-600 rounded"
                >
                  Done
                </button>
              </div>
              <div ref={mountRef} style={{ minHeight: '60px' }} />
            </div>
          );
        }

        if (section.type === 'text') {
          return (
            <TextRenderer
              key={index}
              content={fields.get('content') ?? ''}
              onStartEdit={() => setEditingIndex(index)}
            />
          );
        }

        if (section.type === 'chat') {
          return (
            <ChatRenderer
              key={index}
              title={section.label}
              instructions={fields.get('instructions') ?? ''}
              onStartEdit={() => setEditingIndex(index)}
            />
          );
        }

        if (section.type === 'article') {
          const articleSource = fields.get('source')?.trim();
          const from = fields.get('from') ?? undefined;
          const to = fields.get('to') ?? undefined;

          let effectiveSource = articleSource;
          if (!effectiveSource) {
            for (let j = index - 1; j >= 0; j--) {
              if (sections[j].type === 'article') {
                const prev = parseFields(sections[j].content).get('source')?.trim();
                if (prev) { effectiveSource = prev; break; }
              }
            }
          }
          if (!effectiveSource) {
            return (
              <div key={index} className="mb-7 p-4 bg-amber-50 rounded-lg border border-amber-200 text-sm text-amber-700">
                Article segment missing source:: field (no preceding article to inherit from)
              </div>
            );
          }
          const lensUuid = scope.docId.slice(RELAY_ID.length + 1);
          const lensPath = Object.entries(metadata).find(([, m]) => m.id === lensUuid)?.[0] ?? '';
          return (
            <ArticleRenderer
              key={index}
              fromAnchor={from}
              toAnchor={to}
              articleSourceWikilink={effectiveSource}
              lensSourcePath={lensPath}
            />
          );
        }

        if (section.type === 'video') {
          const videoSource = fields.get('source')?.trim();
          const from = fields.get('from') ?? undefined;
          const to = fields.get('to') ?? undefined;

          let effectiveSource = videoSource;
          if (!effectiveSource) {
            for (let j = index - 1; j >= 0; j--) {
              if (sections[j].type === 'video') {
                const prev = parseFields(sections[j].content).get('source')?.trim();
                if (prev) { effectiveSource = prev; break; }
              }
            }
          }
          if (!effectiveSource) {
            return (
              <div key={index} className="mb-7 p-4 bg-amber-50 rounded-lg border border-amber-200 text-sm text-amber-700">
                Video segment missing source:: field (no preceding video to inherit from)
              </div>
            );
          }
          const lensUuid = scope.docId.slice(RELAY_ID.length + 1);
          const lensPath = Object.entries(metadata).find(([, m]) => m.id === lensUuid)?.[0] ?? '';
          return (
            <VideoRenderer
              key={index}
              fromTime={from}
              toTime={to}
              videoSourceWikilink={effectiveSource}
              lensSourcePath={lensPath}
            />
          );
        }

        if (section.type === 'question') {
          return (
            <QuestionRenderer
              key={index}
              content={fields.get('content') ?? ''}
              assessmentInstructions={fields.get('assessment-instructions')}
              enforceVoice={fields.get('enforce-voice')}
              maxChars={fields.get('max-chars')}
              onStartEdit={() => setEditingIndex(index)}
            />
          );
        }

        if (
          section.type === 'heading' ||
          section.type === 'lens-ref' ||
          section.type === 'page' ||
          section.type === 'article-ref' ||
          section.type === 'video-ref'
        ) {
          return (
            <HeadingRenderer
              key={index}
              label={section.label}
              onStartEdit={() => setEditingIndex(index)}
            />
          );
        }

        return null;
      })}
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd lens-editor && npx vitest run src/components/EduEditor/ContentPanel.test.tsx`
Expected: PASS both cases.

- [ ] **Step 5: Typecheck**

Run: `cd lens-editor && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
jj st
cd /home/penguin/code/lens-relay/ws3 && jj commit -m "feat(edu-editor): add ContentPanel with full-doc scope"
```

---

## Task 6: `ContentPanel` subtree scope

**Files:**
- Modify: `lens-editor/src/components/EduEditor/ContentPanel.tsx`
- Modify: `lens-editor/src/components/EduEditor/ContentPanel.test.tsx`

- [ ] **Step 1: Write the failing test**

Add this test to `src/components/EduEditor/ContentPanel.test.tsx` inside the `describe('ContentPanel (full-doc scope)', ...)` block — rename the block to `describe('ContentPanel', ...)` and add:

```tsx
  it('renders only the subtree when scope.kind is "subtree"', async () => {
    seedLensDoc(
      'lens-pasta-uuid',
      '---\ntitle: Module\n---\n' +
      '# Lens: Welcome\n' +
      '#### Text\ncontent::\nWelcome text\n' +
      '# Learning Outcome:\nsource:: foo\n',
    );

    render(
      navWrapper(
        React.createElement(ContentPanel, {
          scope: {
            kind: 'subtree',
            docId: `${RELAY_ID}-lens-pasta-uuid`,
            docName: 'Welcome',
            docPath: 'modules/mod.md',
            rootSectionIndex: 1, // index of "# Lens: Welcome" (0 is frontmatter)
            breadcrumb: 'inside modules/mod.md',
          },
        }),
      ),
    );

    await waitFor(() => {
      expect(screen.getByText(/Welcome text/)).toBeInTheDocument();
    });
    // Learning Outcome should NOT render since it's outside the subtree
    expect(screen.queryByText(/Learning Outcome/)).not.toBeInTheDocument();
  });

  it('displays the breadcrumb in the toolbar for subtree scope', async () => {
    seedLensDoc(
      'lens-pasta-uuid',
      '---\ntitle: Module\n---\n' +
      '# Lens: Welcome\n' +
      '#### Text\ncontent::\nWelcome text\n',
    );

    render(
      navWrapper(
        React.createElement(ContentPanel, {
          scope: {
            kind: 'subtree',
            docId: `${RELAY_ID}-lens-pasta-uuid`,
            docName: 'Welcome',
            docPath: 'modules/mod.md',
            rootSectionIndex: 1,
            breadcrumb: 'inside modules/mod.md',
          },
        }),
      ),
    );

    await waitFor(() => {
      expect(screen.getByText(/inside modules\/mod\.md/)).toBeInTheDocument();
    });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd lens-editor && npx vitest run src/components/EduEditor/ContentPanel.test.tsx`
Expected: FAIL — the new subtree scope branch is not yet implemented; Learning Outcome text is still rendered, or breadcrumb missing.

- [ ] **Step 3: Implement subtree filtering and breadcrumb display**

In `src/components/EduEditor/ContentPanel.tsx`:

Add import at the top:

```ts
import { getSubtreeRange } from './getSubtreeRange';
```

Replace the `visible` computation (currently `const visible = sections.map(...)`) with:

```ts
  let from = 0;
  let to = sections.length;
  if (scope.kind === 'subtree' && sections.length > 0) {
    const [rangeFrom, rangeTo] = getSubtreeRange(sections, scope.rootSectionIndex);
    // Skip the root itself — its label is in the toolbar
    from = rangeFrom + 1;
    to = rangeTo;
  }
  const visible = sections
    .map((section, index) => ({ section, index }))
    .filter(({ index }) => index >= from && index < to);
```

Replace the `<PowerToolbar ... />` call with a conditional that shows the breadcrumb for subtree scope:

```tsx
      {scope.kind === 'full-doc' ? (
        <PowerToolbar lensFileName={`${scope.docName}.md`} />
      ) : (
        <div className="flex items-center gap-2 mb-6 px-3 py-2 bg-white rounded-lg border border-[#e8e5df] text-xs text-gray-500">
          <span className="px-2.5 py-0.5 rounded-xl bg-gray-900 text-white font-medium">Edit</span>
          <span className="text-[11px] text-gray-500">{scope.docName}</span>
          <span className="text-[11px] text-gray-400">· {scope.breadcrumb}</span>
        </div>
      )}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd lens-editor && npx vitest run src/components/EduEditor/ContentPanel.test.tsx`
Expected: PASS all cases.

- [ ] **Step 5: Typecheck**

Run: `cd lens-editor && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
jj st
cd /home/penguin/code/lens-relay/ws3 && jj commit -m "feat(edu-editor): add subtree scope to ContentPanel"
```

---

## Task 7: `ModuleTreeEditor` — header + top-level entries

**Files:**
- Create: `lens-editor/src/components/EduEditor/ModuleTreeEditor.tsx`
- Create: `lens-editor/src/components/EduEditor/ModuleTreeEditor.test.tsx`
- Create: `lens-editor/src/components/EduEditor/ModuleTreeEditor/ModuleHeader.tsx`
- Create: `lens-editor/src/components/EduEditor/ModuleTreeEditor/TreeEntry.tsx`

This task creates the skeleton without LO cards (added in Task 8). It covers the module header and top-level entries (`# Lens:`, `# Submodule:`, and generic entries).

- [ ] **Step 1: Write the failing test**

Create `src/components/EduEditor/ModuleTreeEditor.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { NavigationContext } from '../../contexts/NavigationContext';
import { parseSections } from '../SectionEditor/parseSections';

vi.mock('./useLODocs', () => ({
  useLODocs: () => ({}),
}));

const { ModuleTreeEditor } = await import('./ModuleTreeEditor');

function wrap(children: React.ReactNode) {
  return render(
    React.createElement(
      NavigationContext.Provider,
      {
        value: {
          metadata: {},
          viewingSuggestions: false,
          toggleSuggestions: () => {},
          isReadOnly: false,
        } as any,
      },
      children,
    ),
  );
}

describe('ModuleTreeEditor', () => {
  it('renders the module header', () => {
    const sections = parseSections('---\ntitle: Cognitive Superpowers\nslug: cognitive\n---\n');
    wrap(
      React.createElement(ModuleTreeEditor, {
        moduleSections: sections,
        modulePath: 'modules/cognitive.md',
        activeSelection: null,
        onSelect: () => {},
      }),
    );
    expect(screen.getByText('Cognitive Superpowers')).toBeInTheDocument();
  });

  it('renders a tree entry for an inline # Lens: section', () => {
    const text =
      '---\ntitle: Mod\n---\n' +
      '# Lens: Welcome\n' +
      '#### Text\ncontent::\nhi\n';
    const sections = parseSections(text);
    wrap(
      React.createElement(ModuleTreeEditor, {
        moduleSections: sections,
        modulePath: 'modules/mod.md',
        activeSelection: null,
        onSelect: () => {},
      }),
    );
    expect(screen.getByText('Welcome')).toBeInTheDocument();
    expect(screen.getByText('Lens')).toBeInTheDocument(); // badge text
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd lens-editor && npx vitest run src/components/EduEditor/ModuleTreeEditor.test.tsx`
Expected: FAIL with "Cannot find module './ModuleTreeEditor'".

- [ ] **Step 3: Create `ModuleHeader.tsx`**

```tsx
interface ModuleHeaderProps {
  title: string;
  slug?: string;
  tags?: string;
  onStartEdit: () => void;
  active: boolean;
}

export function ModuleHeader({ title, slug, tags, onStartEdit, active }: ModuleHeaderProps) {
  return (
    <div
      onClick={onStartEdit}
      className={`px-3 py-2.5 mb-2 rounded-md border cursor-pointer transition-all ${
        active ? 'border-blue-500 border-2 bg-blue-50' : 'border-[#e4e0d4] bg-white hover:border-blue-300'
      }`}
    >
      <div style={{ fontFamily: "'Newsreader', serif", fontSize: '15px', fontWeight: 700, color: '#1a1a1a' }}>
        {title}
      </div>
      {(slug || tags) && (
        <div className="text-[10px] text-gray-500 mt-0.5 font-mono">
          {slug && `slug: ${slug}`}
          {slug && tags && ' · '}
          {tags && `tags: ${tags}`}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Create `TreeEntry.tsx`**

```tsx
interface TreeEntryProps {
  badgeText: string;
  badgeClass: string; // tailwind classes for badge background/color
  label: string;
  inlineTag?: string;
  active: boolean;
  onClick: () => void;
}

export function TreeEntry({ badgeText, badgeClass, label, inlineTag, active, onClick }: TreeEntryProps) {
  return (
    <div
      onClick={onClick}
      className={`px-2.5 py-1.5 mb-1 rounded border cursor-pointer transition-all flex items-center gap-2 ${
        active
          ? 'border-2 border-blue-500 bg-blue-100'
          : 'border-[#e8e5df] bg-white hover:border-blue-300 hover:bg-blue-50'
      }`}
    >
      <span className={`text-[9px] px-1.5 py-0.5 rounded font-semibold uppercase tracking-wider ${badgeClass}`}>
        {badgeText}
      </span>
      <span className="text-[12px] font-medium text-gray-800 flex-1">{label}</span>
      {inlineTag && <span className="text-[9px] text-gray-400 italic">{inlineTag}</span>}
      <span className="text-blue-300 text-sm">→</span>
    </div>
  );
}
```

- [ ] **Step 5: Create `ModuleTreeEditor.tsx`**

```tsx
import type { Section } from '../SectionEditor/parseSections';
import { parseFields, parseFrontmatterFields } from '../../lib/parseFields';
import { resolveWikilinkToUuid } from '../../lib/resolveDocPath';
import { useNavigation } from '../../contexts/NavigationContext';
import { ModuleHeader } from './ModuleTreeEditor/ModuleHeader';
import { TreeEntry } from './ModuleTreeEditor/TreeEntry';
import { useLODocs } from './useLODocs';
import { RELAY_ID } from '../../lib/constants';
import type { ContentScope } from './ContentPanel';

interface ModuleTreeEditorProps {
  moduleSections: Section[];
  modulePath: string;
  moduleDocId?: string; // compound id of the module itself
  activeSelection: { docId: string; rootIndex?: number } | null;
  onSelect: (scope: ContentScope) => void;
}

export function ModuleTreeEditor({
  moduleSections,
  modulePath,
  moduleDocId,
  activeSelection,
  onSelect,
}: ModuleTreeEditorProps) {
  const { metadata } = useNavigation();
  useLODocs(moduleSections, modulePath); // fetched eagerly for future tasks

  const frontmatter = (() => {
    const fm = moduleSections.find(s => s.type === 'frontmatter');
    return fm ? parseFrontmatterFields(fm.content) : new Map<string, string>();
  })();

  const moduleTitle = frontmatter.get('title') ?? modulePath.split('/').pop()?.replace(/\.md$/, '') ?? 'Module';
  const slug = frontmatter.get('slug');
  const tags = frontmatter.get('tags');

  return (
    <div>
      <ModuleHeader
        title={moduleTitle}
        slug={slug}
        tags={tags}
        onStartEdit={() => {
          // Editing the module frontmatter goes through ContentPanel with a subtree scope
          if (!moduleDocId) return;
          onSelect({
            kind: 'subtree',
            docId: moduleDocId,
            docName: moduleTitle,
            docPath: modulePath,
            rootSectionIndex: 0, // frontmatter section
            breadcrumb: `frontmatter of ${modulePath}`,
          });
        }}
        active={false}
      />

      {moduleSections.map((section, i) => {
        if (section.type === 'frontmatter') return null;

        // Top-level # Lens: entries
        if (section.type === 'lens-ref' && section.level === 1) {
          const fields = parseFields(section.content);
          const sourceField = fields.get('source');
          const label = section.label || 'Lens';

          if (sourceField) {
            // Referenced lens — open the external lens doc
            const uuid = resolveWikilinkToUuid(sourceField.trim(), modulePath, metadata);
            const lensDocId = uuid ? `${RELAY_ID}-${uuid}` : null;
            const isActive = lensDocId !== null && activeSelection?.docId === lensDocId;
            return (
              <TreeEntry
                key={i}
                badgeText="Lens"
                badgeClass="bg-blue-100 text-blue-700"
                label={label}
                active={isActive}
                onClick={() => {
                  if (!lensDocId) return;
                  onSelect({
                    kind: 'full-doc',
                    docId: lensDocId,
                    docName: label,
                    docPath: modulePath,
                  });
                }}
              />
            );
          }

          // Inline lens — subtree of the module doc
          const isActive =
            moduleDocId !== undefined &&
            activeSelection?.docId === moduleDocId &&
            activeSelection?.rootIndex === i;
          return (
            <TreeEntry
              key={i}
              badgeText="Lens"
              badgeClass="bg-blue-100 text-blue-700"
              label={label}
              inlineTag="inline"
              active={isActive}
              onClick={() => {
                if (!moduleDocId) return;
                onSelect({
                  kind: 'subtree',
                  docId: moduleDocId,
                  docName: label,
                  docPath: modulePath,
                  rootSectionIndex: i,
                  breadcrumb: `inside ${modulePath}`,
                });
              }}
            />
          );
        }

        // Generic fallback (heading, submodule at module level, etc.)
        if (section.type === 'heading' || section.type === 'submodule') {
          return (
            <TreeEntry
              key={i}
              badgeText={section.type}
              badgeClass="bg-gray-100 text-gray-600"
              label={section.label}
              active={false}
              onClick={() => {
                if (!moduleDocId) return;
                onSelect({
                  kind: 'subtree',
                  docId: moduleDocId,
                  docName: section.label,
                  docPath: modulePath,
                  rootSectionIndex: i,
                  breadcrumb: `inside ${modulePath}`,
                });
              }}
            />
          );
        }

        // lo-ref rendering deferred to Task 8
        return null;
      })}
    </div>
  );
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd lens-editor && npx vitest run src/components/EduEditor/ModuleTreeEditor.test.tsx`
Expected: PASS both cases.

- [ ] **Step 7: Typecheck**

Run: `cd lens-editor && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
jj st
cd /home/penguin/code/lens-relay/ws3 && jj commit -m "feat(edu-editor): ModuleTreeEditor skeleton with header and top-level entries"
```

---

## Task 8: `ModuleTreeEditor` — LO cards with nested children

**Files:**
- Create: `lens-editor/src/components/EduEditor/ModuleTreeEditor/LoCard.tsx`
- Create: `lens-editor/src/components/EduEditor/ModuleTreeEditor/LoDefinition.tsx`
- Modify: `lens-editor/src/components/EduEditor/ModuleTreeEditor.tsx`
- Modify: `lens-editor/src/components/EduEditor/ModuleTreeEditor.test.tsx`

- [ ] **Step 1: Write the failing test**

Add to `src/components/EduEditor/ModuleTreeEditor.test.tsx` inside the describe block. First, replace the top-of-file `useLODocs` mock with one that returns real data:

```ts
const loDocsMock = vi.fn<() => Record<string, any>>(() => ({}));

vi.mock('./useLODocs', () => ({
  useLODocs: () => loDocsMock(),
}));
```

Then add this test:

```tsx
  it('renders an LO card with title, definition, and nested lenses', () => {
    const moduleText =
      '---\ntitle: Mod\n---\n' +
      '# Learning Outcome:\nsource:: [[../Learning Outcomes/LO-One]]\n';
    const moduleSections = parseSections(moduleText);

    loDocsMock.mockReturnValue({
      'lo-one-uuid': {
        loPath: 'Learning Outcomes/LO-One.md',
        title: 'LO-One',
        frontmatter: new Map([['learning-outcome', 'Explain X in depth.']]),
        sections: parseSections(
          '---\nlearning-outcome: "Explain X in depth."\n---\n' +
          '## Lens:\nsource:: [[../Lenses/PASTA]]\n' +
          '## Test:\n#### Question\ncontent:: q1\n',
        ),
      },
    });

    render(
      React.createElement(
        NavigationContext.Provider,
        {
          value: {
            metadata: {
              'modules/mod.md': { id: 'mod-uuid' },
              'Learning Outcomes/LO-One.md': { id: 'lo-one-uuid' },
              'Lenses/PASTA.md': { id: 'lens-pasta-uuid' },
            },
            viewingSuggestions: false,
            toggleSuggestions: () => {},
            isReadOnly: false,
          } as any,
        },
        React.createElement(ModuleTreeEditor, {
          moduleSections,
          modulePath: 'modules/mod.md',
          moduleDocId: 'relay-mod-uuid',
          activeSelection: null,
          onSelect: () => {},
        }),
      ),
    );

    expect(screen.getByText('LO-One')).toBeInTheDocument();
    expect(screen.getByText('Explain X in depth.')).toBeInTheDocument();
    expect(screen.getByText('PASTA')).toBeInTheDocument(); // nested lens title
    expect(screen.getByText(/Test \(1 questions?\)/)).toBeInTheDocument();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd lens-editor && npx vitest run src/components/EduEditor/ModuleTreeEditor.test.tsx`
Expected: FAIL — LO card not rendered yet.

- [ ] **Step 3: Create `LoDefinition.tsx`**

```tsx
interface LoDefinitionProps {
  definition: string;
  editing: boolean;
  mountRef: React.RefObject<HTMLDivElement | null>;
  onStartEdit: () => void;
  onDone: () => void;
}

export function LoDefinition({ definition, editing, mountRef, onStartEdit, onDone }: LoDefinitionProps) {
  if (editing) {
    return (
      <div className="bg-white border-b border-dashed border-[#f0e0b0]">
        <div className="flex items-center justify-between px-3 py-1 bg-amber-50 border-b border-amber-200">
          <span className="text-[9px] uppercase tracking-wider text-amber-700 font-semibold">
            Editing definition
          </span>
          <button
            onClick={onDone}
            className="text-[10px] px-2 py-0.5 bg-amber-100 hover:bg-amber-200 text-amber-700 rounded"
          >
            Done
          </button>
        </div>
        <div ref={mountRef} style={{ minHeight: '60px', padding: '4px 8px' }} />
      </div>
    );
  }

  return (
    <div className="px-3 py-2 bg-[#fffdf5] border-b border-dashed border-[#f0e0b0]">
      <div className="text-[9px] uppercase tracking-wider text-amber-700 font-semibold mb-1">
        Definition (click to edit)
      </div>
      <div
        onClick={onStartEdit}
        className="text-[11px] text-gray-700 leading-relaxed cursor-text hover:bg-white rounded px-1 py-0.5 border border-transparent hover:border-[#e8d8a0]"
      >
        {definition || <em className="text-gray-400">(no definition)</em>}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Create `LoCard.tsx`**

```tsx
import type { Section } from '../../SectionEditor/parseSections';
import { parseFields } from '../../../lib/parseFields';
import { resolveWikilinkToUuid } from '../../../lib/resolveDocPath';
import { useNavigation } from '../../../contexts/NavigationContext';
import { RELAY_ID } from '../../../lib/constants';
import type { ContentScope } from '../ContentPanel';
import { LoDefinition } from './LoDefinition';

interface LoCardProps {
  uuid: string;
  loDocId: string; // compound doc id for the LO doc
  title: string;
  definition: string;
  sections: Section[];
  loPath: string;
  activeSelection: { docId: string; rootIndex?: number } | null;
  editingDefinition: boolean;
  definitionMountRef: React.RefObject<HTMLDivElement | null>;
  onEditDefinition: () => void;
  onDoneEditingDefinition: () => void;
  onSelect: (scope: ContentScope) => void;
}

export function LoCard({
  uuid,
  loDocId,
  title,
  definition,
  sections,
  loPath,
  activeSelection,
  editingDefinition,
  definitionMountRef,
  onEditDefinition,
  onDoneEditingDefinition,
  onSelect,
}: LoCardProps) {
  const { metadata } = useNavigation();

  return (
    <div className="mb-2 bg-white border-[1.5px] border-[#f0c96a] rounded-md overflow-hidden">
      <div className="px-3 py-2 border-b border-dashed border-[#f0e0b0]">
        <span className="text-[9px] bg-[#fff0cc] text-[#7a5a15] px-1.5 py-0.5 rounded font-bold uppercase tracking-wider">
          Learning Outcome
        </span>
        <div className="font-semibold text-[12px] text-gray-800 mt-1">{title}</div>
      </div>

      <LoDefinition
        definition={definition}
        editing={editingDefinition}
        mountRef={definitionMountRef}
        onStartEdit={onEditDefinition}
        onDone={onDoneEditingDefinition}
      />

      <div className="px-3 py-2">
        {sections.map((s, i) => {
          if (s.type === 'submodule') {
            return (
              <div
                key={i}
                className="text-[9px] font-bold text-purple-700 uppercase tracking-wider px-1 pt-2 pb-0.5"
              >
                {s.label}
              </div>
            );
          }

          if (s.type === 'lens-ref' && s.level === 2) {
            const fields = parseFields(s.content);
            const sourceField = fields.get('source');
            const optional = fields.get('optional') === 'true';
            const lensLabel = sourceField
              ? sourceField.replace(/^!?\[\[/, '').replace(/\]\]$/, '').split('/').pop()?.split('|')[0] ?? 'Lens'
              : s.label || 'Lens';
            const lensUuid = sourceField
              ? resolveWikilinkToUuid(sourceField.trim(), loPath, metadata)
              : null;
            const lensDocId = lensUuid ? `${RELAY_ID}-${lensUuid}` : null;
            const isActive = lensDocId !== null && activeSelection?.docId === lensDocId;

            return (
              <div
                key={i}
                onClick={() => {
                  if (!lensDocId) return;
                  onSelect({
                    kind: 'full-doc',
                    docId: lensDocId,
                    docName: lensLabel,
                    docPath: loPath,
                  });
                }}
                className={`px-2 py-1 my-0.5 rounded border flex items-center gap-1.5 cursor-pointer ${
                  isActive
                    ? 'border-2 border-blue-500 bg-blue-100 font-bold'
                    : 'border-transparent hover:bg-blue-50'
                }`}
              >
                <span className="text-[8px] bg-blue-100 text-blue-700 px-1 py-0.5 rounded font-bold uppercase">
                  Lens
                </span>
                <span className="text-[11px] text-blue-700 flex-1">{lensLabel}</span>
                {optional && <span className="text-[9px] text-gray-400 italic">optional</span>}
              </div>
            );
          }

          if (s.type === 'test-ref' && s.level === 2) {
            // Count #### Question children until next level <= 2
            let questionCount = 0;
            for (let j = i + 1; j < sections.length; j++) {
              if (sections[j].level <= 2) break;
              if (sections[j].type === 'question') questionCount++;
            }
            const label = questionCount > 0 ? `Test (${questionCount} questions)` : 'Test (empty)';
            const isActive =
              activeSelection?.docId === loDocId && activeSelection?.rootIndex === i;
            return (
              <div
                key={i}
                onClick={() =>
                  onSelect({
                    kind: 'subtree',
                    docId: loDocId,
                    docName: 'Test',
                    docPath: loPath,
                    rootSectionIndex: i,
                    breadcrumb: `inside ${title}.md`,
                  })
                }
                className={`px-2 py-1 my-0.5 rounded border flex items-center gap-1.5 cursor-pointer ${
                  isActive
                    ? 'border-2 border-blue-500 bg-blue-100 font-bold'
                    : 'border-transparent hover:bg-red-50'
                }`}
              >
                <span className="text-[8px] bg-red-100 text-red-700 px-1 py-0.5 rounded font-bold uppercase">
                  Test
                </span>
                <span className="text-[11px] text-red-700 italic flex-1">{label}</span>
              </div>
            );
          }

          return null;
        })}
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Wire `LoCard` into `ModuleTreeEditor`**

In `src/components/EduEditor/ModuleTreeEditor.tsx`, replace `return null;` (the `lo-ref` fallback at the bottom of the `moduleSections.map` callback) with:

```tsx
        if (section.type === 'lo-ref' && section.level === 1) {
          const fields = parseFields(section.content);
          const sourceField = fields.get('source');
          if (!sourceField) return null;
          const uuid = resolveWikilinkToUuid(sourceField.trim(), modulePath, metadata);
          if (!uuid) return null;
          const loEntry = loDocs[uuid];
          if (!loEntry) {
            return (
              <div key={i} className="px-3 py-2 mb-2 text-[11px] text-gray-400 italic border border-dashed border-gray-200 rounded">
                Loading LO&hellip;
              </div>
            );
          }

          return (
            <LoCard
              key={i}
              uuid={uuid}
              loDocId={`${RELAY_ID}-${uuid}`}
              title={loEntry.title}
              definition={loEntry.frontmatter.get('learning-outcome') ?? ''}
              sections={loEntry.sections}
              loPath={loEntry.loPath}
              activeSelection={activeSelection}
              editingDefinition={false}
              definitionMountRef={{ current: null }}
              onEditDefinition={() => { /* implemented in Task 10 */ }}
              onDoneEditingDefinition={() => {}}
              onSelect={onSelect}
            />
          );
        }
```

Also change the top of the function to capture the LO docs:

```tsx
  const loDocs = useLODocs(moduleSections, modulePath);
```

(Replacing the existing `useLODocs(moduleSections, modulePath);` statement.)

Add the `LoCard` import at the top:

```tsx
import { LoCard } from './ModuleTreeEditor/LoCard';
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd lens-editor && npx vitest run src/components/EduEditor/ModuleTreeEditor.test.tsx`
Expected: PASS the LO-card test and the existing two tests.

- [ ] **Step 7: Typecheck**

Run: `cd lens-editor && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
jj st
cd /home/penguin/code/lens-relay/ws3 && jj commit -m "feat(edu-editor): ModuleTreeEditor renders LO cards with nested children"
```

---

## Task 9: `ModuleTreeEditor` click dispatch assertions

**Files:**
- Modify: `lens-editor/src/components/EduEditor/ModuleTreeEditor.test.tsx`

This task adds behavioral tests verifying that clicks fire `onSelect` with the correct `ContentScope`. No production code changes; clicks should already work from Tasks 7 and 8.

- [ ] **Step 1: Write the click-dispatch tests**

Add to `src/components/EduEditor/ModuleTreeEditor.test.tsx`:

```tsx
import { fireEvent } from '@testing-library/react';

  it('fires onSelect with full-doc scope when clicking a referenced lens inside an LO', () => {
    const moduleText =
      '---\ntitle: Mod\n---\n' +
      '# Learning Outcome:\nsource:: [[../Learning Outcomes/LO-One]]\n';
    const moduleSections = parseSections(moduleText);

    loDocsMock.mockReturnValue({
      'lo-one-uuid': {
        loPath: 'Learning Outcomes/LO-One.md',
        title: 'LO-One',
        frontmatter: new Map([['learning-outcome', 'X']]),
        sections: parseSections(
          '---\nlearning-outcome: "X"\n---\n' +
          '## Lens:\nsource:: [[../Lenses/PASTA]]\n',
        ),
      },
    });

    const onSelect = vi.fn();
    render(
      React.createElement(
        NavigationContext.Provider,
        {
          value: {
            metadata: {
              'modules/mod.md': { id: 'mod-uuid' },
              'Learning Outcomes/LO-One.md': { id: 'lo-one-uuid' },
              'Lenses/PASTA.md': { id: 'lens-pasta-uuid' },
            },
            viewingSuggestions: false,
            toggleSuggestions: () => {},
            isReadOnly: false,
          } as any,
        },
        React.createElement(ModuleTreeEditor, {
          moduleSections,
          modulePath: 'modules/mod.md',
          moduleDocId: 'relay-mod-uuid',
          activeSelection: null,
          onSelect,
        }),
      ),
    );

    fireEvent.click(screen.getByText('PASTA'));
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'full-doc',
        docName: 'PASTA',
      }),
    );
    const call = onSelect.mock.calls[0][0];
    expect(call.docId).toContain('lens-pasta-uuid');
  });

  it('fires onSelect with subtree scope when clicking an inline # Lens: entry', () => {
    const moduleText =
      '---\ntitle: Mod\n---\n' +
      '# Lens: Welcome\n' +
      '#### Text\ncontent::\nhi\n';
    const moduleSections = parseSections(moduleText);
    loDocsMock.mockReturnValue({});

    const onSelect = vi.fn();
    render(
      React.createElement(
        NavigationContext.Provider,
        {
          value: {
            metadata: {},
            viewingSuggestions: false,
            toggleSuggestions: () => {},
            isReadOnly: false,
          } as any,
        },
        React.createElement(ModuleTreeEditor, {
          moduleSections,
          modulePath: 'modules/mod.md',
          moduleDocId: 'relay-mod-uuid',
          activeSelection: null,
          onSelect,
        }),
      ),
    );

    fireEvent.click(screen.getByText('Welcome'));
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'subtree',
        docId: 'relay-mod-uuid',
        rootSectionIndex: expect.any(Number),
      }),
    );
  });

  it('fires onSelect with subtree scope when clicking a test under an LO', () => {
    const moduleText =
      '---\ntitle: Mod\n---\n' +
      '# Learning Outcome:\nsource:: [[../Learning Outcomes/LO-One]]\n';
    const moduleSections = parseSections(moduleText);

    loDocsMock.mockReturnValue({
      'lo-one-uuid': {
        loPath: 'Learning Outcomes/LO-One.md',
        title: 'LO-One',
        frontmatter: new Map([['learning-outcome', 'X']]),
        sections: parseSections(
          '---\nlearning-outcome: "X"\n---\n' +
          '## Test:\n#### Question\ncontent:: q1\n',
        ),
      },
    });

    const onSelect = vi.fn();
    render(
      React.createElement(
        NavigationContext.Provider,
        {
          value: {
            metadata: {
              'modules/mod.md': { id: 'mod-uuid' },
              'Learning Outcomes/LO-One.md': { id: 'lo-one-uuid' },
            },
            viewingSuggestions: false,
            toggleSuggestions: () => {},
            isReadOnly: false,
          } as any,
        },
        React.createElement(ModuleTreeEditor, {
          moduleSections,
          modulePath: 'modules/mod.md',
          moduleDocId: 'relay-mod-uuid',
          activeSelection: null,
          onSelect,
        }),
      ),
    );

    fireEvent.click(screen.getByText(/Test \(1 questions?\)/));
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'subtree',
        docId: 'relay-lo-one-uuid',
      }),
    );
    const call = onSelect.mock.calls[0][0];
    expect(call.rootSectionIndex).toBeGreaterThanOrEqual(0);
  });
```

- [ ] **Step 2: Run tests**

Run: `cd lens-editor && npx vitest run src/components/EduEditor/ModuleTreeEditor.test.tsx`
Expected: PASS all cases. If any fail, fix the wiring in `ModuleTreeEditor.tsx` or `LoCard.tsx` so the click handlers dispatch the exact `ContentScope` the tests expect. (No changes required if Tasks 7 and 8 were implemented as specified.)

- [ ] **Step 3: Commit**

```bash
jj st
cd /home/penguin/code/lens-relay/ws3 && jj commit -m "test(edu-editor): ModuleTreeEditor click dispatch"
```

---

## Task 10: LO definition editing

**Files:**
- Modify: `lens-editor/src/components/EduEditor/ModuleTreeEditor.tsx`
- Modify: `lens-editor/src/components/EduEditor/ModuleTreeEditor.test.tsx`

- [ ] **Step 1: Write the failing test**

Add to `src/components/EduEditor/ModuleTreeEditor.test.tsx`:

```tsx
  it('shows the "Editing definition" UI when the LO definition is clicked', () => {
    const moduleText =
      '---\ntitle: Mod\n---\n' +
      '# Learning Outcome:\nsource:: [[../Learning Outcomes/LO-One]]\n';
    const moduleSections = parseSections(moduleText);

    loDocsMock.mockReturnValue({
      'lo-one-uuid': {
        loPath: 'Learning Outcomes/LO-One.md',
        title: 'LO-One',
        frontmatter: new Map([['learning-outcome', 'Explain X in depth.']]),
        sections: parseSections(
          '---\nlearning-outcome: "Explain X in depth."\n---\n',
        ),
      },
    });

    render(
      React.createElement(
        NavigationContext.Provider,
        {
          value: {
            metadata: {
              'modules/mod.md': { id: 'mod-uuid' },
              'Learning Outcomes/LO-One.md': { id: 'lo-one-uuid' },
            },
            viewingSuggestions: false,
            toggleSuggestions: () => {},
            isReadOnly: false,
          } as any,
        },
        React.createElement(ModuleTreeEditor, {
          moduleSections,
          modulePath: 'modules/mod.md',
          moduleDocId: 'relay-mod-uuid',
          activeSelection: null,
          onSelect: () => {},
        }),
      ),
    );

    fireEvent.click(screen.getByText('Explain X in depth.'));
    expect(screen.getByText(/Editing definition/i)).toBeInTheDocument();
  });
```

Also stub `useSectionEditor` for this test file by adding at the top (after other mocks):

```ts
vi.mock('../../hooks/useSectionEditor', () => ({
  useSectionEditor: () => ({ mountRef: { current: null } }),
}));
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd lens-editor && npx vitest run src/components/EduEditor/ModuleTreeEditor.test.tsx`
Expected: FAIL — no editing UI appears, because `editingDefinition` is always `false`.

- [ ] **Step 3: Wire definition editing state and CM mount**

In `src/components/EduEditor/ModuleTreeEditor.tsx`, add at the top:

```tsx
import { useState } from 'react';
import * as Y from 'yjs';
import { useDocConnection } from '../../hooks/useDocConnection';
import { useSectionEditor } from '../../hooks/useSectionEditor';
```

Inside the `ModuleTreeEditor` function body (above the `frontmatter` computation):

```tsx
  const { getOrConnect } = useDocConnection();
  const [editingDefUuid, setEditingDefUuid] = useState<string | null>(null);
  const [editingYtext, setEditingYtext] = useState<Y.Text | null>(null);
  const [editingRange, setEditingRange] = useState<[number, number]>([0, 0]);

  const { mountRef: definitionMountRef } = useSectionEditor({
    ytext: editingYtext,
    sectionFrom: editingRange[0],
    sectionTo: editingRange[1],
    active: editingDefUuid !== null,
  });

  async function startEditingDefinition(uuid: string) {
    const loEntry = loDocs[uuid];
    if (!loEntry) return;
    const loDocId = `${RELAY_ID}-${uuid}`;
    const { doc } = await getOrConnect(loDocId);
    const ytext = doc.getText('contents');
    const fmSection = loEntry.sections.find(s => s.type === 'frontmatter');
    if (!fmSection) return;
    setEditingYtext(ytext);
    setEditingRange([fmSection.from, fmSection.to]);
    setEditingDefUuid(uuid);
  }

  function stopEditingDefinition() {
    setEditingDefUuid(null);
    setEditingYtext(null);
  }
```

Change the `LoCard` props in the map to pass the real values:

```tsx
            <LoCard
              key={i}
              uuid={uuid}
              loDocId={`${RELAY_ID}-${uuid}`}
              title={loEntry.title}
              definition={loEntry.frontmatter.get('learning-outcome') ?? ''}
              sections={loEntry.sections}
              loPath={loEntry.loPath}
              activeSelection={activeSelection}
              editingDefinition={editingDefUuid === uuid}
              definitionMountRef={editingDefUuid === uuid ? definitionMountRef : { current: null }}
              onEditDefinition={() => { void startEditingDefinition(uuid); }}
              onDoneEditingDefinition={stopEditingDefinition}
              onSelect={onSelect}
            />
```

- [ ] **Step 4: Run tests**

Run: `cd lens-editor && npx vitest run src/components/EduEditor/ModuleTreeEditor.test.tsx`
Expected: PASS all cases including the new definition-editing test.

- [ ] **Step 5: Typecheck**

Run: `cd lens-editor && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
jj st
cd /home/penguin/code/lens-relay/ws3 && jj commit -m "feat(edu-editor): LO definition editing via CM frontmatter mount"
```

---

## Task 11: Wire `EduEditor` to use the new components

**Files:**
- Modify: `lens-editor/src/components/EduEditor/EduEditor.tsx`

- [ ] **Step 1: Rewrite `EduEditor.tsx`**

Replace the existing contents with:

```tsx
import { useEffect, useState, useCallback } from 'react';
import { useDocConnection } from '../../hooks/useDocConnection';
import { parseSections } from '../SectionEditor/parseSections';
import type { Section } from '../SectionEditor/parseSections';
import { ModuleTreeEditor } from './ModuleTreeEditor';
import { ContentPanel, type ContentScope } from './ContentPanel';

interface EduEditorProps {
  moduleDocId: string;
  sourcePath?: string;
}

export function EduEditor({ moduleDocId, sourcePath }: EduEditorProps) {
  const { getOrConnect, disconnectAll } = useDocConnection();
  const [moduleSections, setModuleSections] = useState<Section[]>([]);
  const [synced, setSynced] = useState(false);
  const [scope, setScope] = useState<ContentScope | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function connect() {
      const { doc } = await getOrConnect(moduleDocId);
      if (cancelled) return;

      const ytext = doc.getText('contents');
      const update = () => {
        setModuleSections(parseSections(ytext.toString()));
      };

      setSynced(true);
      update();
      ytext.observe(update);

      return () => { ytext.unobserve(update); };
    }

    const cleanupPromise = connect();
    return () => {
      cancelled = true;
      cleanupPromise.then(cleanup => cleanup?.());
    };
  }, [moduleDocId, getOrConnect]);

  useEffect(() => disconnectAll, [disconnectAll]);

  const handleSelect = useCallback((next: ContentScope) => {
    setScope(next);
  }, []);

  const activeSelection =
    scope === null
      ? null
      : {
          docId: scope.docId,
          rootIndex: scope.kind === 'subtree' ? scope.rootSectionIndex : undefined,
        };

  if (!synced) {
    return (
      <div className="h-full flex items-center justify-center text-gray-400 text-sm">
        Connecting to module...
      </div>
    );
  }

  return (
    <div className="h-full flex">
      <div className="w-[420px] min-w-[420px] border-r-2 border-gray-200 bg-[#fbfaf7] overflow-y-auto p-4">
        <div className="text-[11px] uppercase tracking-wider text-gray-500 font-semibold mb-3 pb-2 border-b border-gray-200">
          {sourcePath?.split('/').pop()?.replace(/\.md$/, '') ?? 'Module'}
        </div>
        <ModuleTreeEditor
          moduleSections={moduleSections}
          modulePath={sourcePath ?? ''}
          moduleDocId={moduleDocId}
          activeSelection={activeSelection}
          onSelect={handleSelect}
        />
      </div>

      <div className="flex-1 overflow-y-auto" style={{ background: '#faf8f3' }}>
        <div className="max-w-[720px] mx-auto py-8 px-10 h-full">
          <ContentPanel scope={scope} />
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Run typecheck**

Run: `cd lens-editor && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Run the full test suite for EduEditor**

Run: `cd lens-editor && npx vitest run src/components/EduEditor`
Expected: PASS all tests.

- [ ] **Step 4: Commit**

```bash
jj st
cd /home/penguin/code/lens-relay/ws3 && jj commit -m "feat(edu-editor): wire ModuleTreeEditor and ContentPanel in EduEditor"
```

---

## Task 12: Delete obsolete `LensPanel` and `ModulePanel`

**Files:**
- Delete: `lens-editor/src/components/EduEditor/LensPanel.tsx`
- Delete: `lens-editor/src/components/EduEditor/ModulePanel.tsx`

- [ ] **Step 1: Delete the files**

```bash
cd /home/penguin/code/lens-relay/ws3/lens-editor
rm src/components/EduEditor/LensPanel.tsx src/components/EduEditor/ModulePanel.tsx
```

- [ ] **Step 2: Typecheck to confirm nothing imports them**

Run: `cd lens-editor && npx tsc --noEmit`
Expected: clean. If there are import errors, grep for remaining references and remove them:

```bash
cd /home/penguin/code/lens-relay/ws3/lens-editor
grep -rn "LensPanel\|ModulePanel" src
```

- [ ] **Step 3: Run the full test suite**

Run: `cd lens-editor && npx vitest run`
Expected: PASS everything.

- [ ] **Step 4: Commit**

```bash
jj st
cd /home/penguin/code/lens-relay/ws3 && jj commit -m "chore(edu-editor): remove obsolete LensPanel and ModulePanel"
```

---

## Task 13: Manual smoke test in the running app

**Files:** none (manual verification only)

- [ ] **Step 1: Ensure the local relay server (port 8290) and Vite dev server (port 5373) are running**

The user typically runs both already. If not, ask before starting servers — do not kill existing ones without checking `./scripts/list-servers` first.

- [ ] **Step 2: Open the Edu Editor in Chrome via the MCP**

Navigate to the edu editor for the Cognitive Superpowers module (or another module fixture). Verify:

- Left pane shows the module header, an inline `# Lens: Welcome` entry (badge = Lens, inline tag), and each `# Learning Outcome:` as an LO card.
- Each LO card shows its `learning-outcome:` definition text.
- Each LO card shows its nested `## Lens:` entries by title and its `## Test:` entry with a question count.
- Clicking a lens title → right pane loads the lens with the standard editor.
- Clicking the inline `Welcome` lens → right pane shows the module's welcome subtree (just the `#### Text` block, editable).
- Clicking a test with embedded questions → right pane shows the test's `#### Question` children, editable.
- Clicking an LO's definition text → the definition area shows "Editing definition" with a CM editor; typing writes back to the LO doc.
- Active selection is highlighted in the left pane.

- [ ] **Step 3: Run the full test suite once more**

Run: `cd lens-editor && npx vitest run`
Expected: PASS everything.

- [ ] **Step 4: Typecheck**

Run: `cd lens-editor && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 5: Lint**

Run: `cd lens-editor && npm run lint`
Expected: clean (or no new errors vs. baseline).

- [ ] **Step 6: Final commit if anything needed polish**

Only commit if you made changes during the manual test. Otherwise skip this step.

```bash
jj st
cd /home/penguin/code/lens-relay/ws3 && jj commit -m "fix(edu-editor): <describe any polish fix>"
```

---

## Self-review notes

Coverage check against the spec:

| Spec requirement | Task |
|---|---|
| Add `level` to `Section` | Task 1 |
| `getSubtreeRange` pure helper | Task 2 |
| `useLODocs` eager fetch + observe | Task 3 |
| Extract renderers | Task 4 |
| `ContentPanel` full-doc scope | Task 5 |
| `ContentPanel` subtree scope + breadcrumb | Task 6 |
| `ModuleTreeEditor` skeleton + top-level entries | Task 7 |
| LO cards with definition + nested children | Task 8 |
| Click dispatch assertions | Task 9 |
| LO definition editing | Task 10 |
| `EduEditor` wiring | Task 11 |
| Delete obsolete files | Task 12 |
| Manual smoke test | Task 13 |

All non-goal items from the spec (add/delete/reorder, awareness, collapse UI) are NOT implemented — confirmed none of the tasks touch them.

Type consistency spot-check:
- `ContentScope` defined in Task 5; imported unchanged in Tasks 7, 8, 11.
- `LODocEntry` defined in Task 3; consumed in Task 8 as `loEntry.frontmatter.get('learning-outcome')` — matches.
- `getSubtreeRange(sections, rootIndex): [number, number]` — same shape in Task 2 and Task 6.
- `useSectionEditor({ ytext, sectionFrom, sectionTo, active })` — matches existing signature in both Task 5 and Task 10 uses.
