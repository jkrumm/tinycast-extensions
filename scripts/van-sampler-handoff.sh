#!/usr/bin/env bash
# MacBook handoff for the van-sampler move, spike first. Run (logged in, at the screen) from anywhere:
#   bash <(git -C ~/SourceRoot/tinycast-extensions show origin/wave/van-sampler:scripts/van-sampler-handoff.sh)
#
# 1. checks the branch out into a throwaway worktree and runs the Bluetooth TCC spike there
#    (Tinycast quits itself; click Allow on the macOS Bluetooth dialog);
# 2. FAIL -> nothing is merged or installed; prints the .app-bundle fallback and exits 1;
# 3. PASS -> merges wave/van-sampler into master (it contains wave/netgear-launchd), pushes,
#    make install check deploy van-sampler-setup, and prints the manual checks.
set -euo pipefail

repo="${1:-$HOME/SourceRoot/tinycast-extensions}"
branch="wave/van-sampler"
wt="$(mktemp -d "${TMPDIR:-/tmp}/van-sampler-wt.XXXXXX")"
cleanup() { git -C "$repo" worktree remove --force "$wt" 2>/dev/null || rm -rf "$wt"; }
trap cleanup EXIT

git -C "$repo" fetch origin "$branch" master
git -C "$repo" worktree add --detach "$wt" "origin/$branch" >/dev/null
( cd "$wt/extension" && bun install --frozen-lockfile >/dev/null )

if ! make -C "$wt" van-sampler-spike; then
  cat <<'MSG'

SPIKE FAILED — nothing merged, nothing installed (the Tinycast van-sampler command keeps running).
Evidence: ~/Library/Logs/van-sampler-spike.result and van-sampler-spike.log.
Fallback: wrap the helper in an .app bundle (docs/van-sampler-tcc.md § Fallback). Report the result
file back to the orchestrator; do not hand-edit the grant.
MSG
  exit 1
fi

[ -z "$(git -C "$repo" status --porcelain)" ] || { echo "spike PASSED, but $repo has uncommitted changes — commit or stash, then re-run (the spike result stays valid)."; exit 1; }
git -C "$repo" checkout master
git -C "$repo" merge --ff-only origin/master || { echo "local master is not a fast-forward of origin/master — reconcile it, then re-run."; exit 1; }
git -C "$repo" merge --no-edit "origin/$branch" || { git -C "$repo" merge --abort; echo "merge of $branch conflicted and was aborted."; exit 1; }
# verify the merged tree before it reaches origin/master
if ! make -C "$repo" install check; then
  git -C "$repo" reset --hard ORIG_HEAD
  echo "check failed on the merged tree; master reset, nothing pushed."
  exit 1
fi
git -C "$repo" push origin master
make -C "$repo" deploy van-sampler-setup

cat <<'MSG'

Installed. Remaining manual checks (Tinycast QUIT for the first two):
  1. make van-sampler-status       -> state loaded, jobrun record ok; within 15 min
     make van-sampler-check ARGS="--wait 1"   -> a reading landed with Tinycast not running
  2. make van-sampler-notify-test  -> a "Van battery" banner appears (low-battery alert path)
  3. open Van Power: it shows the sampler's readings and the Pause/Resume action toggles the daemon
MSG
