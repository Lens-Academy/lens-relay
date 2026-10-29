#!/usr/bin/env bash
# Puts the relay bucket, or one object, back together from what r2-backup.sh
# made, into an empty folder, then checks it: exactly the objects the backups
# recorded for that point, each with its recorded MD5. Any difference is an
# error, never a silent change. Only complete snapshots (with a done/ marker)
# are used.
#   daily/YYYY-MM-DD, weekly/YYYY-WW  a full copy, as it is.
#   YYYY-MM-DD-HH  the last hourly record at or before that hour,
#                  lists/<hour>: that day's daily, then that day's hourlies up
#                  to the record in order (each holds only what changed),
#                  keeping only the objects the record names.
#
# Usage: r2-backup-restore.sh POINT TARGET [OBJECT]
#   TARGET  an empty local folder or rclone path outside the two buckets
#   OBJECT  only that document (its folder name) or file, e.g. files/<hash>
set -euo pipefail

BACKUPS="${R2_BACKUP_DEST:-r2bk:lens-relay-backups}"
POINT="${1:-}" TARGET="${2:-}" OBJECT="${3:-}"
usage() { echo "Usage: $0 YYYY-MM-DD-HH|daily/YYYY-MM-DD|weekly/YYYY-WW TARGET [OBJECT]"; exit 2; }
[[ -n "$TARGET" ]] || usage
[[ "$TARGET" != *lens-relay-storage* && "$TARGET" != *lens-relay-backups* ]] ||
  { echo "Put it together in a scratch folder, then copy back only what you need"; exit 2; }
[[ -z "$(rclone lsf --max-depth 1 "$TARGET" 2>/dev/null | head -1)" ]] ||
  { echo "$TARGET is not empty"; exit 2; }

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
fail() { echo "$*"; exit 1; }
names() {
  local rc=0
  NAMES=$(rclone lsf --dirs-only "$BACKUPS/$1" 2>"$WORK/err") || rc=$?
  if ((rc == 3)); then NAMES=""; elif ((rc != 0)); then fail "FAILED listing $1: $(tail -1 "$WORK/err")"; fi
  NAMES=$(tr -d / <<<"$NAMES")
}
has() { names "$1" && grep -qx "$2" <<<"$NAMES"; }
# Lines "path<TAB>md5" on stdin, only OBJECT's if one is given, sorted
only_object() { awk -F'\t' -v o="$OBJECT" 'o == "" || $1 == o || index($1, o "/") == 1' | LC_ALL=C sort; }
# A folder that doesn't exist lists as empty (R2) or exits 3 (local disk)
listing() {
  local rc=0
  rclone lsf -R --fast-list --files-only --format ph --hash MD5 --separator $'\t' "$1" >"$WORK/l" 2>"$WORK/err" || rc=$?
  ((rc == 0 || rc == 3)) || fail "FAILED listing $1: $(tail -1 "$WORK/err")"
  only_object <"$WORK/l"
}
FLAGS=(--fast-list --ignore-times --transfers 32 --checkers 32) # a later snapshot always wins
[[ -z "$OBJECT" ]] || FLAGS+=(--include "/$OBJECT" --include "/$OBJECT/**")

case "$POINT" in
  daily/????-??-?? | weekly/????-??)
    has "done/${POINT%%/*}" "${POINT#*/}" || fail "No complete backup $POINT"
    sources=("$POINT")
    what="$POINT ($(rclone cat "$BACKUPS/done/$POINT/ok"))"
    listing "$BACKUPS/$POINT" >"$WORK/want"
    ;;
  ????-??-??-??)
    names lists
    AT=$(LC_ALL=C sort <<<"$NAMES" | awk -v p="$POINT" 'NF && $0 <= p' | tail -1)
    [[ -n "$AT" ]] || fail "No hourly record at or before $POINT; restore a daily/ or weekly/ snapshot instead"
    DAY="${AT:0:10}"
    has done/daily "$DAY" || fail "daily/$DAY is not complete, so $AT can't be put together"
    names hourly
    sources=("daily/$DAY")
    for h in $(grep "^$DAY-" <<<"$NAMES" | LC_ALL=C sort || true); do
      [[ "$h" > "$AT" ]] || sources+=("hourly/$h")
    done
    what="$AT"
    [[ "$AT" == "$POINT" ]] || what="$AT, the last record before $POINT (no backup was recorded in between)"
    rclone cat "$BACKUPS/lists/$AT/objects.tsv" | only_object >"$WORK/want"
    ;;
  *) usage ;;
esac
[[ -s "$WORK/want" ]] || fail "${OBJECT:-The bucket} has no objects at $what"

for s in "${sources[@]}"; do rclone copy "$BACKUPS/$s" "$TARGET" "${FLAGS[@]}"; done
listing "$TARGET" >"$WORK/got"
LC_ALL=C comm -23 <(cut -f1 "$WORK/got") <(cut -f1 "$WORK/want") >"$WORK/extra"
if [[ -s "$WORK/extra" ]]; then # objects deleted before that point
  rclone delete "$TARGET" --files-from "$WORK/extra"
  listing "$TARGET" >"$WORK/got"
fi
# An object recorded without an MD5 is checked by its name only
awk -F'\t' -v OFS='\t' 'NR == FNR { if ($2 == "") nomd5[$1]; next } $1 in nomd5 { $2 = "" } 1' \
  "$WORK/want" "$WORK/got" >"$WORK/got.cmp"
if ! cmp -s "$WORK/want" "$WORK/got.cmp"; then
  echo "FAILED: $TARGET does not match the record of $what (- recorded, + put together):"
  diff "$WORK/want" "$WORK/got.cmp" | grep '^[<>]' | sed 's/^</-/; s/^>/+/' | head -20
  exit 1
fi
echo "Put together $what${OBJECT:+ for $OBJECT} in $TARGET: $(wc -l <"$WORK/want") objects, all matching the record"
