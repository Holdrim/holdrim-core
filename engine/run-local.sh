#!/usr/bin/env bash
# Brings up the site + the API on your machine, just like it runs in the cloud, with TEST data in memory.
# Nothing goes to a database; when you stop it (Ctrl+C), the test events disappear.
# The pages come straight from the repository: edit, reload the browser.
# Usage: bash engine/run-local.sh              → http://localhost:8095
#        bash engine/run-local.sh examples/cash-register   → another project, the same way
#        ACTING_AS=reviewer@example.org bash engine/run-local.sh   → simulates another person
#        HOLDRIM_OWNER=ana@example.org bash engine/run-local.sh    → another owner (default: you@example.org)
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
# The project to serve: this repository's own example by default, or any folder with a holdrim.json.
# Without it, the README's red example would need Docker for the one thing a newcomer most needs to see.
SITE=$(cd "${1:-$ROOT}" 2>/dev/null && pwd) || { echo "✗ no such folder: $1"; exit 1; }
cd "$ROOT"
[ -f "$SITE/holdrim.json" ] || { echo "✗ no holdrim.json in $SITE: is this a project folder?"; exit 1; }
# Who you pretend to be and the port come from the project's holdrim.json — the engine has no fixed
# e-mail. A file that readConfig refuses (one naming an owner, say) prints its reason and stops here:
# silenced, the runner would go on with empty values and blame something else.
read_config() { node -e "
const {readConfig}=await import('./engine/core/config.js');
const fs=await import('node:fs');
let c; try { c=readConfig(process.argv[2],{readFile:p=>fs.readFileSync(p,'utf8')},process.env); }
catch (e) { console.log('✗ '+e.message); process.exit(1); }
console.log(c[process.argv[1]] ?? '');" --input-type=module "$1" "$SITE" 2>/dev/null; }
# readConfig takes a holdrim.json it cannot parse for no file at all, which is right for the service
# and wrong here: the runner would then go on with the file's settings missing and never say why.
UNREADABLE=$(read_config unreadable) || { echo "$UNREADABLE"; exit 1; }
[ -z "$UNREADABLE" ] || { echo "✗ $SITE/holdrim.json is not valid JSON: $UNREADABLE"; exit 1; }
# The owner is the deployment's to name, never the file's, and here this runner is the deployment:
# events in memory, gone when it stops, so a placeholder owner can lock nothing anybody keeps.
# Without a default, "straight in" would first need a variable nobody reading the README has set.
OWNER=${HOLDRIM_OWNER:-you@example.org}; OWNER_FROM=${HOLDRIM_OWNER:+HOLDRIM_OWNER}; OWNER_FROM=${OWNER_FROM:-this runner}
# A project that names nobody to act as is opened as its owner: "straight in", as promised.
ACTING_AS=${ACTING_AS:-${HOLDRIM_DEV_EMAIL:-$(read_config actAs)}}; ACTING_AS=${ACTING_AS:-$OWNER}
PORT=${PORT:-$(read_config port)}; PORT=${PORT:-8095}

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

echo "Holdrim local → http://localhost:$PORT   (you are acting as: $ACTING_AS · owner: $OWNER, from $OWNER_FROM · test data, disappears when you stop)"
# This runner's one promise is "test data, disappears when you stop" — a shell that already has
# HOLDRIM_EVENTS=sqlite or =firestore, or HOLDRIM_IDENTITY=password, set for some OTHER project
# would otherwise carry straight through to server.ts, which prefers the environment over this
# runner's own defaults (the local default only applies when the variable is absent at all). Then
# the placeholder owner above — a real e-mail nobody chose on purpose — would get first-access on a
# store that outlives this process: a permanent account, made by a runner whose README entry says
# "no login". Pinning here, in the exec, beats anything already exported: `env NAME=value` always
# wins for the child, regardless of what the caller's shell had set. HOLDRIM_EVENTS_PATH,
# HOLDRIM_USERS and HOLDRIM_USERS_PATH are unset too, on the same reasoning, even though memory and
# dev identity alone already keep them from being read — a value already sitting there is a lie
# about where this runner keeps data, worth removing rather than merely outvoting.
exec env -u HOLDRIM_EVENTS_PATH -u HOLDRIM_USERS -u HOLDRIM_USERS_PATH \
  HOLDRIM_MODE=local HOLDRIM_ENVIRONMENT=Development HOLDRIM_EVENTS=memory HOLDRIM_IDENTITY=dev \
  HOLDRIM_OWNER="$OWNER" HOLDRIM_DEV_EMAIL="$ACTING_AS" HOLDRIM_SITE="$SITE" PORT="$PORT" \
  node engine/api/server.ts
