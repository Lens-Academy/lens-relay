import subprocess
import os
import sys
import json
import pytest

# Add scripts/ to path so we can import the module
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))

from importlib import import_module
detect = import_module("detect-regressions")


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
    # old.md was committed 31 days before latest — outside window
    assert "old.md" not in timelines


# ---- detect_exact_reversions tests ----

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


# ---- detect_near_exact_reversions tests ----

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


# ---- detect_full_wipes tests ----

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


# ---- CLI / output formatting tests ----

def test_cli_text_output(tmp_path):
    """End-to-end: CLI produces text output for a repo with a regression."""
    repo = make_repo(tmp_path)
    write_file(repo, "doc.md", "original content\nwith lines\n")
    commit(repo, "add", date="2026-04-01T10:00:00+00:00")
    write_file(repo, "doc.md", "original content\nwith lines\nextra\n")
    commit(repo, "expand", date="2026-04-01T10:01:00+00:00")
    write_file(repo, "doc.md", "original content\nwith lines\n")
    commit(repo, "revert", date="2026-04-01T10:02:00+00:00")

    output = detect.run_cli([repo, "--days", "7", "--output", "text", "--min-gap", "0"])

    assert "doc.md" in output
    assert "exact-reversion" in output


def test_cli_json_output(tmp_path):
    """End-to-end: CLI produces valid JSON output."""
    repo = make_repo(tmp_path)
    write_file(repo, "doc.md", "lots of content\n" * 10)
    commit(repo, "add", date="2026-04-01T10:00:00+00:00")
    write_file(repo, "doc.md", "_")
    commit(repo, "wipe", date="2026-04-01T10:01:00+00:00")

    output = detect.run_cli([repo, "--days", "7", "--output", "json", "--min-gap", "0"])

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

    output = detect.run_cli([repo, "--days", "7", "--output", "json", "--min-gap", "0"])
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

    output = detect.run_cli([repo, "--days", "7", "--output", "json", "--min-gap", "0"])
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


# ---- --min-gap tests ----

def test_cli_min_gap_filters_short_reversions(tmp_path):
    """Reversions within min-gap are filtered out."""
    repo = make_repo(tmp_path)
    write_file(repo, "doc.md", "original\n")
    commit(repo, "add", date="2026-04-01T10:00:00+00:00")
    write_file(repo, "doc.md", "original\nextra\n")
    commit(repo, "edit", date="2026-04-01T10:00:30+00:00")
    write_file(repo, "doc.md", "original\n")
    commit(repo, "revert", date="2026-04-01T10:01:00+00:00")

    # With default 60-minute gap, this 1-minute reversion should be filtered
    output = detect.run_cli([repo, "--days", "7", "--output", "json"])
    data = json.loads(output)
    assert len(data) == 0

    # With 0-minute gap, it should appear
    output = detect.run_cli([repo, "--days", "7", "--output", "json", "--min-gap", "0"])
    data = json.loads(output)
    assert len(data) == 1


def test_cli_min_gap_keeps_long_reversions(tmp_path):
    """Reversions spanning more than min-gap are kept."""
    repo = make_repo(tmp_path)
    write_file(repo, "doc.md", "original\n")
    commit(repo, "add", date="2026-04-01T10:00:00+00:00")
    write_file(repo, "doc.md", "original\nextra stuff\n")
    commit(repo, "edit", date="2026-04-01T10:30:00+00:00")
    write_file(repo, "doc.md", "original\n")
    # Revert 2 hours later
    commit(repo, "revert", date="2026-04-01T12:00:00+00:00")

    output = detect.run_cli([repo, "--days", "7", "--output", "json", "--min-gap", "60"])
    data = json.loads(output)
    assert len(data) == 1
    assert data[0]["file"] == "doc.md"
