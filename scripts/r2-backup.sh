#!/usr/bin/env bash
# Hourly backup of the live relay bucket into a separate R2 bucket.
# Source and destination use the same rclone remote, so every copy is a
# server-side copy inside Cloudflare: no data passes through this machine.
# The r2bk remote needs no_head=true (R2 rejects rclone 1.60's post-upload HEAD).
set -euo pipefail

SOURCE="r2bk:lens-relay-storage"
DEST="r2bk:lens-relay-backups"
NOW_HOUR=$(date +%Y-%m-%d-%H)
NOW_DATE=$(date +%Y-%m-%d)
NOW_WEEK=$(date +%Y-%W)

# Skip if the previous run is still going
exec 9>/var/lock/r2-backup.lock
flock -n 9 || { echo "[$(date -Is)] Previous run still active, skipping"; exit 0; }

# Snapshot names in a tier (empty if the tier doesn't exist yet)
list() { rclone lsf --dirs-only "$DEST/$1" 2>/dev/null | tr -d / || true; }

# Server-side copy; remove the partial copy on failure so the next run retries cleanly
snapshot() {
  if ! rclone copy "$1" "$2" --transfers 32 --checkers 32; then
    rclone purge "$2" --checkers 32 2>/dev/null || true
    echo "[$(date -Is)] FAILED: $1 → $2"
    exit 1
  fi
}

# 1. Copy live bucket → hourly snapshot
if ! grep -qx "$NOW_HOUR" <<<"$(list hourly)"; then
  snapshot "$SOURCE" "$DEST/hourly/$NOW_HOUR"
  SIZE=$(rclone size --json "$DEST/hourly/$NOW_HOUR")
  echo "[$(date -Is)] Hourly backup: hourly/$NOW_HOUR ($(grep -o '"count":[0-9]*' <<<"$SIZE" | cut -d: -f2) objects, $(grep -o '"bytes":[0-9]*' <<<"$SIZE" | cut -d: -f2 | awk '{printf "%dM", $1/1048576}'))"
fi

# 2. Promote hourly → daily (once per day)
if ! grep -qx "$NOW_DATE" <<<"$(list daily)"; then
  OLDEST=$(list hourly | grep "^$NOW_DATE-" | sort | head -1 || true)
  if [ -n "$OLDEST" ]; then
    snapshot "$DEST/hourly/$OLDEST" "$DEST/daily/$NOW_DATE"
    echo "[$(date -Is)] Daily promotion: hourly/$OLDEST → daily/$NOW_DATE"
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

# 4. Prune expired backups by the date in their name (keeps 24 hourly, 22 daily, ~26 weekly)
prune() {
  for name in $(list "$1"); do
    if [[ "$name" < "$2" ]]; then
      # Output only on failure: purge always warns that R2 refuses its versioning lookup
      if out=$(rclone purge "$DEST/$1/$name" --checkers 32 2>&1); then
        echo "[$(date -Is)] Pruned $1/$name"
      else
        echo "[$(date -Is)] FAILED to prune $1/$name: $out"
      fi
    fi
  done
}
prune hourly "$(date -d '23 hours ago' +%Y-%m-%d-%H)"
prune daily  "$(date -d '21 days ago' +%Y-%m-%d)"
prune weekly "$(date -d '182 days ago' +%Y-%W)"

echo "[$(date -Is)] Done. Snapshots: $(list hourly | wc -l) hourly, $(list daily | wc -l) daily, $(list weekly | wc -l) weekly"
