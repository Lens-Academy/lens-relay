#!/usr/bin/env bash
# Hourly backup of the live relay bucket into a separate R2 bucket.
# Source and destination use the same rclone remote, so every copy is a
# server-side copy inside Cloudflare: no data passes through this machine.
# The r2bk remote needs no_head=true (R2 rejects rclone 1.60's post-upload HEAD).
#
# R2 bills every list call and every copy. A daily snapshot is a full copy;
# an hourly snapshot holds only the objects that changed since the last
# snapshot. current/ holds the newest backed-up version of every object, and
# an object has changed when its MD5 differs from its copy there. --fast-list
# lists a whole bucket in one call per 1,000 objects, not one per document
# folder. scripts/r2-backup-restore.sh puts a point in time back together.
set -euo pipefail

SOURCE="${R2_BACKUP_SOURCE:-r2bk:lens-relay-storage}"
DEST="${R2_BACKUP_DEST:-r2bk:lens-relay-backups}"
AT="${R2_BACKUP_AT:-now}" # the tests set the clock
NOW_HOUR=$(date -d "$AT" +%Y-%m-%d-%H)
NOW_DATE=$(date -d "$AT" +%Y-%m-%d)
NOW_WEEK=$(date -d "$AT" +%Y-%W)
FLAGS=(--fast-list --checksum --transfers 32 --checkers 32)

# Skip if the previous run is still going
exec 9>"${R2_BACKUP_LOCK:-/var/lock/r2-backup.lock}"
flock -n 9 || { echo "[$(date -Is)] Previous run still active, skipping"; exit 0; }

# Snapshot names in a tier (empty if the tier doesn't exist yet)
list() { rclone lsf --dirs-only "$DEST/$1" 2>/dev/null | tr -d / || true; }

# Server-side copy; remove the partial copy on failure so the next run retries cleanly
snapshot() {
  if ! rclone copy "$1" "$2" "${FLAGS[@]}" "${@:3}"; then
    rclone purge "$2" --fast-list --checkers 32 2>/dev/null || true
    echo "[$(date -Is)] FAILED: $1 → $2"
    exit 1
  fi
}

# current/ only takes versions that a snapshot holds, so a failure here leaves
# it behind, never ahead: the next run copies the difference again.
update_current() {
  rclone "$1" "$2" "$DEST/current" "${FLAGS[@]}" || {
    echo "[$(date -Is)] FAILED: $2 → current"
    exit 1
  }
}

# Every object of $1 as "md5<TAB>path", sorted, into $2. Comparing two of
# these takes a few list calls; rclone's --compare-dest asks once per object.
# A folder that doesn't exist yet lists as empty (R2) or exits 3 (local disk).
listing() {
  local rc=0
  rclone lsf -R --fast-list --files-only --format hp --hash MD5 --separator $'\t' "$1" >"$2" || rc=$?
  ((rc == 0 || rc == 3)) || { echo "[$(date -Is)] FAILED to list $1"; exit 1; }
  LC_ALL=C sort -o "$2" "$2"
}

summary() {
  local size
  size=$(rclone size --json --fast-list "$1")
  echo "$(grep -o '"count":[0-9]*' <<<"$size" | cut -d: -f2) objects, $(grep -o '"bytes":[0-9]*' <<<"$size" | cut -d: -f2 | awk '{printf "%dM", $1/1048576}')"
}

# 1. Once a day: a full copy of the live bucket, which current/ then matches
if ! grep -qx "$NOW_DATE" <<<"$(list daily)"; then
  snapshot "$SOURCE" "$DEST/daily/$NOW_DATE"
  update_current sync "$DEST/daily/$NOW_DATE"
  echo "[$(date -Is)] Daily backup: daily/$NOW_DATE ($(summary "$DEST/daily/$NOW_DATE"))"
fi

# 2. Every hour: the objects that differ from current/, which then takes them
if ! grep -qx "$NOW_HOUR" <<<"$(list hourly)"; then
  WORK=$(mktemp -d)
  trap 'rm -rf "$WORK"' EXIT
  listing "$SOURCE" "$WORK/live"
  listing "$DEST/current" "$WORK/current"
  LC_ALL=C comm -23 "$WORK/live" "$WORK/current" | cut -f2- >"$WORK/changed"
  if [[ -s "$WORK/changed" ]]; then
    snapshot "$SOURCE" "$DEST/hourly/$NOW_HOUR" --files-from "$WORK/changed" --no-traverse
    update_current copy "$DEST/hourly/$NOW_HOUR"
    echo "[$(date -Is)] Hourly backup: hourly/$NOW_HOUR ($(summary "$DEST/hourly/$NOW_HOUR") changed)"
  else
    echo "[$(date -Is)] Hourly backup: nothing changed since the last snapshot"
  fi
fi

# 3. Promote daily → weekly (once per week)
if ! grep -qx "$NOW_WEEK" <<<"$(list weekly)"; then
  OLDEST_DAILY=$(list daily | sort | head -1 || true)
  if [ -n "$OLDEST_DAILY" ]; then
    snapshot "$DEST/daily/$OLDEST_DAILY" "$DEST/weekly/$NOW_WEEK"
    echo "[$(date -Is)] Weekly promotion: daily/$OLDEST_DAILY → weekly/$NOW_WEEK"
  fi
fi

# 4. Prune expired backups by the date in their name. An hour is rebuilt from
# its day's daily plus that day's hourlies up to it, so hourlies go a whole day
# at a time, once the next day is over: 24 to 48 are kept. 22 daily, ~26 weekly.
prune() {
  for name in $(list "$1"); do
    if [[ "$name" < "$2" ]]; then
      # Output only on failure: purge always warns that R2 refuses its versioning lookup
      if out=$(rclone purge "$DEST/$1/$name" --fast-list --checkers 32 2>&1); then
        echo "[$(date -Is)] Pruned $1/$name"
      else
        echo "[$(date -Is)] FAILED to prune $1/$name: $out"
      fi
    fi
  done
}
prune hourly "$(date -d "$AT 1 day ago" +%Y-%m-%d)"
prune daily "$(date -d "$AT 21 days ago" +%Y-%m-%d)"
prune weekly "$(date -d "$AT 182 days ago" +%Y-%W)"

echo "[$(date -Is)] Done. Snapshots: $(list hourly | wc -l) hourly, $(list daily | wc -l) daily, $(list weekly | wc -l) weekly"
