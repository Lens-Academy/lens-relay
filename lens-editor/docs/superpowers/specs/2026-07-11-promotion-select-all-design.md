# Promotion Select All Control

## Goal

Let an admin select every changed promotion file without clicking hundreds of
individual rows.

## Design

Add a `Select all files` checkbox beside the selected-file count on `/promote`.
Checking it selects every file returned by `GET /api/promotion/changes`,
regardless of the current text filter. Unchecking it clears the full selection.
The checkbox is checked only when every changed file is selected.

Individual row selection, query-string preselection, PR creation, and backend
authorization remain unchanged. The control is not shown when there are no
changed files. Raise the backend request limit from 100 to 1,000 paths so the
bulk selection can promote the current change set while retaining a finite
abuse guard.

## Testing

- Selecting all checks every file and updates the count.
- Clearing select all unchecks every file and resets the count.
- The backend accepts 101 paths and rejects 1,001 paths.
- Existing individual-selection tests continue to pass.

## Out Of Scope

- Status, directory, or other review-style filters.
- Selecting only currently filtered rows.
- Removing the backend promotion limit entirely.
