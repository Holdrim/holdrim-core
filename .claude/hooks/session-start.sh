#!/bin/bash
# Prepares a Claude Code session IN THE CLOUD: the container starts empty, and without this the
# first thing every session did was find out that none of the five proofs can run yet.
# It does nothing on a developer's machine (CLAUDE_CODE_REMOTE unset): that environment is theirs.
set -euo pipefail
[ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || exit 0
cd "$CLAUDE_PROJECT_DIR"
npm install --no-audit --no-fund
