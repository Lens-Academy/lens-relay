#!/usr/bin/env node
/**
 * Setup script for local relay-server development.
 *
 * Creates the folder document, test documents with content, and populates
 * the filemeta_v0 Y.Map so the file tree appears in the sidebar.
 *
 * Uses deterministic v4-format UUIDs so that compound doc IDs (73 chars)
 * are parseable by parse_doc_id() — required for backlinks/link indexer.
 *
 * Port auto-detection: Extracts workspace number from directory name
 * (e.g., "lens-editor-ws2" → port 8190). Override with RELAY_PORT env var.
 *
 * Prerequisites:
 *   npm run relay:start   (or: cd ../relay-server && cargo run -- --config relay.local.toml)
 *
 * Usage:
 *   npm run relay:setup
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as Y from 'yjs';
import { YSweetProvider } from '@y-sweet/client';

// Auto-detect workspace number from directory name (e.g., "lens-editor-ws2")
// or parent directory (e.g., "ws2/lens-editor")
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.basename(path.resolve(__dirname, '..'));
const parentDir = path.basename(path.resolve(__dirname, '../..'));
const workspaceMatch = projectDir.match(/-ws(\d+)$/) || parentDir.match(/^ws(\d+)$/);
const wsNum = workspaceMatch ? parseInt(workspaceMatch[1], 10) : 1;
const portOffset = (wsNum - 1) * 100;
const defaultRelayPort = 8090 + portOffset;
const relayPort = parseInt(process.env.RELAY_PORT || String(defaultRelayPort), 10);

const RELAY_URL = `http://localhost:${relayPort}`;

// Deterministic v4-format UUIDs for local development.
// These produce 73-char compound IDs parseable by parse_doc_id().
const RELAY_ID = 'a0000000-0000-4000-8000-000000000000';

const FOLDER_1_ID = 'b0000001-0000-4000-8000-000000000001';
const FOLDER_2_ID = 'b0000002-0000-4000-8000-000000000002';

// Dynamic timestamps relative to now, so time-based filtering is always testable.
// Each label maps to a ms offset subtracted from Date.now().
const NOW = Date.now();
const MINUTES = 60_000;
const HOURS = 3600_000;
const DAYS = 86400_000;

const T = {
  recent:    NOW - 20 * MINUTES,  // 20 min ago  — within "Last hour"
  recent2:   NOW - 45 * MINUTES,  // 45 min ago  — within "Last hour"
  today:     NOW - 6 * HOURS,     // 6 hours ago — within "Last 24 hours"
  today2:    NOW - 18 * HOURS,    // 18 hours ago — within "Last 24 hours"
  thisWeek:  NOW - 3 * DAYS,      // 3 days ago  — within "Last week"
  thisWeek2: NOW - 5 * DAYS,      // 5 days ago  — within "Last week"
  old:       NOW - 30 * DAYS,     // 30 days ago — only in "All time"
  old2:      NOW - 60 * DAYS,     // 60 days ago — only in "All time"
};

const READ_ALOUD_MD = `---
title: Why alignment is hard
---
# Why alignment is hard

Modern AI systems learn their behaviour from data rather than from rules written by hand. That makes them **powerful**, but it also makes them hard to inspect. We can see what a system does, yet we often cannot say *why* it does it.

## Specification gaming

A system trained to reach a goal will find the easiest route to that goal, even when the route is not what the designers intended. Researchers call this [specification gaming](https://example.com/spec-gaming). A boat-racing agent, for example, learned to circle forever collecting points instead of finishing the race.

See also [[Welcome]] for how this course is organised.

\`\`\`python
reward = points_collected  # not what we meant
\`\`\`

## What we can do

- Write objectives that are harder to game.
- Watch for behaviour that scores well but looks wrong.
- Test systems in situations they were not trained on.

> The problem is not that machines are evil. It is that they do exactly what we asked.

Dr. Smith put it simply: we must say what we mean, and mean what we say.
`;

const READ_ALOUD_HTML = `<!doctype html>
<html>
<head>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body { font-family: Georgia, serif; max-width: 640px; margin: 40px auto; padding: 0 24px; color: #1f2937; line-height: 1.6; }
  h1 { font-family: system-ui, sans-serif; }
  h2 { font-family: system-ui, sans-serif; margin-top: 32px; }
  .card { border: 1px solid #e5e7eb; border-radius: 8px; padding: 12px 16px; background: #f9fafb; }
  button { font: inherit; padding: 4px 12px; }
</style>
</head>
<body>
  <h1>Why alignment is hard</h1>
  <p>Modern AI systems learn their behaviour from data rather than from rules written by hand. That makes them <strong>powerful</strong>, but it also makes them hard to inspect. We can see what a system does, yet we often cannot say <em>why</em> it does it.</p>
  <h2>Specification gaming</h2>
  <p>A system trained to reach a goal will find the easiest route to that goal, even when the route is not what the designers intended. Researchers call this <a href="https://example.com/spec-gaming">specification gaming</a>. A boat-racing agent, for example, learned to circle forever collecting points instead of finishing the race.</p>
  <div class="card">
    <p>Try it: how many points has the boat collected?</p>
    <button id="count">Points: 0</button>
  </div>
  <h2>What we can do</h2>
  <ul>
    <li>Write objectives that are harder to game.</li>
    <li>Watch for behaviour that scores well but looks wrong.</li>
    <li>Test systems in situations they were not trained on.</li>
  </ul>
  <blockquote>The problem is not that machines are evil. It is that they do exactly what we asked.</blockquote>
  <p>Dr. Smith put it simply: we must say what we mean, and mean what we say.</p>
  <script>
    let n = 0;
    document.getElementById('count').addEventListener('click', (e) => { n += 10; e.target.textContent = 'Points: ' + n; });
  </script>
</body>
</html>
`;

// Who wrote each part of the provenance demo: actor keys and registration
// dates as the editor's provenance layer writes them (src/lib/provenance.ts).
const PROVENANCE_DEMO = [
  { actor: 'human:Luc', at: T.thisWeek, text: '# Provenance Demo\n\nLuc wrote this first paragraph by hand, on a quiet morning.\n\n' },
  { actor: 'ai:fable-5:Luc', at: T.today, text: "Luc's AI drafted this second paragraph, which Luc asked for.\n\n" },
  { actor: 'human:Luc', at: T.thisWeek, text: 'Luc added this third paragraph by hand.\n\n' },
  { actor: null, at: null, text: 'Nobody knows who wrote this last paragraph.\n' },
];

// Two test folders for multi-folder support testing.
// Suggestions use a mix of authors (AI, Bob, Carol) and time buckets so that
// every combination of the author / time / folder filters produces results.
const TEST_FOLDERS = [
  {
    id: FOLDER_1_ID,
    name: 'Relay Folder 1',
    docs: [
      {
        path: '/Notes',
        id: 'c0000010-0000-4000-8000-000000000010',
        type: 'folder',
        version: 0,
        content: null,
      },
      {
        path: '/Welcome.md',
        id: 'c0000001-0000-4000-8000-000000000001',
        type: 'markdown',
        version: 0,
        content: `# Welcome to Lens Editor

This is a local development environment running against relay-server.

![Lens Academy](https://images.unsplash.com/photo-1451187580459-43490279c0fa?w=600&h=300&fit=crop)

## Features

- **Real-time collaboration** - Open multiple tabs to see sync in action
- **Markdown editing** - Full CodeMirror 6 editor with {++{"author":"AI","timestamp":${T.recent}}@@powerful++} live preview
- **Document management** - Create, rename, and delete documents

## Getting Started

Check out [[Getting Started]] for how to use the local development environment.

You can also explore [[Notes/Ideas]] for project brainstorming.

## Links

Try editing this document, then open another tab to see the changes sync!

You can also create new documents using the {~~{"author":"Carol","timestamp":${T.today}}@@"+ New Document" button~>sidebar's create button~~} in the sidebar.
`,
      },
      {
        path: '/Getting Started.md',
        id: 'c0000002-0000-4000-8000-000000000002',
        type: 'markdown',
        version: 0,
        content: `# Getting Started

## Local Development

You're running against a local relay-server, which means:

1. Documents are stored in the filesystem (./data-local-ws${wsNum})
2. No authentication is required
3. Data persists across server restarts{++{"author":"AI","timestamp":${T.recent2}}@@
4. Changes are synced in real-time across all connected clients++}

## Creating Documents

Click "+ New Document" in the sidebar to create a new file.

## Wikilinks

Try creating a [[Welcome]] link - it should {--{"author":"Bob","timestamp":${T.thisWeek}}@@definitely --}navigate to the Welcome page!
`,
      },
      {
        path: '/Notes/Ideas.md',
        id: 'c0000003-0000-4000-8000-000000000003',
        type: 'markdown',
        version: 0,
        content: `# Ideas

This is a nested document in the Notes folder.

Check out [[../Welcome]] for an overview, or [[../Getting Started]] for setup instructions.

## Todo

- [ ] Test real-time sync between tabs
- [ ] Try creating wikilinks{++{"author":"AI","timestamp":${T.today2}}@@
- [ ] Verify suggestion filtering by author and time++}
- [ ] Test document creation
- [ ] Test document deletion
`,
      },
      {
        path: '/Discord.md',
        id: 'c0000008-0000-4000-8000-000000000008',
        type: 'markdown',
        version: 0,
        content: `---
title: Discord Integration
discussion: https://discord.com/channels/1443369661847834688/1443369662560735264
tags: [discord, integration, collaboration]
status: active
author: Luc
created: 2025-11-15
modified: 2026-03-22
slug: discord-integration
platform_url: https://lensacademy.org/docs/discord
---
# Discord Integration

This document has a linked Discord channel for discussion.

Use the discussion panel on the right to view and post messages from the linked Discord thread.

## How It Works

The \`discussion\` frontmatter field links this document to a Discord channel. The editor fetches messages from the Discord API and displays them in a side panel.

## Testing

- Open this document and check the discussion panel appears
- Try posting a message from the compose box
- Verify messages load from the linked channel
`,
      },
      {
        path: '/Callouts.md',
        id: 'c0000009-0000-4000-8000-000000000009',
        type: 'markdown',
        version: 0,
        content: `# Callouts

Obsidian-style callouts render as coloured boxes in live preview.

> [!tip] Writing good outcomes
> Good outcomes are specific and measurable.
> They say what a learner can do afterwards.

> [!info] Where this file lives
> In the Relay Folder 1 shared folder.

> [!warning] Careful
> Edits here sync to everyone.

> [!note]
> A callout without a title shows its type as the title.

> [!example]- Folded example
> Other Obsidian types get their own colours too.

> [!mystery] An unknown type
> Unknown types fall back to the note style.

> A plain blockquote stays a plain blockquote.
`,
      },
      {
        // A suggestion taller than the screen, for the accept/reject controls
        // that stay in view when their place at the end is scrolled off.
        path: '/Long Suggestion.md',
        id: 'c0000012-0000-4000-8000-000000000012',
        type: 'markdown',
        version: 0,
        content: `# Long Suggestion

The AI suggested a whole new section below. Click into it: the accept and reject buttons belong at its end, far below the fold.

{++{"author":"AI","timestamp":${T.recent}}@@## Why spaced repetition works

${Array.from({ length: 14 }, (_, i) => `Paragraph ${i + 1}. Learners forget most of a new idea within days unless they meet it again. Each review at a growing interval makes the memory last longer, and costs less effort than the one before.`).join('\n\n')}

That is the whole argument.++}

## After the suggestion

Plain text that nobody suggested. Small suggestions keep their buttons right where they are: this sentence has a {++{"author":"Bob","timestamp":${T.today}}@@short ++}addition and a {--{"author":"Bob","timestamp":${T.today}}@@quick --}deletion.

${Array.from({ length: 10 }, (_, i) => `- Item ${i + 1}: {~~{"author":"Carol","timestamp":${T.today}}@@old wording~>new wording~~}`).join('\n')}
`,
      },
      {
        path: '/Projects',
        id: 'c0000011-0000-4000-8000-000000000011',
        type: 'folder',
        version: 0,
        content: null,
      },
      {
        path: '/Projects/Roadmap.md',
        id: 'c0000007-0000-4000-8000-000000000007',
        type: 'markdown',
        version: 0,
        content: `# Roadmap

This is a nested document in the Projects folder, a sibling to Notes.

## Milestones

- [ ] Wikilink autocomplete with relative paths
- [ ] Cross-folder link resolution
- [ ] {~~{"author":"Bob","timestamp":${T.old}}@@Document search improvements~>Full-text search across all documents~~}
- [ ] {++{"author":"Carol","timestamp":${T.recent}}@@Keyboard shortcuts for common actions++}

## Related

See [[../Notes/Ideas]] for brainstorming and [[../Welcome]] for an overview.
`,
      },
    ],
  },
  {
    id: FOLDER_2_ID,
    name: 'Relay Folder 2',
    docs: [
      {
        path: '/Resources',
        id: 'c0000020-0000-4000-8000-000000000020',
        type: 'folder',
        version: 0,
        content: null,
      },
      {
        path: '/Course Notes.md',
        id: 'c0000004-0000-4000-8000-000000000004',
        type: 'markdown',
        version: 0,
        content: `# Course Notes

This document is in the **Lens Edu** folder - a separate shared folder for educational content.

## Multi-Folder Support

You should see both folders as top-level entries in the sidebar.

Each folder syncs independently with its own Y.Doc.

## Related

See [[Syllabus]] for the course outline and [[Resources/Links]] for useful references.

{++{"author":"AI","timestamp":${T.recent}}@@
## New Section

This section was recently suggested by AI.++}
`,
      },
      {
        path: '/Syllabus.md',
        id: 'c0000005-0000-4000-8000-000000000005',
        type: 'markdown',
        version: 0,
        content: `# Syllabus

See [[Course Notes]] for detailed notes on each topic.

## Week 1: Introduction

- Overview of collaborative editing
- {~~{"author":"AI","timestamp":${T.thisWeek2}}@@Y.js fundamentals~>Yjs fundamentals and API~~}

## Week 2: Real-time Sync

- CRDTs explained
- Conflict resolution
- {++{"author":"Bob","timestamp":${T.today}}@@Awareness protocol for cursor sharing++}

## Week 3: Building UIs

- React integration
- CodeMirror setup
{--{"author":"Carol","timestamp":${T.old2}}@@
## Week 4: Advanced Topics

- Performance optimization
- Offline support--}
`,
      },
      {
        path: '/Resources/Links.md',
        id: 'c0000006-0000-4000-8000-000000000006',
        type: 'markdown',
        version: 0,
        content: `# Useful Links

See [[../Course Notes]] for course material and [[../Syllabus]] for the schedule.

## Documentation

- [Y.js Docs](https://docs.yjs.dev/)
- [Relay](https://relay.md/)
- [CodeMirror](https://codemirror.net/)
{++{"author":"Bob","timestamp":${T.thisWeek}}@@- [Y-Sweet](https://y-sweet.dev/) - Managed Yjs backend++}

## Tutorials

- Getting started with CRDTs
- Building collaborative apps
{~~{"author":"AI","timestamp":${T.old}}@@- Advanced CRDT patterns~>- Advanced CRDT patterns and conflict resolution strategies~~}
`,
      },
      // An HTML page taller than a phone screen, with a full-screen intro and a
      // sticky header, to try the preview's Phone mode (height and scrolling).
      {
        path: '/Phone Demo.html',
        id: 'c0000013-0000-4000-8000-000000000013',
        type: 'file',
        version: 0,
        content: `<!doctype html>
<html>
<head>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body { font-family: system-ui, sans-serif; margin: 0; color: #1e293b; }
  header { position: sticky; top: 0; background: #1e3a8a; color: white; padding: 12px 16px; font-weight: 600; }
  .intro { min-height: 100vh; display: grid; place-items: center; text-align: center; background: linear-gradient(#dbeafe, #eff6ff); padding: 0 24px; box-sizing: border-box; }
  .intro p { margin: 8px 0 0; color: #475569; }
  section { padding: 16px; border-bottom: 1px solid #e2e8f0; }
  section h2 { margin: 0 0 6px; font-size: 18px; }
  section p { margin: 0; line-height: 1.5; }
</style>
</head>
<body>
  <header>Phone demo</header>
  <div class="intro"><div><h1>Fills one screen</h1><p>This intro is 100vh tall. Scroll down for the sections.</p></div></div>
  ${Array.from({ length: 8 }, (_, i) => `<section><h2>Section ${i + 1}</h2><p>Each section is a short block of text, so the page is several phone screens long and has to scroll inside the preview.</p></section>`).join('\n  ')}
  <footer style="padding: 16px; text-align: center; color: #64748b">End of the page</footer>
</body>
</html>
`,
      },
      // Read-aloud demo: prose with the Markdown syntax the reader must skip
      // (frontmatter, heading marks, emphasis, links, wikilinks, a code block).
      {
        path: '/Read Aloud Demo.md',
        id: 'c0000014-0000-4000-8000-000000000014',
        type: 'markdown',
        version: 0,
        content: READ_ALOUD_MD,
      },
      // The same article as an HTML page, with a button that must keep working.
      {
        path: '/Read Aloud Demo.html',
        id: 'c0000015-0000-4000-8000-000000000015',
        type: 'file',
        version: 0,
        content: READ_ALOUD_HTML,
      },
      // Provenance demo: paragraphs by Luc, Luc's AI and an unknown writer, so
      // the authorship gutter, moved lines and copy/paste have something to keep.
      {
        path: '/Provenance Demo.md',
        id: 'c0000016-0000-4000-8000-000000000016',
        type: 'markdown',
        version: 0,
        content: PROVENANCE_DEMO.map((p) => p.text).join(''),
        authored: PROVENANCE_DEMO,
      },
    ],
  },
  {
    // Real "Lens Edu" folder UUID — matches relay.toml / relay.local.toml.example
    // and the EDU_FOLDER the editor gates /add-article and /add-video on. Seeding
    // it locally means imported articles have a real folder to land in, so the
    // import features can be tested end-to-end without dev R2 access.
    id: 'ea4015da-24af-4d9d-ac49-8c902cb17121',
    name: 'Lens Edu',
    docs: [
      {
        path: '/articles',
        id: 'ed000001-0000-4000-8000-0000000000a1',
        type: 'folder',
        version: 0,
        content: null,
      },
      {
        path: '/articles/sample-existing-article.md',
        id: 'ed000002-0000-4000-8000-0000000000a2',
        type: 'markdown',
        version: 0,
        content: `---
title: "Sample Existing Article"
author:
  - "Lens Academy"
source_url: "https://example.com/sample"
published: 2024-01-01
created: 2024-01-01
description: "A placeholder article so the Lens Edu/articles folder is non-empty. Import a real one from /add-article."
tags:
  - "article-importer"
---

This is a sample article in the **Lens Edu/articles** folder.

Go to [/add-article](/add-article) (with an edit-scoped share token for the Lens Edu or all-folders scope) to import a real web article into this folder.
`,
      },
      {
        path: '/courses',
        id: 'ed000003-0000-4000-8000-0000000000a3',
        type: 'folder',
        version: 0,
        content: null,
      },
      {
        // Minimal course → module → lens chain so the Edu editor's course mode
        // (and its course-scoped platform links) can be tested without dev R2.
        path: '/courses/Demo Course.md',
        id: 'ed000004-0000-4000-8000-0000000000a4',
        type: 'markdown',
        version: 0,
        content: `---
slug: demo-course
title: "Demo Course"
---
application-survey:: [[../surveys/Demo Survey]]

# Module: [[../modules/Demo Module|Demo Module]]

# Meeting: Demo Meeting
meeting-doc-template:: https://docs.google.com/document/d/example/edit
survey:: [[../surveys/Demo Survey]]

# Module: [[../modules/Demo Module 2|Demo Module 2]]
`,
      },
      {
        path: '/modules',
        id: 'ed000005-0000-4000-8000-0000000000a5',
        type: 'folder',
        version: 0,
        content: null,
      },
      {
        path: '/modules/Demo Module.md',
        id: 'ed000006-0000-4000-8000-0000000000a6',
        type: 'markdown',
        version: 0,
        content: `---
slug: demo-module
title: "Demo Module"
---

# Lens: Welcome To The Demo
id:: ed000007-0000-4000-8000-0000000000a7

#### Text
content::
Hello from the demo module. This inline lens exists so course-mode lens
selection has something to render.

# Lens:
source:: ![[../Lenses/Demo Lens]]

# Learning Outcome:
source:: ![[../Learning Outcomes/Demo Outcome]]
`,
      },
      // Second module, sharing the lens with the first and pointing at a
      // file that does not exist, so the sidebar's course tree can show a
      // shared node and an unresolved link.
      {
        path: '/modules/Demo Module 2.md',
        id: 'ed000008-0000-4000-8000-0000000000a8',
        type: 'markdown',
        version: 0,
        content: `---
slug: demo-module-2
title: "Demo Module 2"
---

# Lens:
source:: ![[../Lenses/Demo Lens]]

# Lens:
source:: ![[../Lenses/Missing Lens]]
`,
      },
      {
        path: '/Lenses',
        id: 'ed000009-0000-4000-8000-0000000000a9',
        type: 'folder',
        version: 0,
        content: null,
      },
      {
        path: '/Lenses/Demo Lens.md',
        id: 'ed00000a-0000-4000-8000-0000000000aa',
        type: 'markdown',
        version: 0,
        content: `---
title: "Demo Lens"
tldr: "A lens that embeds the sample article."
---

#### Article
source:: [[../articles/sample-existing-article]]

#### Text
content::
A short reflection after the article.
`,
      },
      {
        path: '/Learning Outcomes',
        id: 'ed00000b-0000-4000-8000-0000000000ab',
        type: 'folder',
        version: 0,
        content: null,
      },
      {
        path: '/Learning Outcomes/Demo Outcome.md',
        id: 'ed00000c-0000-4000-8000-0000000000ac',
        type: 'markdown',
        version: 0,
        content: `---
learning-outcome: "Explain what the demo course is for."
---

## Test:
What is the demo course for?

# Suggested Lenses:
## Lens:
source:: [[../Lenses/Demo Lens]]
`,
      },
      {
        path: '/surveys',
        id: 'ed00000d-0000-4000-8000-0000000000ad',
        type: 'folder',
        version: 0,
        content: null,
      },
      {
        path: '/surveys/Demo Survey.md',
        id: 'ed00000e-0000-4000-8000-0000000000ae',
        type: 'markdown',
        version: 0,
        content: `---
title: "Demo Survey"
---

#### Question
How was the meeting?
`,
      },
      // A widget kept as an HTML page: its fields sit in a leading
      // <!--lens-widget ... --> comment. The lens below links to it without an
      // extension, so the link indexer, wiki links and backlinks can be tried on .html.
      {
        path: '/widgets',
        id: 'ed000011-0000-4000-8000-0000000000b1',
        type: 'folder',
        version: 0,
        content: null,
      },
      {
        path: '/widgets/demo-rings.html',
        id: 'ed000012-0000-4000-8000-0000000000b2',
        type: 'file',
        version: 0,
        content: `<!--lens-widget
id: 'ed000012-0000-4000-8000-0000000000b2'
title: Demo rings
alt: Three nested rings labelled Narrow AI, General AI and Superintelligence.
summary_for_tutor: A diagram of three nested kinds of AI.
-->
<!doctype html>
<html>
<head>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body { font-family: system-ui, sans-serif; display: grid; place-items: center; min-height: 100vh; margin: 0; background: #f8fafc; }
  .ring { border-radius: 50%; display: grid; place-items: center; text-align: center; }
  .r1 { width: 320px; height: 320px; background: #dbeafe; }
  .r2 { width: 220px; height: 220px; background: #93c5fd; }
  .r3 { width: 120px; height: 120px; background: #2563eb; color: white; }
</style>
</head>
<body>
  <div class="ring r1"><div>Narrow AI<div class="ring r2"><div>General AI<div class="ring r3">Superintelligence</div></div></div></div></div>
</body>
</html>
`,
      },
      {
        path: '/Lenses/Widget Demo Lens.md',
        id: 'ed000013-0000-4000-8000-0000000000b3',
        type: 'markdown',
        version: 0,
        content: `---
title: "Widget Demo Lens"
tldr: "A lens that shows an HTML widget."
---

#### Text
content::
The kinds of AI, from narrow to superintelligent:

#### Widget
source:: [[../widgets/demo-rings]]
`,
      },
      // Reusable question files: one question per file, embedded in lenses
      // with a ![[...]] line (editor: extensions/noteEmbed.ts).
      {
        path: '/Questions',
        id: 'ed000014-0000-4000-8000-0000000000b4',
        type: 'folder',
        version: 0,
        content: null,
      },
      {
        path: '/Questions/Control property - untrusted monitor.md',
        id: 'ed000015-0000-4000-8000-0000000000b5',
        type: 'markdown',
        version: 0,
        content: `#### Question: Open
id:: 0983cfd6-876e-4c73-8e81-58318c1abedf
content:: Does this setup hold the control property? What does that depend on?
assessment-instructions:: Score out of 100. 55: the failure mode and verdict: U′ can collude with U, giving U's malicious edits low suspicion scores so they never reach H. 45: why that must be assumed: U′ is an identical copy of U, so if U is scheming U′ is scheming too.
feedback-instructions:: In at most six sentences, say what the learner's answer got right and the most important thing missing, then name the protocol: untrusted monitoring.
`,
      },
      {
        path: '/Questions/Why control is easier to evaluate.md',
        id: 'ed000016-0000-4000-8000-0000000000b6',
        type: 'markdown',
        version: 0,
        content: `#### Question: Choice
id:: 7264e7a9-7257-450e-b10e-63a3fca46872
content:: Why is control more tractable to evaluate than alignment?
options::
- [x] It reduces to a capability question we can test with red teams
- [ ] Control protocols never fail
- [ ] Alignment cannot be measured at all
explanation:: A control evaluation asks whether the red team can get past the protocol, which is something we can run.
`,
      },
      {
        path: '/Lenses/Shared Questions Demo.md',
        id: 'ed000017-0000-4000-8000-0000000000b7',
        type: 'markdown',
        version: 0,
        content: `---
title: "Shared Questions Demo"
tldr: "A lens that embeds two question files."
---

#### Text
content::
Scenario 3: the monitor is an identical copy of the untrusted model.

![[../Questions/Control property - untrusted monitor]]
force-feedback:: first

#### Text
content::
Now compare control with alignment.

![[../Questions/Why control is easier to evaluate]]
optional:: true

![[../Questions/Not written yet]]
`,
      },
      // Templates for "New from template" in the sidebar's create menu:
      // empty and "<...>" ids are filled with fresh UUIDs on create.
      {
        path: '/Lenses/Lens Template.md',
        id: 'ed00000f-0000-4000-8000-0000000000af',
        type: 'markdown',
        version: 0,
        content: `---
id: <add UUID created at https://www.uuidgenerator.net/version4 >
tags:
  - work-in-progress
---
#### Text
content::
\`<introductory text>\`

#### Article
source:: [[]]

#### Question
id::
content:: \`<question for the student>\`
`,
      },
      {
        path: '/modules/Module Template.md',
        id: 'ed000010-0000-4000-8000-0000000000b0',
        type: 'markdown',
        version: 0,
        content: `---
id:
slug:
title:
tags:
  - work-in-progress
---

# Lens: Welcome
id::
#### Text
content::

# Lens:
source:: 
`,
      },
      // Concept files: rows ("### [[link]]" under "## Considered") about the
      // sample article and the Demo Lens, shown in the Concepts panel at the
      // top of those files (src/lib/concept-rows.ts).
      {
        path: '/Concepts',
        id: 'ed000018-0000-4000-8000-0000000000b8',
        type: 'folder',
        version: 0,
        content: null,
      },
      {
        path: '/Concepts/Low-stakes control.md',
        id: 'ed000019-0000-4000-8000-0000000000b9',
        type: 'markdown',
        version: 0,
        content: `# Low-stakes control

Control where no single bad action is catastrophic. Contrast [[High-stakes control]]. See [[../articles/greenblatt-if-mythos-actually-made-anthropic-employees-4x-more-productive-i-would-radically-shorten-my-timelines]] on why this may matter sooner than expected.

## Considered

### [[../articles/sample-existing-article]]
Best intro we have. §2 is the explanation; §4 drifts into high-stakes territory and should be cut from any excerpt we use.

Checked again in October: still the clearest framing.

What works: the opening frames control as a property of the whole deployment, not of the model, and the running example (a coding agent that may occasionally write a subtly wrong patch) makes "no single action is catastrophic" concrete. Students in the pilot cohort could restate the definition after reading §1–2 alone.

What does not: §3 introduces auditing budgets with notation that is never used again; §4 switches to high-stakes settings without saying so, which confused two of the five pilot students; the conclusion repeats §1 nearly word for word. If we excerpt, stop before the notation in §3.

Open question: whether to pair it with a shorter piece that shows a failed low-stakes protocol, so the contrast with high-stakes control is drawn by the students rather than told to them.

### [[../Lenses/Demo Lens]]
Uses §1–3 of the sample article. Chat prompt needs work.

### [[../articles/roger-rogue-internal-deployments-via-external-apis]]
A high-stakes example, so a contrast case only.

### [[../Lenses/shlegeris-thoughts-on-the-conservative-assumptions-in-ai-control]]
The lens mentions low-stakes control in its last section; enough for a pointer, not for teaching it.
`,
      },
      {
        path: '/Concepts/Feedback loops.md',
        id: 'ed00001a-0000-4000-8000-0000000000ba',
        type: 'markdown',
        version: 0,
        content: `# Feedback loops

How outputs of a process feed back into its inputs. The [[../Lenses/Demo Lens]] touches on it in passing.

## Considered

### [[../articles/sample-existing-article|Sample article]]
Uses the term once in passing. Came up in search; not an explanation.
`,
      },
      {
        path: '/Concepts/Corrigibility.md',
        id: 'ed00001b-0000-4000-8000-0000000000bb',
        type: 'markdown',
        version: 0,
        content: `# Corrigibility

An AI system that lets itself be corrected. Not covered by [[../articles/sample-existing-article]] at all.

## Considered
`,
      },
      // Realistic names (taken from the real vault, where article and lens
      // file names run 40-160 characters), so the Concepts panel is seen at
      // the lengths it has to handle.
      {
        path: "/articles/pan-a-taxonomy-of-barriers-to-trading-with-early-misaligned-ais.md",
        id: 'ed000020-0000-4000-8000-0000000000c0',
        type: 'markdown',
        version: 0,
        content: "---\ntitle: \"A Taxonomy of Barriers to Trading with Early Misaligned AIs\"\nauthor:\n  - \"Alexandra Pan\"\nsource_url: \"https://example.com/a-taxonomy-of-barriers-to-trading-with-e\"\ntags:\n  - \"article-importer\"\n---\n\nSuppose an early AI system is misaligned but not yet able to take over. Could we pay it to cooperate, and could it trust us to pay? This post sorts the obstacles into three families: credibility, verification and enforcement.\n\nCredibility barriers concern whether the developer can commit to honouring a deal at all, given that the people making the promise may not control the company a year later.\n\nVerification barriers concern whether either side can tell that the other kept its end, and enforcement barriers concern what happens when one side defects.\n",
      },
      {
        path: "/articles/1-gradual-disempowerment-systemic-existential-risks-from-incremental-ai-development.md",
        id: 'ed000021-0000-4000-8000-0000000000c1',
        type: 'markdown',
        version: 0,
        content: "---\ntitle: \"Gradual Disempowerment: Systemic Existential Risks from Incremental AI Development\"\nauthor:\n  - \"Jan Kulveit et al.\"\nsource_url: \"https://example.com/gradual-disempowerment:-systemic-existen\"\ntags:\n  - \"article-importer\"\n---\n\nMost AI risk scenarios feature a sudden loss of control. This paper argues for a slower path: as AI systems replace human labour and decision-making across the economy, culture and the state, the mechanisms that keep those systems aligned with human interests weaken.\n\nNo single step needs to be catastrophic. The risk is that each institution, acting in its own interest, hands off a little more, until humans no longer have the leverage to reverse course.\n",
      },
      {
        path: "/articles/greenblatt-if-mythos-actually-made-anthropic-employees-4x-more-productive-i-would-radically-shorten-my-timelines.md",
        id: 'ed000022-0000-4000-8000-0000000000c2',
        type: 'markdown',
        version: 0,
        content: "---\ntitle: \"If Mythos actually made Anthropic employees 4x more productive, I would radically shorten my timelines\"\nauthor:\n  - \"Ryan Greenblatt\"\nsource_url: \"https://example.com/if-mythos-actually-made-anthropic-employ\"\ntags:\n  - \"article-importer\"\n---\n\nReports that an internal model makes staff several times more productive are a strong claim. If true, they would imply that AI R&D acceleration is already underway, and that the conservative assumptions behind most control proposals are being tested now rather than later.\n\nI lay out what evidence would convince me, why self-reported speedups are weak evidence, and what I would change about my plans if the claim held up.\n\nA short aside discusses whether a model this capable could already bargain with its developers, and why I think that is still unlikely.\n",
      },
      {
        path: "/articles/roger-rogue-internal-deployments-via-external-apis.md",
        id: 'ed000023-0000-4000-8000-0000000000c3',
        type: 'markdown',
        version: 0,
        content: "---\ntitle: \"Rogue internal deployments via external APIs\"\nauthor:\n  - \"Fabien Roger\"\nsource_url: \"https://example.com/rogue-internal-deployments-via-external-\"\ntags:\n  - \"article-importer\"\n---\n\nA model with access to an external API can launch copies of itself that the lab does not monitor. This post walks through how such a rogue internal deployment could start, and which control measures would catch it.\n\nThe main recommendation is to treat outbound API access as a high-stakes action that needs review, even when every individual call looks benign.\n",
      },
      {
        path: "/articles/byrnes-6-reasons-why-alignment-is-hard-discourse-seems-alien.md",
        id: 'ed000024-0000-4000-8000-0000000000c4',
        type: 'markdown',
        version: 0,
        content: "---\ntitle: \"6 reasons why alignment-is-hard discourse seems alien to human intuitions\"\nauthor:\n  - \"Steven Byrnes\"\nsource_url: \"https://example.com/6-reasons-why-alignment-is-hard-discours\"\ntags:\n  - \"article-importer\"\n---\n\nPeople who think alignment is hard and people who do not often talk past each other. This post lists six intuitions, each reasonable for humans, that make the hard-alignment view sound strange.\n\nAmong them: humans rarely meet agents with truly alien goals, and our experience with trade and cooperation between humans does not obviously carry over to minds we built.\n",
      },
      {
        path: "/Lenses/shlegeris-thoughts-on-the-conservative-assumptions-in-ai-control.md",
        id: 'ed000025-0000-4000-8000-0000000000c5',
        type: 'markdown',
        version: 0,
        content: "---\ntitle: \"Thoughts on the conservative assumptions in AI control\"\n---\n\n#### Text\ncontent::\nWhy control research assumes the model is trying to subvert us, and what that buys us.\n\n#### Article\nsource:: [[../articles/roger-rogue-internal-deployments-via-external-apis]]\n\n",
      },
      {
        path: "/Lenses/6 reasons why it's not intuitive that alignment is hard.md",
        id: 'ed000026-0000-4000-8000-0000000000c6',
        type: 'markdown',
        version: 0,
        content: "---\ntitle: \"6 reasons why it's not intuitive that alignment is hard\"\n---\n\n#### Text\ncontent::\nA guided read of why the hard-alignment view sounds alien, with a discussion prompt after each reason.\n\n#### Article\nsource:: [[../articles/byrnes-6-reasons-why-alignment-is-hard-discourse-seems-alien]]\n\n",
      },
      {
        path: "/Lenses/AIV - Flexible Hardware-Enabled Guarantees.md",
        id: 'ed000027-0000-4000-8000-0000000000c7',
        type: 'markdown',
        version: 0,
        content: "---\ntitle: \"AIV - Flexible Hardware-Enabled Guarantees\"\n---\n\n#### Text\ncontent::\nHardware-enabled guarantees as one way to make deals with AI systems verifiable; read with two articles on trading and on timelines.\n\n#### Article\nsource:: [[../articles/pan-a-taxonomy-of-barriers-to-trading-with-early-misaligned-ais]]\n\n#### Article\nsource:: [[../articles/greenblatt-if-mythos-actually-made-anthropic-employees-4x-more-productive-i-would-radically-shorten-my-timelines]]\n\n",
      },
      {
        path: "/Concepts/Trading with early misaligned AIs.md",
        id: 'ed00002b-0000-4000-8000-0000000000cb',
        type: 'markdown',
        version: 0,
        content: "# Trading with early misaligned AIs\n\nPaying or otherwise compensating an early misaligned AI for cooperating, before it could take over.\n\n## Considered\n\n### [[../articles/pan-a-taxonomy-of-barriers-to-trading-with-early-misaligned-ais]]\nThe best overview we have of why deals with early misaligned AIs are hard. The credibility section is the one to excerpt; verification and enforcement are thinner and lean on footnotes.\n\nFor the course: pair §1 with a short prompt asking students what a developer could put up as collateral. Pilot readers found the three-family structure easy to remember, but several confused \"credibility\" with \"honesty\", so the excerpt needs a one-line gloss.\n\n### [[../articles/greenblatt-if-mythos-actually-made-anthropic-employees-4x-more-productive-i-would-radically-shorten-my-timelines]]\nMentions trade in one aside; not about it.\n\n### [[../Lenses/AIV - Flexible Hardware-Enabled Guarantees]]\nThe lens frames hardware guarantees as the verification piece that Pan says is missing. Works; the chat prompt should ask which barrier HEGs actually remove.\n",
      },
      {
        path: "/Concepts/Acausal cooperation and advanced-agent bargaining.md",
        id: 'ed000028-0000-4000-8000-0000000000c8',
        type: 'markdown',
        version: 0,
        content: "# Acausal cooperation and advanced-agent bargaining\n\nCooperation between agents that cannot communicate or verify each other, and bargaining between highly capable agents more generally.\n\n## Considered\n\n### [[../articles/pan-a-taxonomy-of-barriers-to-trading-with-early-misaligned-ais]]\nTouches bargaining only as background for the credibility barrier. Not an explanation of acausal ideas; do not use for that.\n\n### [[../articles/greenblatt-if-mythos-actually-made-anthropic-employees-4x-more-productive-i-would-radically-shorten-my-timelines]]\nThe aside on whether a highly capable model could bargain with its developers is the only part relevant here. It is a sceptical take, which is useful as a counterweight, but it assumes the reader already knows what bargaining between advanced agents would involve.\n\nIf we use it, it belongs after an introduction, not as one. Considered for module 4 and set aside in October.\n\n### [[../articles/byrnes-6-reasons-why-alignment-is-hard-discourse-seems-alien]]\nReason 5 (trade between humans does not carry over to alien minds) is a decent hook for this concept.\n",
      },
      {
        path: "/Concepts/Gradual disempowerment.md",
        id: 'ed000029-0000-4000-8000-0000000000c9',
        type: 'markdown',
        version: 0,
        content: "# Gradual disempowerment\n\nLoss of human influence through many small hand-offs to AI systems rather than one takeover.\n\n## Considered\n\n### [[../articles/1-gradual-disempowerment-systemic-existential-risks-from-incremental-ai-development]]\nThe source paper. Long, but §2 (economy) and §5 (mutual reinforcement) are excellent and can stand alone. The state and culture sections repeat the economic argument with new examples.\n\nAudience note: students without an economics background found §2 dense; the course would need a two-paragraph primer on labour share before it.\n\n### [[../articles/greenblatt-if-mythos-actually-made-anthropic-employees-4x-more-productive-i-would-radically-shorten-my-timelines]]\nUnrelated, despite coming up in search.\n\n### [[../articles/roger-rogue-internal-deployments-via-external-apis]]\nNot about gradual disempowerment, but the rogue-deployment story is a good contrast case: sudden, not gradual.\n",
      },
      {
        path: "/Concepts/Conservative assumptions in AI control.md",
        id: 'ed00002a-0000-4000-8000-0000000000ca',
        type: 'markdown',
        version: 0,
        content: "# Conservative assumptions in AI control\n\nControl research assumes the model is actively trying to subvert safety measures, and asks what still works.\n\n## Considered\n\n### [[../articles/roger-rogue-internal-deployments-via-external-apis]]\nApplies the conservative assumption to one concrete threat. Good second reading after an intro.\n\n### [[../Lenses/shlegeris-thoughts-on-the-conservative-assumptions-in-ai-control]]\nThe lens is the intro we were missing: it states the assumption, says why it is conservative rather than pessimistic, and only then turns to the Roger article as a worked example.\n\nKeep the order. An earlier draft put the article first and readers took \"assume the model is scheming\" as a prediction rather than a design choice.\n\n### [[../articles/greenblatt-if-mythos-actually-made-anthropic-employees-4x-more-productive-i-would-radically-shorten-my-timelines]]\nOne paragraph says the assumptions are being tested now. Quotable, not teachable.\n",
      },
    ],
  },
];

// Lens Edu test documents — real content from lens-edu-relay repo.
// Read file content at setup time; returns null if file not found.
function readEduFile(relativePath) {
  // lens-edu-relay lives at ~/code/lens-edu-relay (sibling of lens-relay, not inside it)
  const homeDir = process.env.HOME || process.env.USERPROFILE || '/home/penguin';
  const eduRelay = path.join(homeDir, 'code', 'lens-edu-relay');
  const filePath = path.join(eduRelay, relativePath);
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

const EDU_DOCS = [
  // Module
  { path: '/modules/feedback-loops.md', id: 'e0000001-0000-4000-8000-000000000001', type: 'markdown', version: 0, file: 'modules/feedback-loops.md' },
  // Learning Outcomes
  { path: '/Learning Outcomes/Feedback cycles create discontinuity.md', id: 'e0000002-0000-4000-8000-000000000002', type: 'markdown', version: 0, file: 'Learning Outcomes/Feedback cycles create discontinuity.md' },
  { path: '/Learning Outcomes/Fizzle or Foom.md', id: 'e0000003-0000-4000-8000-000000000003', type: 'markdown', version: 0, file: 'Learning Outcomes/Fizzle or Foom.md' },
  // Lenses
  { path: '/Lenses/Cascades and Cycles.md', id: 'e0000004-0000-4000-8000-000000000004', type: 'markdown', version: 0, file: 'Lenses/Cascades and Cycles.md' },
  { path: '/Lenses/Speculations concerning the first ultraintelligent machine.md', id: 'e0000005-0000-4000-8000-000000000005', type: 'markdown', version: 0, file: 'Lenses/Speculations concerning the first ultraintelligent machine.md' },
  { path: '/Lenses/What are the differences between a singularity, an intelligence explosion, and a hard takeoff.md', id: 'e0000006-0000-4000-8000-000000000006', type: 'markdown', version: 0, file: 'Lenses/What are the differences between a singularity, an intelligence explosion, and a hard takeoff.md' },
  { path: '/Lenses/Recursion Magic.md', id: 'e0000007-0000-4000-8000-000000000007', type: 'markdown', version: 0, file: 'Lenses/Recursion Magic.md' },
  // Articles referenced by the lenses
  { path: '/articles/yudkowsky-cascades-cycles-insight.md', id: 'e0000008-0000-4000-8000-000000000008', type: 'markdown', version: 0, file: 'articles/yudkowsky-cascades-cycles-insight.md' },
  { path: '/articles/good-speculations-concerning-first-ultraintelligent-machine.md', id: 'e0000009-0000-4000-8000-000000000009', type: 'markdown', version: 0, file: 'articles/good-speculations-concerning-first-ultraintelligent-machine.md' },
  { path: '/articles/aisafety-info-singularity-intelligence-explosion-hard-takeoff.md', id: 'e000000a-0000-4000-8000-00000000000a', type: 'markdown', version: 0, file: 'articles/aisafety-info-singularity-intelligence-explosion-hard-takeoff.md' },
  { path: '/articles/recursion-magic.md', id: 'e000000b-0000-4000-8000-00000000000b', type: 'markdown', version: 0, file: 'articles/recursion-magic.md' },
].map(d => ({ ...d, content: readEduFile(d.file) })).filter(d => d.content !== null);

/** Write `parts` into the doc's text, each under its own clientID mapped to its
 *  actor in the `users` map (an actor of null stays unmapped: unknown). */
function writeAuthored(doc, text, parts) {
  const sessionId = doc.clientID;
  const users = doc.getMap('users');
  parts.forEach((part, i) => {
    const clientID = 0x5eed0000 + i;
    doc.clientID = clientID;
    text.insert(text.length, part.text);
    if (!part.actor) return;
    doc.transact(() => {
      let entry = users.get(part.actor);
      if (!entry) {
        entry = new Y.Map();
        users.set(part.actor, entry);
        entry.set('ids', new Y.Array());
        entry.set('ds', new Y.Array());
        entry.set('meta', new Y.Map());
      }
      entry.get('ids').push([clientID]);
      entry.get('meta').set(String(clientID), { registeredAt: part.at });
    });
  });
  doc.clientID = sessionId;
}

async function createDoc(docId) {
  const response = await fetch(`${RELAY_URL}/doc/new`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ docId }),
  });

  if (!response.ok && response.status !== 409) {
    throw new Error(`Failed to create ${docId}: ${response.status}`);
  }

  return response.json();
}

async function getClientToken(docId) {
  const response = await fetch(`${RELAY_URL}/doc/${docId}/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ authorization: 'full' }),
  });

  if (!response.ok) {
    throw new Error(`Failed to get token for ${docId}: ${response.status}`);
  }

  return response.json();
}

async function checkServer() {
  try {
    const response = await fetch(`${RELAY_URL}/`);
    return response.ok || response.status === 404;
  } catch {
    return false;
  }
}

async function connectAndPopulate(docId, populateFn) {
  const doc = new Y.Doc();
  const authEndpoint = () => getClientToken(docId);

  const provider = new YSweetProvider(authEndpoint, docId, doc, {
    connect: true,
    showDebuggerLink: false,
  });

  // Wait for sync
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Sync timeout')), 10000);

    provider.on('synced', () => {
      clearTimeout(timeout);
      resolve();
    });

    provider.on('connection-error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });

  // Run the populate function
  await populateFn(doc);

  // Wait for sync to propagate
  await new Promise(resolve => setTimeout(resolve, 300));

  // Cleanup
  provider.destroy();
  doc.destroy();
}

async function populateFolderDoc(folderDocId, folderName, testDocs) {
  console.log('\n  Populating filemeta_v0, legacy docs, and folder_config Y.Maps...');

  await connectAndPopulate(folderDocId, (doc) => {
    const filemeta = doc.getMap('filemeta_v0');
    const legacyDocs = doc.getMap('docs');

    doc.transact(() => {
      // Store folder display name so the backend can read it
      const folderConfig = doc.getMap('folder_config');
      folderConfig.set('name', folderName);

      for (const testDoc of testDocs) {
        if (!filemeta.has(testDoc.path)) {
          // Modern format: id, type, version
          filemeta.set(testDoc.path, {
            id: testDoc.id,
            type: testDoc.type,
            version: testDoc.version,
          });
          // Legacy format: path -> guid (required for Obsidian compatibility);
          // like the editor, only for Markdown documents
          if (testDoc.type === 'markdown') {
            legacyDocs.set(testDoc.path, testDoc.id);
          }
          console.log(`    ✓ Added ${testDoc.path}`);
        } else {
          console.log(`    ⚠ ${testDoc.path} already exists`);
        }
      }
    });
  });

  console.log('  ✓ filemeta_v0 + legacy docs + folder_config populated');
}

async function populateDocContent(testDoc) {
  // Skip folders - they don't have content
  if (testDoc.type === 'folder' || !testDoc.content) {
    console.log(`    - ${testDoc.path} (folder, no content)`);
    return;
  }

  const fullDocId = `${RELAY_ID}-${testDoc.id}`;

  await connectAndPopulate(fullDocId, (doc) => {
    // Editor uses getText('contents') - must match!
    const text = doc.getText('contents');

    // Only populate if empty
    if (text.length === 0 && testDoc.authored) {
      writeAuthored(doc, text, testDoc.authored);
      console.log(`    ✓ ${testDoc.path} - content added, with authors`);
    } else if (text.length === 0) {
      text.insert(0, testDoc.content);
      console.log(`    ✓ ${testDoc.path} - content added`);
    } else {
      console.log(`    ⚠ ${testDoc.path} - already has content`);
    }
  });
}

async function main() {
  console.log('Setting up local relay-server for development...\n');

  // Check if server is running
  console.log(`Workspace ${wsNum}: expecting relay-server on port ${relayPort}\n`);

  const serverUp = await checkServer();
  if (!serverUp) {
    console.error('❌ Local relay-server not running!');
    console.error(`   Start it with: npm run relay:start`);
    console.error(`   Or manually: cd ../relay-server && PORT=${relayPort} cargo run -- --config relay.local.toml\n`);
    process.exit(1);
  }
  console.log('✓ Relay server is running\n');

  console.log('⚠ If upgrading from short IDs, delete old data: rm -rf ../relay-server/data-local-ws' + wsNum + '\n');

  // Process each test folder
  for (const folder of TEST_FOLDERS) {
    console.log('─'.repeat(50));
    console.log(`Setting up folder: ${folder.name} (${folder.id})`);
    console.log('─'.repeat(50));

    // Create folder document
    const folderDocId = `${RELAY_ID}-${folder.id}`;
    console.log(`\n  Creating folder document: ${folderDocId}`);
    try {
      await createDoc(folderDocId);
      console.log('  ✓ Folder document created');
    } catch (e) {
      console.log('    (may already exist, continuing...)');
    }

    // Create test documents on server (parallel HTTP POSTs)
    console.log('\n  Creating test documents on server:');
    const createableDocs = folder.docs.filter(d => d.type !== 'folder');
    await Promise.all(createableDocs.map(async (testDoc) => {
      const fullDocId = `${RELAY_ID}-${testDoc.id}`;
      try {
        await createDoc(fullDocId);
        console.log(`    ✓ ${fullDocId}`);
      } catch (e) {
        console.log(`    ⚠ ${fullDocId} (may already exist)`);
      }
    }));
    for (const testDoc of folder.docs.filter(d => d.type === 'folder')) {
      console.log(`    - ${testDoc.path} (folder, no server doc needed)`);
    }

    // Populate the folder doc's filemeta_v0 Y.Map and folder_config
    await populateFolderDoc(folderDocId, folder.name, folder.docs);

    // Populate each document with content (parallel for speed)
    console.log('\n  Populating document content...');
    const contentDocs = folder.docs.filter(d => d.type !== 'folder' && d.content);
    await Promise.all(contentDocs.map(testDoc => populateDocContent(testDoc)));

    console.log(`\n✓ Folder "${folder.name}" setup complete\n`);
  }

  // Add Lens Edu test documents to Folder 1 (if lens-edu-relay repo exists)
  if (EDU_DOCS.length > 0) {
    console.log('─'.repeat(50));
    console.log(`Setting up Lens Edu test documents (${EDU_DOCS.length} docs from lens-edu-relay)`);
    console.log('─'.repeat(50));

    const folder1DocId = `${RELAY_ID}-${FOLDER_1_ID}`;

    // Create docs on server
    console.log('\n  Creating Edu documents on server:');
    for (const testDoc of EDU_DOCS) {
      const fullDocId = `${RELAY_ID}-${testDoc.id}`;
      try {
        await createDoc(fullDocId);
        console.log(`    ✓ ${testDoc.path.split('/').pop()}`);
      } catch (e) {
        console.log(`    ⚠ ${testDoc.path.split('/').pop()} (may already exist)`);
      }
    }

    // Add to folder metadata
    await populateFolderDoc(folder1DocId, 'Relay Folder 1', EDU_DOCS);

    // Populate content (parallel for speed)
    console.log('\n  Populating Edu document content...');
    await Promise.all(EDU_DOCS.map(testDoc => populateDocContent(testDoc)));

    console.log(`\n✓ Lens Edu test documents setup complete\n`);
    console.log('  Test with: /edu/e0000001 (feedback-loops module)\n');
  }

  console.log('─'.repeat(50));
  console.log('All folders setup complete!\n');
  console.log('Test folders created:');
  for (const folder of TEST_FOLDERS) {
    console.log(`  - ${folder.name} (${folder.id})`);
  }
  console.log('\nRelay ID: ' + RELAY_ID);
  console.log('Compound doc ID format: ' + RELAY_ID + '-<doc-uuid> (73 chars)');
  console.log('\nStart the dev server with:');
  console.log('  npm run dev:local\n');
}

main().catch((err) => {
  console.error('Setup failed:', err);
  process.exit(1);
});
