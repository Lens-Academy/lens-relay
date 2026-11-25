# Sourced by r2-backup.sh and r2-backup-restore.sh, so the script that writes
# the backups and the one that reads them list them the same way. Each script
# defines fail() before it sources this.
BACKUPS="${R2_BACKUP_DEST:-r2bk:lens-relay-backups}"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

# The snapshot names under $1, into NAMES. A failed listing stops the run:
# read as "none yet", it would make a run redo or skip snapshots that exist.
# A folder that doesn't exist lists as empty (R2) or exits 3 (local disk).
names() {
  local rc=0
  NAMES=$(rclone lsf --dirs-only "$BACKUPS/$1" 2>"$WORK/err") || rc=$?
  if ((rc == 3)); then NAMES=""; elif ((rc != 0)); then fail "listing $1: $(tail -1 "$WORK/err")"; fi
  NAMES=$(tr -d / <<<"$NAMES")
}
has() { names "$1" && grep -qx "$2" <<<"$NAMES"; }

# Every object under $1 as "path<TAB>md5", sorted, into $2. This is also the
# format of the hourly records. Comparing two of these takes a few list calls;
# rclone's --compare-dest asks once per object. A folder that doesn't exist is
# an error unless $3 is "missing-ok".
listing() {
  local rc=0
  rclone lsf -R --fast-list --files-only --format ph --hash MD5 --separator $'\t' "$1" >"$2" 2>"$WORK/err" || rc=$?
  if ((rc == 3)) && [[ "${3:-}" == missing-ok ]]; then : >"$2"; elif ((rc != 0)); then fail "listing $1: $(tail -1 "$WORK/err")"; fi
  LC_ALL=C sort -o "$2" "$2"
}
