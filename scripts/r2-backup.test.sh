#!/usr/bin/env bash
# Tests r2-backup.sh and r2-backup-restore.sh over three simulated days, with
# local folders standing in for the two buckets and a stub that makes chosen
# rclone calls fail. Every restore must give exactly what live held at the
# point it names. Run: scripts/r2-backup.test.sh (needs rclone)
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
export RCLONE_CONFIG="$T/rclone.conf" # no remotes, so nothing here can reach R2
export R2_BACKUP_SOURCE="$T/live" R2_BACKUP_DEST="$T/backups" R2_BACKUP_LOCK="$T/lock"
export R2T="$T" REAL_RCLONE="$(command -v rclone)"
B="$T/backups"
mkdir -p "$T/bin" "$T/live" "$T/expect"

# $R2T/fail holds "<when> <path suffix> [doc]" for the next rclone call with an
# argument ending in that suffix: "before" or "after" makes a copy, copyto or
# sync fail before or after copying, "vanish" deletes the live doc first (as
# the relay deleting a document mid-run would), "lsf" and "purge" make that
# command fail.
cat >"$T/bin/rclone" <<'EOF'
#!/usr/bin/env bash
if [[ -f "$R2T/fail" ]]; then
  read -r when into doc <"$R2T/fail"
  match=""
  for a in "${@:2}"; do [[ "$a" == *"$into" ]] && match=1; done
  case "$when:$1" in
    before:copy | before:copyto | before:sync | after:copy | after:sync | vanish:copy | lsf:lsf | purge:purge) ;;
    *) match="" ;;
  esac
  if [[ -n "$match" ]]; then
    rm "$R2T/fail"
    case "$when" in
      before | lsf | purge) exit 1 ;;
      after) "$REAL_RCLONE" "$@"; exit 1 ;;
      vanish) rm -r "$R2T/live/$doc" ;;
    esac
  fi
fi
exec "$REAL_RCLONE" "$@"
EOF
chmod +x "$T/bin/rclone"
export PATH="$T/bin:$PATH"

failures=0
expect() {
  local what="$1" got="$2" want="$3"
  if [[ "$got" == "$want" ]]; then
    echo "ok   $what"
  else
    echo "FAIL $what: got '$got', want '$want'"
    failures=$((failures + 1))
  fi
}

put() { mkdir -p "$T/live/$1"; printf '%s' "$2" >"$T/live/$1/data.ysweet"; }
# "path content" per file, sorted
state() {
  [[ -d "$1" ]] || return 0
  (cd "$1" && find . -type f | LC_ALL=C sort | while read -r f; do echo "${f#./} $(cat "$f")"; done)
}
docs() { state "$1" | cut -d/ -f1 | LC_ALL=C sort -u | tr '\n' ' ' | sed 's/ $//'; }
get() { state "$B/$1" | sed -n "s|^$2/data.ysweet ||p"; }
has() { [[ -e "$B/$1" ]] && echo yes || echo no; }
said() { grep -qF "$1" "$2" && echo yes || echo no; }

# run <date>: one backup at that time. The first run of an hour records what
# live holds then, and after every run current/ may only hold versions some
# snapshot holds.
last_rc=0
run() {
  local want snaps
  last_rc=0
  want="$T/expect/$(date -d "$1" +%Y-%m-%d-%H)"
  [[ -e "$want" ]] || state "$T/live" >"$want"
  R2_BACKUP_AT="$1" bash "$DIR/r2-backup.sh" >"$T/out" 2>&1 || last_rc=$?
  cat "$T/out" >>"$T/log"
  snaps=$(for s in "$B"/{hourly,daily,weekly}/*; do state "$s"; done | LC_ALL=C sort -u)
  if [[ -n "$(LC_ALL=C comm -23 <(state "$B/current") <(echo "$snaps"))" ]]; then
    echo "FAIL after the run at $1: current/ holds a version no snapshot holds"
    failures=$((failures + 1))
  fi
}
restore() {
  last_rc=0
  rm -rf "$T/r"
  bash "$DIR/r2-backup-restore.sh" "$@" >"$T/restore.out" 2>&1 || last_rc=$?
}
# exact <point> <state wanted> <what>: the restore holds exactly that
exact() {
  restore "$1" "$T/r"
  expect "restore $1 ($3): exit 0" "$last_rc" 0
  expect "restore $1 ($3): exactly the objects and contents" "$(state "$T/r")" "$2"
}

# --- 27 Oct: deployed at 14:30. The old script left full snapshots and no
# current/, lists/ or done/; z was in them and has been deleted since.
put a a1; put b b1; put c c1; put z z1; mkdir -p "$T/live/files"; printf x1 >"$T/live/files/h1"
for snap in daily/2026-10-01 daily/2026-10-27 hourly/2026-10-26-20 hourly/2026-10-27-14; do
  mkdir -p "$B/$snap"
  cp -r "$T/live/." "$B/$snap/"
done
rm -r "$T/live/z"

run "2026-10-27 14:30"
expect "first run: exit 0" "$last_rc" 0
expect "first run: the old dailies are marked complete" "$(has done/daily/2026-10-27/ok) $(state "$B/daily/2026-10-27" | grep -c '^z/')" "yes 1"
expect "first run: current/ matches live" "$(state "$B/current")" "$(state "$T/live")"
expect "first run: the hour's record" "$(wc -l <"$B/lists/2026-10-27-14/objects.tsv")" 4
expect "first run: weekly made from the oldest daily" "$(docs "$B/weekly/2026-43") / $(cat "$B/done/weekly/2026-43/ok")" "a b c files z / a copy of daily/2026-10-01"
expect "daily older than 22 days pruned, with its marker" "$(ls "$B/daily") $(has done/daily/2026-10-01)" "2026-10-27 no"
expect "yesterday's hourly kept" "$(ls "$B/hourly" | head -1)" "2026-10-26-20"

run "2026-10-27 15:00"
expect "nothing changed: no hourly snapshot" "$(has hourly/2026-10-27-15)" no
expect "nothing changed: logged, with the record" "$(said 'Hourly backup 2026-10-27-15: 0 changed, record of 4 objects' "$T/out")" yes

put a a2; put d d1
run "2026-10-27 16:00"
expect "changed and new docs only" "$(docs "$B/hourly/2026-10-27-16")" "a d"
expect "current/ takes the new version" "$(get current a)" a2
expect "hourly logs its counts" "$(said 'Hourly backup 2026-10-27-16: 2 changed, record of 5 objects' "$T/out")" yes

run "2026-10-27 17:00"

rm -r "$T/live/b"; put c c2
run "2026-10-27 18:00"
expect "a deleted doc is not copied" "$(docs "$B/hourly/2026-10-27-18")" "c"
expect "a deleted doc stays in current/ until the daily" "$(get current b)" b1

put d d2; echo "after hourly/2026-10-27-19" >"$T/fail"
run "2026-10-27 19:00"
expect "hourly copy fails: exit 1, no record" "$last_rc $(has lists/2026-10-27-19)" "1 no"
expect "hourly copy fails: current/ unchanged" "$(get current d)" d1

run "2026-10-27 20:00"
expect "after a failed hour the next one catches up" "$(docs "$B/hourly/2026-10-27-20") / $(get current d)" "d / d2"

put a a3; echo "before current" >"$T/fail"
run "2026-10-27 21:00"
expect "current/ update fails: exit 1, no record" "$last_rc $(has lists/2026-10-27-21)" "1 no"
expect "current/ update fails: snapshot stays, current/ behind" "$(get hourly/2026-10-27-21 a) $(get current a)" "a3 a2"

run "2026-10-27 22:00"
expect "behind current/ catches up" "$(docs "$B/hourly/2026-10-27-22") / $(get current a)" "a / a3"
put a a4
run "2026-10-27 22:40"
expect "second run in an hour: nothing done" "$last_rc $(get hourly/2026-10-27-22 a)" "0 a3"

put e e1; put f f1; echo "vanish hourly/2026-10-27-23 f" >"$T/fail"
run "2026-10-27 23:00"
state "$T/live" >"$T/expect/2026-10-27-23" # f was gone by the time of the copy
expect "a doc deleted mid-run: the rest backed up" "$last_rc $(docs "$B/hourly/2026-10-27-23")" "0 a e"

# --- 28 Oct
run "2026-10-28 00:00"
expect "daily: exit 0 and marked" "$last_rc $(has done/daily/2026-10-28/ok)" "0 yes"
expect "daily: a full copy of live" "$(state "$B/daily/2026-10-28")" "$(state "$T/live")"
expect "daily: current/ matches it, deleted doc gone" "$(state "$B/current")" "$(state "$T/live")"
expect "daily: no hourly when nothing changed after it" "$(has hourly/2026-10-28-00)" no
expect "hourlies before yesterday pruned" "$(ls "$B/hourly" | grep -c 2026-10-26 || true)" 0

put a a5
run "2026-10-28 01:00"
expect "next day: changes only" "$(docs "$B/hourly/2026-10-28-01")" "a"

put c c3; echo "before lists/2026-10-28-02/objects.tsv" >"$T/fail"
run "2026-10-28 02:00"
expect "record write fails: exit 1, no record" "$last_rc $(has lists/2026-10-28-02)" "1 no"
run "2026-10-28 03:00"
expect "after a failed record the next hour has one" "$(grep -c $'^c/data.ysweet\t' "$B/lists/2026-10-28-03/objects.tsv")" 1

rm -r "$T/live/e"
run "2026-10-28 04:00"
expect "a deletion only: no hourly snapshot, a new record" "$(has hourly/2026-10-28-04) $(grep -c '^e/' "$B/lists/2026-10-28-04/objects.tsv" || true)" "no 0"

mv "$T/live" "$T/live.away"
run "2026-10-28 05:00"
expect "live bucket missing: exit 1, no record" "$last_rc $(has lists/2026-10-28-05)" "1 no"
mkdir "$T/live"
run "2026-10-28 05:20"
expect "live bucket empty: exit 1" "$last_rc $(said 'the live bucket lists as empty' "$T/out")" "1 yes"
rm -r "$T/live" && mv "$T/live.away" "$T/live"
rm "$T/expect/2026-10-28-05"
run "2026-10-28 05:40"
expect "live back: the hour is backed up" "$last_rc $(has lists/2026-10-28-05)" "0 yes"

before=$(state "$B/daily/2026-10-28")
echo "lsf done/daily" >"$T/fail"
run "2026-10-28 06:00"
expect "a listing fails: exit 1" "$last_rc" 1
expect "a listing fails: the complete daily untouched" "$(state "$B/daily/2026-10-28")" "$before"
rm "$T/expect/2026-10-28-06"
run "2026-10-28 06:30"
expect "after a failed listing the hour is backed up" "$(has lists/2026-10-28-06)" yes

# Late the next day an hour of yesterday still needs all its earlier hourlies.
run "2026-10-28 20:00"
expect "late next day: yesterday's hourlies and records all kept" \
  "$(ls "$B/hourly" | grep -c 2026-10-27 || true) $(ls "$B/lists" | grep -c 2026-10-27 || true)" "8 8"

for h in 2026-10-27-{14,15,16,17,18,20,22,23} 2026-10-28-{00,01,03,04,05,06,20}; do
  exact "$h" "$(cat "$T/expect/$h")" "recorded hour"
done
exact 2026-10-27-19 "$(cat "$T/expect/2026-10-27-18")" "failed hour: the one before"
expect "restore of a failed hour says which hour it gives" "$(said '2026-10-27-18, the last record before 2026-10-27-19' "$T/restore.out")" yes
exact 2026-10-27-21 "$(cat "$T/expect/2026-10-27-20")" "failed hour: the one before"
exact 2026-10-28-02 "$(cat "$T/expect/2026-10-28-01")" "hour without a record: the one before"
restore 2026-10-27-13 "$T/r"
expect "restore before the first record: refused" "$last_rc $(said 'No hourly record at or before 2026-10-27-13' "$T/restore.out")" "1 yes"
exact daily/2026-10-28 "$(state "$B/daily/2026-10-28")" "a daily"
exact weekly/2026-43 "$(state "$B/weekly/2026-43")" "a weekly"
expect "restore of a weekly says which daily it holds" "$(said 'weekly/2026-43 (a copy of daily/2026-10-01)' "$T/restore.out")" yes
exact daily/2026-10-27 "$(state "$B/daily/2026-10-27")" "a daily from before the change"
restore 2026-10-27-16 "$T/r" a
expect "restore one document" "$last_rc $(state "$T/r")" "0 a/data.ysweet a2"
restore 2026-10-27-16 "$T/r" files/h1
expect "restore one attachment" "$last_rc $(state "$T/r")" "0 files/h1 x1"
restore 2026-10-27-20 "$T/r" b
expect "restore a document deleted by then: exit 1" "$last_rc" 1
restore 2026-10-27-15 "$T/r" d
expect "restore a document not yet made: exit 1" "$last_rc" 1

mkdir -p "$T/r" && touch "$T/r/x"
last_rc=0
bash "$DIR/r2-backup-restore.sh" 2026-10-27-16 "$T/r" >/dev/null 2>&1 || last_rc=$?
expect "restore refuses a folder that is not empty" "$last_rc" 2
restore 2026-10-27-16 r2bk:lens-relay-storage
expect "restore refuses the live bucket" "$last_rc" 2
restore 2026-10-27-16 r2bk:lens-relay-backups/hourly/x
expect "restore refuses the backup bucket" "$last_rc" 2
restore 2026-10-27 "$T/r"
expect "restore refuses a malformed point" "$last_rc" 2
restore daily/2026-10-20 "$T/r"
expect "restore a daily that doesn't exist: exit 1" "$last_rc" 1

mv "$B/hourly/2026-10-28-01" "$T/stash"
restore 2026-10-28-03 "$T/r"
expect "a snapshot missing from the chain: refused, says so" "$last_rc $(said 'does not match the record' "$T/restore.out")" "1 yes"
mv "$T/stash" "$B/hourly/2026-10-28-01"

# --- 29 Oct: the daily fails twice, then a prune fails once
put a a6; echo "after daily/2026-10-29" >"$T/fail"
run "2026-10-29 00:00"
expect "daily copy fails: exit 1, not marked, no hourly" "$last_rc $(has done/daily/2026-10-29) $(has lists/2026-10-29-00)" "1 no no"
echo "before current" >"$T/fail"
run "2026-10-29 01:00"
expect "daily sync fails: exit 1, not marked" "$last_rc $(has done/daily/2026-10-29)" "1 no"
echo "purge hourly/2026-10-27-16" >"$T/fail"
run "2026-10-29 02:00"
expect "daily finished by the next run" "$(has done/daily/2026-10-29/ok) $(state "$B/daily/2026-10-29")" "yes $(state "$T/live")"
expect "a prune fails: exit 1, said" "$last_rc $(said 'FAILED to prune hourly/2026-10-27-16' "$T/out")" "1 yes"
expect "a prune fails: the hour is still backed up" "$(has lists/2026-10-29-02)" yes
run "2026-10-29 03:00"
expect "next run: the prune is done" "$last_rc $(ls "$B/hourly" "$B/lists" | grep -c 2026-10-27 || true)" "0 0"

exact 2026-10-29-00 "$(cat "$T/expect/2026-10-28-20")" "daily not made yet: yesterday's last record"
exact 2026-10-29-02 "$(cat "$T/expect/2026-10-29-02")" "after the late daily"
exact 2026-10-28-04 "$(cat "$T/expect/2026-10-28-04")" "yesterday, still whole"
restore 2026-10-27-20 "$T/r"
expect "restore after its records are pruned: refused" "$last_rc" 1

if ((failures > 0)); then
  echo "$failures failed"
  echo "--- backup log"
  cat "$T/log"
  exit 1
fi
echo "all passed"
