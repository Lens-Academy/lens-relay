#!/usr/bin/env bash
# Tests r2-backup.sh and r2-backup-restore.sh over two simulated days, with
# local folders standing in for the two buckets and a stub that makes chosen
# rclone copies fail. Run: scripts/r2-backup.test.sh (needs rclone)
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
export RCLONE_CONFIG="$T/rclone.conf" # no remotes, so nothing here can reach R2
export R2_BACKUP_SOURCE="$T/live" R2_BACKUP_DEST="$T/backups" R2_BACKUP_LOCK="$T/lock"
export R2T="$T" REAL_RCLONE="$(command -v rclone)"
B="$T/backups"
mkdir -p "$T/bin" "$T/live" "$T/expect"

# $R2T/fail holds "<when> <folder suffix> [doc]": the next copy or sync into a
# folder with that suffix fails before or after copying, or "vanish" deletes
# the live doc first, as the relay deleting a document mid-run would.
cat >"$T/bin/rclone" <<'EOF'
#!/usr/bin/env bash
if [[ -f "$R2T/fail" && "$1" =~ ^(copy|sync)$ ]]; then
  read -r when into doc <"$R2T/fail"
  if [[ "$3" == *"$into" ]]; then
    rm "$R2T/fail"
    case "$when" in
      before) exit 1 ;;
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

# run <date>: one backup at that time. The live state it should capture is
# kept (the first run of an hour makes its snapshot), and current/ must only
# ever hold versions some snapshot holds.
last_rc=0
run() {
  local want
  last_rc=0
  want="$T/expect/$(date -d "$1" +%Y-%m-%d-%H)"
  [[ -e "$want" ]] || state "$T/live" >"$want"
  R2_BACKUP_AT="$1" bash "$DIR/r2-backup.sh" >"$T/out" 2>&1 || last_rc=$?
  cat "$T/out" >>"$T/log"
  local snaps
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
# restored <hour> <extra docs>: the restore holds everything live held at that
# hour, plus documents deleted earlier that day and nothing else.
restored() {
  restore "$1" "$T/r"
  expect "restore $1: everything live held" "$(LC_ALL=C comm -13 <(state "$T/r") "$T/expect/$1")" ""
  expect "restore $1: extra documents" \
    "$(LC_ALL=C comm -23 <(state "$T/r" | cut -d/ -f1 | LC_ALL=C sort -u) <(cut -d/ -f1 "$T/expect/$1" | LC_ALL=C sort -u) | tr '\n' ' ' | sed 's/ $//')" "$2"
}

# Before the deploy: full snapshots in the old layout and no current/.
put a a1; put b b1; put c c1; mkdir -p "$T/live/files"; printf x1 >"$T/live/files/h1"
for snap in daily/2026-10-01 daily/2026-10-27 hourly/2026-10-26-20 hourly/2026-10-27-14; do
  mkdir -p "$B/$snap"
  cp -r "$T/live/." "$B/$snap/"
done
state "$T/live" >"$T/expect/2026-10-27-14"

run "2026-10-27 15:00"
expect "first run: exit 0" "$last_rc" 0
expect "first run with no current/: the hourly is a full copy" "$(docs "$B/hourly/2026-10-27-15")" "a b c files"
expect "first run: current/ matches live" "$(state "$B/current")" "$(state "$T/live")"
expect "first run: weekly made from the oldest daily" "$(docs "$B/weekly/2026-43")" "a b c files"
expect "daily older than 22 days pruned" "$(ls "$B/daily")" "2026-10-27"
expect "yesterday's hourly kept" "$(ls "$B/hourly" | head -1)" "2026-10-26-20"

put a a2; put d d1
run "2026-10-27 16:00"
expect "changed and new docs only" "$(docs "$B/hourly/2026-10-27-16")" "a d"
expect "current/ takes the new version" "$(get current a)" a2
grep -q "Hourly backup: hourly/2026-10-27-16 (2 objects" "$T/out" && x=logged || x=missing
expect "hourly logs its count" "$x" logged

run "2026-10-27 17:00"
expect "nothing changed: no hourly snapshot" "$(docs "$B/hourly/2026-10-27-17")" ""
expect "nothing changed: logged" "$(grep -c 'nothing changed since the last snapshot' "$T/out")" 1

rm -r "$T/live/b"; put c c2
run "2026-10-27 18:00"
expect "a deleted doc is not copied" "$(docs "$B/hourly/2026-10-27-18")" "c"
expect "a deleted doc stays in current/ until the daily" "$(get current b)" b1

put d d2; echo "after hourly/2026-10-27-19" >"$T/fail"
run "2026-10-27 19:00"
expect "hourly copy fails: exit 1" "$last_rc" 1
expect "hourly copy fails: partial snapshot removed" "$(ls "$B/hourly" | grep -c 2026-10-27-19 || true)" 0
expect "hourly copy fails: current/ unchanged" "$(get current d)" d1

run "2026-10-27 20:00"
expect "after a failed hour the next one catches up" "$(docs "$B/hourly/2026-10-27-20")" "d"
expect "after a failed hour current/ catches up" "$(get current d)" d2

put a a3; echo "before current" >"$T/fail"
run "2026-10-27 21:00"
expect "current/ update fails: exit 1" "$last_rc" 1
expect "current/ update fails: the snapshot stays" "$(get hourly/2026-10-27-21 a)" a3
expect "current/ update fails: current/ stays behind" "$(get current a)" a2

run "2026-10-27 22:00"
expect "behind current/ is copied again" "$(docs "$B/hourly/2026-10-27-22")" "a"
expect "behind current/ catches up" "$(get current a)" a3
put a a4
run "2026-10-27 22:40"
expect "second run in an hour: exit 0" "$last_rc" 0
expect "second run in an hour: snapshot untouched" "$(get hourly/2026-10-27-22 a)" a3

put e e1; put f f1; echo "vanish hourly/2026-10-27-23 f" >"$T/fail"
run "2026-10-27 23:00"
vanished_rc=$last_rc
state "$T/live" >"$T/expect/2026-10-27-23" # f is gone by the time of the copy

run "2026-10-28 00:00"
expect "daily: exit 0" "$last_rc" 0
expect "daily: a full copy of live" "$(state "$B/daily/2026-10-28")" "$(state "$T/live")"
expect "daily: current/ matches it, deleted doc gone" "$(state "$B/current")" "$(state "$T/live")"
expect "daily: no hourly when nothing changed after it" "$(docs "$B/hourly/2026-10-28-00")" ""
expect "hourlies before yesterday pruned" "$(ls "$B/hourly" | grep -c 2026-10-26 || true)" 0
expect "yesterday's hourlies kept" "$(ls "$B/hourly" | grep -c 2026-10-27 || true)" $((vanished_rc == 0 ? 8 : 7))

put a a5
run "2026-10-28 01:00"
expect "next day: changes only" "$(docs "$B/hourly/2026-10-28-01")" "a"

# Late the next day an hour of yesterday still needs all its earlier hourlies.
run "2026-10-28 20:00"
expect "late next day: yesterday's hourlies all kept" "$(ls "$B/hourly" | grep -c 2026-10-27 || true)" $((vanished_rc == 0 ? 8 : 7))

if [[ "$vanished_rc" == 0 ]]; then
  expect "a doc deleted mid-run: the rest is backed up" "$(docs "$B/hourly/2026-10-27-23")" "a e"
else
  expect "a doc deleted mid-run: the next run caught up" "$(get daily/2026-10-28 e)" e1
fi

for h in 15 16 17; do restored "2026-10-27-$h" ""; done
for h in 18 20 21 22; do restored "2026-10-27-$h" "b"; done
restored 2026-10-28-00 ""
restored 2026-10-28-01 ""
restore 2026-10-27-19 "$T/r"
expect "restore a failed hour: the hour before" "$(state "$T/r" | grep -v '^b/')" "$(cat "$T/expect/2026-10-27-18")"
restore 2026-10-27-16 "$T/r" a
expect "restore one document" "$(state "$T/r")" "a/data.ysweet a2"
mkdir -p "$T/r" && touch "$T/r/x"
last_rc=0
bash "$DIR/r2-backup-restore.sh" 2026-10-27-16 "$T/r" >/dev/null 2>&1 || last_rc=$?
expect "restore refuses a folder that is not empty" "$last_rc" 2
restore 2026-10-27-16 r2bk:lens-relay-storage
expect "restore refuses the live bucket" "$last_rc" 2
restore 2026-10-27 "$T/r"
expect "restore refuses a malformed hour" "$last_rc" 2
restore 2026-10-20-12 "$T/r"
expect "restore without a daily: exit 1" "$last_rc" 1

put a a6
run "2026-10-29 00:00"
expect "two days on: that day's hourlies pruned" "$(ls "$B/hourly" | grep -c 2026-10-27 || true)" 0
restore 2026-10-27-20 "$T/r"
expect "restore after its hourlies are gone: says so" "$(grep -c 'hourly backups of 2026-10-27 are gone' "$T/restore.out")" 1
expect "restore after its hourlies are gone: start of that day" "$(state "$T/r")" "$(state "$B/daily/2026-10-27")"
restored 2026-10-28-01 ""

if ((failures > 0)); then
  echo "$failures failed"
  echo "--- backup log"
  cat "$T/log"
  exit 1
fi
echo "all passed"
