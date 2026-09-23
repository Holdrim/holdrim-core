#!/bin/bash
# Prepares a Claude Code session IN THE CLOUD: the container starts empty, and without this the
# first thing every session did was find out that none of the five proofs can run yet.
# It does nothing on a developer's machine (CLAUDE_CODE_REMOTE unset): that environment is theirs.
set -euo pipefail
[ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || exit 0
cd "$CLAUDE_PROJECT_DIR"

# The engine runs TypeScript by type stripping, which Node has without a flag only from 22.18.
# An older Node fails later, inside a proof, with an error that names a syntax and not a version.
if ! node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 18) ? 0 : 1)'; then
  echo "WARNING: Node $(node -v 2>/dev/null || echo 'is missing'); Holdrim needs 22.18 or newer. The proofs will not run." >&2
fi

# `npm ci`, not `npm install`: install rewrites package-lock.json whenever the container's npm
# resolves differently, and a dirty lockfile lands in the diff every review lens reads.
npm ci --no-audit --no-fund

# Without the hooks the commit-msg rule is checked only by CI, after the push.
git config core.hooksPath .githooks

# `npm run browser` needs the Chromium build this playwright-core expects; the one the container
# ships is usually older. A failed download is said out loud, so that a skipped browser run is a
# known gap and not a silent one.
if ! npx --no-install playwright-core install chromium >/dev/null 2>&1; then
  echo "WARNING: could not install Chromium for Playwright (no network?). 'npm run browser' will not run in this session." >&2
fi
