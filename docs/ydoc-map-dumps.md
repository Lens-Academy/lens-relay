# Y.Doc Map Dumps (Local Relay)

Extracted: 2026-02-08T13:42:52.595Z
Relay URL: http://localhost:8090
Relay ID: a0000000-0000-4000-8000-000000000000

---

## Relay Folder 1

Folder doc ID: `a0000000-0000-4000-8000-000000000000-b0000001-0000-4000-8000-000000000001`

### filemeta_v0

Maps path -> metadata for every file/folder in this shared folder.

```json
{
  "/Notes": {
    "type": "folder",
    "id": "c0000010-0000-4000-8000-000000000010",
    "version": 0
  },
  "/Welcome.md": {
    "version": 0,
    "id": "c0000001-0000-4000-8000-000000000001",
    "type": "markdown"
  },
  "/Getting Started.md": {
    "id": "c0000002-0000-4000-8000-000000000002",
    "type": "markdown",
    "version": 0
  },
  "/Notes/Ideas.md": {
    "version": 0,
    "type": "markdown",
    "id": "c0000003-0000-4000-8000-000000000003"
  }
}
```

### docs (legacy)

Maps path -> UUID. Required for Obsidian compatibility.

```json
{
  "/Welcome.md": "c0000001-0000-4000-8000-000000000001",
  "/Getting Started.md": "c0000002-0000-4000-8000-000000000002",
  "/Notes/Ideas.md": "c0000003-0000-4000-8000-000000000003"
}
```

### backlinks_v0

Maps target_uuid -> array of source_uuids that link to it.

```json
{
  "c0000002-0000-4000-8000-000000000002": [
    "c0000001-0000-4000-8000-000000000001",
    "c0000003-0000-4000-8000-000000000003"
  ],
  "c0000003-0000-4000-8000-000000000003": [
    "c0000001-0000-4000-8000-000000000001"
  ],
  "c0000001-0000-4000-8000-000000000001": [
    "c0000002-0000-4000-8000-000000000002",
    "c0000003-0000-4000-8000-000000000003"
  ]
}
```

---

## Relay Folder 2

Folder doc ID: `a0000000-0000-4000-8000-000000000000-b0000002-0000-4000-8000-000000000002`

### filemeta_v0

Maps path -> metadata for every file/folder in this shared folder.

```json
{
  "/Resources": {
    "type": "folder",
    "id": "c0000020-0000-4000-8000-000000000020",
    "version": 0
  },
  "/Course Notes.md": {
    "id": "c0000004-0000-4000-8000-000000000004",
    "version": 0,
    "type": "markdown"
  },
  "/Syllabus.md": {
    "type": "markdown",
    "version": 0,
    "id": "c0000005-0000-4000-8000-000000000005"
  },
  "/Resources/Links.md": {
    "type": "markdown",
    "version": 0,
    "id": "c0000006-0000-4000-8000-000000000006"
  }
}
```

### docs (legacy)

Maps path -> UUID. Required for Obsidian compatibility.

```json
{
  "/Course Notes.md": "c0000004-0000-4000-8000-000000000004",
  "/Syllabus.md": "c0000005-0000-4000-8000-000000000005",
  "/Resources/Links.md": "c0000006-0000-4000-8000-000000000006"
}
```

### backlinks_v0

Maps target_uuid -> array of source_uuids that link to it.

```json
{
  "c0000006-0000-4000-8000-000000000006": [
    "c0000004-0000-4000-8000-000000000004"
  ],
  "c0000005-0000-4000-8000-000000000005": [
    "c0000004-0000-4000-8000-000000000004",
    "c0000006-0000-4000-8000-000000000006"
  ],
  "c0000004-0000-4000-8000-000000000004": [
    "c0000005-0000-4000-8000-000000000005",
    "c0000006-0000-4000-8000-000000000006"
  ]
}
```
