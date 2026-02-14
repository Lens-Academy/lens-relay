# Wikilink Resolution Specification

## Virtual Filesystem Model

Obsidian sees relay folders as top-level directories in a single vault. The relay server stores each folder as a separate Y.Doc with folder-relative paths in `filemeta_v0`. Resolution must operate on the **virtual tree** that unifies both views.

```
VIRTUAL FILESYSTEM                          Y.DOC STRUCTURE
(what Obsidian / users see)                 (what the server stores)

vault root/
│
├── Relay Folder 1/ ◄───────────────────── Folder Doc 1 (Y.Doc)
│   │                                       filemeta_v0:
│   ├── Welcome.md              [W]           /Welcome.md
│   ├── Getting Started.md      [GS]          /Getting Started.md
│   ├── Notes/                  (folder)      /Notes  (type: folder)
│   │   └── Ideas.md            [I]           /Notes/Ideas.md
│   └── Projects/               (folder)      /Projects  (type: folder)
│       └── Roadmap.md          [R]           /Projects/Roadmap.md
│
└── Relay Folder 2/ ◄───────────────────── Folder Doc 2 (Y.Doc)
    │                                       filemeta_v0:
    ├── Course Notes.md         [CN]          /Course Notes.md
    ├── Syllabus.md             [S]           /Syllabus.md
    └── Resources/              (folder)      /Resources  (type: folder)
        └── Links.md            [L]           /Resources/Links.md
```

A file's **virtual path** is `{folder name}{filemeta path}`, e.g. `Relay Folder 1/Notes/Ideas.md`.

A file's **filemeta path** is the key in the folder doc's `filemeta_v0` map, e.g. `/Notes/Ideas.md`.

## Resolution Algorithm

For a wikilink `[[target]]` in a source file with virtual path `{folder}/{filemeta_path}`:

1. **Relative** (priority) — resolve `target` from the source file's directory in the virtual tree, append `.md`
2. **Absolute** (fallback) — `/{target}.md` in the virtual tree
3. Only match entries with `type: "markdown"` (skip folders, images, etc.)
4. Case-insensitive matching
5. Map the resulting virtual path back to (folder name, filemeta path) to find the target document

### Relative resolution

Compute the source file's directory in the virtual tree, then apply the target's path segments:

- Plain name: `[[Ideas]]` from `RF1/Notes/Ideas.md` → dir is `Relay Folder 1/Notes/` → `Relay Folder 1/Notes/Ideas.md`
- Parent traversal: `[[../Welcome]]` from `RF1/Notes/Ideas.md` → `Relay Folder 1/Welcome.md`
- Cross-folder: `[[../../Relay Folder 1/Notes/Ideas]]` from `RF2/Resources/Links.md` → up to `Relay Folder 2/`, up to root, then down → `Relay Folder 1/Notes/Ideas.md`
- Root clamping: `..` beyond vault root stays at root

### Absolute resolution

Prepend `/` and append `.md` to the target, then look up in the virtual tree:

- `[[Relay Folder 1/Notes/Ideas]]` → `/Relay Folder 1/Notes/Ideas.md` → found in RF1's filemeta as `/Notes/Ideas.md`
- `[[Welcome]]` → `/Welcome.md` → nothing at vault root, fails

### What is NOT supported

- **Basename matching**: `[[Ideas]]` does NOT search subdirectories for `Ideas.md`. It only resolves relative to the source's directory or absolute from vault root.
- **Cross-folder without path**: `[[Syllabus]]` from RF1 does not search RF2. Cross-folder links require an explicit path (relative or absolute) that includes the folder name.

## Test Matrix

### From [W] — `Relay Folder 1/Welcome.md` (dir: `Relay Folder 1/`)

| Link | Relative | Absolute | Result |
|---|---|---|---|
| `[[Getting Started]]` | `RF1/Getting Started.md` found | — | **[GS]** |
| `[[Notes/Ideas]]` | `RF1/Notes/Ideas.md` found | — | **[I]** |
| `[[Ideas]]` | `RF1/Ideas.md` not found | `/Ideas.md` not found | **nothing** |
| `[[Nonexistent]]` | `RF1/Nonexistent.md` not found | `/Nonexistent.md` not found | **nothing** |
| `[[Relay Folder 2/Syllabus]]` | `RF1/Relay Folder 2/Syllabus.md` not found | `/Relay Folder 2/Syllabus.md` found | **[S] cross-folder** |
| `[[../Relay Folder 2/Syllabus]]` | `Relay Folder 2/Syllabus.md` found | — | **[S] cross-folder** |

### From [I] — `Relay Folder 1/Notes/Ideas.md` (dir: `Relay Folder 1/Notes/`)

| Link | Relative | Absolute | Result |
|---|---|---|---|
| `[[../Welcome]]` | `RF1/Welcome.md` found | — | **[W]** |
| `[[../Projects/Roadmap]]` | `RF1/Projects/Roadmap.md` found | — | **[R]** |
| `[[../Getting Started]]` | `RF1/Getting Started.md` found | — | **[GS]** |
| `[[Welcome]]` | `RF1/Notes/Welcome.md` not found | `/Welcome.md` not found | **nothing** |
| `[[Getting Started]]` | `RF1/Notes/Getting Started.md` not found | `/Getting Started.md` not found | **nothing** |
| `[[Ideas]]` | `RF1/Notes/Ideas.md` found (self) | — | **[I] self-link** |
| `[[Relay Folder 1/Welcome]]` | `RF1/Notes/Relay Folder 1/Welcome.md` not found | `/Relay Folder 1/Welcome.md` found | **[W] absolute** |

### From [R] — `Relay Folder 1/Projects/Roadmap.md` (dir: `Relay Folder 1/Projects/`)

| Link | Relative | Absolute | Result |
|---|---|---|---|
| `[[../Notes/Ideas]]` | `RF1/Notes/Ideas.md` found | — | **[I]** |
| `[[../Welcome]]` | `RF1/Welcome.md` found | — | **[W]** |
| `[[Notes/Ideas]]` | `RF1/Projects/Notes/Ideas.md` not found | `/Notes/Ideas.md` not found | **nothing** |
| `[[Welcome]]` | `RF1/Projects/Welcome.md` not found | `/Welcome.md` not found | **nothing** |

### From [L] — `Relay Folder 2/Resources/Links.md` (dir: `Relay Folder 2/Resources/`)

| Link | Relative | Absolute | Result |
|---|---|---|---|
| `[[../Syllabus]]` | `RF2/Syllabus.md` found | — | **[S]** |
| `[[../Course Notes]]` | `RF2/Course Notes.md` found | — | **[CN]** |
| `[[Syllabus]]` | `RF2/Resources/Syllabus.md` not found | `/Syllabus.md` not found | **nothing** |
| `[[../../Relay Folder 1/Notes/Ideas]]` | `RF1/Notes/Ideas.md` found | — | **[I] cross-folder (relative)** |
| `[[../../Relay Folder 1/Welcome]]` | `RF1/Welcome.md` found | — | **[W] cross-folder (relative)** |
| `[[Relay Folder 1/Notes/Ideas]]` | `RF2/Resources/RF1/Notes/Ideas.md` not found | `/RF1/Notes/Ideas.md` found | **[I] cross-folder (absolute)** |
| `[[../../Nonexistent Folder/File]]` | `Nonexistent Folder/File.md` no such folder | `/Nonexistent Folder/File.md` not found | **nothing** |

### From [CN] — `Relay Folder 2/Course Notes.md` (dir: `Relay Folder 2/`)

| Link | Relative | Absolute | Result |
|---|---|---|---|
| `[[Syllabus]]` | `RF2/Syllabus.md` found | — | **[S]** |
| `[[Resources/Links]]` | `RF2/Resources/Links.md` found | — | **[L]** |
| `[[../Relay Folder 1/Welcome]]` | `RF1/Welcome.md` found | — | **[W] cross-folder** |
| `[[Relay Folder 1/Welcome]]` | `RF2/Relay Folder 1/Welcome.md` not found | `/RF1/Welcome.md` found | **[W] cross-folder (absolute)** |

### From [S] — `Relay Folder 2/Syllabus.md` (dir: `Relay Folder 2/`)

| Link | Relative | Absolute | Result |
|---|---|---|---|
| `[[Course Notes]]` | `RF2/Course Notes.md` found | — | **[CN]** |
| `[[Resources/Links]]` | `RF2/Resources/Links.md` found | — | **[L]** |

## Parity Rule

For every resolved link, both the frontend and backend must agree:

- If `resolvePageName(target, metadata, sourcePath)` returns a document, then that document's `backlinks_v0` must include the source
- If `resolvePageName()` returns null, then no backlink should be created

## Implications

### Existing test data needs updating

The setup script's current wikilinks use patterns that rely on basename matching or the old absolute-within-folder fallback. Under this spec:

| File | Current link | Status | Correct link |
|---|---|---|---|
| `Ideas.md` | `[[Welcome]]` | broken (no `/Notes/Welcome.md`) | `[[../Welcome]]` |
| `Ideas.md` | `[[Getting Started]]` | broken (no `/Notes/Getting Started.md`) | `[[../Getting Started]]` |
| `Roadmap.md` | `[[Notes/Ideas]]` | broken (no `/Projects/Notes/Ideas.md`) | `[[../Notes/Ideas]]` |
| `Roadmap.md` | `[[Welcome]]` | broken (no `/Projects/Welcome.md`) | `[[../Welcome]]` |
| `Getting Started.md` | `[[Welcome]]` | works (same directory as Welcome.md) | `[[Welcome]]` (no change) |

### Frontend resolver needs the virtual tree

The current `resolvePageName()` operates on a single folder's filemeta. To support cross-folder links and correct absolute resolution, it needs access to all folders' filemeta with folder names as path prefixes.

### Backend indexer needs the virtual tree

The current `resolve_link_to_uuid()` operates per-folder-doc. It needs the same virtual tree view: resolve in the full virtual path space, then map back to the correct folder doc.
