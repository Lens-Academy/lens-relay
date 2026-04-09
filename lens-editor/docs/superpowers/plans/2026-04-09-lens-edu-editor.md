# Lens Edu Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two-panel editor for Lens Edu content — left panel shows module structure (pages, submodules, LOs), right panel shows selected lens with platform-style rendering and inline CRDT editing. Article/video excerpts expand inline showing source text.

**Architecture:** Module doc drives left panel tree. Clicking a lens ref connects to that lens's Y.Doc and renders it in the right panel with platform styling (Newsreader/DM Sans, warm off-white). Article-excerpt sections connect to the article's Y.Doc to show/edit excerpt text. Pure functions from `lens-content-processor` handle wikilink parsing, article excerpt extraction, and video timestamp processing.

**Tech Stack:** React, React Router, CodeMirror, yjs, Y-Sweet, lens-content-processor, react-markdown, Tailwind CSS, vitest

---

## File Structure

**New files:**

```
src/lib/constants.ts                      — RELAY_ID and folder config (extracted from App.tsx)
src/lib/parseFields.ts                    — Extract field:: values from section content
src/lib/parseFields.test.ts               — Tests for parseFields
src/lib/resolveDocPath.ts                 — Resolve wikilink paths to relay doc UUIDs via folder metadata
src/lib/resolveDocPath.test.ts            — Tests for resolveDocPath
src/components/EduEditor/EduEditor.tsx    — Top-level route component, two-panel layout
src/components/EduEditor/ModulePanel.tsx  — Left panel: module tree with collapsible LOs/submodules
src/components/EduEditor/LensPanel.tsx    — Right panel: platform-style lens sections
src/components/EduEditor/ArticleEmbed.tsx — Article excerpt card with inline expansion + editing
src/components/EduEditor/VideoExcerptEmbed.tsx — Video transcript excerpt card
src/components/EduEditor/TutorInstructions.tsx — Chat instructions display
src/components/EduEditor/PowerToolbar.tsx — Edit/Preview/Feedback/Raw mode toolbar
```

**Modified files:**

```
src/components/SectionEditor/parseSections.ts     — Add submodule, question, video-excerpt, article-excerpt, page types
src/components/SectionEditor/parseSections.test.ts — Tests for new types
src/App.tsx                                        — Add /edu/:moduleDocId route, import RELAY_ID from constants
package.json                                       — Add react-markdown, lens-content-processor deps
```

---

### Task 1: Add lens-content-processor dependency and parseFields utility

This task wires up the content-processor package and creates the `parseFields` utility that extracts `field:: value` pairs from section content. This is the most-used utility across the entire feature — every section type has fields like `content::`, `source::`, `from::`, `to::`, `instructions::`, `optional::`.

**Files:**
- Modify: `package.json` — add `lens-content-processor` as file dependency
- Create: `src/lib/parseFields.ts`
- Create: `src/lib/parseFields.test.ts`

**Context:** The `lens-content-processor` package lives at `/home/penguin/code/lens-platform/ws2/content_processor/`. It exports `parseWikilink`, `extractArticleExcerpt`, `extractVideoExcerpt`, `parseTimestamp`, and related types. It has only `yaml` as a runtime dependency. It uses Node's `path` module for `resolveWikilinkPath` — we won't use that function (we do our own resolution via relay metadata). The functions we need (`parseWikilink`, `extractArticleExcerpt`, `extractVideoExcerpt`, `parseTimestamp`, `extractFromTimestamps`) are all pure string processing.

**Field syntax in Lens Edu docs:**
```
content:: This is the value
source:: [[../Lenses/Some Lens]]
from:: "Cascades are when"
to:: "neutron multiplication factor?_"
optional:: true
instructions:: Multi-line value that continues
until the next field or section boundary
```

Fields use `key:: value` syntax (double colon). Values can be:
- Single-line: `key:: value` (value is rest of line after `:: `)
- Quoted: `key:: "value with quotes"` (strip quotes)
- Multi-line: value continues on subsequent lines until next `key::` or end of section
- Wikilinks: `source:: [[../path]]` or `source:: ![[../path]]`

- [ ] **Step 1: Write failing tests for parseFields**

```typescript
// src/lib/parseFields.test.ts
import { describe, it, expect } from 'vitest';
import { parseFields, parseFrontmatterFields } from './parseFields';

describe('parseFields', () => {
  it('extracts single-line fields', () => {
    const text = 'content:: Hello world\nfrom:: "start text"';
    const fields = parseFields(text);
    expect(fields.get('content')).toBe('Hello world');
    expect(fields.get('from')).toBe('start text');
  });

  it('strips surrounding quotes from values', () => {
    const text = 'from:: "some quoted value"\nto:: "another"';
    const fields = parseFields(text);
    expect(fields.get('from')).toBe('some quoted value');
    expect(fields.get('to')).toBe('another');
  });

  it('extracts multi-line field values', () => {
    const text = 'instructions::\nLine 1\nLine 2\nLine 3';
    const fields = parseFields(text);
    expect(fields.get('instructions')).toBe('Line 1\nLine 2\nLine 3');
  });

  it('stops multi-line value at next field', () => {
    const text = 'content::\nParagraph one\nParagraph two\nfrom:: "anchor"';
    const fields = parseFields(text);
    expect(fields.get('content')).toBe('Paragraph one\nParagraph two');
    expect(fields.get('from')).toBe('anchor');
  });

  it('extracts wikilink from source field', () => {
    const text = 'source:: [[../Lenses/AI Control]]';
    const fields = parseFields(text);
    expect(fields.get('source')).toBe('[[../Lenses/AI Control]]');
  });

  it('extracts transclusion wikilink', () => {
    const text = 'source:: ![[../Learning Outcomes/Some LO]]';
    const fields = parseFields(text);
    expect(fields.get('source')).toBe('![[../Learning Outcomes/Some LO]]');
  });

  it('handles empty field value', () => {
    const text = 'from:: ""';
    const fields = parseFields(text);
    expect(fields.get('from')).toBe('');
  });

  it('returns empty map for text with no fields', () => {
    const text = 'Just some plain text\nwith no fields';
    const fields = parseFields(text);
    expect(fields.size).toBe(0);
  });

  it('handles optional boolean field', () => {
    const text = 'optional:: true\nsource:: [[../Lenses/Foo]]';
    const fields = parseFields(text);
    expect(fields.get('optional')).toBe('true');
  });

  it('handles field on first line after header', () => {
    const text = '#### Text\ncontent::\nSome text here';
    const fields = parseFields(text);
    expect(fields.get('content')).toBe('Some text here');
  });

  it('parseFrontmatterFields extracts YAML single-colon fields', () => {
    const text = '---\ntitle: Test Title\ntldr: Some summary here\nslug: test\n---\n';
    const fields = parseFrontmatterFields(text);
    expect(fields.get('tldr')).toBe('Some summary here');
    expect(fields.get('title')).toBe('Test Title');
    expect(fields.get('slug')).toBe('test');
  });

  it('parseFrontmatterFields handles quoted YAML values', () => {
    const text = '---\ntldr: "A quoted value"\n---\n';
    const fields = parseFrontmatterFields(text);
    expect(fields.get('tldr')).toBe('A quoted value');
  });

  it('handles multi-line content with blank lines', () => {
    const text = 'content::\nParagraph one\n\nParagraph two\n\nParagraph three';
    const fields = parseFields(text);
    expect(fields.get('content')).toBe('Paragraph one\n\nParagraph two\n\nParagraph three');
  });

  it('extracts source on same line with newline-separated wikilink', () => {
    const text = 'source::\n![[../Lenses/AI Control]]';
    const fields = parseFields(text);
    expect(fields.get('source')).toBe('![[../Lenses/AI Control]]');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd lens-editor && npx vitest run src/lib/parseFields.test.ts`
Expected: FAIL — `parseFields` module not found

- [ ] **Step 3: Install lens-content-processor dependency**

```bash
cd lens-editor && npm install --save ../../lens-platform/ws2/content_processor
```

Verify it installed:
```bash
node -e "const cp = require('lens-content-processor'); console.log(typeof cp.parseWikilink)"
```
Expected: `function`

If the package isn't built yet:
```bash
cd ../../lens-platform/ws2/content_processor && npm run build && cd ../../../lens-relay/ws3/lens-editor
```

- [ ] **Step 4: Implement parseFields**

```typescript
// src/lib/parseFields.ts

/**
 * Extract field:: value pairs from section content.
 *
 * Supports:
 * - Single-line: `key:: value`
 * - Quoted: `key:: "value"` (strips quotes)
 * - Multi-line: value continues on subsequent lines until next `key::` line
 * - Empty: `key:: ""` → empty string
 */
export function parseFields(text: string): Map<string, string> {
  const fields = new Map<string, string>();
  const lines = text.split('\n');

  let currentKey: string | null = null;
  let currentLines: string[] = [];

  for (const line of lines) {
    const fieldMatch = line.match(/^(\w[\w-]*)::(?:\s(.*))?$/);

    if (fieldMatch) {
      // Save previous field
      if (currentKey !== null) {
        fields.set(currentKey, finishValue(currentLines));
      }

      currentKey = fieldMatch[1];
      const rest = (fieldMatch[2] ?? '').trim();

      if (rest) {
        // Single-line value — strip quotes if present
        currentLines = [stripQuotes(rest)];
      } else {
        // Value starts on next line(s)
        currentLines = [];
      }
    } else if (currentKey !== null) {
      // Continuation line for multi-line value
      currentLines.push(line);
    }
  }

  // Save last field
  if (currentKey !== null) {
    fields.set(currentKey, finishValue(currentLines));
  }

  return fields;
}

/**
 * Extract key: value pairs from YAML frontmatter (single colon).
 * Simple line-by-line extraction — not a full YAML parser.
 * Handles only top-level scalar fields (not arrays/objects).
 */
export function parseFrontmatterFields(text: string): Map<string, string> {
  const fields = new Map<string, string>();
  const lines = text.split('\n');
  let inFrontmatter = false;

  for (const line of lines) {
    if (line.trim() === '---') {
      if (!inFrontmatter) { inFrontmatter = true; continue; }
      break; // closing ---
    }
    if (!inFrontmatter) continue;

    const match = line.match(/^(\w[\w-]*):\s+(.+)$/);
    if (match) {
      fields.set(match[1], stripQuotes(match[2].trim()));
    }
  }

  return fields;
}

function stripQuotes(s: string): string {
  if (s.startsWith('"') && s.endsWith('"')) {
    return s.slice(1, -1);
  }
  return s;
}

function finishValue(lines: string[]): string {
  // Trim trailing empty lines
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
    lines.pop();
  }
  // Trim leading empty lines
  while (lines.length > 0 && lines[0].trim() === '') {
    lines.shift();
  }
  return lines.join('\n');
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd lens-editor && npx vitest run src/lib/parseFields.test.ts`
Expected: all PASS

- [ ] **Step 6: Verify content-processor imports work**

Add a quick smoke test to verify the imported functions work:

```typescript
// Add to src/lib/parseFields.test.ts
import { parseWikilink } from 'lens-content-processor';

describe('content-processor integration', () => {
  it('parseWikilink works', () => {
    const result = parseWikilink('[[../Lenses/AI Control]]');
    expect(result).not.toBeNull();
    expect(result!.path).toBe('../Lenses/AI Control');
    expect(result!.isEmbed).toBeFalsy();
  });

  it('parseWikilink handles transclusion', () => {
    const result = parseWikilink('![[../Learning Outcomes/Foo]]');
    expect(result).not.toBeNull();
    expect(result!.path).toBe('../Learning Outcomes/Foo');
    expect(result!.isEmbed).toBe(true);
  });
});
```

Run: `cd lens-editor && npx vitest run src/lib/parseFields.test.ts`
Expected: all PASS

- [ ] **Step 7: Commit**

```bash
jj new -m "feat: parseFields utility + lens-content-processor integration"
```

---

### Task 2: Extend parseSections for Edu section types

Add `submodule`, `page`, `question`, `video-excerpt`, and `article-excerpt` section types to the existing `parseSections` classifier. These are needed for both the module tree (left panel) and lens content (right panel).

**Files:**
- Modify: `src/components/SectionEditor/parseSections.ts:128-156` (classifyHeader and cleanLabel)
- Modify: `src/components/SectionEditor/parseSections.test.ts`

**Context:** The existing `classifyHeader` checks `level === 4` for video/text/chat, then checks prefixes for lens/test/lo/module/meeting. We need to add:
- `submodule` (any level, title starts with "Submodule")
- `page` (any level, title starts with "Page")
- `question` (level 4, title is "Question")
- `video-excerpt` (level 4, title is "Video-excerpt")
- `article-excerpt` (level 4, title is "Article-excerpt")

- [ ] **Step 1: Write failing tests**

Add to `src/components/SectionEditor/parseSections.test.ts`:

```typescript
it('classifies submodule headers', () => {
  const text = '# Submodule: Welcome\nContent\n# Submodule: Testing\nMore';
  const sections = parseSections(text);
  expect(sections.map(s => s.type)).toEqual(['submodule', 'submodule']);
  expect(sections[0].label).toBe('Welcome');
  expect(sections[1].label).toBe('Testing');
});

it('classifies page headers at different levels', () => {
  const text = '# Page: Welcome\nContent\n## Page: Details\nMore';
  const sections = parseSections(text);
  expect(sections.map(s => s.type)).toEqual(['page', 'page']);
  expect(sections[0].label).toBe('Welcome');
});

it('classifies question sections', () => {
  const text = '#### Question\ncontent:: What is AI?';
  const sections = parseSections(text);
  expect(sections[0].type).toBe('question');
});

it('classifies video-excerpt sections', () => {
  const text = '#### Video-excerpt\nto:: 14:49';
  const sections = parseSections(text);
  expect(sections[0].type).toBe('video-excerpt');
});

it('classifies article-excerpt sections', () => {
  const text = '#### Article-excerpt\nfrom:: "start"\nto:: "end"';
  const sections = parseSections(text);
  expect(sections[0].type).toBe('article-excerpt');
});

it('classifies mixed edu sections in a module', () => {
  const text = [
    '# Submodule: Welcome',
    '## Page: Intro',
    '### Text',
    'content:: Hello',
    '# Learning Outcome:',
    'source:: ![[../LO/Test]]',
  ].join('\n');
  const sections = parseSections(text);
  expect(sections.map(s => s.type)).toEqual([
    'submodule', 'page', 'text', 'lo-ref',
  ]);
});

it('classifies ## Text and ## Chat at non-#### levels', () => {
  const text = '## Text\ncontent:: Hello\n## Chat\ninstructions:: Help';
  const sections = parseSections(text);
  expect(sections.map(s => s.type)).toEqual(['text', 'chat']);
});

it('classifies ### Text in modules', () => {
  const text = '### Text\ncontent:: Some framing text';
  const sections = parseSections(text);
  expect(sections[0].type).toBe('text');
});

it('handles CriticMarkup-wrapped Chat headers', () => {
  const text = '#### {--{"author":"AI","timestamp":123}@@Chat: Old Title--}{++{"author":"AI","timestamp":123}@@Chat++}\ninstructions:: Help';
  const sections = parseSections(text);
  expect(sections[0].type).toBe('chat');
  expect(sections[0].label).toBe('Chat');
});

it('classifies ### Article: and ### Video: as article-ref and video-ref', () => {
  const text = '### Article: Some Article\nsource:: [[../articles/foo]]\n### Video: Some Video\nsource:: [[../video_transcripts/bar]]';
  const sections = parseSections(text);
  expect(sections.map(s => s.type)).toEqual(['article-ref', 'video-ref']);
  expect(sections[0].label).toBe('Some Article');
  expect(sections[1].label).toBe('Some Video');
});

it('classifies mixed edu sections in a lens', () => {
  const text = [
    '### Article: Some Article',
    'source:: [[../articles/foo]]',
    '#### Text',
    'content:: Framing text',
    '#### Article-excerpt',
    'from:: "start"',
    'to:: "end"',
    '#### Chat',
    'instructions:: Help the user',
  ].join('\n');
  const sections = parseSections(text);
  expect(sections.map(s => s.type)).toEqual([
    'heading', 'text', 'article-excerpt', 'chat',
  ]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd lens-editor && npx vitest run src/components/SectionEditor/parseSections.test.ts`
Expected: FAIL — new types not classified yet

- [ ] **Step 3: Update classifyHeader and cleanLabel**

In `src/components/SectionEditor/parseSections.ts`, replace `classifyHeader` and `cleanLabel`:

```typescript
function classifyHeader(title: string, level: number): string {
  // Strip CriticMarkup tracked-change wrappers before classifying.
  // Production lenses have headers like:
  //   #### {--...@@Chat: Discussion on X-Risk--}{++...@@Chat++}
  // We extract the final accepted text (inside {++ ... ++}).
  const cleaned = stripCriticMarkup(title);
  const lower = cleaned.toLowerCase().replace(/:$/, '').trim();

  // These types can appear at any heading level (##, ###, ####)
  if (lower === 'video') return 'video';
  if (lower === 'video-excerpt') return 'video-excerpt';
  if (lower === 'article-excerpt') return 'article-excerpt';
  if (lower === 'text') return 'text';
  if (lower === 'chat' || lower.startsWith('chat')) return 'chat';
  if (lower === 'question') return 'question';

  if (lower.startsWith('submodule')) return 'submodule';
  if (lower.startsWith('page')) return 'page';
  if (lower.startsWith('article')) return 'article-ref';
  if (lower.startsWith('video')) return 'video-ref';
  if (lower.startsWith('lens')) return 'lens-ref';
  if (lower.startsWith('test')) return 'test-ref';
  if (lower.startsWith('learning outcome')) return 'lo-ref';
  if (lower.startsWith('module')) return 'module-ref';
  if (lower.startsWith('meeting')) return 'meeting-ref';

  return 'heading';
}

/**
 * Strip CriticMarkup from header text, keeping the accepted (++) version.
 * E.g., "{--old--}{++new++}" → "new"
 * If no CriticMarkup, returns the input unchanged.
 */
function stripCriticMarkup(text: string): string {
  // Remove deletions: {--...--}
  let result = text.replace(/\{--[\s\S]*?--\}/g, '');
  // Extract additions: {++...++} → keep inner content
  result = result.replace(/\{\+\+([\s\S]*?)\+\+\}/g, '$1');
  // Strip any @@-prefixed metadata markers left behind
  result = result.replace(/^.*?@@/, '');
  return result.trim() || text;
}

function cleanLabel(title: string, level: number): string {
  const cleaned = stripCriticMarkup(title);
  const lower = cleaned.toLowerCase().replace(/:$/, '').trim();

  if (lower === 'video') return 'Video';
  if (lower === 'video-excerpt') return 'Video Excerpt';
  if (lower === 'article-excerpt') return 'Article Excerpt';
  if (lower === 'text') return 'Text';
  if (lower === 'chat' || lower.startsWith('chat')) return cleaned.replace(/:$/, '').trim();
  if (lower === 'question') return 'Question';

  // For "# Submodule: Welcome" → "Welcome", "# Page: Intro" → "Intro"
  const colonIndex = cleaned.indexOf(':');
  if (colonIndex !== -1 && ['submodule', 'page', 'article', 'video'].includes(lower.split(':')[0].trim())) {
    return cleaned.slice(colonIndex + 1).trim();
  }

  // For reference sections like "# Lens:" or "## Test:", show cleaned title
  return cleaned.replace(/:$/, '').trim();
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd lens-editor && npx vitest run src/components/SectionEditor/parseSections.test.ts`
Expected: all PASS

- [ ] **Step 5: Run full test suite to check for regressions**

Run: `cd lens-editor && npx vitest run src/components/SectionEditor/`
Expected: all PASS (including existing parseSections and y-section-sync tests)

- [ ] **Step 6: Commit**

```bash
jj new -m "feat: extend parseSections for Edu types (submodule, page, question, article-excerpt, video-excerpt)"
```

---

### Task 3: Wikilink-to-UUID resolution utility

Create a utility that resolves wikilink paths (like `../Lenses/AI Control`) to relay doc UUIDs using the folder metadata already loaded in the app. This is needed for connecting to LO, Lens, and Article Y.Docs when users expand references.

**Files:**
- Create: `src/lib/resolveDocPath.ts`
- Create: `src/lib/resolveDocPath.test.ts`

**Context:** The app already loads folder metadata via `useMultiFolderMetadata` hook. The metadata is `Record<string, { id: string; type: string; ... }>` keyed by file path (e.g., `Lens Edu/Lenses/AI Control.md`). Wikilinks in Lens Edu docs use relative paths like `[[../Lenses/AI Control]]` — relative to the source doc's location in the vault.

The resolution algorithm:
1. Parse wikilink using `parseWikilink` from content-processor → get `path`
2. Resolve relative path against source doc's location → get absolute vault path
3. Look up vault path in folder metadata → get doc UUID

We can't use the content-processor's `resolveWikilinkPath` (uses Node's `path` module). We need a browser-compatible version.

- [ ] **Step 1: Write failing tests**

```typescript
// src/lib/resolveDocPath.test.ts
import { describe, it, expect } from 'vitest';
import { resolveWikilinkToUuid, resolveRelativePath } from './resolveDocPath';

describe('resolveRelativePath', () => {
  it('resolves sibling reference', () => {
    expect(resolveRelativePath('../Lenses/AI Control', 'Lens Edu/modules/feedback-loops.md'))
      .toBe('Lens Edu/Lenses/AI Control');
  });

  it('resolves same-directory reference', () => {
    expect(resolveRelativePath('../Learning Outcomes/Foom', 'Lens Edu/modules/feedback-loops.md'))
      .toBe('Lens Edu/Learning Outcomes/Foom');
  });

  it('resolves from LO to Lens', () => {
    expect(resolveRelativePath('../Lenses/Cascades and Cycles', 'Lens Edu/Learning Outcomes/Some LO.md'))
      .toBe('Lens Edu/Lenses/Cascades and Cycles');
  });

  it('resolves article reference from lens', () => {
    expect(resolveRelativePath('../articles/carlsmith-ai-for-ai-safety', 'Lens Edu/Lenses/AI for AI safety.md'))
      .toBe('Lens Edu/articles/carlsmith-ai-for-ai-safety');
  });

  it('resolves video transcript reference', () => {
    expect(resolveRelativePath('../video_transcripts/kurzgesagt-ai', 'Lens Edu/Lenses/Some Lens.md'))
      .toBe('Lens Edu/video_transcripts/kurzgesagt-ai');
  });
});

describe('resolveWikilinkToUuid', () => {
  const metadata: Record<string, { id: string; type?: string }> = {
    'Lens Edu/Lenses/AI Control.md': { id: 'abc-123' },
    'Lens Edu/Learning Outcomes/Some LO.md': { id: 'def-456' },
    'Lens Edu/articles/carlsmith-ai-for-ai-safety.md': { id: 'ghi-789' },
  };

  it('resolves wikilink to UUID', () => {
    const uuid = resolveWikilinkToUuid(
      '[[../Lenses/AI Control]]',
      'Lens Edu/modules/feedback-loops.md',
      metadata
    );
    expect(uuid).toBe('abc-123');
  });

  it('resolves transclusion to UUID', () => {
    const uuid = resolveWikilinkToUuid(
      '![[../Learning Outcomes/Some LO]]',
      'Lens Edu/modules/feedback-loops.md',
      metadata
    );
    expect(uuid).toBe('def-456');
  });

  it('returns null for unresolvable link', () => {
    const uuid = resolveWikilinkToUuid(
      '[[../Lenses/Nonexistent]]',
      'Lens Edu/modules/feedback-loops.md',
      metadata
    );
    expect(uuid).toBeNull();
  });

  it('tries with .md extension', () => {
    const uuid = resolveWikilinkToUuid(
      '[[../articles/carlsmith-ai-for-ai-safety]]',
      'Lens Edu/Lenses/AI for AI safety.md',
      metadata
    );
    expect(uuid).toBe('ghi-789');
  });

  it('returns null for malformed wikilink', () => {
    const uuid = resolveWikilinkToUuid(
      'not a wikilink',
      'Lens Edu/modules/foo.md',
      metadata
    );
    expect(uuid).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd lens-editor && npx vitest run src/lib/resolveDocPath.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement resolveDocPath**

```typescript
// src/lib/resolveDocPath.ts
import { parseWikilink } from 'lens-content-processor';

/**
 * Resolve a relative path against a source file's directory.
 * Browser-compatible alternative to Node's path.resolve.
 *
 * Example: resolveRelativePath('../Lenses/AI Control', 'Lens Edu/modules/feedback-loops.md')
 *       → 'Lens Edu/Lenses/AI Control'
 */
export function resolveRelativePath(relativePath: string, sourceFile: string): string {
  // Get source directory: 'Lens Edu/modules/feedback-loops.md' → 'Lens Edu/modules'
  const lastSlash = sourceFile.lastIndexOf('/');
  const sourceDir = lastSlash !== -1 ? sourceFile.slice(0, lastSlash) : '';

  // Split both into segments
  const baseParts = sourceDir ? sourceDir.split('/') : [];
  const relParts = relativePath.split('/');

  // Process relative segments
  const result = [...baseParts];
  for (const part of relParts) {
    if (part === '..') {
      result.pop();
    } else if (part !== '.' && part !== '') {
      result.push(part);
    }
  }

  return result.join('/');
}

/**
 * Resolve a wikilink string to a relay doc UUID using folder metadata.
 *
 * @param wikilinkText - Raw wikilink like '[[../Lenses/AI Control]]' or '![[../LOs/Foo]]'
 * @param sourceFile - Path of the file containing the wikilink (e.g., 'Lens Edu/modules/feedback-loops.md')
 * @param metadata - Folder metadata: Record<path, { id: string; ... }>
 * @returns Doc UUID or null if not found
 */
export function resolveWikilinkToUuid(
  wikilinkText: string,
  sourceFile: string,
  metadata: Record<string, { id: string; [key: string]: unknown }>
): string | null {
  const parsed = parseWikilink(wikilinkText.trim());
  if (!parsed || parsed.error || !parsed.path) return null;

  const resolved = resolveRelativePath(parsed.path, sourceFile);

  // Try exact match
  if (metadata[resolved]) return metadata[resolved].id;

  // Try with .md extension
  const withMd = resolved + '.md';
  if (metadata[withMd]) return metadata[withMd].id;

  return null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd lens-editor && npx vitest run src/lib/resolveDocPath.test.ts`
Expected: all PASS

- [ ] **Step 5: Commit**

```bash
jj new -m "feat: resolveDocPath utility — wikilink-to-UUID resolution via folder metadata"
```

---

### Task 4: EduEditor route and two-panel layout shell

Create the top-level `EduEditor` component with the two-panel layout and wire up the `/edu/:moduleDocId` route. This task creates the skeleton — left panel shows "Module Structure" header, right panel shows "Select a lens" placeholder. The panels are populated in subsequent tasks.

**Files:**
- Create: `src/components/EduEditor/EduEditor.tsx`
- Modify: `src/App.tsx` — add route

**Context:** The route URL is `/edu/:moduleDocId` where `moduleDocId` is a short UUID (8+ chars). It follows the same resolution pattern as `MultiDocSectionEditorView` in App.tsx — prefix-match against metadata to get the full compound doc ID. The component connects to the module's Y.Doc and provides it as context for the child panels.

- [ ] **Step 1: Create EduEditor component**

```typescript
// src/components/EduEditor/EduEditor.tsx
import { useEffect, useState, useCallback } from 'react';
import { useDocConnection } from '../../hooks/useDocConnection';
import { parseSections } from '../SectionEditor/parseSections';
import type { Section } from '../SectionEditor/parseSections';

interface EduEditorProps {
  moduleDocId: string;  // Full compound doc ID
}

export function EduEditor({ moduleDocId }: EduEditorProps) {
  const { getOrConnect, disconnectAll } = useDocConnection();
  const [moduleSections, setModuleSections] = useState<Section[]>([]);
  const [synced, setSynced] = useState(false);
  const [selectedLensDocId, setSelectedLensDocId] = useState<string | null>(null);

  // Connect to module doc and observe changes
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

      return () => {
        ytext.unobserve(update);
      };
    }

    const cleanupPromise = connect();
    return () => {
      cancelled = true;
      cleanupPromise.then(cleanup => cleanup?.());
    };
  }, [moduleDocId, getOrConnect]);

  // Cleanup all connections on unmount
  useEffect(() => disconnectAll, [disconnectAll]);

  const handleSelectLens = useCallback((docId: string) => {
    setSelectedLensDocId(docId);
  }, []);

  if (!synced) {
    return (
      <div className="h-full flex items-center justify-center text-gray-400 text-sm">
        Connecting to module...
      </div>
    );
  }

  return (
    <div className="h-full flex">
      {/* Left panel: Module structure */}
      <div className="w-[340px] min-w-[340px] border-r-2 border-gray-200 bg-white overflow-y-auto p-4">
        <div className="text-[11px] uppercase tracking-wider text-gray-500 font-semibold mb-3 pb-2 border-b border-gray-200">
          Module Structure
        </div>
        <div className="text-sm text-gray-500">
          {moduleSections.length} sections loaded
        </div>
        {/* ModulePanel goes here in Task 5 */}
      </div>

      {/* Right panel: Lens content */}
      <div className="flex-1 overflow-y-auto" style={{ background: '#faf8f3' }}>
        <div className="max-w-[720px] mx-auto py-8 px-10">
          {selectedLensDocId ? (
            <div className="text-sm text-gray-500">
              Lens panel placeholder — doc {selectedLensDocId}
            </div>
          ) : (
            <div className="flex items-center justify-center h-48 text-gray-400 text-sm border-2 border-dashed border-gray-200 rounded-lg">
              Select a lens from the module structure
            </div>
          )}
          {/* LensPanel goes here in Task 6 */}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Add route in App.tsx**

In `src/App.tsx`, add the import at the top:

```typescript
import { EduEditor } from './components/EduEditor/EduEditor';
```

Add a new view component (after `MultiDocSectionEditorView`):

```typescript
function EduEditorView() {
  const { docUuid } = useParams<{ docUuid: string }>();
  const { metadata } = useNavigation();

  if (!docUuid) {
    return (
      <main className="flex-1 flex items-center justify-center bg-gray-50">
        <p className="text-gray-500">Provide a module UUID: /edu/:moduleDocId</p>
      </main>
    );
  }

  // Resolve short UUID to full compound doc ID (same pattern as MultiDocSectionEditorView)
  const shortCompoundId = `${RELAY_ID}-${docUuid}`;
  let resolvedId: string | null = null;

  if (shortCompoundId.length >= 73) {
    resolvedId = shortCompoundId;
  } else {
    const docPrefix = shortCompoundId.slice(37);
    for (const meta of Object.values(metadata)) {
      if (meta.id.startsWith(docPrefix)) {
        resolvedId = `${RELAY_ID}-${meta.id}`;
        break;
      }
    }
  }

  if (!resolvedId) {
    return (
      <main className="flex-1 flex items-center justify-center bg-gray-50">
        <div className="text-sm text-gray-500">Resolving module document...</div>
      </main>
    );
  }

  return <EduEditor moduleDocId={resolvedId} />;
}
```

Add the route before the section-editor route:

```tsx
<Route path="/edu/:docUuid" element={<EduEditorView />} />
<Route path="/section-editor/:docUuid" element={<MultiDocSectionEditorView />} />
```

- [ ] **Step 3: Verify the route works**

Start the dev server (`npm run dev:local`), navigate to `/edu/<module-doc-uuid>` in the browser. Verify:
- The two-panel layout renders
- Left panel shows "Module Structure" header and section count
- Right panel shows "Select a lens" placeholder
- No console errors

- [ ] **Step 4: Commit**

```bash
jj new -m "feat: EduEditor route + two-panel layout shell"
```

---

### Task 5: ModulePanel — left panel tree rendering

Populate the left panel with the module's section tree. Shows frontmatter, submodule groups (collapsible), page headers, text previews, LO blocks (expandable — connects to LO doc to show its lens references), and lens ref cards (clickable → loads lens in right panel).

**Files:**
- Create: `src/components/EduEditor/ModulePanel.tsx`
- Modify: `src/components/EduEditor/EduEditor.tsx` — use ModulePanel

**Context:** The module doc's sections from `parseSections` include types like `submodule`, `page`, `text`, `lo-ref`, `lens-ref`, `meeting-ref`, `frontmatter`. The tree structure comes from heading levels — `#` headers (submodule, page, lo-ref) are top-level, `##`+ headers under them are children.

LO expansion is the complex part: when the user clicks an LO block, we need to:
1. Extract the `source::` wikilink from the LO section content using `parseFields`
2. Resolve it to a doc UUID using `resolveWikilinkToUuid`
3. Connect to the LO's Y.Doc
4. Parse the LO doc's sections (which contain `lens-ref`, `test-ref`, `submodule` sections)
5. Render them nested under the LO block

- [ ] **Step 1: Create ModulePanel component**

```typescript
// src/components/EduEditor/ModulePanel.tsx
import { useState, useEffect, useCallback } from 'react';
import type { Section } from '../SectionEditor/parseSections';
import { parseSections } from '../SectionEditor/parseSections';
import { parseFields } from '../../lib/parseFields';
import { resolveWikilinkToUuid } from '../../lib/resolveDocPath';
import { useDocConnection } from '../../hooks/useDocConnection';
import { useNavigation } from '../../contexts/NavigationContext';
import { RELAY_ID } from '../../lib/constants';

interface ModulePanelProps {
  sections: Section[];
  sourcePath: string;  // e.g., 'Lens Edu/modules/feedback-loops.md'
  onSelectLens: (compoundDocId: string, lensName: string) => void;
  activeLensDocId: string | null;
}

// Badge colors by section type
const BADGE_STYLES: Record<string, string> = {
  frontmatter: 'bg-gray-100 text-gray-500',
  submodule: 'bg-purple-100 text-purple-700',
  page: 'bg-purple-100 text-purple-700',
  text: 'bg-indigo-100 text-indigo-700',
  chat: 'bg-green-100 text-green-700',
  'lo-ref': 'bg-amber-100 text-amber-700',
  'lens-ref': 'bg-blue-100 text-blue-700',
  'test-ref': 'bg-red-100 text-red-700',
  'meeting-ref': 'bg-gray-100 text-gray-600',
  question: 'bg-orange-100 text-orange-700',
  heading: 'bg-gray-100 text-gray-600',
};

function Badge({ type }: { type: string }) {
  const style = BADGE_STYLES[type] ?? 'bg-gray-100 text-gray-600';
  const label = type.replace(/-ref$/, '').replace(/-/g, ' ');
  return (
    <span className={`text-[10px] px-[7px] py-[2px] rounded font-semibold ${style}`}>
      {label}
    </span>
  );
}

function SectionItem({ section, children }: { section: Section; children?: React.ReactNode }) {
  return (
    <div className="mb-1.5">
      <div className="px-3 py-2.5 rounded-md border border-gray-200 bg-white cursor-pointer hover:border-blue-300 hover:bg-gray-50 transition-all text-[13px]">
        <Badge type={section.type} />
        <div className="font-medium text-gray-700 mt-1">{section.label}</div>
        {section.type === 'text' && (
          <div className="text-xs text-gray-400 mt-1 line-clamp-2">
            {section.content.slice(0, 200)}
          </div>
        )}
      </div>
      {children}
    </div>
  );
}

function LensRefCard({
  section,
  loSourcePath,
  onSelectLens,
  activeLensDocId,
}: {
  section: Section;
  loSourcePath: string | null;
  onSelectLens: (docId: string, name: string) => void;
  activeLensDocId: string | null;
}) {
  const { metadata } = useNavigation();
  const lensFields = parseFields(section.content);
  const lensSource = lensFields.get('source');
  const lensUuid = lensSource && loSourcePath
    ? resolveWikilinkToUuid(lensSource.trim(), loSourcePath, metadata)
    : null;
  const lensName = lensSource
    ? lensSource.replace(/^!?\[\[/, '').replace(/\]\]$/, '').split('/').pop()?.split('|')[0] ?? 'Lens'
    : 'Lens';
  const compoundId = lensUuid ? `${RELAY_ID}-${lensUuid}` : null;
  const isActive = compoundId === activeLensDocId;
  const isOptional = lensFields.get('optional') === 'true';

  return (
    <div
      onClick={() => compoundId && onSelectLens(compoundId, lensName)}
      className={`px-2.5 py-1.5 mt-1 rounded border cursor-pointer flex items-center gap-1.5 transition-all ${
        isActive
          ? 'border-blue-500 border-2 bg-blue-100'
          : 'border-blue-200 bg-blue-50 hover:border-blue-400 hover:bg-blue-100'
      }`}
    >
      <Badge type="lens-ref" />
      <span className="text-xs text-blue-700 font-medium">{lensName}</span>
      {isOptional && <span className="text-[10px] text-gray-400">(optional)</span>}
      <span className="text-blue-300 text-sm ml-auto">&rarr;</span>
    </div>
  );
}

function LOBlock({
  section,
  sourcePath,
  onSelectLens,
  activeLensDocId,
}: {
  section: Section;
  sourcePath: string;
  onSelectLens: (docId: string, name: string) => void;
  activeLensDocId: string | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const [loSections, setLoSections] = useState<Section[]>([]);
  const [loSourcePath, setLoSourcePath] = useState<string | null>(null);
  const { getOrConnect } = useDocConnection();
  const { metadata } = useNavigation();

  const handleExpand = useCallback(async () => {
    if (expanded) {
      setExpanded(false);
      return;
    }
    setExpanded(true);

    // Extract source:: wikilink from section content
    const fields = parseFields(section.content);
    const sourceField = fields.get('source');
    if (!sourceField) return;

    const uuid = resolveWikilinkToUuid(sourceField.trim(), sourcePath, metadata);
    if (!uuid) return;

    // Find the path for this LO doc in metadata
    const loPath = Object.entries(metadata).find(([, m]) => m.id === uuid)?.[0] ?? null;
    setLoSourcePath(loPath);

    const compoundId = `${RELAY_ID}-${uuid}`;
    const { doc } = await getOrConnect(compoundId);
    const ytext = doc.getText('contents');

    const update = () => setLoSections(parseSections(ytext.toString()));
    update();
    ytext.observe(update);
  }, [expanded, section, sourcePath, metadata, getOrConnect]);

  // Extract LO name from wikilink for display
  const fields = parseFields(section.content);
  const sourceField = fields.get('source');
  const loName = sourceField
    ? sourceField.replace(/^!?\[\[/, '').replace(/\]\]$/, '').split('/').pop()?.split('|')[0] ?? 'Learning Outcome'
    : 'Learning Outcome';

  return (
    <div className={`mb-3 p-2.5 rounded-md border ${expanded ? 'border-amber-400 border-2' : 'border-amber-200'} bg-amber-50/50`}>
      <div className="cursor-pointer" onClick={handleExpand}>
        <div className="text-xs font-semibold text-amber-700 mb-1">Learning Outcome</div>
        <div className="text-xs text-stone-500 italic">{loName}</div>
      </div>

      {expanded && loSections.length > 0 && (
        <div className="mt-2 ml-4 border-l-2 border-amber-200 pl-3">
          {(() => {
            // Build a set of indices that belong to submodule groups
            // so we don't render them as standalone items
            const submoduleChildIndices = new Set<number>();
            for (let idx = 0; idx < loSections.length; idx++) {
              if (loSections[idx].type === 'submodule') {
                for (let j = idx + 1; j < loSections.length; j++) {
                  if (loSections[j].type === 'submodule') break;
                  submoduleChildIndices.add(j);
                }
              }
            }

            return loSections.map((s, i) => {
              if (s.type === 'frontmatter') return null;
              // Skip sections that are children of a submodule group
              if (submoduleChildIndices.has(i)) return null;

              if (s.type === 'lens-ref') {
                // Only renders for ungrouped lens-refs (not inside a submodule)
                return <LensRefCard key={i} section={s} loSourcePath={loSourcePath}
                  onSelectLens={onSelectLens} activeLensDocId={activeLensDocId} />;
              }

              if (s.type === 'submodule') {
                return (
                  <SubmoduleGroup key={i} section={s} loSections={loSections} startIndex={i}
                    loSourcePath={loSourcePath} onSelectLens={onSelectLens} activeLensDocId={activeLensDocId} />
                );
              }

              if (s.type === 'test-ref') {
                return (
                  <div key={i} className="mb-1">
                    <SectionItem section={s} />
                  </div>
                );
              }

              return null;
            });
          })()}
        </div>
      )}
    </div>
  );
}

function SubmoduleGroup({
  section,
  loSections,
  startIndex,
  loSourcePath,
  onSelectLens,
  activeLensDocId,
}: {
  section: Section;
  loSections: Section[];
  startIndex: number;
  loSourcePath: string | null;
  onSelectLens: (docId: string, name: string) => void;
  activeLensDocId: string | null;
}) {
  const [collapsed, setCollapsed] = useState(true);
  const { metadata } = useNavigation();

  // Collect children: sections between this submodule and the next submodule (or end)
  const children: Section[] = [];
  for (let i = startIndex + 1; i < loSections.length; i++) {
    if (loSections[i].type === 'submodule') break;
    children.push(loSections[i]);
  }

  return (
    <div className="mb-2">
      <div
        className="flex items-center gap-1.5 px-2 py-1.5 cursor-pointer text-xs text-purple-700 font-semibold hover:bg-purple-50 rounded"
        onClick={() => setCollapsed(!collapsed)}
      >
        <span className="text-purple-400">{collapsed ? '▸' : '▾'}</span>
        {section.label}
        <span className="text-purple-300 ml-1 font-normal">({children.filter(c => c.type === 'lens-ref').length} lenses)</span>
      </div>

      {!collapsed && (
        <div className="ml-3 mt-1">
          {children.map((s, i) => {
            if (s.type === 'lens-ref') {
              return <LensRefCard key={i} section={s} loSourcePath={loSourcePath}
                onSelectLens={onSelectLens} activeLensDocId={activeLensDocId} />;
            }
            if (s.type === 'test-ref') {
              return <SectionItem key={i} section={s} />;
            }
            return null;
          })}
        </div>
      )}
    </div>
  );
}

export function ModulePanel({ sections, sourcePath, onSelectLens, activeLensDocId }: ModulePanelProps) {
  return (
    <div>
      {sections.map((section, i) => {
        if (section.type === 'frontmatter') {
          return (
            <div key={i} className="mb-1.5 opacity-70">
              <div className="px-3 py-2 rounded-md border border-gray-200 bg-white text-[11px] text-gray-400 font-mono">
                <Badge type="frontmatter" />
                <div className="mt-1">{section.content.slice(4, 80)}...</div>
              </div>
            </div>
          );
        }

        if (section.type === 'lo-ref') {
          return (
            <LOBlock
              key={i}
              section={section}
              sourcePath={sourcePath}
              onSelectLens={onSelectLens}
              activeLensDocId={activeLensDocId}
            />
          );
        }

        if (section.type === 'submodule') {
          // Top-level submodule in module (not inside LO)
          return <SectionItem key={i} section={section} />;
        }

        if (section.type === 'page' || section.type === 'text' || section.type === 'heading') {
          return (
            <div key={i} className={section.type === 'text' ? 'ml-4 border-l-2 border-gray-200 pl-3' : ''}>
              <SectionItem section={section} />
            </div>
          );
        }

        if (section.type === 'meeting-ref') {
          return <SectionItem key={i} section={section} />;
        }

        return <SectionItem key={i} section={section} />;
      })}
    </div>
  );
}
```

- [ ] **Step 2: Wire ModulePanel into EduEditor**

In `src/components/EduEditor/EduEditor.tsx`, replace the placeholder left panel content with `<ModulePanel>`:

```typescript
import { ModulePanel } from './ModulePanel';
```

Add `selectedLensName` state:
```typescript
const [selectedLensName, setSelectedLensName] = useState<string | null>(null);
```

Update `handleSelectLens`:
```typescript
const handleSelectLens = useCallback((docId: string, name: string) => {
  setSelectedLensDocId(docId);
  setSelectedLensName(name);
}, []);
```

We also need to know the module's file path in the vault (for wikilink resolution). Add a `sourcePath` prop to EduEditor or derive it from metadata. Add to `EduEditorProps`:
```typescript
interface EduEditorProps {
  moduleDocId: string;
  sourcePath?: string;  // e.g., 'Lens Edu/modules/feedback-loops.md'
}
```

In `EduEditorView` in App.tsx, find the path from metadata:
```typescript
// After resolvedId is found, find the source path
const docUuidFull = resolvedId.slice(RELAY_ID.length + 1);
const sourcePath = Object.entries(metadata).find(([, m]) => m.id === docUuidFull)?.[0] ?? '';

return <EduEditor moduleDocId={resolvedId} sourcePath={sourcePath} />;
```

Replace the left panel placeholder in EduEditor:
```tsx
<ModulePanel
  sections={moduleSections}
  sourcePath={sourcePath ?? ''}
  onSelectLens={handleSelectLens}
  activeLensDocId={selectedLensDocId}
/>
```

- [ ] **Step 3: Verify in browser**

Navigate to `/edu/<module-uuid>`. Verify:
- Module sections render as cards in the left panel
- LO blocks are clickable and expand to show nested lens refs
- Lens ref cards show the lens name
- Submodule groups collapse/expand
- No console errors

- [ ] **Step 4: Commit**

```bash
jj new -m "feat: ModulePanel — left panel tree with LO expansion and lens selection"
```

---

### Task 6: LensPanel — right panel with platform-style rendering

Create the right panel that renders the selected lens's sections in the platform's visual style. Text sections render markdown, chat sections show tutor instructions, article-excerpt sections show as embed cards (article expansion comes in Task 7). All sections are editable on click via inline CM editors.

**Files:**
- Create: `src/components/EduEditor/LensPanel.tsx`
- Create: `src/components/EduEditor/TutorInstructions.tsx`
- Create: `src/components/EduEditor/PowerToolbar.tsx`
- Modify: `src/components/EduEditor/EduEditor.tsx` — wire in LensPanel
- Modify: `package.json` — add react-markdown

- [ ] **Step 1: Install react-markdown**

```bash
cd lens-editor && npm install react-markdown
```

- [ ] **Step 2: Create PowerToolbar**

```typescript
// src/components/EduEditor/PowerToolbar.tsx

interface PowerToolbarProps {
  lensFileName: string;
}

export function PowerToolbar({ lensFileName }: PowerToolbarProps) {
  return (
    <div className="flex items-center gap-2 mb-6 px-3 py-2 bg-white rounded-lg border border-[#e8e5df] text-xs text-gray-500">
      <span className="px-2.5 py-0.5 rounded-xl bg-gray-900 text-white font-medium">Edit</span>
      <span className="px-2.5 py-0.5 rounded-xl bg-gray-100 font-medium cursor-pointer hover:bg-gray-200">Preview</span>
      <div className="w-px h-4 bg-gray-200" />
      <span className="px-2.5 py-0.5 rounded-xl bg-gray-100 font-medium cursor-pointer hover:bg-gray-200">Feedback</span>
      <span className="px-2.5 py-0.5 rounded-xl bg-gray-100 font-medium cursor-pointer hover:bg-gray-200">Raw</span>
      <span className="ml-auto text-[11px] text-gray-400">{lensFileName}</span>
    </div>
  );
}
```

- [ ] **Step 3: Create TutorInstructions**

```typescript
// src/components/EduEditor/TutorInstructions.tsx
import ReactMarkdown from 'react-markdown';

interface TutorInstructionsProps {
  title: string;
  instructions: string;
  onEdit?: () => void;
}

export function TutorInstructions({ title, instructions, onEdit }: TutorInstructionsProps) {
  return (
    <div
      className="mb-7 p-4 bg-green-50 border border-green-200 rounded-lg relative group cursor-pointer hover:outline hover:outline-2 hover:outline-blue-300/30 hover:outline-offset-1"
      onClick={onEdit}
    >
      <div className="absolute -top-2 -right-2 bg-blue-500 text-white text-[10px] px-2 py-0.5 rounded font-medium opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
        click to edit
      </div>
      <div className="flex items-center gap-1.5 text-xs font-semibold text-green-800 uppercase tracking-wider mb-2.5">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
        Tutor Instructions — {title}
      </div>
      <div className="text-[13px] text-gray-700 leading-relaxed prose prose-sm prose-green max-w-none">
        <ReactMarkdown>{instructions}</ReactMarkdown>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Create LensPanel**

```typescript
// src/components/EduEditor/LensPanel.tsx
import { useEffect, useState, useRef, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import type { EditorView } from 'codemirror';
import type { Section } from '../SectionEditor/parseSections';
import { parseSections } from '../SectionEditor/parseSections';
import { parseFields } from '../../lib/parseFields';
import { createSectionEditorView } from '../SectionEditor/createSectionEditorView';
import { useDocConnection } from '../../hooks/useDocConnection';
import { PowerToolbar } from './PowerToolbar';
import { TutorInstructions } from './TutorInstructions';
import * as Y from 'yjs';

interface LensPanelProps {
  lensDocId: string;
  lensName: string;
}

export function LensPanel({ lensDocId, lensName }: LensPanelProps) {
  const { getOrConnect } = useDocConnection();
  const [sections, setSections] = useState<Section[]>([]);
  const [synced, setSynced] = useState(false);
  const [frontmatter, setFrontmatter] = useState<Map<string, string>>(new Map());
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const ytextRef = useRef<Y.Text | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const mountRef = useRef<HTMLDivElement>(null);

  // Connect to lens doc
  useEffect(() => {
    let cancelled = false;

    async function connect() {
      const { doc, provider } = await getOrConnect(lensDocId);
      if (cancelled) return;

      const ytext = doc.getText('contents');
      ytextRef.current = ytext;

      const update = () => {
        const text = ytext.toString();
        const parsed = parseSections(text);
        setSections(parsed);

        // Extract frontmatter fields (YAML uses single colon, not double)
        const fmSection = parsed.find(s => s.type === 'frontmatter');
        if (fmSection) {
          setFrontmatter(parseFrontmatterFields(fmSection.content));
        }
      };

      setSynced(true);
      update();
      ytext.observe(update);

      return () => {
        ytext.unobserve(update);
      };
    }

    setSynced(false);
    setSections([]);
    setEditingIndex(null);
    const cleanupPromise = connect();
    return () => {
      cancelled = true;
      cleanupPromise.then(cleanup => cleanup?.());
    };
  }, [lensDocId, getOrConnect]);

  // Create/destroy CM editor when editingIndex changes
  useEffect(() => {
    if (viewRef.current) {
      viewRef.current.destroy();
      viewRef.current = null;
    }
    if (editingIndex === null || !mountRef.current || !ytextRef.current) return;

    const ytext = ytextRef.current;
    const freshSections = parseSections(ytext.toString());
    const section = freshSections[editingIndex];
    if (!section) return;

    const view = createSectionEditorView({
      ytext,
      sectionFrom: section.from,
      sectionTo: section.to,
      parent: mountRef.current,
    });

    viewRef.current = view;
    requestAnimationFrame(() => view.focus());

    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [editingIndex]);

  const deactivate = useCallback(() => setEditingIndex(null), []);

  if (!synced) {
    return (
      <div className="flex items-center justify-center h-48 text-gray-400 text-sm">
        Loading lens...
      </div>
    );
  }

  const tldr = frontmatter.get('tldr');

  return (
    <div>
      <PowerToolbar lensFileName={`${lensName}.md`} />

      {/* TL;DR */}
      {tldr && (
        <div className="mb-6 p-3 bg-white rounded-lg border border-[#e8e5df] text-[13px] text-gray-500 leading-relaxed">
          <strong className="text-[#b87018]">TL;DR:</strong> {tldr}
        </div>
      )}

      {/* Sections */}
      {sections.map((section, i) => {
        if (section.type === 'frontmatter') return null;

        const fields = parseFields(section.content);

        // Editing state
        if (editingIndex === i) {
          return (
            <div key={i} className="mb-7 rounded-lg border-2 border-blue-400 bg-white overflow-hidden">
              <div className="flex items-center justify-between px-4 py-2 bg-blue-50 border-b border-blue-200">
                <span className="font-medium text-sm text-blue-700">{section.label}</span>
                <button onClick={deactivate}
                  className="text-xs px-2 py-1 bg-blue-100 hover:bg-blue-200 text-blue-600 rounded">
                  Done
                </button>
              </div>
              <div ref={mountRef} style={{ minHeight: '60px' }} />
            </div>
          );
        }

        // Text section
        if (section.type === 'text') {
          const content = fields.get('content') ?? '';
          // Check if it looks like a discussion question (short, ends with ?)
          const isQuestion = content.trim().length < 500 && content.trim().endsWith('?');

          if (isQuestion) {
            return (
              <div key={i} className="mb-7 relative group cursor-pointer hover:outline hover:outline-2 hover:outline-blue-300/30 hover:outline-offset-1 rounded-lg"
                onClick={() => setEditingIndex(i)}>
                <div className="absolute -top-2 -right-2 bg-blue-500 text-white text-[10px] px-2 py-0.5 rounded font-medium opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
                  click to edit
                </div>
                <div className="p-4 bg-white rounded-lg border border-[#e8e5df]" style={{ fontFamily: "'Newsreader', serif", fontSize: '17px', fontStyle: 'italic', lineHeight: 1.6, color: '#44403c' }}>
                  {content}
                </div>
              </div>
            );
          }

          return (
            <div key={i} className="mb-7 relative group cursor-pointer hover:outline hover:outline-2 hover:outline-blue-300/30 hover:outline-offset-1 rounded-md"
              onClick={() => setEditingIndex(i)}>
              <div className="absolute -top-2 -right-2 bg-blue-500 text-white text-[10px] px-2 py-0.5 rounded font-medium opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
                click to edit
              </div>
              <div className="text-[15px] leading-[1.75] text-gray-900 prose prose-sm max-w-none" style={{ fontFamily: "'DM Sans', sans-serif" }}>
                <ReactMarkdown>{content}</ReactMarkdown>
              </div>
            </div>
          );
        }

        // Chat section
        if (section.type === 'chat') {
          const instructions = fields.get('instructions') ?? '';
          return (
            <TutorInstructions
              key={i}
              title={section.label}
              instructions={instructions}
              onEdit={() => setEditingIndex(i)}
            />
          );
        }

        // Article-excerpt section (placeholder — full implementation in Task 7)
        if (section.type === 'article-excerpt') {
          const from = fields.get('from') ?? '';
          const to = fields.get('to') ?? '';
          return (
            <div key={i} className="mb-7 rounded-xl border border-[rgba(184,112,24,0.15)] overflow-hidden shadow-[0_1px_4px_0_rgba(0,0,0,0.06)]"
              style={{ background: 'rgba(184, 112, 24, 0.04)' }}>
              <div className="px-6 py-4 border-b border-[rgba(184,112,24,0.1)]">
                <div style={{ fontFamily: "'Newsreader', serif", fontSize: '20px', fontWeight: 600, color: '#1a1a1a' }}>
                  Article Excerpt
                </div>
              </div>
              <div className="px-6 py-5 text-sm text-gray-600 relative group cursor-pointer hover:outline hover:outline-2 hover:outline-blue-300/30 hover:outline-offset-1 rounded"
                onClick={() => setEditingIndex(i)}>
                <div className="absolute -top-2 -right-2 bg-blue-500 text-white text-[10px] px-2 py-0.5 rounded font-medium opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
                  click to edit
                </div>
                <div className="text-gray-400 tracking-wider mb-1">&hellip;</div>
                <div className="text-gray-700">
                  {from && <span className="font-mono text-xs text-amber-700">from:: {from}</span>}
                  {to && <span className="font-mono text-xs text-amber-700 ml-4">to:: {to}</span>}
                </div>
                <div className="text-gray-400 tracking-wider mt-1">&hellip;</div>
              </div>
            </div>
          );
        }

        // Video-excerpt section (placeholder — full implementation in Task 7)
        if (section.type === 'video-excerpt') {
          const from = fields.get('from') ?? '';
          const to = fields.get('to') ?? '';
          return (
            <div key={i} className="mb-7 rounded-xl border border-[rgba(184,112,24,0.15)] overflow-hidden shadow-[0_1px_4px_0_rgba(0,0,0,0.06)]"
              style={{ background: 'rgba(184, 112, 24, 0.04)' }}
              onClick={() => setEditingIndex(i)}>
              <div className="px-6 py-4 border-b border-[rgba(184,112,24,0.1)]">
                <div style={{ fontFamily: "'Newsreader', serif", fontSize: '20px', fontWeight: 600, color: '#1a1a1a' }}>
                  Video Excerpt
                </div>
                <div className="text-xs text-gray-500 mt-1">
                  {from && `from: ${from}`} {to && `to: ${to}`}
                </div>
              </div>
              <div className="px-6 py-4 text-sm text-gray-400 italic">
                Video transcript excerpt — expand to view
              </div>
            </div>
          );
        }

        // Question section
        if (section.type === 'question') {
          const content = fields.get('content') ?? '';
          const assessmentInstructions = fields.get('assessment-instructions');
          const enforceVoice = fields.get('enforce-voice');
          const maxChars = fields.get('max-chars');
          return (
            <div key={i} className="mb-7 p-4 bg-white rounded-lg border border-[#e8e5df] relative group cursor-pointer hover:outline hover:outline-2 hover:outline-blue-300/30 hover:outline-offset-1"
              onClick={() => setEditingIndex(i)}>
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

        // Page header (e.g., "### Page: AI Control")
        if (section.type === 'page') {
          return (
            <div key={i} className="mb-4 relative group cursor-pointer hover:outline hover:outline-2 hover:outline-blue-300/30 hover:outline-offset-1 rounded"
              onClick={() => setEditingIndex(i)}>
              <div className="absolute -top-2 -right-2 bg-blue-500 text-white text-[10px] px-2 py-0.5 rounded font-medium opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
                click to edit
              </div>
              <div style={{ fontFamily: "'Newsreader', serif", fontSize: '22px', fontWeight: 600, color: '#1a1a1a' }}>
                {section.label}
              </div>
            </div>
          );
        }

        // Article/Video reference heading (e.g., "### Article: Some Article")
        if (section.type === 'article-ref' || section.type === 'video-ref') {
          return (
            <div key={i} className="mb-4 relative group cursor-pointer hover:outline hover:outline-2 hover:outline-blue-300/30 hover:outline-offset-1 rounded"
              onClick={() => setEditingIndex(i)}>
              <div className="absolute -top-2 -right-2 bg-blue-500 text-white text-[10px] px-2 py-0.5 rounded font-medium opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
                click to edit
              </div>
              <div style={{ fontFamily: "'Newsreader', serif", fontSize: '18px', fontWeight: 600, color: '#1a1a1a' }}>
                {section.label}
              </div>
            </div>
          );
        }

        // Generic heading
        if (section.type === 'heading') {
          return (
            <div key={i} className="mb-4 relative group cursor-pointer hover:outline hover:outline-2 hover:outline-blue-300/30 hover:outline-offset-1 rounded"
              onClick={() => setEditingIndex(i)}>
              <div className="absolute -top-2 -right-2 bg-blue-500 text-white text-[10px] px-2 py-0.5 rounded font-medium opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
                click to edit
              </div>
              <div style={{ fontFamily: "'Newsreader', serif", fontSize: '18px', fontWeight: 600, color: '#1a1a1a' }}>
                {section.label}
              </div>
            </div>
          );
        }

        return null;
      })}
    </div>
  );
}
```

- [ ] **Step 5: Wire LensPanel into EduEditor**

In `EduEditor.tsx`, import and use LensPanel:

```typescript
import { LensPanel } from './LensPanel';
```

Replace the right panel placeholder:

```tsx
{selectedLensDocId && selectedLensName ? (
  <LensPanel lensDocId={selectedLensDocId} lensName={selectedLensName} />
) : (
  <div className="flex items-center justify-center h-48 text-gray-400 text-sm border-2 border-dashed border-gray-200 rounded-lg">
    Select a lens from the module structure
  </div>
)}
```

- [ ] **Step 6: Verify in browser**

Navigate to `/edu/<module-uuid>`, expand an LO, click a lens reference. Verify:
- Right panel shows lens content with platform styling
- TL;DR card renders
- Text sections render as markdown
- Chat sections show tutor instructions in green card
- Article-excerpt sections show as placeholder cards with from/to values
- Clicking any section opens the inline CM editor
- "Done" button closes the editor
- Fonts match platform (Newsreader for headings, DM Sans for body)

- [ ] **Step 7: Commit**

```bash
jj new -m "feat: LensPanel — platform-style lens rendering with inline editing"
```

---

### Task 7: Article excerpt expansion with multi-doc editing

Replace the article-excerpt placeholder with a full embed card that connects to the article's Y.Doc, extracts the excerpt text using `extractArticleExcerpt` from content-processor, and renders it inline. The excerpt text is editable via an inline CM editor scoped to the excerpt range in the article doc.

**Files:**
- Create: `src/components/EduEditor/ArticleEmbed.tsx`
- Modify: `src/components/EduEditor/LensPanel.tsx` — use ArticleEmbed

**Context:** Each lens has a top-level `### Article: Title` or `### Video: Title` heading with a `source::` field pointing to the article doc. Article-excerpt sections below it use `from::`/`to::` to mark the excerpt range. We need to:
1. Find the article source from the lens's heading section
2. Resolve the wikilink to a doc UUID
3. Connect to the article's Y.Doc
4. Extract the excerpt using `extractArticleExcerpt` (from content-processor)
5. Render the excerpt text, editable via CM

The `extractArticleExcerpt` function returns `{ content, startIndex, endIndex }` — these indices are relative to the article body (after frontmatter stripping). We need the absolute indices in the Y.Text for CM editing.

- [ ] **Step 1: Create ArticleEmbed component**

```typescript
// src/components/EduEditor/ArticleEmbed.tsx
import { useEffect, useState, useRef, useCallback } from 'react';
import type { EditorView } from 'codemirror';
import ReactMarkdown from 'react-markdown';
import { extractArticleExcerpt, stripFrontmatter } from 'lens-content-processor/dist/bundler/article.js';
import { useDocConnection } from '../../hooks/useDocConnection';
import { resolveWikilinkToUuid } from '../../lib/resolveDocPath';
import { useNavigation } from '../../contexts/NavigationContext';
import { createSectionEditorView } from '../SectionEditor/createSectionEditorView';
import { RELAY_ID } from '../../lib/constants';
import * as Y from 'yjs';

interface ArticleEmbedProps {
  fromAnchor?: string;
  toAnchor?: string;
  articleSourceWikilink: string;  // The source:: wikilink from the lens's article heading
  lensSourcePath: string;         // Path of the lens doc (for resolving wikilinks)
}

export function ArticleEmbed({ fromAnchor, toAnchor, articleSourceWikilink, lensSourcePath }: ArticleEmbedProps) {
  const { getOrConnect } = useDocConnection();
  const { metadata } = useNavigation();
  const [excerptText, setExcerptText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [articleTitle, setArticleTitle] = useState<string>('Article');
  const [editing, setEditing] = useState(false);
  const [excerptRange, setExcerptRange] = useState<{ from: number; to: number } | null>(null);
  const ytextRef = useRef<Y.Text | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const mountRef = useRef<HTMLDivElement>(null);

  // Extract article name from wikilink for display
  useEffect(() => {
    const name = articleSourceWikilink
      .replace(/^!?\[\[/, '').replace(/\]\]$/, '')
      .split('/').pop()?.split('|')[0] ?? 'Article';
    setArticleTitle(name);
  }, [articleSourceWikilink]);

  // Connect to article doc and extract excerpt
  useEffect(() => {
    let cancelled = false;

    async function connect() {
      const uuid = resolveWikilinkToUuid(articleSourceWikilink, lensSourcePath, metadata);
      if (!uuid) {
        setError(`Could not resolve: ${articleSourceWikilink}`);
        return;
      }

      const compoundId = `${RELAY_ID}-${uuid}`;
      const { doc } = await getOrConnect(compoundId);
      if (cancelled) return;

      const ytext = doc.getText('contents');
      ytextRef.current = ytext;

      const update = () => {
        const fullText = ytext.toString();
        const result = extractArticleExcerpt(fullText, fromAnchor, toAnchor, 'article');

        if (result.error) {
          setError(result.error.message);
          setExcerptText(null);
          setExcerptRange(null);
        } else if (result.content) {
          setExcerptText(result.content);
          setError(null);

          // Calculate absolute offsets in the full Y.Text
          // extractArticleExcerpt works on the body after stripping frontmatter
          const body = stripFrontmatter(fullText);
          const fmOffset = fullText.indexOf(body);
          setExcerptRange({
            from: fmOffset + (result.startIndex ?? 0),
            to: fmOffset + (result.endIndex ?? body.length),
          });
        }
      };

      update();
      ytext.observe(update);

      return () => ytext.unobserve(update);
    }

    setExcerptText(null);
    setError(null);
    setEditing(false);
    const cleanupPromise = connect();
    return () => {
      cancelled = true;
      cleanupPromise.then(cleanup => cleanup?.());
    };
  }, [articleSourceWikilink, lensSourcePath, fromAnchor, toAnchor, metadata, getOrConnect]);

  // Create CM editor when editing
  useEffect(() => {
    if (viewRef.current) {
      viewRef.current.destroy();
      viewRef.current = null;
    }
    if (!editing || !mountRef.current || !ytextRef.current || !excerptRange) return;

    const ytext = ytextRef.current;
    const view = createSectionEditorView({
      ytext,
      sectionFrom: excerptRange.from,
      sectionTo: excerptRange.to,
      parent: mountRef.current,
    });

    viewRef.current = view;
    requestAnimationFrame(() => view.focus());

    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [editing, excerptRange]);

  return (
    <div className="mb-7 rounded-xl border border-[rgba(184,112,24,0.15)] overflow-hidden shadow-[0_1px_4px_0_rgba(0,0,0,0.06)]"
      style={{ background: 'rgba(184, 112, 24, 0.04)' }}>
      {/* Header */}
      <div className="px-6 py-4 border-b border-[rgba(184,112,24,0.1)]">
        <div style={{ fontFamily: "'Newsreader', serif", fontSize: '20px', fontWeight: 600, color: '#1a1a1a' }}>
          {articleTitle}
        </div>
      </div>

      {/* Body */}
      <div className="px-6 py-5">
        {error && (
          <div className="text-sm text-red-600 bg-red-50 p-3 rounded">{error}</div>
        )}

        {!error && !excerptText && (
          <div className="text-sm text-gray-400 italic">Loading excerpt...</div>
        )}

        {!error && excerptText && !editing && (
          <div className="relative group cursor-pointer hover:outline hover:outline-2 hover:outline-blue-300/30 hover:outline-offset-1 rounded"
            onClick={() => setEditing(true)}>
            <div className="absolute -top-2 -right-2 bg-blue-500 text-white text-[10px] px-2 py-0.5 rounded font-medium opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
              click to edit
            </div>
            <div className="text-gray-400 tracking-wider mb-1">&hellip;</div>
            <div className="text-[14px] leading-[1.8] text-gray-700 prose prose-sm max-w-none" style={{ fontFamily: "'DM Sans', sans-serif" }}>
              <ReactMarkdown>{excerptText}</ReactMarkdown>
            </div>
            <div className="text-gray-400 tracking-wider mt-1">&hellip;</div>
          </div>
        )}

        {!error && editing && (
          <div className="rounded-lg border-2 border-blue-400 bg-white overflow-hidden">
            <div className="flex items-center justify-between px-4 py-2 bg-blue-50 border-b border-blue-200">
              <span className="font-medium text-sm text-blue-700">Editing: {articleTitle}</span>
              <button onClick={() => setEditing(false)}
                className="text-xs px-2 py-1 bg-blue-100 hover:bg-blue-200 text-blue-600 rounded">
                Done
              </button>
            </div>
            <div ref={mountRef} style={{ minHeight: '60px' }} />
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Wire ArticleEmbed into LensPanel**

In `LensPanel.tsx`, import ArticleEmbed:
```typescript
import { ArticleEmbed } from './ArticleEmbed';
```

The article-excerpt section needs the `source::` from its parent heading section (the `### Article: ...` heading that has `source:: [[../articles/...]]`). Add state to track the current article source:

Replace the article-excerpt rendering block in LensPanel with:

```tsx
// Article-excerpt section
if (section.type === 'article-excerpt') {
  const from = fields.get('from') ?? undefined;
  const to = fields.get('to') ?? undefined;

  // Find the article source from the nearest preceding article-ref heading
  let articleSource = '';
  for (let j = i - 1; j >= 0; j--) {
    if (sections[j].type === 'article-ref') {
      const headingFields = parseFields(sections[j].content);
      const src = headingFields.get('source');
      if (src) {
        articleSource = src.trim();
        break;
      }
    }
  }

  if (!articleSource) {
    return (
      <div key={i} className="mb-7 p-4 bg-amber-50 rounded-lg border border-amber-200 text-sm text-amber-700">
        Article-excerpt has no article source:: in a preceding heading
      </div>
    );
  }

  // Resolve lens source path from metadata
  const lensUuid = lensDocId.slice(RELAY_ID.length + 1);
  const lensPath = Object.entries(metadata).find(([, m]) => m.id === lensUuid)?.[0] ?? '';

  return (
    <ArticleEmbed
      key={i}
      fromAnchor={from}
      toAnchor={to}
      articleSourceWikilink={articleSource}
      lensSourcePath={lensPath}
    />
  );
}
```

Add the missing imports to LensPanel:
```typescript
import { useNavigation } from '../../contexts/NavigationContext';
import { RELAY_ID } from '../../lib/constants';
```

Add at the top of the LensPanel component:
```typescript
const { metadata } = useNavigation();
```

- [ ] **Step 3: Verify in browser**

Navigate to a lens with article excerpts. Verify:
- Article embed card renders with article title
- Excerpt text is shown between ellipsis markers
- Excerpt text is rendered as markdown
- Clicking the excerpt opens an inline CM editor
- Edits in the CM editor update the excerpt text in real-time
- "Done" button closes the editor
- Error state shows when anchor text is not found

- [ ] **Step 4: Commit**

```bash
jj new -m "feat: ArticleEmbed — inline article excerpt display with multi-doc CRDT editing"
```

---

### Task 8: Video excerpt with timestamp processing

Add video-excerpt support. Similar to article excerpts but uses timestamp-based extraction from `lens-content-processor`. The video transcript and its `.timestamps.json` companion file are fetched, timestamps are processed, and the resulting transcript text is shown inline.

**Files:**
- Create: `src/components/EduEditor/VideoExcerptEmbed.tsx`
- Modify: `src/components/EduEditor/LensPanel.tsx` — use VideoExcerptEmbed

**Context:** Video-excerpt sections have `from::` and `to::` fields containing timestamps like `14:49`. The transcript is a separate relay doc. The `.timestamps.json` is a separate file in the relay vault (e.g., `video_transcripts/foo.timestamps.json`). We need to:
1. Find the video source from the preceding `### Video:` heading's `source::` field
2. Resolve it to a transcript doc UUID
3. Connect to the transcript Y.Doc
4. Find the `.timestamps.json` path by appending `.timestamps.json` to the transcript path (minus `.md`)
5. Connect to the timestamps doc (it's stored as a relay doc too)
6. Parse timestamps and extract the excerpt using `extractVideoExcerpt` from content-processor

Note: The `.timestamps.json` files are stored in the relay as documents. Their Y.Text contents will be the raw JSON string. We parse it to get the `TimestampEntry[]` array.

- [ ] **Step 1: Create VideoExcerptEmbed component**

```typescript
// src/components/EduEditor/VideoExcerptEmbed.tsx
import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { extractVideoExcerpt } from 'lens-content-processor/dist/bundler/video.js';
import type { TimestampEntry } from 'lens-content-processor/dist/bundler/video.js';
import { useDocConnection } from '../../hooks/useDocConnection';
import { resolveWikilinkToUuid } from '../../lib/resolveDocPath';
import { useNavigation } from '../../contexts/NavigationContext';
import { RELAY_ID } from '../../lib/constants';

interface VideoExcerptEmbedProps {
  fromTime?: string;
  toTime?: string;
  videoSourceWikilink: string;
  lensSourcePath: string;
}

export function VideoExcerptEmbed({ fromTime, toTime, videoSourceWikilink, lensSourcePath }: VideoExcerptEmbedProps) {
  const { getOrConnect } = useDocConnection();
  const { metadata } = useNavigation();
  const [excerptText, setExcerptText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [videoTitle, setVideoTitle] = useState<string>('Video');

  useEffect(() => {
    const name = videoSourceWikilink
      .replace(/^!?\[\[/, '').replace(/\]\]$/, '')
      .split('/').pop()?.split('|')[0] ?? 'Video';
    setVideoTitle(name);
  }, [videoSourceWikilink]);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      // Resolve transcript doc
      const transcriptUuid = resolveWikilinkToUuid(videoSourceWikilink, lensSourcePath, metadata);
      if (!transcriptUuid) {
        setError(`Could not resolve transcript: ${videoSourceWikilink}`);
        return;
      }

      // Connect to transcript doc
      const transcriptCompoundId = `${RELAY_ID}-${transcriptUuid}`;
      const { doc: transcriptDoc } = await getOrConnect(transcriptCompoundId);
      if (cancelled) return;

      const transcriptText = transcriptDoc.getText('contents').toString();

      // Try to find and load timestamps.json
      // The transcript path is like 'Lens Edu/video_transcripts/foo.md'
      // The timestamps path is 'Lens Edu/video_transcripts/foo.timestamps.json'
      const transcriptPath = Object.entries(metadata).find(([, m]) => m.id === transcriptUuid)?.[0];
      let timestamps: TimestampEntry[] | undefined;

      if (transcriptPath) {
        const tsPath = transcriptPath.replace(/\.md$/, '.timestamps.json');
        const tsEntry = metadata[tsPath];

        if (tsEntry) {
          try {
            const tsCompoundId = `${RELAY_ID}-${tsEntry.id}`;
            const { doc: tsDoc } = await getOrConnect(tsCompoundId);
            if (cancelled) return;

            const tsText = tsDoc.getText('contents').toString();
            timestamps = JSON.parse(tsText) as TimestampEntry[];
          } catch {
            // Fall back to inline timestamp extraction
          }
        }
      }

      // Extract excerpt
      const from = fromTime ?? '0:00';
      const result = extractVideoExcerpt(transcriptText, from, toTime, 'video', timestamps);

      if (cancelled) return;

      if (result.error) {
        setError(result.error.message);
      } else if (result.transcript) {
        setExcerptText(result.transcript);
      }
    }

    setExcerptText(null);
    setError(null);
    load();
    return () => { cancelled = true; };
  }, [videoSourceWikilink, lensSourcePath, fromTime, toTime, metadata, getOrConnect]);

  return (
    <div className="mb-7 rounded-xl border border-[rgba(184,112,24,0.15)] overflow-hidden shadow-[0_1px_4px_0_rgba(0,0,0,0.06)]"
      style={{ background: 'rgba(184, 112, 24, 0.04)' }}>
      <div className="px-6 py-4 border-b border-[rgba(184,112,24,0.1)]">
        <div style={{ fontFamily: "'Newsreader', serif", fontSize: '20px', fontWeight: 600, color: '#1a1a1a' }}>
          {videoTitle}
        </div>
        <div className="text-xs text-gray-500 mt-1">
          Video transcript {fromTime && `from ${fromTime}`} {toTime && `to ${toTime}`}
        </div>
      </div>
      <div className="px-6 py-5">
        {error && (
          <div className="text-sm text-red-600 bg-red-50 p-3 rounded">{error}</div>
        )}
        {!error && !excerptText && (
          <div className="text-sm text-gray-400 italic">Loading transcript...</div>
        )}
        {!error && excerptText && (
          <>
            <div className="text-gray-400 tracking-wider mb-1">&hellip;</div>
            <div className="text-[14px] leading-[1.8] text-gray-700" style={{ fontFamily: "'DM Sans', sans-serif" }}>
              <ReactMarkdown>{excerptText}</ReactMarkdown>
            </div>
            <div className="text-gray-400 tracking-wider mt-1">&hellip;</div>
          </>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Wire VideoExcerptEmbed into LensPanel**

In `LensPanel.tsx`, import:
```typescript
import { VideoExcerptEmbed } from './VideoExcerptEmbed';
```

Replace the video-excerpt rendering block:

```tsx
// Video-excerpt section
if (section.type === 'video-excerpt') {
  const from = fields.get('from') ?? undefined;
  const to = fields.get('to') ?? undefined;

  // Find the video source from the nearest preceding video-ref heading
  let videoSource = '';
  for (let j = i - 1; j >= 0; j--) {
    if (sections[j].type === 'video-ref') {
      const headingFields = parseFields(sections[j].content);
      const src = headingFields.get('source');
      if (src) {
        videoSource = src.trim();
        break;
      }
    }
  }

  if (!videoSource) {
    return (
      <div key={i} className="mb-7 p-4 bg-amber-50 rounded-lg border border-amber-200 text-sm text-amber-700">
        Video-excerpt has no video source:: in a preceding heading
      </div>
    );
  }

  const lensUuid = lensDocId.slice(RELAY_ID.length + 1);
  const lensPath = Object.entries(metadata).find(([, m]) => m.id === lensUuid)?.[0] ?? '';

  return (
    <VideoExcerptEmbed
      key={i}
      fromTime={from}
      toTime={to}
      videoSourceWikilink={videoSource}
      lensSourcePath={lensPath}
    />
  );
}
```

- [ ] **Step 3: Verify in browser**

Navigate to a lens that contains a video (e.g., "A.I. - Humanity's Final Invention" lens). Verify:
- Video excerpt embed card renders with video title
- Transcript excerpt text is shown between ellipsis markers
- If timestamps.json exists, word-level extraction is used
- If timestamps.json doesn't exist, falls back to inline timestamp markers or full transcript
- Error messages display correctly for missing transcripts

- [ ] **Step 4: Commit**

```bash
jj new -m "feat: VideoExcerptEmbed — video transcript excerpt via timestamp processing"
```

---

## Verification

After all tasks are complete:

1. `cd lens-editor && npx vitest run` — all tests pass
2. `cd lens-editor && npx tsc --noEmit` — clean compile
3. Browser verification:
   - Navigate to `/edu/<feedback-loops-module-uuid>`
   - Left panel shows module structure with Welcome page, two LOs
   - Expand "Feedback cycles create discontinuity" LO → shows Cascades and Cycles + Speculations lenses
   - Click "Cascades and Cycles" → right panel shows lens content
   - Text sections render as markdown with platform styling
   - Article excerpt shows extracted text from the Yudkowsky article
   - Chat section shows tutor instructions in green card
   - Click any section → inline CM editor opens
   - Edit excerpt from/to markers → excerpt text updates in real-time
   - Navigate to `/edu/<existing-approaches-module-uuid>`
   - LO expands with 5 submodules (Automating Alignment, MI, Evals, Control, Agent Foundations)
   - Submodules collapse/expand correctly
   - Each submodule's lenses are clickable
