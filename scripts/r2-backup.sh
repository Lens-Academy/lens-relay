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
# Every failure prints one FAILED line and exits 1; the next run tries again.
# scripts/r2-backup-restore.sh restores a point.
set -euo pipefail

SOURCE="${R2_BACKUP_SOURCE:-r2bk:lens-relay-storage}"
AT="${R2_BACKUP_AT:-now}" # the tests set the clock
NOW_HOUR=$(date -d "$AT" +%Y-%m-%d-%H)
NOW_DATE=$(date -d "$AT" +%Y-%m-%d)
NOW_WEEK=$(date -d "$AT" +%Y-%W)
FLAGS=(--fast-list --checksum --transfers 32 --checkers 32)

# Skip if the previous run is still going
exec 9>"${R2_BACKUP_LOCK:-/var/lock/r2-backup.lock}"
flock -n 9 || { echo "[$(date -Is)] Previous run still active, skipping"; exit 0; }

fail() { echo "[$(date -Is)] FAILED: $*; the next run tries again"; exit 1; }
source "$(dirname "$0")/r2-backup-lib.sh"

mark() {
  printf '%s\n' "$2" >"$WORK/mark"
  rclone copyto "$WORK/mark" "$BACKUPS/done/$1/ok" || fail "marking $1 complete"
}

summary() {
  local size
  size=$(rclone size --json --fast-list "$1")
  echo "$(grep -o '"count":[0-9]*' <<<"$size" | cut -d: -f2) objects, $(grep -o '"bytes":[0-9]*' <<<"$size" | cut -d: -f2 | awk '{printf "%dM", $1/1048576}')"
}

# Once, on the first run of this layout: the dailies and weeklies the old
# script made are taken as complete. done/backfill/ok is written last, so a
# run that fails part-way is finished by the next one.
if ! has done backfill; then
  for tier in daily weekly; do
    names "done/$tier"
    marked=$NAMES
    names "$tier"
    for name in $NAMES; do
      grep -qx "$name" <<<"$marked" || mark "$tier/$name" "made by the old backup script, not checked to be complete"
    done
  done
  mark backfill "made at $(date -Is)"
fi

daily_due=yes hourly_due=yes
if has done/daily "$NOW_DATE"; then daily_due=""; fi
if has lists "$NOW_HOUR"; then
  hourly_due=""
  echo "[$(date -Is)] lists/$NOW_HOUR exists: this hour is already backed up"
fi
if [[ -n "$daily_due$hourly_due" ]]; then
  listing "$SOURCE" "$WORK/live"
  [[ -s "$WORK/live" ]] || fail "the live bucket lists as empty"
fi

# 1. Once a day: a full copy of the live bucket, which current/ then matches.
if [[ -n "$daily_due" ]]; then
  rclone sync "$SOURCE" "$BACKUPS/daily/$NOW_DATE" "${FLAGS[@]}" || fail "daily/$NOW_DATE"
  rclone sync "$BACKUPS/daily/$NOW_DATE" "$BACKUPS/current" "${FLAGS[@]}" || fail "daily/$NOW_DATE → current"
  mark "daily/$NOW_DATE" "made at $(date -Is)"
  echo "[$(date -Is)] Daily backup: daily/$NOW_DATE ($(summary "$BACKUPS/daily/$NOW_DATE"))"
fi

# 2. Every hour: the objects that differ from current/, which then takes them,
# then the hour's record. An hour is done once its record is written. An
# object without an MD5 can't be compared, so it counts as changed every hour.
if [[ -n "$hourly_due" ]]; then
  listing "$BACKUPS/current" "$WORK/current" missing-ok
  awk -F'\t' -v OFS='\t' '$2 == "" { $2 = "no-md5" } 1' "$WORK/live" >"$WORK/live.md5"
  nomd5=$(grep -c $'\tno-md5$' "$WORK/live.md5" || true)
  ((nomd5 == 0)) || echo "[$(date -Is)] WARNING: $nomd5 objects have no MD5, so they are copied every hour"
  LC_ALL=C comm -23 "$WORK/live.md5" "$WORK/current" | cut -f1 >"$WORK/changed"
  LC_ALL=C comm -12 "$WORK/live.md5" "$WORK/current" >"$WORK/record"
  if [[ -s "$WORK/changed" ]]; then
    # A run that failed earlier this hour can have left versions here. The
    # objects about to be copied again go first, so the record below never
    # takes one of those for an object that has been deleted since.
    if has hourly "$NOW_HOUR"; then
      rclone delete "$BACKUPS/hourly/$NOW_HOUR" --files-from-raw "$WORK/changed" --fast-list || fail "clearing hourly/$NOW_HOUR"
    fi
    rclone copy "$SOURCE" "$BACKUPS/hourly/$NOW_HOUR" --files-from-raw "$WORK/changed" --no-traverse "${FLAGS[@]}" ||
      fail "hourly/$NOW_HOUR"
    # current/ only takes versions a snapshot holds, so a failure leaves it
    # behind, never ahead: the next run copies the difference again.
    rclone copy "$BACKUPS/hourly/$NOW_HOUR" "$BACKUPS/current" --files-from-raw "$WORK/changed" --no-traverse "${FLAGS[@]}" ||
      fail "hourly/$NOW_HOUR → current"
    # The record takes each changed object as copied, which can be newer than
    # listed. One deleted before its copy is left out, and current/ drops it.
    listing "$BACKUPS/hourly/$NOW_HOUR" "$WORK/copied" missing-ok
    awk -F'\t' 'NR == FNR { changed[$0]; next } $1 in changed' "$WORK/changed" "$WORK/copied" >>"$WORK/record"
    LC_ALL=C sort -o "$WORK/record" "$WORK/record"
    LC_ALL=C comm -23 "$WORK/changed" <(cut -f1 "$WORK/copied") >"$WORK/gone"
    if [[ -s "$WORK/gone" ]]; then
      rclone delete "$BACKUPS/current" --files-from-raw "$WORK/gone" --fast-list || fail "dropping deleted objects from current"
    fi
  fi
  rclone copyto "$WORK/record" "$BACKUPS/lists/$NOW_HOUR/objects.tsv" || fail "record lists/$NOW_HOUR"
  echo "[$(date -Is)] Hourly backup $NOW_HOUR: $(wc -l <"$WORK/changed") changed, record of $(wc -l <"$WORK/record") objects"
fi

# 3. Once a week: a copy of the oldest complete daily
if ! has done/weekly "$NOW_WEEK"; then
  names done/daily
  OLDEST_DAILY=$(LC_ALL=C sort <<<"$NAMES" | head -1)
  if [ -n "$OLDEST_DAILY" ]; then
    rclone sync "$BACKUPS/daily/$OLDEST_DAILY" "$BACKUPS/weekly/$NOW_WEEK" "${FLAGS[@]}" || fail "weekly/$NOW_WEEK"
    made=$(rclone cat "$BACKUPS/done/daily/$OLDEST_DAILY/ok") || fail "reading done/daily/$OLDEST_DAILY/ok"
    mark "weekly/$NOW_WEEK" "a copy of daily/$OLDEST_DAILY, which was $made"
    echo "[$(date -Is)] Weekly promotion: daily/$OLDEST_DAILY → weekly/$NOW_WEEK"
  fi
fi

# 4. Prune expired backups by the date in their name. An hour is restored from
# its day's daily plus that day's hourlies up to it, so hourlies and records go
# a whole day at a time, once the next day is over: 24 to 48 hours are kept.
# Records go before their hourlies and markers before their snapshots, so a
# restore never finds a record or marker whose snapshots are half pruned.
# 22 daily, ~26 weekly.
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
      out=$(rclone purge "$BACKUPS/$path" --fast-list --checkers 32 2>&1) || rc=$?
      if ((rc != 0 && rc != 3)); then
        echo "[$(date -Is)] FAILED: pruning $path: $out"
        prune_failed=1
        continue 2
      fi
    done
    echo "[$(date -Is)] Pruned $1/$name"
  done
}
prune lists "$(date -d "$AT 1 day ago" +%Y-%m-%d)"
prune hourly "$(date -d "$AT 1 day ago" +%Y-%m-%d)"
prune daily "$(date -d "$AT 21 days ago" +%Y-%m-%d)" marked
prune weekly "$(date -d "$AT 182 days ago" +%Y-%W)" marked

counts=""
for tier in hourly daily weekly; do
  names "$tier"
  counts+="$(grep -c . <<<"$NAMES" || true) $tier, "
done
echo "[$(date -Is)] Done. Snapshots: ${counts%, }"
((prune_failed == 0)) || fail "pruning (see above)"
