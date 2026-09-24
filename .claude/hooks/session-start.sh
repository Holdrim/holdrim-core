#!/bin/bash
# Prepares a Claude Code session IN THE CLOUD: the container starts empty, and without this the
# first thing every session did was find out that none of the five proofs can run yet.
# It does nothing on a developer's machine (CLAUDE_CODE_REMOTE unset): that environment is theirs.
set -euo pipefail
[ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || exit 0
cd "$CLAUDE_PROJECT_DIR"

# The engine runs TypeScript by type stripping, which Node has without a flag only from the version
# package.json's engines.node names. An older Node fails later, inside a proof, with an error that
# names a syntax and not a version. The floor is read from there, so bumping it is one edit.
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
