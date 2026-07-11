# Asana Autonomous Task Review Design

## Goal

Give Luc a browser-based review queue for every incomplete `Lens Tasks` Inbox/ToDo item whose Topic contains `Dev::Relay&editor`. Codex preselects tasks that appear suitable for agent implementation, while Luc can select or deselect tasks and leave comments that Codex can read afterward.

## Scope

The initial snapshot contains the 33 currently matching tasks. Reading Asana is allowed; building and using the review app does not modify Asana. Task execution, PR creation, staging merges, and Asana writeback happen only in a later phase after Luc finalizes a pilot selection.

## Classification

Each task records:

- recommendation: selected or not selected;
- fit: autonomous, autonomous with human validation, needs clarification, or defer;
- rationale and likely repository;
- estimated size and confidence;
- automated verification approach;
- whether visual validation is expected;
- delivery recommendation: PR only or eligible for a separately authorized staging merge.

Tasks may be selected even when human visual verification is needed. Broad visual polish, undefined redesigns, production-only mutations, and external coordination remain unselected by default.

## Application

The app is a small repository-local Node service with a static browser UI. It binds to `0.0.0.0` on the first free ws1 utility port, starting at 9103. The UI supports:

- task cards with full description, Asana link, classification, rationale, and verification plan;
- checkbox selection and editable user comments;
- filters for selection, fit, visual validation, repository, and free-text search;
- selected and total counts;
- immediate persistence after changes;
- a visible saved/error state.

The server exposes read and update endpoints over localhost/dev.vps. Updates are validated by task GID and written atomically to a local state file. Asana-derived snapshot data and Codex recommendations are kept separate from Luc's mutable review state, so refreshing source data does not erase choices or comments.

## Data

- `tasks.json`: Asana snapshot plus Codex classification.
- `review-state.json`: task GID to `{ selected, comment, updatedAt }`.

Both files are readable by Codex. The mutable state file is gitignored because it represents a local review session; the classified snapshot and app code are tracked for reproducibility.

## Verification

Automated tests cover state validation, persistence, unknown task rejection, and API round trips. Browser verification covers loading all 33 tasks, filtering, changing a checkbox, entering a comment, refreshing, and confirming both values persist.

## Execution Handoff

After Luc finishes reviewing, Codex reads `review-state.json`, reports the final selected pilot, and asks for any remaining task-specific clarification before creating ephemeral workspaces or changing Asana.
