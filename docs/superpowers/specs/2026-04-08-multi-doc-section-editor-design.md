# Multi-Document Section Editor

## Goal

Show sections from multiple relay documents on a single section editor page, interleaved across documents, each independently editable with full CRDT sync and remote cursor support.

## Context

The current section editor (`SectionEditor.tsx`) works with a single document: one `RelayProvider` wraps the component, providing a single Y.Doc via `useYDoc()`. Sections are parsed from that Y.Doc's `Y.Text('contents')` and rendered as clickable cards. Clicking a card creates a CM instance with `ySectionSync` bound to the Y.Text slice.

For course review workflows, users need to see and edit sections from multiple documents side by side (e.g. a lesson plan + its reference material). This requires managing multiple Y.Doc connections simultaneously.

## Approach: useDocConnection with exposed provider

The existing `useDocConnection` hook already manages multiple simultaneous Y.Doc + YSweetProvider connections in a `Map<docId, { doc, provider }>`. It currently only returns the `Y.Doc` from `getOrConnect()`. We extend it to also return the `YSweetProvider`, which has `.awareness` as a public property (created automatically by y-sweet: `this.awareness = new Awareness(doc)`).

This avoids nested `<RelayProvider>` components or context gymnastics. The multi-doc section editor manages its own connections directly.

### Why not multiple RelayProviders

`useYDoc()` and `useYjsProvider()` read from React context and only see the nearest `<RelayProvider>`. You can't call them N times for N docs from a single component. You'd need N child components inside N providers to extract the Y.Docs, then lift them up — awkward and fragile.

## Architecture

```
URL: /section-editor/abc123+def456
         |
         v
  Split on '+' -> ['abc123', 'def456']
         |
         v
  useMultiDocConnection(ids)
    -> N x { doc: Y.Doc, provider: YSweetProvider }
         |
         v
  N x Y.Text('contents') -> N x parseSections()
         |
         v
  interleaveSections(docSections[]) -> MultiDocSection[]
    (each section tagged with docIndex, docId, ytext, awareness)
         |
         v
  Render: SectionCard per item
  On click: CM with ySectionSync(section.ytext, from, to, { awareness })
```

## URL Format

`/section-editor/:docUuids` where `docUuids` is `+`-separated.

Examples:
- Single doc (backward compatible): `/section-editor/abc12345`
- Two docs: `/section-editor/abc12345+def67890`
- N docs: `/section-editor/abc12345+def67890+ghi11111`

The route pattern stays `/:docUuid` in React Router; the component splits the param on `+`.

## Key Types

```ts
interface MultiDocSection extends Section {
  docIndex: number;          // which document (0, 1, ...)
  compoundDocId: string;     // full compound doc ID
  ytext: Y.Text;             // this doc's Y.Text
  awareness: Awareness;      // this doc's awareness instance
}
```

## Components

### useDocConnection change

Change `getOrConnect` return type from `Promise<Y.Doc>` to `Promise<{ doc: Y.Doc; provider: YSweetProvider }>`.

Update the one existing caller (`ReviewPageWithActions`) to destructure.

### useMultiDocSections (new hook)

Custom hook encapsulating the multi-doc connection + section parsing lifecycle:

```ts
function useMultiDocSections(compoundDocIds: string[]): {
  sections: MultiDocSection[];
  synced: boolean;
  errors: Map<string, Error>;
}
```

Responsibilities:
1. Call `getOrConnect(id)` for each doc ID
2. Initialize awareness on each connection (display name + color, mirroring `AwarenessInitializer` logic)
3. Observe each `Y.Text('contents')` for changes
4. Parse sections from each doc, tag with doc metadata
5. Interleave sections across docs
6. Clean up connections on unmount

### interleaveSections (new pure function)

```ts
function interleaveSections(
  docSections: { sections: Section[]; docIndex: number; compoundDocId: string; ytext: Y.Text; awareness: Awareness }[]
): MultiDocSection[]
```

Round-robin interleave: take one section from each doc in turn, skip exhausted docs. Deterministic — same input always produces same output. Produces a flat array of `MultiDocSection`.

### MultiDocSectionEditor (new component)

Similar to `SectionEditor` but uses `useMultiDocSections` instead of `useYDoc`. Key differences:
- Receives `compoundDocIds: string[]` as prop
- Each section card shows which document it belongs to (small label + color accent)
- On click, creates CM with `ySectionSync(section.ytext, section.from, section.to, { awareness: section.awareness })`
- Doc colors: doc 0 = blue tint, doc 1 = green tint, doc 2 = amber tint, etc.

### SectionCard extraction

Extract `SectionCard` from `SectionEditor.tsx` into its own file so both single-doc and multi-doc editors can reuse it. Add an optional `docLabel` and `docColor` prop for multi-doc context.

### MultiDocSectionEditorView (in App.tsx)

Route handler that:
1. Reads `docUuids` param, splits on `+`
2. Resolves each short UUID to full compound ID via `useResolvedDocId`
3. Renders `<MultiDocSectionEditor compoundDocIds={resolvedIds} />`

Replaces the current `SectionEditorView` which handles single docs. Single-doc URLs still work (no `+` = array of one).

## Awareness Initialization

The current `AwarenessInitializer` component requires `useYjsProvider()` context (inside a `<RelayProvider>`). Since multi-doc doesn't use RelayProvider, awareness is initialized directly in `useMultiDocSections`:

```ts
const { displayName } = useDisplayName();

// After each connection:
const color = USER_COLORS[provider.awareness.clientID % USER_COLORS.length];
provider.awareness.setLocalStateField('user', {
  name: displayName ?? `User ${provider.awareness.clientID % 1000}`,
  color,
});
```

This mirrors `AwarenessInitializer` logic without needing the component.

## What Changes

| File | Change |
|------|--------|
| `hooks/useDocConnection.ts` | Return `{ doc, provider }` from `getOrConnect` |
| `App.tsx` | Update `ReviewPageWithActions` caller; replace `SectionEditorView` with `MultiDocSectionEditorView` |
| `SectionEditor/MultiDocSectionEditor.tsx` | New: multi-doc section editor component |
| `SectionEditor/useMultiDocSections.ts` | New: hook for multi-doc connection + section parsing |
| `SectionEditor/interleaveSections.ts` | New: pure interleave function |
| `SectionEditor/interleaveSections.test.ts` | New: tests for interleaving |
| `SectionEditor/SectionCard.tsx` | Extracted from SectionEditor.tsx, add docLabel/docColor props |
| `SectionEditor/index.ts` | Update exports |

## What Stays the Same

| File | Why |
|------|-----|
| `y-section-sync.ts` | Already doc-agnostic (takes Y.Text + offsets) |
| `parseSections.ts` | Pure function, no doc awareness |
| `SectionEditor.tsx` | Single-doc version preserved (simplified to use extracted SectionCard) |

## Edge Cases

- **Doc fails to connect**: Show error state for that doc's sections, others still render. `useMultiDocSections` tracks errors per doc ID.
- **Doc syncs slowly**: Show "Connecting..." placeholder for pending docs, render available docs immediately.
- **Empty doc**: Doc with no content produces zero sections. Other docs' sections render normally.
- **Same doc twice in URL**: Deduplicate — connect once, show sections once.

## Testing Strategy

- `interleaveSections`: Unit tests (pure function). Test round-robin with 1, 2, 3 docs; uneven section counts; empty docs.
- `useMultiDocSections`: Integration test with real Y.Docs (no mocks). Create N Y.Docs in memory, populate with markdown, verify sections are parsed and interleaved correctly.
- `MultiDocSectionEditor`: Verify CM creation with correct Y.Text and awareness per section.

## Future Work (not in this spec)

- Smarter section ordering (by type, drag-and-drop)
- Section type filtering
- Cross-doc section linking
- Pre-configured "review sets" (named collections of docs)
