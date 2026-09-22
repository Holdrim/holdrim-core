#!/usr/bin/env bash
# A worktree ready to work in, in one command.
#
#   bash scripts/worktree.sh subject-linking
#
# Why this exists: `git worktree add` gives you the files and nothing else. In this repository that
# means no `node_modules`, so the first thing you do in the new tree is wait three minutes for an
# install of dependencies that are already on the disk, one directory over. Multiply that by the
# four parallel branches you opened precisely to save time.
#
# It also exists so that two agents working at once cannot step on each other: each gets its own
# tree and its own branch, and the only shared thing is a read-only symlink.
set -euo pipefail

NAME=${1:-}
if [ -z "$NAME" ]; then
  echo "usage: bash scripts/worktree.sh <name>"
  echo "       creates ../holdrim-<name> on a branch called <name>"
  exit 2
fi

ROOT=$(cd "$(dirname "$0")/.." && pwd)
DEST="$ROOT/../holdrim-$NAME"

if [ -e "$DEST" ]; then
  echo "$DEST already exists. Pick another name, or remove it with:"
  echo "  git -C \"$ROOT\" worktree remove \"$DEST\""
  exit 1
fi

git -C "$ROOT" worktree add -b "$NAME" "$DEST" HEAD

# Shared, not copied. A worktree is for a few hours of work; a second 200MB copy of the same
# dependency tree is pure waste. ⚠️ It is a symlink, so `npm install` in the worktree writes into
# the MAIN tree's node_modules. If you need different dependencies, delete the link first:
#   rm node_modules && npm ci
if [ -d "$ROOT/node_modules" ]; then
  ln -s "$ROOT/node_modules" "$DEST/node_modules"
  echo "node_modules: linked to the main tree (shared, not copied)"
else
  echo "node_modules: not in the main tree — run 'npm ci' inside the worktree"
fi

# The events database is not shared. Two trees writing to one SQLite file would interleave events
# from two different pieces of work, and events are the one thing here that never gets erased.
mkdir -p "$DEST/data"

cat <<EOF

  worktree:  $DEST
  branch:    $NAME

  cd "$DEST"
  npm test && bash engine/test-contract.sh

  when you are done:
    git -C "$ROOT" worktree remove "$DEST"      # refuses if there is uncommitted work
    git -C "$ROOT" branch -d "$NAME"
EOF
