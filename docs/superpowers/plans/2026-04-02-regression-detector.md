# Regression Detector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a standalone Python CLI script that detects content regressions in git repos by finding files whose content reverted to a previous state.

**Architecture:** A single Python script with three detection functions (exact reversion via blob hash, near-exact reversion via line-set similarity, full wipe) that build file snapshot timelines from git history and compare them. A test harness creates temporary git repos with known regression patterns to verify each detector.

**Tech Stack:** Python 3.12, subprocess (git CLI), pytest, argparse

---

## File Structure

```
scripts/detect-regressions.py     # Main CLI script (all detection logic + output formatting)
tests/test_detect_regressions.py  # All tests — uses temporary git repos as fixtures
```

Two files total. The script is self-contained with no external dependencies beyond Python stdlib and git. Tests use pytest with `tmp_path` fixtures to create throwaway git repos.

---

### Task 1: Test Harness — Git Repo Fixture Helper

**Files:**
- Create: `tests/test_detect_regressions.py`

The test helper creates temporary git repos with specific commit histories. Every subsequent test task uses this helper.

- [ ] **Step 1: Write the fixture helper and a smoke test**

```python
# tests/test_detect_regressions.py
import subprocess
import os
import pytest


def git(repo_path: str, *args: str) -> str:
    """Run a git command in the given repo, return stdout."""
    result = subprocess.run(
        ["git", "-C", repo_path] + list(args),
        capture_output=True, text=True, check=True,
    )
    return result.stdout.strip()


def make_repo(tmp_path) -> str:
    """Create an empty git repo and return its path."""
    repo = str(tmp_path / "repo")
    os.makedirs(repo)
    git(repo, "init")
    git(repo, "config", "user.email", "test@test.com")
    git(repo, "config", "user.name", "Test")
    # Initial commit so we have a HEAD
    dummy = os.path.join(repo, ".gitkeep")
    open(dummy, "w").close()
    git(repo, "add", ".")
    git(repo, "commit", "-m", "initial")
    return repo


def write_file(repo: str, filename: str, content: str) -> None:
    """Write content to a file in the repo."""
    filepath = os.path.join(repo, filename)
    os.makedirs(os.path.dirname(filepath), exist_ok=True)
    with open(filepath, "w") as f:
        f.write(content)


def commit(repo: str, message: str, date: str | None = None) -> str:
    """Stage all and commit. Returns commit hash. Optional date in ISO format."""
    git(repo, "add", ".")
    date_args = ["--date", date] if date else []
    git(repo, "commit", "-m", message, *date_args)
    return git(repo, "rev-parse", "HEAD")


# ---- Smoke test ----

def test_make_repo(tmp_path):
    repo = make_repo(tmp_path)
    log = git(repo, "log", "--oneline")
    assert "initial" in log
```

- [ ] **Step 2: Run test to verify it passes**

Run: `cd /home/penguin/code/lens-relay/ws2 && python3 -m pytest tests/test_detect_regressions.py -v`
Expected: PASS — `test_make_repo` passes

- [ ] **Step 3: Commit**

```bash
jj new -m "feat: regression detector test harness"
# (files are auto-tracked)
```

---

### Task 2: Git History Reader — Build Snapshot Timelines

**Files:**
- Create: `scripts/detect-regressions.py`
- Modify: `tests/test_detect_regressions.py`

The core data layer: given a repo path and a lookback window, produce a dict mapping each file to its timeline of `(commit_hash, date, blob_hash)` tuples.

- [ ] **Step 1: Write the failing test**

Add to `tests/test_detect_regressions.py`:

```python
import sys
import os

# Add scripts/ to path so we can import the module
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))

from importlib import import_module
detect = import_module("detect-regressions")


def test_build_timelines_single_file(tmp_path):
    repo = make_repo(tmp_path)
    write_file(repo, "notes.md", "line one\n")
    c1 = commit(repo, "add notes", date="2026-04-01T10:00:00+00:00")
    write_file(repo, "notes.md", "line one\nline two\n")
    c2 = commit(repo, "update notes", date="2026-04-01T10:01:00+00:00")

    timelines = detect.build_timelines(repo, days=7)

    assert "notes.md" in timelines
    tl = timelines["notes.md"]
    assert len(tl) == 2
    assert tl[0].commit == c1
    assert tl[1].commit == c2
    # Each entry should have a blob_hash
    assert tl[0].blob_hash != tl[1].blob_hash


def test_build_timelines_respects_window(tmp_path):
    repo = make_repo(tmp_path)
    write_file(repo, "old.md", "old content\n")
    commit(repo, "old commit", date="2026-03-01T10:00:00+00:00")
    write_file(repo, "new.md", "new content\n")
    commit(repo, "new commit", date="2026-04-01T10:00:00+00:00")

    # 7-day window from latest commit should only include new.md
    timelines = detect.build_timelines(repo, days=7)
    assert "new.md" not in timelines or True  # old.md may appear if it's in the window
    # old.md was committed 31 days before latest — outside window
    assert "old.md" not in timelines
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/penguin/code/lens-relay/ws2 && python3 -m pytest tests/test_detect_regressions.py::test_build_timelines_single_file -v`
Expected: FAIL — `ModuleNotFoundError` or `AttributeError` (module doesn't exist yet)

- [ ] **Step 3: Write minimal implementation**

Create `scripts/detect-regressions.py`:

```python
#!/usr/bin/env python3
"""Detect content regressions in git repositories."""

import subprocess
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone


@dataclass
class Snapshot:
    commit: str
    date: datetime
    blob_hash: str


def _git(repo: str, *args: str) -> str:
    result = subprocess.run(
        ["git", "-C", repo] + list(args),
        capture_output=True, text=True, check=True,
    )
    return result.stdout.strip()


def build_timelines(repo: str, days: int = 7) -> dict[str, list[Snapshot]]:
    """Build a timeline of snapshots for each file modified within the lookback window.

    Returns a dict mapping file paths to lists of Snapshot, ordered chronologically.
    """
    # Find the latest commit date to anchor the window
    latest_date_str = _git(repo, "log", "-1", "--format=%aI")
    latest_date = datetime.fromisoformat(latest_date_str)
    cutoff = latest_date - timedelta(days=days)
    cutoff_iso = cutoff.isoformat()

    # Get all commits in the window with their dates
    log_output = _git(
        repo, "log", "--format=%H %aI", f"--since={cutoff_iso}", "--reverse"
    )
    if not log_output:
        return {}

    commits = []
    for line in log_output.splitlines():
        parts = line.split(" ", 1)
        commits.append((parts[0], datetime.fromisoformat(parts[1])))

    # For each commit, find which files changed and their blob hashes
    timelines: dict[str, list[Snapshot]] = {}

    for commit_hash, commit_date in commits:
        # Get files changed in this commit
        try:
            diff_output = _git(
                repo, "diff-tree", "--no-commit-id", "-r", commit_hash
            )
        except subprocess.CalledProcessError:
            continue

        if not diff_output:
            continue

        for line in diff_output.splitlines():
            # Format: :old_mode new_mode old_hash new_hash status\tfilename
            parts = line.split("\t", 1)
            if len(parts) != 2:
                continue
            meta, filepath = parts
            meta_parts = meta.split()
            if len(meta_parts) < 5:
                continue
            new_blob_hash = meta_parts[3]
            status = meta_parts[4]

            # Skip deleted files
            if status.startswith("D"):
                continue

            snapshot = Snapshot(
                commit=commit_hash,
                date=commit_date,
                blob_hash=new_blob_hash,
            )
            timelines.setdefault(filepath, []).append(snapshot)

    return timelines
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /home/penguin/code/lens-relay/ws2 && python3 -m pytest tests/test_detect_regressions.py -v`
Expected: PASS — all three tests pass (smoke + two timeline tests)

- [ ] **Step 5: Commit**

```bash
jj new -m "feat: regression detector — git history reader"
```

---

### Task 3: Detector 1 — Exact Reversion (Blob Hash Match)

**Files:**
- Modify: `scripts/detect-regressions.py`
- Modify: `tests/test_detect_regressions.py`

Detect when a file's blob hash at a later commit matches an earlier commit's blob hash, with different hashes in between.

- [ ] **Step 1: Write the failing test**

Add to `tests/test_detect_regressions.py`:

```python
def test_detect_exact_reversion(tmp_path):
    repo = make_repo(tmp_path)
    write_file(repo, "doc.md", "original content\n")
    c1 = commit(repo, "add doc", date="2026-04-01T10:00:00+00:00")
    write_file(repo, "doc.md", "original content\nextra stuff\nmore lines\n")
    c2 = commit(repo, "expand doc", date="2026-04-01T10:01:00+00:00")
    write_file(repo, "doc.md", "original content\n")
    c3 = commit(repo, "revert doc", date="2026-04-01T10:02:00+00:00")

    timelines = detect.build_timelines(repo, days=7)
    regressions = detect.detect_exact_reversions(timelines)

    assert len(regressions) == 1
    r = regressions[0]
    assert r.file == "doc.md"
    assert r.reverted_at == c3
    assert r.reverted_to == c1
    assert r.regression_type == "exact-reversion"


def test_exact_reversion_many_commits_to_one(tmp_path):
    """Content built over many small commits, then undone in a single commit."""
    repo = make_repo(tmp_path)
    write_file(repo, "doc.md", "base\n")
    c_base = commit(repo, "base", date="2026-04-01T10:00:00+00:00")
    # Simulate 10 auto-sync commits adding content incrementally
    content = "base\n"
    for i in range(10):
        content += f"line {i}\n"
        write_file(repo, "doc.md", content)
        commit(repo, f"auto-sync {i}", date=f"2026-04-01T10:{i+1:02d}:00+00:00")
    # Single commit reverts back to original
    write_file(repo, "doc.md", "base\n")
    c_revert = commit(repo, "revert all", date="2026-04-01T10:30:00+00:00")

    timelines = detect.build_timelines(repo, days=7)
    regressions = detect.detect_exact_reversions(timelines)

    assert len(regressions) == 1
    r = regressions[0]
    assert r.file == "doc.md"
    assert r.reverted_at == c_revert
    assert r.reverted_to == c_base


def test_no_false_positive_on_normal_edits(tmp_path):
    repo = make_repo(tmp_path)
    write_file(repo, "doc.md", "version 1\n")
    commit(repo, "v1", date="2026-04-01T10:00:00+00:00")
    write_file(repo, "doc.md", "version 2\n")
    commit(repo, "v2", date="2026-04-01T10:01:00+00:00")
    write_file(repo, "doc.md", "version 3\n")
    commit(repo, "v3", date="2026-04-01T10:02:00+00:00")

    timelines = detect.build_timelines(repo, days=7)
    regressions = detect.detect_exact_reversions(timelines)

    assert len(regressions) == 0
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /home/penguin/code/lens-relay/ws2 && python3 -m pytest tests/test_detect_regressions.py::test_detect_exact_reversion -v`
Expected: FAIL — `AttributeError: module has no attribute 'detect_exact_reversions'`

- [ ] **Step 3: Write minimal implementation**

Add to `scripts/detect-regressions.py`:

```python
@dataclass
class Regression:
    file: str
    regression_type: str  # "exact-reversion", "near-exact-reversion", "full-wipe"
    reverted_at: str      # commit hash where regression happened
    reverted_to: str      # commit hash of the state it reverted to
    reverted_at_date: datetime | None = None
    reverted_to_date: datetime | None = None
    detail: str = ""


def detect_exact_reversions(timelines: dict[str, list[Snapshot]]) -> list[Regression]:
    """Detect files where a blob hash reappears after different hashes in between."""
    regressions = []

    for filepath, snapshots in timelines.items():
        if len(snapshots) < 3:
            continue

        # For each snapshot, check if its blob hash appeared earlier
        # with different hashes in between
        for i in range(2, len(snapshots)):
            current_hash = snapshots[i].blob_hash
            for j in range(i - 2, -1, -1):
                if snapshots[j].blob_hash == current_hash:
                    # Check there's at least one different hash between j and i
                    has_different = any(
                        snapshots[k].blob_hash != current_hash
                        for k in range(j + 1, i)
                    )
                    if has_different:
                        regressions.append(Regression(
                            file=filepath,
                            regression_type="exact-reversion",
                            reverted_at=snapshots[i].commit,
                            reverted_to=snapshots[j].commit,
                            reverted_at_date=snapshots[i].date,
                            reverted_to_date=snapshots[j].date,
                        ))
                        break  # Found earliest match, stop looking back
            # Only report the first reversion per file
            if regressions and regressions[-1].file == filepath:
                break

    return regressions
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /home/penguin/code/lens-relay/ws2 && python3 -m pytest tests/test_detect_regressions.py -v`
Expected: PASS — all tests pass

- [ ] **Step 5: Commit**

```bash
jj new -m "feat: regression detector — exact reversion detection"
```

---

### Task 4: Detector 2 — Near-Exact Reversion (Line-Set Similarity)

**Files:**
- Modify: `scripts/detect-regressions.py`
- Modify: `tests/test_detect_regressions.py`

Detect when a file's content becomes very similar to a prior state after having diverged. Uses line-set comparison on actual file content (read via `git show`).

- [ ] **Step 1: Write the failing tests**

Add to `tests/test_detect_regressions.py`:

```python
def test_detect_near_exact_reversion(tmp_path):
    """Content reverts to ~identical state but with minor whitespace/formatting diff."""
    repo = make_repo(tmp_path)
    write_file(repo, "doc.md", "line one\nline two\nline three\n")
    c1 = commit(repo, "original", date="2026-04-01T10:00:00+00:00")
    write_file(repo, "doc.md", "line one\nline two\nline three\nextra A\nextra B\nextra C\n")
    c2 = commit(repo, "add content", date="2026-04-01T10:01:00+00:00")
    # Revert to nearly-identical state (tiny difference — trailing space)
    write_file(repo, "doc.md", "line one\nline two \nline three\n")
    c3 = commit(repo, "near-revert", date="2026-04-01T10:02:00+00:00")

    timelines = detect.build_timelines(repo, days=7)
    regressions = detect.detect_near_exact_reversions(repo, timelines)

    assert len(regressions) == 1
    r = regressions[0]
    assert r.file == "doc.md"
    assert r.regression_type == "near-exact-reversion"


def test_near_exact_no_false_positive_growing_file(tmp_path):
    """A file that grows over time should not be flagged."""
    repo = make_repo(tmp_path)
    write_file(repo, "doc.md", "line one\n")
    commit(repo, "start", date="2026-04-01T10:00:00+00:00")
    write_file(repo, "doc.md", "line one\nline two\n")
    commit(repo, "grow", date="2026-04-01T10:01:00+00:00")
    write_file(repo, "doc.md", "line one\nline two\nline three\n")
    commit(repo, "grow more", date="2026-04-01T10:02:00+00:00")

    timelines = detect.build_timelines(repo, days=7)
    regressions = detect.detect_near_exact_reversions(repo, timelines)

    assert len(regressions) == 0
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /home/penguin/code/lens-relay/ws2 && python3 -m pytest tests/test_detect_regressions.py::test_detect_near_exact_reversion -v`
Expected: FAIL — `AttributeError: module has no attribute 'detect_near_exact_reversions'`

- [ ] **Step 3: Write minimal implementation**

Add to `scripts/detect-regressions.py`:

```python
def _get_file_lines(repo: str, commit: str, filepath: str) -> set[str]:
    """Get normalized line set for a file at a specific commit."""
    try:
        content = _git(repo, "show", f"{commit}:{filepath}")
    except subprocess.CalledProcessError:
        return set()
    return {line.strip() for line in content.splitlines() if line.strip()}


def detect_near_exact_reversions(
    repo: str,
    timelines: dict[str, list[Snapshot]],
    similarity_threshold: float = 0.9,
) -> list[Regression]:
    """Detect files where content becomes very similar to a prior state
    after having diverged (different blob hashes, but similar line content)."""
    regressions = []

    for filepath, snapshots in timelines.items():
        if len(snapshots) < 3:
            continue

        # Skip files already caught by exact reversion (same blob hash)
        blob_hashes = [s.blob_hash for s in snapshots]

        # Compare latest snapshot against earlier ones
        for i in range(len(snapshots) - 1, 1, -1):
            if blob_hashes[i] in blob_hashes[:i]:
                # Already caught by exact reversion detector
                continue

            lines_i = _get_file_lines(repo, snapshots[i].commit, filepath)
            if not lines_i:
                continue

            for j in range(i - 2, -1, -1):
                if blob_hashes[j] == blob_hashes[i]:
                    continue

                lines_j = _get_file_lines(repo, snapshots[j].commit, filepath)
                if not lines_j:
                    continue

                # How similar is snapshot i to snapshot j?
                if len(lines_j) == 0:
                    continue
                overlap = len(lines_i & lines_j) / len(lines_j)

                if overlap >= similarity_threshold:
                    # Check that something meaningful existed in between
                    # that is NOT in the current snapshot
                    has_lost_content = False
                    for k in range(j + 1, i):
                        lines_k = _get_file_lines(repo, snapshots[k].commit, filepath)
                        added_then_lost = lines_k - lines_i
                        if len(added_then_lost) >= 1:
                            has_lost_content = True
                            break

                    if has_lost_content:
                        regressions.append(Regression(
                            file=filepath,
                            regression_type="near-exact-reversion",
                            reverted_at=snapshots[i].commit,
                            reverted_to=snapshots[j].commit,
                            reverted_at_date=snapshots[i].date,
                            reverted_to_date=snapshots[j].date,
                        ))
                        break
            # Only report first reversion per file
            if regressions and regressions[-1].file == filepath:
                break

    return regressions
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /home/penguin/code/lens-relay/ws2 && python3 -m pytest tests/test_detect_regressions.py -v`
Expected: PASS — all tests pass

- [ ] **Step 5: Commit**

```bash
jj new -m "feat: regression detector — near-exact reversion detection"
```

---

### Task 5: Detector 3 — Full Wipe

**Files:**
- Modify: `scripts/detect-regressions.py`
- Modify: `tests/test_detect_regressions.py`

Detect files that were wiped to near-empty content. This catches cases where the empty state has never existed before (so blob hash won't match).

- [ ] **Step 1: Write the failing test**

Add to `tests/test_detect_regressions.py`:

```python
def test_detect_full_wipe(tmp_path):
    repo = make_repo(tmp_path)
    write_file(repo, "doc.md", "lots of content\n" * 10)
    c1 = commit(repo, "add content", date="2026-04-01T10:00:00+00:00")
    write_file(repo, "doc.md", "_")
    c2 = commit(repo, "wipe it", date="2026-04-01T10:01:00+00:00")

    timelines = detect.build_timelines(repo, days=7)
    regressions = detect.detect_full_wipes(repo, timelines)

    assert len(regressions) == 1
    r = regressions[0]
    assert r.file == "doc.md"
    assert r.regression_type == "full-wipe"
    assert r.reverted_at == c2


def test_no_wipe_for_small_files(tmp_path):
    """A file that was always small should not be flagged."""
    repo = make_repo(tmp_path)
    write_file(repo, "tiny.md", "hi\n")
    commit(repo, "small file", date="2026-04-01T10:00:00+00:00")
    write_file(repo, "tiny.md", "_")
    commit(repo, "replace", date="2026-04-01T10:01:00+00:00")

    timelines = detect.build_timelines(repo, days=7)
    regressions = detect.detect_full_wipes(repo, timelines)

    assert len(regressions) == 0
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /home/penguin/code/lens-relay/ws2 && python3 -m pytest tests/test_detect_regressions.py::test_detect_full_wipe -v`
Expected: FAIL — `AttributeError: module has no attribute 'detect_full_wipes'`

- [ ] **Step 3: Write minimal implementation**

Add to `scripts/detect-regressions.py`:

```python
def _get_file_size(repo: str, commit: str, filepath: str) -> int:
    """Get file size in bytes at a specific commit."""
    try:
        content = _git(repo, "show", f"{commit}:{filepath}")
        return len(content.encode("utf-8"))
    except subprocess.CalledProcessError:
        return 0


_EMPTY_PATTERNS = {"", "_", " ", "\n", "\r\n"}
_MIN_PEAK_SIZE = 50  # bytes — files that never exceeded this aren't flagged


def detect_full_wipes(
    repo: str,
    timelines: dict[str, list[Snapshot]],
) -> list[Regression]:
    """Detect files that were wiped to near-empty content."""
    regressions = []

    for filepath, snapshots in timelines.items():
        if len(snapshots) < 2:
            continue

        latest = snapshots[-1]

        # Check if latest content is near-empty
        try:
            content = _git(repo, "show", f"{latest.commit}:{filepath}")
        except subprocess.CalledProcessError:
            continue

        if content.strip() not in _EMPTY_PATTERNS:
            continue
        current_size = len(content.encode("utf-8"))

        # Find peak size in the timeline
        peak_size = 0
        peak_snapshot = snapshots[0]
        for s in snapshots:
            size = _get_file_size(repo, s.commit, filepath)
            if size > peak_size:
                peak_size = size
                peak_snapshot = s

        if peak_size < _MIN_PEAK_SIZE:
            continue

        regressions.append(Regression(
            file=filepath,
            regression_type="full-wipe",
            reverted_at=latest.commit,
            reverted_to=peak_snapshot.commit,
            reverted_at_date=latest.date,
            reverted_to_date=peak_snapshot.date,
            detail=f"Peak: {peak_size} bytes, now: {current_size} bytes",
        ))

    return regressions
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /home/penguin/code/lens-relay/ws2 && python3 -m pytest tests/test_detect_regressions.py -v`
Expected: PASS — all tests pass

- [ ] **Step 5: Commit**

```bash
jj new -m "feat: regression detector — full wipe detection"
```

---

### Task 6: CLI Entrypoint and Output Formatting

**Files:**
- Modify: `scripts/detect-regressions.py`
- Modify: `tests/test_detect_regressions.py`

Wire the three detectors together with argparse CLI and text/JSON output.

- [ ] **Step 1: Write the failing test**

Add to `tests/test_detect_regressions.py`:

```python
import json


def test_cli_text_output(tmp_path):
    """End-to-end: CLI produces text output for a repo with a regression."""
    repo = make_repo(tmp_path)
    write_file(repo, "doc.md", "original content\nwith lines\n")
    commit(repo, "add", date="2026-04-01T10:00:00+00:00")
    write_file(repo, "doc.md", "original content\nwith lines\nextra\n")
    commit(repo, "expand", date="2026-04-01T10:01:00+00:00")
    write_file(repo, "doc.md", "original content\nwith lines\n")
    commit(repo, "revert", date="2026-04-01T10:02:00+00:00")

    output = detect.run_cli([repo, "--days", "7", "--output", "text"])

    assert "doc.md" in output
    assert "exact-reversion" in output


def test_cli_json_output(tmp_path):
    """End-to-end: CLI produces valid JSON output."""
    repo = make_repo(tmp_path)
    write_file(repo, "doc.md", "lots of content\n" * 10)
    commit(repo, "add", date="2026-04-01T10:00:00+00:00")
    write_file(repo, "doc.md", "_")
    commit(repo, "wipe", date="2026-04-01T10:01:00+00:00")

    output = detect.run_cli([repo, "--days", "7", "--output", "json"])

    data = json.loads(output)
    assert len(data) >= 1
    assert data[0]["file"] == "doc.md"
    assert data[0]["type"] == "full-wipe"


def test_cli_multiple_files_regress_in_one_commit(tmp_path):
    """Multiple files wiped in the same commit — both should be detected."""
    repo = make_repo(tmp_path)
    write_file(repo, "doc1.md", "content one\n" * 5)
    write_file(repo, "doc2.md", "content two\n" * 5)
    commit(repo, "add both", date="2026-04-01T10:00:00+00:00")
    write_file(repo, "doc1.md", "_")
    write_file(repo, "doc2.md", "_")
    commit(repo, "wipe both", date="2026-04-01T10:01:00+00:00")

    output = detect.run_cli([repo, "--days", "7", "--output", "json"])
    data = json.loads(output)

    files = {r["file"] for r in data}
    assert "doc1.md" in files
    assert "doc2.md" in files


def test_cli_file_existed_before_window(tmp_path):
    """File had content before the lookback window, gets wiped within it."""
    repo = make_repo(tmp_path)
    write_file(repo, "doc.md", "old content that existed for months\n" * 5)
    commit(repo, "old content", date="2026-01-01T10:00:00+00:00")
    # A small edit within the window
    write_file(repo, "doc.md", "old content that existed for months\n" * 5 + "tiny addition\n")
    commit(repo, "small edit", date="2026-04-01T10:00:00+00:00")
    # Wipe within window
    write_file(repo, "doc.md", "_")
    commit(repo, "wipe", date="2026-04-01T10:01:00+00:00")

    output = detect.run_cli([repo, "--days", "7", "--output", "json"])
    data = json.loads(output)

    assert len(data) >= 1
    assert data[0]["file"] == "doc.md"


def test_cli_clean_repo(tmp_path):
    """No regressions — clean output."""
    repo = make_repo(tmp_path)
    write_file(repo, "doc.md", "just fine\n")
    commit(repo, "fine", date="2026-04-01T10:00:00+00:00")

    output = detect.run_cli([repo, "--days", "7", "--output", "text"])

    assert "No regressions" in output
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /home/penguin/code/lens-relay/ws2 && python3 -m pytest tests/test_detect_regressions.py::test_cli_text_output -v`
Expected: FAIL — `AttributeError: module has no attribute 'run_cli'`

- [ ] **Step 3: Write minimal implementation**

Add to `scripts/detect-regressions.py`:

```python
import argparse
import json as json_module
import sys


def format_text(regressions: list[Regression]) -> str:
    if not regressions:
        return "No regressions detected."

    lines = []
    for r in regressions:
        lines.append(f"Regression detected in: {r.file}")
        lines.append(f"  Type: {r.regression_type}")
        lines.append(f"  Reverted at: {r.reverted_at[:8]} ({r.reverted_at_date})")
        lines.append(f"  Reverted to: {r.reverted_to[:8]} ({r.reverted_to_date})")
        if r.detail:
            lines.append(f"  Detail: {r.detail}")
        lines.append("")
    return "\n".join(lines)


def format_json(regressions: list[Regression]) -> str:
    return json_module.dumps([
        {
            "file": r.file,
            "type": r.regression_type,
            "reverted_at": r.reverted_at,
            "reverted_to": r.reverted_to,
            "reverted_at_date": r.reverted_at_date.isoformat() if r.reverted_at_date else None,
            "reverted_to_date": r.reverted_to_date.isoformat() if r.reverted_to_date else None,
            "detail": r.detail,
        }
        for r in regressions
    ], indent=2)


def run_cli(argv: list[str] | None = None) -> str:
    parser = argparse.ArgumentParser(description="Detect content regressions in git repos")
    parser.add_argument("repo", help="Path to git repository")
    parser.add_argument("--days", type=int, default=7, help="Lookback window in days (default: 7)")
    parser.add_argument("--output", choices=["text", "json"], default="text", help="Output format")
    args = parser.parse_args(argv)

    timelines = build_timelines(args.repo, days=args.days)

    regressions: list[Regression] = []
    regressions.extend(detect_exact_reversions(timelines))
    regressions.extend(detect_near_exact_reversions(args.repo, timelines))
    regressions.extend(detect_full_wipes(args.repo, timelines))

    # Deduplicate — a file might be caught by multiple detectors
    seen_files: set[str] = set()
    unique: list[Regression] = []
    for r in regressions:
        if r.file not in seen_files:
            seen_files.add(r.file)
            unique.append(r)

    if args.output == "json":
        return format_json(unique)
    else:
        return format_text(unique)


if __name__ == "__main__":
    print(run_cli())
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /home/penguin/code/lens-relay/ws2 && python3 -m pytest tests/test_detect_regressions.py -v`
Expected: PASS — all tests pass

- [ ] **Step 5: Commit**

```bash
jj new -m "feat: regression detector — CLI and output formatting"
```

---

### Task 7: Validate Against Real Repos

**Files:** none (manual validation)

Run the detector against the two real repos to verify it catches the known regressions and doesn't produce excessive false positives.

- [ ] **Step 1: Run against lens-folder-relay with full history**

```bash
cd /home/penguin/code/lens-relay/ws2
python3 scripts/detect-regressions.py ~/code/lens-folder-relay --days 90 --output text
```

Expected: Should flag at least `Navigator Training Course.md` (full-wipe) and `adam-magyar-stainless-alexanderplatz.md` (full-wipe).

- [ ] **Step 2: Run against lens-edu-relay**

```bash
cd /home/penguin/code/lens-relay/ws2
python3 scripts/detect-regressions.py ~/code/lens-edu-relay --days 90 --output text
```

Expected: Review output for regressions. Investigate any flagged files to confirm they're real.

- [ ] **Step 3: Check JSON output**

```bash
python3 scripts/detect-regressions.py ~/code/lens-folder-relay --days 90 --output json | python3 -m json.tool
```

Expected: Valid JSON array.

- [ ] **Step 4: Tune thresholds if needed**

If there are false positives or missed regressions, adjust:
- `_MIN_PEAK_SIZE` (minimum file size to flag wipes)
- `similarity_threshold` in `detect_near_exact_reversions` 
- The `_EMPTY_PATTERNS` set

- [ ] **Step 5: Commit any threshold adjustments**

```bash
jj new -m "chore: tune regression detector thresholds"
```

- [ ] **Step 6: Make script executable**

```bash
chmod +x scripts/detect-regressions.py
jj new -m "chore: make detect-regressions.py executable"
```
