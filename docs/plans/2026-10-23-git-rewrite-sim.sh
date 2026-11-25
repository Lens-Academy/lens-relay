set -e
G="git -c user.name=t -c user.email=t@t -c commit.gpgsign=false"
git init -q --bare remote.git -b main
git clone -q remote.git sync 2>/dev/null; cd sync
echo "hello" > a.md; $G add -A; $G commit -qm c1
echo "SECRET line" >> a.md; $G add -A; $G commit -qm c2-leak
echo "more" >> a.md; $G add -A; $G commit -qm c3
git push -q -u origin main
cd ..
# Someone else rewrites history on the remote: drop the SECRET line from every commit.
git clone -q remote.git rewriter; cd rewriter
$G filter-branch -f --tree-filter 'sed -i "/SECRET/d" a.md' -- --all >/dev/null 2>&1
git push -q -f origin main
cd ../sync
# Meanwhile git-sync made a new local commit (an edit in the relay).
echo "new edit" >> a.md; $G add -A; $G commit -qm c4-local
# git-sync's cycle: fetch, then (ahead>0 and behind>0) pull --rebase origin main
git fetch -q origin
echo "behind/ahead: $(git rev-list --left-right --count origin/main...main)"
$G pull -q --rebase origin main
echo "--- log after pull --rebase:"; git log --format='%s' main
echo "--- SECRET present in history? $(git log -p main | grep -c SECRET || true)"
echo "--- a.md:"; cat a.md
