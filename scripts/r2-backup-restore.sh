#!/usr/bin/env bash
# Puts the relay bucket back together as it was at an hour, from what
# r2-backup.sh made: that day's daily copy, then each of that day's hourly
# snapshots up to the hour, in order, each holding only what had changed.
# The whole bucket put together this way also holds the documents deleted from
# storage earlier that day.
#
# Usage: r2-backup-restore.sh YYYY-MM-DD-HH TARGET [DOC_ID]
#   TARGET  an empty local folder or rclone path; never the live bucket
#   DOC_ID  only that document
set -euo pipefail

BACKUPS="${R2_BACKUP_DEST:-r2bk:lens-relay-backups}"
HOUR="${1:-}" TARGET="${2:-}" DOC="${3:-}"
[[ "$HOUR" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}-[0-9]{2}$ && -n "$TARGET" ]] ||
  { echo "Usage: $0 YYYY-MM-DD-HH TARGET [DOC_ID]"; exit 2; }
[[ "$TARGET" != *lens-relay-storage* ]] ||
  { echo "Put it together in a scratch folder, then copy back only what you need"; exit 2; }
[[ -z "$(rclone lsf --max-depth 1 "$TARGET" 2>/dev/null | head -1)" ]] ||
  { echo "$TARGET is not empty"; exit 2; }

DAY="${HOUR:0:10}"
FLAGS=(--fast-list --ignore-times --transfers 32 --checkers 32) # a later snapshot always wins
[[ -z "$DOC" ]] || FLAGS+=(--include "/$DOC/**")
list() { rclone lsf --dirs-only "$BACKUPS/$1" 2>/dev/null | tr -d / || true; }

grep -qx "$DAY" <<<"$(list daily)" || { echo "No daily backup for $DAY"; exit 1; }
all_hourly=$(list hourly | sort)
if [[ -z "$all_hourly" || "$DAY" < "${all_hourly:0:10}" ]]; then
  echo "The hourly backups of $DAY are gone: this is the bucket at the start of $DAY"
fi

rclone copy "$BACKUPS/daily/$DAY" "$TARGET" "${FLAGS[@]}"
used=0
for h in $(grep "^$DAY-" <<<"$all_hourly" || true); do
  [[ "$h" > "$HOUR" ]] && break
  rclone copy "$BACKUPS/hourly/$h" "$TARGET" "${FLAGS[@]}"
  used=$((used + 1))
done
echo "Put together $HOUR${DOC:+ for $DOC} in $TARGET: daily/$DAY and $used hourly snapshots"
