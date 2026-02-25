#!/usr/bin/env bash
set -euo pipefail

BACKUP_ROOT="/root/backups/r2"
BUCKET="r2:lens-relay-storage"
NOW_HOUR=$(date +%Y-%m-%d-%H)
NOW_DATE=$(date +%Y-%m-%d)
NOW_WEEK=$(date +%Y-%W)

# Ensure tier directories exist
mkdir -p "$BACKUP_ROOT/hourly" "$BACKUP_ROOT/daily" "$BACKUP_ROOT/weekly"

# 1. Sync R2 → hourly snapshot
HOURLY_DIR="$BACKUP_ROOT/hourly/$NOW_HOUR"
if [ ! -d "$HOURLY_DIR" ]; then
  mkdir -p "$HOURLY_DIR"
  rclone copy "$BUCKET" "$HOURLY_DIR"
  echo "[$(date -Is)] Hourly backup: $HOURLY_DIR ($(du -sh "$HOURLY_DIR" | cut -f1))"
fi

# 2. Promote hourly → daily (once per day)
DAILY_DIR="$BACKUP_ROOT/daily/$NOW_DATE"
if [ ! -d "$DAILY_DIR" ]; then
  OLDEST=$(ls -d "$BACKUP_ROOT/hourly/$NOW_DATE"-* 2>/dev/null | head -1)
  if [ -n "$OLDEST" ]; then
    mkdir -p "$DAILY_DIR"
    cp -al "$OLDEST/." "$DAILY_DIR/"
    echo "[$(date -Is)] Daily promotion: $OLDEST → $DAILY_DIR"
  fi
fi

# 3. Promote daily → weekly (once per week)
WEEKLY_DIR="$BACKUP_ROOT/weekly/$NOW_WEEK"
if [ ! -d "$WEEKLY_DIR" ]; then
  OLDEST_DAILY=$(ls -d "$BACKUP_ROOT/daily/"* 2>/dev/null | head -1)
  if [ -n "$OLDEST_DAILY" ]; then
    mkdir -p "$WEEKLY_DIR"
    cp -al "$OLDEST_DAILY/." "$WEEKLY_DIR/"
    echo "[$(date -Is)] Weekly promotion: $OLDEST_DAILY → $WEEKLY_DIR"
  fi
fi

# 4. Prune expired backups
find "$BACKUP_ROOT/hourly" -maxdepth 1 -mindepth 1 -type d -mmin +1440 -exec rm -rf {} + 2>/dev/null || true
find "$BACKUP_ROOT/daily"  -maxdepth 1 -mindepth 1 -type d -mtime +21  -exec rm -rf {} + 2>/dev/null || true
find "$BACKUP_ROOT/weekly" -maxdepth 1 -mindepth 1 -type d -mtime +182 -exec rm -rf {} + 2>/dev/null || true

echo "[$(date -Is)] Prune complete. Disk usage: $(du -sh "$BACKUP_ROOT" | cut -f1)"
