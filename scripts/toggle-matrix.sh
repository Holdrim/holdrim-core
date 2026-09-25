#!/usr/bin/env bash
# Every toggle that gates code (docs/ROLES.md, section 7), run ON and OFF against something REAL —
# a live server for comments/pageRequests/bugCategory/peopleScreen, a real CLI invocation for graph.
#
#   bash scripts/toggle-matrix.sh
#
# Why this exists apart from `npm test` and `engine/test-contract.sh`: `npm test` is unit only and
# NEVER boots the server (AGENTS.md) — it can prove `readFeatures` validates the "features" block
# and that a toggle can never wrap a guard (engine/tests/features.test.js), but not that the SERVER
# actually refuses a `comment` event when `comments: false`. That needs a live process, twice, each
# against a project whose holdrim.json disagrees with the other about what is on. `voice` and
# `sketch` are absent on purpose: nothing reads them yet, so there is no "off" behaviour to tell
# apart from "on" — engine/tests/features.test.js is where their existence is proved instead.
#
# A toggle whose OFF state nobody ever ran is a branch nobody proved (docs/ROLES.md, "Every toggle
# is tested in both states") — this script is that run, kept separate from
# `engine/test-contract.sh` so that file's own project and assertions (today's behaviour, every
# toggle left at its default) stay exactly as they are.
set -uo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd); cd "$ROOT"
FAILURES=0
OWNER=owner@example.org

expect() { if [ "$2" = "$3" ]; then echo "  ok   $1"; else echo "  FAIL $1 — expected $2, got $3"; FAILURES=$((FAILURES+1)); fi; }
has() { grep "$@" >/dev/null; }

WORK=$(mktemp -d)
PIDS=()
cleanup() { for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null; done; rm -rf "$WORK"; }
trap cleanup EXIT INT TERM

# One project per state. "on" ships exactly as the example does today — no "features" key at all,
# so every default applies, which is the whole promise of a toggle: a project that configures
# nothing sees nothing change. "off" is the same content with every SERVER-gated toggle turned off.
ON="$WORK/on"; OFF="$WORK/off"
cp -r examples/hello-world "$ON"
cp -r examples/hello-world "$OFF"
node -e '
  const fs = require("fs");
  const path = process.argv[1];
  const config = JSON.parse(fs.readFileSync(path, "utf8"));
  config.features = { comments: false, pageRequests: false, bugCategory: false, peopleScreen: false, graph: false };
  fs.writeFileSync(path, JSON.stringify(config, null, 2));
' "$OFF/holdrim.json"

# Waits for a server on `$1` to answer /api/health, or gives up after 10s — the same shape
# engine/test-contract.sh and engine/test-browser.js already use.
wait_up() { for i in $(seq 40); do curl -s "http://127.0.0.1:$1/api/health" >/dev/null 2>&1 && return 0; sleep 0.25; done; return 1; }
post() { curl -s -o /dev/null -w '%{http_code}' -H "X-Dev-Email: $2" -H 'Content-Type: application/json' -d "$3" "http://127.0.0.1:$1/api/events"; }

# ------------------------------------------------------------------- comments, pageRequests, bugCategory
echo "server-gated events — comments, pageRequests, bugCategory:"
ONPORT=18195; OFFPORT=18196
HOLDRIM_MODE=local HOLDRIM_ENVIRONMENT=Development HOLDRIM_OWNER=$OWNER HOLDRIM_DEV_EMAIL= PORT=$ONPORT \
  HOLDRIM_SITE="$ON" node engine/api/server.ts >"$WORK/on.log" 2>&1 & PIDS+=($!)
HOLDRIM_MODE=local HOLDRIM_ENVIRONMENT=Development HOLDRIM_OWNER=$OWNER HOLDRIM_DEV_EMAIL= PORT=$OFFPORT \
  HOLDRIM_SITE="$OFF" node engine/api/server.ts >"$WORK/off.log" 2>&1 & PIDS+=($!)
wait_up $ONPORT || { echo "the ON server never came up"; cat "$WORK/on.log"; exit 1; }
wait_up $OFFPORT || { echo "the OFF server never came up"; cat "$WORK/off.log"; exit 1; }

expect "comments ON: a comment is recorded"           201 "$(post $ONPORT  $OWNER '{"type":"comment","page":"UC-01","text":"hi"}')"
expect "comments OFF: the same comment is refused"    403 "$(post $OFFPORT $OWNER '{"type":"comment","page":"UC-01","text":"hi"}')"

expect "pageRequests ON: asking for a page works"     201 "$(post $ONPORT  $OWNER '{"type":"request","page":"UC-01","text":"a new page","data":{"category":"page"}}')"
expect "pageRequests OFF: the same request is refused" 403 "$(post $OFFPORT $OWNER '{"type":"request","page":"UC-01","text":"a new page","data":{"category":"page"}}')"

expect "bugCategory ON: a bug report works"           201 "$(post $ONPORT  $OWNER '{"type":"request","page":"UC-01","text":"broken","data":{"category":"bug"}}')"
expect "bugCategory OFF: the same report is refused"  403 "$(post $OFFPORT $OWNER '{"type":"request","page":"UC-01","text":"broken","data":{"category":"bug"}}')"

# Everything else off must not mean everything off: an ungated category still goes through.
expect "an ungated category still works when the other three are off" 201 \
  "$(post $OFFPORT $OWNER '{"type":"request","page":"UC-01","text":"still fine","data":{"category":"text"}}')"

for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null; done
PIDS=()

# --------------------------------------------------------------------------------- peopleScreen
echo "peopleScreen — the screen hides, the guard behind it does not:"
PPORT=18197
HOLDRIM_ENVIRONMENT=Production HOLDRIM_IDENTITY=password HOLDRIM_OWNER=$OWNER HOLDRIM_EVENTS=memory \
  HOLDRIM_USERS_PATH="$WORK/users.db" PORT=$PPORT HOLDRIM_SITE="$OFF" \
  node engine/api/server.ts >"$WORK/people.log" 2>&1 & PIDS+=($!)
wait_up $PPORT || { echo "the people-screen server never came up"; cat "$WORK/people.log"; exit 1; }

FIRST_PW=$(grep -m1 'password:' "$WORK/people.log" | sed 's/.*password:[[:space:]]*//')
curl -s -c "$WORK/cookies" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$OWNER\",\"password\":\"$FIRST_PW\"}" "http://127.0.0.1:$PPORT/api/sign-in" >/dev/null

expect "peopleScreen OFF: the screen redirects home, even for the owner" 0 \
  "$(curl -s -b "$WORK/cookies" -D- -o /dev/null "http://127.0.0.1:$PPORT/engine/people" | has -i 'location: /engine/home'; echo $?)"
expect "peopleScreen OFF: /api/users still enforces its guard (the owner still creates an access)" 201 \
  "$(curl -s -b "$WORK/cookies" -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' \
    -d '{"email":"new@example.org","name":"New"}' "http://127.0.0.1:$PPORT/api/users")"

for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null; done
PIDS=()

# --------------------------------------------------------------------------------------- graph
echo "graph — the CLI command:"
node engine/cli/holdrim.ts graph --json --root "$ON" >/dev/null 2>"$WORK/graph-on.err"
expect "graph ON: the command runs" 0 "$?"
node engine/cli/holdrim.ts graph --json --root "$OFF" >/dev/null 2>"$WORK/graph-off.err"
expect "graph OFF: the command refuses" 2 "$?"
expect "graph OFF: and says why" 0 "$(has 'graph is turned off' < "$WORK/graph-off.err"; echo $?)"

echo
if [ "$FAILURES" -eq 0 ]; then
  echo "all good — every gated toggle behaves on, and behaves differently off"
  exit 0
else
  echo "$FAILURES failure(s)"
  exit 1
fi
