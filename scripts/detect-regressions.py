#!/usr/bin/env python3
"""Detect content regressions in git repositories."""

import argparse
import json as json_module
import subprocess
import sys
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

    # Get all commits with their author dates; filter by window in Python
    # (git --since uses committer date, but --date in tests only sets author date)
    log_output = _git(
        repo, "log", "--format=%H %aI", "--reverse"
    )
    if not log_output:
        return {}

    commits = []
    for line in log_output.splitlines():
        parts = line.split(" ", 1)
        commit_date = datetime.fromisoformat(parts[1])
        if commit_date >= cutoff:
            commits.append((parts[0], commit_date))

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


@dataclass
class Regression:
    file: str
    regression_type: str  # "exact-reversion", "near-exact-reversion", "full-wipe"
    reverted_at: str      # commit hash where regression happened
    reverted_to: str      # commit hash of the state it reverted to
    reverted_at_date: datetime | None = None
    reverted_to_date: datetime | None = None
    detail: str = ""


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
    parser.add_argument("--min-gap", type=int, default=60, help="Minimum time gap in minutes between reverted_to and reverted_at (default: 60)")
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

    # Filter by minimum time gap between reverted_to and reverted_at
    if args.min_gap > 0:
        min_delta = timedelta(minutes=args.min_gap)
        unique = [r for r in unique if r.reverted_at_date and r.reverted_to_date
                  and (r.reverted_at_date - r.reverted_to_date) >= min_delta]

    if args.output == "json":
        return format_json(unique)
    else:
        return format_text(unique)


if __name__ == "__main__":
    print(run_cli())
