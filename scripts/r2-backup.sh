#!/usr/bin/env bash
# Hourly backup of the live relay bucket into a separate R2 bucket.
# Source and destination use the same rclone remote, so every copy is a
# server-side copy inside Cloudflare: no data passes through this machine.
# The r2bk remote needs no_head=true (R2 rejects rclone 1.60's post-upload HEAD).
#
# R2 bills every list call and every copy. A daily snapshot is a full copy;
# an hourly snapshot holds only the objects that changed since the last
# snapshot. current/ holds the newest backed-up version of every object, and
# an object has changed when its MD5 differs from its copy there. Each hour
# also gets a record, lists/<hour>/objects.tsv: every object and the MD5 the
# backups hold for it, so a restore can leave out deleted objects and check the
# rest. A daily or weekly is complete only once done/<tier>/<name>/ok exists;
# until then each run finishes it. --fast-list lists a whole bucket in one call
# per 1,000 objects, not one per document folder.
# scripts/r2-backup-restore.sh puts a point back together.
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

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
fail() { echo "[$(date -Is)] FAILED: $*"; exit 1; }

# The snapshot names in a tier, into NAMES. A failed listing stops the run:
# read as "none yet", it would make the run redo snapshots that exist.
names() {
  local rc=0
  NAMES=$(rclone lsf --dirs-only "$DEST/$1" 2>"$WORK/err") || rc=$?
  if ((rc == 3)); then NAMES=""; elif ((rc != 0)); then fail "listing $1: $(tail -1 "$WORK/err")"; fi
  NAMES=$(tr -d / <<<"$NAMES")
}
has() { names "$1" && grep -qx "$2" <<<"$NAMES"; }

# Every object under $1 as "path<TAB>md5", sorted, into $2. Comparing two of
# these takes a few list calls; rclone's --compare-dest asks once per object.
# A folder that doesn't exist lists as empty (R2) or exits 3 (local disk);
# that is an error unless $3 is "missing-ok".
listing() {
  local rc=0
  rclone lsf -R --fast-list --files-only --format ph --hash MD5 --separator $'\t' "$1" >"$2" 2>"$WORK/err" || rc=$?
  if ((rc == 3)) && [[ "${3:-}" == missing-ok ]]; then : >"$2"; elif ((rc != 0)); then fail "listing $1: $(tail -1 "$WORK/err")"; fi
  LC_ALL=C sort -o "$2" "$2"
}

mark() {
  printf '%s\n' "$2" >"$WORK/mark"
  rclone copyto "$WORK/mark" "$DEST/done/$1/ok" || fail "marking $1 complete"
}

summary() {
  local size
  size=$(rclone size --json --fast-list "$1")
  echo "$(grep -o '"count":[0-9]*' <<<"$size" | cut -d: -f2) objects, $(grep -o '"bytes":[0-9]*' <<<"$size" | cut -d: -f2 | awk '{printf "%dM", $1/1048576}')"
}

# The dailies and weeklies made before done/ markers existed are complete.
names done/daily
if [[ -z "$NAMES" ]]; then
  names daily
  for name in $NAMES; do mark "daily/$name" "made before done/ markers"; done
  names weekly
  for name in $NAMES; do mark "weekly/$name" "made before done/ markers; a copy of an older daily"; done
fi

daily_due=yes hourly_due=yes
if has done/daily "$NOW_DATE"; then daily_due=""; fi
if has lists "$NOW_HOUR"; then hourly_due=""; fi
if [[ -n "$daily_due$hourly_due" ]]; then
  listing "$SOURCE" "$WORK/live"
  [[ -s "$WORK/live" ]] || fail "the live bucket lists as empty"
fi

# 1. Once a day: a full copy of the live bucket, which current/ then matches.
# A copy or sync that fails is finished by the next run.
if [[ -n "$daily_due" ]]; then
  rclone sync "$SOURCE" "$DEST/daily/$NOW_DATE" "${FLAGS[@]}" || fail "daily/$NOW_DATE (the next run finishes it)"
  rclone sync "$DEST/daily/$NOW_DATE" "$DEST/current" "${FLAGS[@]}" || fail "daily/$NOW_DATE → current (the next run redoes it)"
  mark "daily/$NOW_DATE" "made at $(date -Is)"
  echo "[$(date -Is)] Daily backup: daily/$NOW_DATE ($(summary "$DEST/daily/$NOW_DATE"))"
fi

# 2. Every hour: the objects that differ from current/, which then takes them,
# then the hour's record. An hour is done once its record is written. An
# object without an MD5 can't be compared, so it counts as changed every hour.
if [[ -n "$hourly_due" ]]; then
  listing "$DEST/current" "$WORK/current" missing-ok
  awk -F'\t' -v OFS='\t' '$2 == "" { $2 = "no-md5" } 1' "$WORK/live" >"$WORK/live.md5"
  nomd5=$(grep -c $'\tno-md5$' "$WORK/live.md5" || true)
  ((nomd5 == 0)) || echo "[$(date -Is)] WARNING: $nomd5 objects have no MD5, so they are copied every hour"
  LC_ALL=C comm -23 "$WORK/live.md5" "$WORK/current" | cut -f1 >"$WORK/changed"
  LC_ALL=C comm -12 "$WORK/live.md5" "$WORK/current" >"$WORK/record"
  if [[ -s "$WORK/changed" ]]; then
    rclone copy "$SOURCE" "$DEST/hourly/$NOW_HOUR" --files-from "$WORK/changed" --no-traverse "${FLAGS[@]}" ||
      fail "hourly/$NOW_HOUR (the next run copies these again)"
    # current/ only takes versions a snapshot holds, so a failure leaves it
    # behind, never ahead: the next run copies the difference again.
    rclone copy "$DEST/hourly/$NOW_HOUR" "$DEST/current" --files-from "$WORK/changed" --no-traverse "${FLAGS[@]}" ||
      fail "hourly/$NOW_HOUR → current (the next run copies these again)"
    # The record takes each changed object as copied, which can be newer than
    # listed; one deleted in between is left out.
    listing "$DEST/hourly/$NOW_HOUR" "$WORK/copied" missing-ok
    awk -F'\t' 'NR == FNR { changed[$0]; next } $1 in changed' "$WORK/changed" "$WORK/copied" >>"$WORK/record"
    LC_ALL=C sort -o "$WORK/record" "$WORK/record"
  fi
  rclone copyto "$WORK/record" "$DEST/lists/$NOW_HOUR/objects.tsv" || fail "record lists/$NOW_HOUR"
  echo "[$(date -Is)] Hourly backup $NOW_HOUR: $(wc -l <"$WORK/changed") changed, record of $(wc -l <"$WORK/record") objects"
fi

# 3. Once a week: a copy of the oldest complete daily
if ! has done/weekly "$NOW_WEEK"; then
  names done/daily
  OLDEST_DAILY=$(LC_ALL=C sort <<<"$NAMES" | head -1)
  if [ -n "$OLDEST_DAILY" ]; then
    rclone sync "$DEST/daily/$OLDEST_DAILY" "$DEST/weekly/$NOW_WEEK" "${FLAGS[@]}" ||
      fail "weekly/$NOW_WEEK (the next run finishes it)"
    mark "weekly/$NOW_WEEK" "a copy of daily/$OLDEST_DAILY"
    echo "[$(date -Is)] Weekly promotion: daily/$OLDEST_DAILY → weekly/$NOW_WEEK"
  fi
fi

# 4. Prune expired backups by the date in their name. An hour is rebuilt from
# its day's daily plus that day's hourlies up to it, so hourlies and records go
# a whole day at a time, once the next day is over: 24 to 48 hours are kept.
# 22 daily, ~26 weekly. A marker goes before its snapshot, so a snapshot that
# is only half pruned is never taken as complete.
prune_failed=0
prune() {
  local name path out rc
  names "$1"
  for name in $NAMES; do
    [[ "$name" < "$2" ]] || continue
    for path in ${3:+"done/$1/$name"} "$1/$name"; do
      # Output only on failure: purge always warns that R2 refuses its
      # versioning lookup. Exit 3: already gone (a daily never completed has no marker).
      rc=0
      out=$(rclone purge "$DEST/$path" --fast-list --checkers 32 2>&1) || rc=$?
      if ((rc != 0 && rc != 3)); then
        echo "[$(date -Is)] FAILED to prune $path: $out"
        prune_failed=1
        continue 2
      fi
    done
    echo "[$(date -Is)] Pruned $1/$name"
  done
}
prune hourly "$(date -d "$AT 1 day ago" +%Y-%m-%d)"
prune lists "$(date -d "$AT 1 day ago" +%Y-%m-%d)"
prune daily "$(date -d "$AT 21 days ago" +%Y-%m-%d)" marked
prune weekly "$(date -d "$AT 182 days ago" +%Y-%W)" marked

count() { names "$1" && grep -c . <<<"$NAMES" || true; }
echo "[$(date -Is)] Done. Snapshots: $(count hourly) hourly, $(count daily) daily, $(count weekly) weekly"
((prune_failed == 0)) || fail "pruning (see above); the next run tries again"
