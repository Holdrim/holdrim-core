#!/bin/bash
# Prepares a Claude Code session, and points every session — cloud or local — at the crew's
# handoff. The cloud-only setup below (npm ci, Chromium, the Firestore emulator) still guards on
# CLAUDE_CODE_REMOTE: the container starts empty, and without it the first thing every cloud
# session did was find out that none of the five proofs can run yet. A developer's machine is
# already set up, so that part still does nothing there.
# The stale-checkout warning and the handoff note further down run everywhere instead: a local
# session forgets its handoff on /clear exactly as a cloud one does, and a local checkout can sit
# behind origin/main just as easily as the cloud one that prompted this hook to grow these checks.
set -euo pipefail
cd "$CLAUDE_PROJECT_DIR"

if [ "${CLAUDE_CODE_REMOTE:-}" = "true" ]; then
  # The engine runs TypeScript by type stripping, which Node has without a flag only from the
  # version package.json's engines.node names. An older Node fails later, inside a proof, with an
  # error that names a syntax and not a version. The floor is read from there, so bumping it is
  # one edit.
  if ! node -e '
    const [need, have] = [require("./package.json").engines.node.replace(">=", ""), process.versions.node]
      .map((v) => v.split(".").map(Number)).map(([a, b = 0, c = 0]) => (a * 1000 + b) * 1000 + c);
    process.exit(have >= need ? 0 : 1)'; then
    echo "WARNING: Node $(node -v 2>/dev/null || echo 'is missing') does not meet package.json's engines.node. The proofs will not run." >&2
  fi

  # `npm ci`, not `npm install`: install rewrites package-lock.json whenever the container's npm
  # resolves differently, and a dirty lockfile lands in the diff every review lens reads.
  npm ci --no-audit --no-fund

  # Without the hooks nothing checks a commit message: CI does not run the commit-msg rule.
  git config core.hooksPath .githooks

  # `npm run browser` needs the Chromium build this playwright-core expects; the one the container
  # ships is usually older. A failed download is said out loud, so that a skipped browser run is a
  # known gap and not a silent one.
  if ! npx --no-install playwright-core install chromium >/dev/null 2>&1; then
    echo "WARNING: could not install Chromium for Playwright (no network?). 'npm run browser' will not run in this session." >&2
  fi

  # Without the emulator every Firestore test skips here and the store is proved only by CI, after
  # the push. The variable reaches the session through CLAUDE_ENV_FILE; a failure is said out loud.
  if line=$(bash scripts/firestore-emulator.sh); then
    if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
      echo "$line" >> "$CLAUDE_ENV_FILE"
    else
      echo "WARNING: the Firestore emulator is running, but nothing carries its variable into the session. Run: $line" >&2
    fi
  else
    echo "WARNING: no Firestore emulator in this session. Its tests will SKIP here; CI still runs them." >&2
  fi
fi

# Is this checkout a stale COPY of origin/main? Skills, agents and hooks — this file among them,
# and .claude/skills/crew/ which reads the handoff below — are loaded from THIS checkout, never
# fetched from GitHub. A copy that sits behind main can be missing any of them, which is exactly
# how this check came to exist: a session's primary checkout was on a branch named `main-buanui`,
# 21 commits behind origin/main and with none of its own, so .claude/skills/crew/ did not exist
# there yet and nothing told the session so before it went looking for a skill that was not there.
# The check is on ancestry, not on the branch being named "main": that branch was not named "main"
# — the harness had checked out a copy under a made-up name — so a name check would have missed the
# very bug this exists for. It also deliberately does NOT warn on an ordinary feature branch that
# is behind main: such a branch has commits of its own (ahead > 0), which is normal mid-review and
# not what broke — warning on every one of those is noise people learn to ignore, and the one
# case that matters (a same-as-main copy with skills missing) would drown in it.
# This hook only warns, never merges or switches branches itself: doing that behind whoever is
# using this checkout, mid-edit or not, would be a far worse surprise than a stale checkout that at
# least says so.
default_branch=main
if fetch_err=$(git fetch origin "$default_branch" --quiet 2>&1); then
  # FETCH_HEAD, not refs/remotes/origin/main: the fetch above always sets it, whatever this
  # checkout's remote-tracking refspec happens to be, so the comparison holds even in a partial or
  # oddly configured clone.
  ahead=$(git rev-list --count FETCH_HEAD..HEAD)
  behind=$(git rev-list --count HEAD..FETCH_HEAD)
  if [ "$ahead" -eq 0 ] && [ "$behind" -gt 0 ]; then
    echo "WARNING: this checkout is a copy of origin/$default_branch, $behind commit(s) behind it and with no commits of its own. Skills, agents and hooks (including /crew) load from THIS checkout, so newer ones may simply be missing here." >&2
    # ahead == 0 means there is no history of this checkout's own to lose, so the fast-forward
    # below can never conflict — the only thing that could still block it is an uncommitted change.
    if [ -z "$(git status --porcelain)" ]; then
      echo "WARNING: working tree is clean; consider: git merge --ff-only origin/$default_branch" >&2
    fi
  fi
else
  # git's own fatal messages span several lines; folded to one so the WARNING reads as one line
  # in whatever log collects stderr, instead of the real reason scrolling past unlabelled.
  fetch_err=$(echo "${fetch_err:-no network?}" | tr '\n' ' ')
  echo "WARNING: could not fetch origin/$default_branch ($fetch_err); cannot tell whether this checkout is behind." >&2
fi

# Printed to stdout, not stderr: a SessionStart hook's stdout is added to the session's context, so
# this is the one channel guaranteed to reach every session — cloud or local, fresh or freshly
# /cleared — including the one that started this: a checkout too old to even have the /crew skill
# that would otherwise have said this instead.
# Keep this in step with .claude/skills/crew/SKILL.md, step 2 ("Read the open issue labelled
# handoff..."): the two say the same thing to two different readers, and only one of them is
# guaranteed to load.
echo "This project's crew keeps state in the open GitHub issue labelled 'handoff': read it and its"
echo "comments (newest last) before acting on anything here. '/crew <role>' does that for you;"
echo "without it, read the issue directly first."
