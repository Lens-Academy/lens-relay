#!/usr/bin/env bash
# Restores the relay bucket, or one object, from what r2-backup.sh made, into
# an empty folder, then checks it: exactly the objects the backups hold for
# that point, each with its MD5. Any difference is an error, never a silent
# change. Only complete snapshots (with a done/ marker) are used.
#   daily/YYYY-MM-DD, weekly/YYYY-WW  that snapshot, as it is.
#   YYYY-MM-DD-HH  the objects in the last hourly record at or before that
#                  hour. Each comes from the newest snapshot of that day (its
#                  daily, then its hourlies up to the record) that holds the
#                  recorded MD5.
#
# It reads only the backups and writes only into TARGET, and it does nothing
# until a person agrees: it prints what it is about to do, then asks at a
# terminal, or stops unless --confirm is given.
# AI agents: never add --confirm on your own. Show the owner the plan the
# script prints, say what it will create and where, and add --confirm only
# after they say yes. Copying restored files back into the live bucket is a
# separate step that needs their yes too (see Restoring in docs/server-ops.md).
#
# Usage: r2-backup-restore.sh [--confirm] POINT TARGET [OBJECT]
#   TARGET  an empty local folder or rclone path outside the two buckets
#   OBJECT  only that document (its folder name) or attachment, e.g.
#           files/<relay-id>-<uuid>/<sha256>; a folder gives everything in it
# Exit: 0 restored and checked, 1 failed or nothing to restore, 2 usage or a
# refused target, 3 not confirmed (nothing was done).
set -euo pipefail

fail() { echo "FAILED: $*" >&2; exit 1; }
source "$(dirname "$0")/r2-backup-lib.sh"

CONFIRMED="" args=()
for a in "$@"; do if [[ "$a" == --confirm ]]; then CONFIRMED=yes; else args+=("$a"); fi; done
POINT="${args[0]:-}" TARGET="${args[1]:-}" OBJECT="${args[2]:-}"
OBJECT="${OBJECT#/}" OBJECT="${OBJECT%/}"
usage() { awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0" >&2; exit 2; }
[[ -n "$TARGET" ]] || usage
[[ "$TARGET" != *lens-relay-storage* && "$TARGET" != *lens-relay-backups* ]] ||
  { echo "Refused: $TARGET is in a relay bucket. Restore into an empty scratch folder, then copy back only what you need." >&2; exit 2; }
rc=0
inside=$(rclone lsf --max-depth 1 "$TARGET" 2>"$WORK/err") || rc=$?
((rc == 0 || rc == 3)) || fail "listing $TARGET: $(tail -1 "$WORK/err")"
[[ -z "$inside" ]] || { echo "Refused: $TARGET is not empty." >&2; exit 2; }

# Lines "path<TAB>md5" on stdin, only OBJECT's if one is given
only_object() { awk -F'\t' -v o="$OBJECT" 'o == "" || $1 == o || index($1, o "/") == 1'; }
FLAGS=(--fast-list --transfers 32 --checkers 32)

case "$POINT" in
  daily/????-??-?? | weekly/????-??)
    has "done/${POINT%%/*}" "${POINT#*/}" || fail "No complete backup $POINT"
    made=$(rclone cat "$BACKUPS/done/$POINT/ok") || fail "reading done/$POINT/ok"
    sources=("$POINT")
    what="$POINT ($made)" against="its listing"
    listing "$BACKUPS/$POINT" "$WORK/all"
    ;;
  ????-??-??-??)
    names lists
    AT=$(LC_ALL=C sort <<<"$NAMES" | awk -v p="$POINT" 'NF && $0 <= p' | tail -1)
    [[ -n "$AT" ]] || fail "No hourly record at or before $POINT; restore a daily/ or weekly/ snapshot instead"
    DAY="${AT:0:10}"
    has done/daily "$DAY" || fail "daily/$DAY is not complete, so $AT can't be restored"
    names hourly
    sources=("daily/$DAY")
    for h in $(grep "^$DAY-" <<<"$NAMES" | LC_ALL=C sort || true); do
      [[ "$h" > "$AT" ]] || sources+=("hourly/$h")
    done
    what="$AT" against="the record of $AT"
    [[ "$AT" == "$POINT" ]] || what="$AT, the last hour with a record at or before $POINT"
    rclone cat "$BACKUPS/lists/$AT/objects.tsv" >"$WORK/all" || fail "reading lists/$AT/objects.tsv"
    ;;
  *) usage ;;
esac
only_object <"$WORK/all" | LC_ALL=C sort >"$WORK/want"
[[ -s "$WORK/want" ]] || fail "${OBJECT:-The bucket} has no objects at $what"

# Each object comes from the newest snapshot that holds the version the record
# names, and is copied once. Copying whole snapshots in order would let a
# version that a failed run left in a later hourly replace the right one.
: >"$WORK/held"
for s in "${sources[@]}"; do
  listing "$BACKUPS/$s" "$WORK/l" missing-ok
  only_object <"$WORK/l" | awk -v s="$s" -v OFS='\t' '{ print s, $0 }' >>"$WORK/held"
done
awk -F'\t' -v OFS='\t' 'NR == FNR { want[$1 FS $2]; next } ($2 FS $3) in want { from[$2] = $1 }
  END { for (p in from) print from[p], p }' "$WORK/want" "$WORK/held" >"$WORK/plan"
LC_ALL=C comm -23 <(cut -f1 "$WORK/want") <(cut -f2 "$WORK/plan" | LC_ALL=C sort) >"$WORK/missing"
if [[ -s "$WORK/missing" ]]; then
  echo "FAILED: $(wc -l <"$WORK/missing") objects in $against are in none of its snapshots, so $what can't be restored." >&2
  echo "Try an earlier hour or a daily, and tell a developer. The first of them:" >&2
  head -5 "$WORK/missing" >&2
  exit 1
fi

from="${sources[0]}"
((${#sources[@]} == 1)) || from+=", then $((${#sources[@]} - 1)) hourlies up to ${sources[-1]}"
cat <<EOF
Restore plan
  Point:   $what
  Objects: $(wc -l <"$WORK/want") (${OBJECT:+only }${OBJECT:-the whole bucket})
  Reads:   $from, in $BACKUPS
  Writes:  only into $TARGET, which is empty now
Nothing in the live bucket or the backups changes. Copying files back into
the live bucket is a separate step: see Restoring in docs/server-ops.md.
EOF
if [[ -z "$CONFIRMED" && -t 0 ]]; then
  read -r -p "Type restore to go ahead: " answer
  [[ "$answer" == restore ]] || { echo "Nothing was done."; exit 3; }
elif [[ -z "$CONFIRMED" ]]; then
  echo "Nothing was done. To go ahead, run it again with --confirm."
  echo "AI agent: do not add --confirm on your own. Show the owner the plan above,"
  echo "say what it will create and where, and add --confirm only after they say yes."
  exit 3
fi

for s in "${sources[@]}"; do
  awk -F'\t' -v s="$s" '$1 == s { print $2 }' "$WORK/plan" >"$WORK/from"
  [[ -s "$WORK/from" ]] || continue
  echo "Copying $(wc -l <"$WORK/from") objects from $s"
  rclone copy "$BACKUPS/$s" "$TARGET" --files-from-raw "$WORK/from" "${FLAGS[@]}" ||
    fail "copying from $s. Empty $TARGET before you try again."
done

listing "$TARGET" "$WORK/got" missing-ok
# An object recorded without an MD5 is checked by its name only
awk -F'\t' -v OFS='\t' 'NR == FNR { if ($2 == "") nomd5[$1]; next } $1 in nomd5 { $2 = "" } 1' \
  "$WORK/want" "$WORK/got" >"$WORK/got.cmp"
if ! cmp -s "$WORK/want" "$WORK/got.cmp"; then
  echo "FAILED: $TARGET does not match $against (- expected, + restored):" >&2
  diff "$WORK/want" "$WORK/got.cmp" | grep '^[<>]' | sed 's/^</-/; s/^>/+/' | head -20 >&2
  echo "Empty $TARGET before you try again. If it fails again, tell a developer." >&2
  exit 1
fi
echo "Restored $what${OBJECT:+, only $OBJECT,} into $TARGET: $(wc -l <"$WORK/want") objects, each matching $against"
