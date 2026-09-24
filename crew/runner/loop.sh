#!/usr/bin/env bash
# Starts one pass, waits, starts the next: a failed pass is logged and the next one starts clean,
# since each pass clones afresh and reads the state from the repository, never from the last one.
set -uo pipefail
while true; do
  bash run-orchestrator.sh || echo "pass ended with exit $? at $(date -u +%FT%TZ)"
  sleep "${INTERVAL_SECONDS:-7200}"
done
