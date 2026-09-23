#!/usr/bin/env bash
# Brings up the site + the API on your machine, just like it runs in the cloud, with TEST data in memory.
# Nothing goes to a database; when you stop it (Ctrl+C), the test events disappear.
# The pages come straight from the repository: edit, reload the browser.
# Usage: bash engine/run-local.sh              → http://localhost:8095
#        bash engine/run-local.sh examples/cash-register   → another project, the same way
#        ACTING_AS=reviewer@example.org bash engine/run-local.sh   → simulates another person
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
# The project to serve: this repository's own example by default, or any folder with a holdrim.json.
# Without it, the README's red example would need Docker for the one thing a newcomer most needs to see.
SITE=$(cd "${1:-$ROOT}" 2>/dev/null && pwd) || { echo "✗ no such folder: $1"; exit 1; }
cd "$ROOT"
# Who approves and who you pretend to be come from the project's holdrim.json — the engine has no fixed e-mail.
read_config() { node -e "
const {readConfig}=await import('./engine/core/config.js');
const fs=await import('node:fs');
const c=readConfig(process.argv[2],{readFile:p=>fs.readFileSync(p,'utf8')},process.env);
console.log(c[process.argv[1]] ?? '');" --input-type=module "$1" "$SITE" 2>/dev/null; }
# readConfig takes a holdrim.json it cannot parse for no file at all, which is right for the service
# and wrong here: the owner check below would then blame a missing owner for a trailing comma.
UNREADABLE=$(read_config unreadable)
[ -z "$UNREADABLE" ] || { echo "✗ $SITE/holdrim.json is not valid JSON: $UNREADABLE"; exit 1; }
OWNER=${HOLDRIM_OWNER:-$(read_config owner)}
# A project that names nobody to act as is opened as its owner: "straight in", as promised.
ACTING_AS=${ACTING_AS:-${HOLDRIM_DEV_EMAIL:-$(read_config actAs)}}; ACTING_AS=${ACTING_AS:-$OWNER}
PORT=${PORT:-$(read_config port)}; PORT=${PORT:-8095}
[ -n "$OWNER" ] || [ -f "$SITE/holdrim.json" ] || { echo "✗ no holdrim.json in $SITE: is this a project folder?"; exit 1; }
[ -n "$OWNER" ] || { echo "✗ missing the owner: put it in holdrim.json or in HOLDRIM_OWNER."; exit 1; }

# If the port is already in use, the OLD process keeps answering — and you end up testing the
# previous binary without knowing it, and may undo a fix that is actually correct because the old
# code still fails. Better not to come up than to come up lying.
# The question goes to the port itself, through Node, which is certain to be here. `ss` is not: on a
# machine without it the answer would come back empty, read as "free", and the guard would wave every
# busy port through — silently, which is the one thing it exists to prevent.
# `ss` is still asked, but only for the pid, and only when it is there to answer.
if node -e "require('net').connect(+process.argv[1], '127.0.0.1')
  .on('connect', () => process.exit(0)).on('error', () => process.exit(1))" "$PORT"; then
  # `|| true`: under `set -euo pipefail` a missing `ss` would fail this line and end the script
  # right here — refusing, but without a word of why.
  PID=$(ss -ltnp 2>/dev/null | grep ":$PORT " | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2 || true)
  echo "✗ port $PORT is already in use (pid ${PID:-?})."
  echo "  What answers there is the OLD process, not the code you just changed."
  echo "  Stop it with:  kill ${PID:-<pid>}      or use another one:  PORT=8096 bash engine/run-local.sh"
  exit 1
fi

[ -d node_modules ] || { echo "installing dependencies..."; npm install --silent; }
# ⚠️ Nothing else runs before the server, on purpose. With `set -e`, a step here that fails — a
# build step of some project, say — makes this script exit 1 before starting anything at all: the
# documented way to run it locally would be dead, silently, and no test would notice because no
# test runs this file.

echo "Holdrim local → http://localhost:$PORT   (you are acting as: $ACTING_AS · test data, disappears when you stop)"
exec env HOLDRIM_MODE=local HOLDRIM_ENVIRONMENT=Development HOLDRIM_OWNER="$OWNER" \
  HOLDRIM_DEV_EMAIL="$ACTING_AS" HOLDRIM_SITE="$SITE" PORT="$PORT" \
  node engine/api/server.ts
