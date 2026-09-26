#!/usr/bin/env bash
# The HTTP contract of the API, against a real server. Usage: bash engine/test-contract.sh
set -uo pipefail
# ⚠️ Brace expansion OFF, and the whole suite depends on it. Every body here is JSON —
# `{"type":"approval","page":"D01",…}` — which is also the shape of a brace list, `{a,b,c}`.
#
# ONE shape breaks, and only on the bash 3.2 that macOS still ships: a command substitution that
# sits INSIDE a double-quoted string, with the body double-quoted inside it —
#
#     expect "…" 400 "$(post $OWNER "{\"type\":\"approval\",\"page\":\"D01\"}")"
#
# which is how most of the checks below are written. Bash 3.2 loses the inner quoting there and
# brace-expands, so ONE request goes out as FOUR, each carrying a fragment like `"page":"D01"`,
# each answered 500. Without this line, every check written that way fails on a Mac while CI's
# Linux is green.
#
# The same body assigned to a variable first, or passed straight to a command, is NOT affected —
# which is why this is easy to look for and fail to find. Bash 4 and newer are fine everywhere.
set +B
ROOT=$(cd "$(dirname "$0")" && pwd); cd "$ROOT/.."
# Not a fixed number: the guard a few lines down only catches a SECOND run that starts after the
# first is already listening — it does nothing for two runs (two worktrees, two agents) that start
# within the same instant, both find the port free, and both proceed. One of their servers then
# wins the bind; the other's dies of EADDRINUSE, silently, while ITS OWN health-check loop keeps
# polling the same port and finds the WINNER's server instead — answering, so the loop moves on,
# every assertion after that now run against the wrong config. Round 1 of the issue #31 review saw a
# symptom this shape fits exactly: a check expecting a role read a raw address once, then passed
# clean on retry, with 5+ isolated-port re-runs never reproducing it — consistent with another run's
# server answering for one boot, on a machine likely running more than one worktree, rather than a
# bug in the code either run was proving. Spreading the default over a wide range makes two such
# runs landing on the SAME port a coincidence rather than a certainty; `PORT=` set explicitly, as the
# guard's own message already tells whoever hits it, still wins outright and is left completely
# alone.
PORT=${PORT:-$((19000 + RANDOM % 9000))}; B=http://127.0.0.1:$PORT; FAILURES=0
export OWNER=owner@example.org; export REVIEWER=reviewer@example.org
LEAD=lead@example.org
# Marked as an agent by HOLDRIM_AGENTS on the first server below (docs/ROLES.md, section 4).
AGENT=agent@example.org
SITE="$PWD/examples/hello-world"

expect() { if [ "$2" = "$3" ]; then echo "  ok   $1"; else echo "  FAIL $1 — expected $2, got $3"; FAILURES=$((FAILURES+1)); fi; }
# OWNER_ID and MEMBER_ID, once captured below, become the EXPECTED side of every `expect` that
# names them — and `expect` only counts a mismatch, it never stops the run. An empty id there would
# make each of those checks compare "" against whatever `log_field` returns, which PASSES if
# `log_field` is also broken (issue #127) rather than failing on its own badly-shaped expected
# value — the empty-vs-empty trap the self-check above guards against, still open if the id itself
# were ever captured as "". This is a hard stop, not another `expect`, so a bad id ends the run with
# one named reason instead of surfacing as a run of unrelated-looking FAILs further down.
require_id() { [ -n "$1" ] || { echo "$2 came back empty — every check below that expects it would compare '' against another value, possibly also ''. Aborting rather than let that happen quietly."; exit 1; }; }
# Whether the input has a match, reading ALL of it. `grep -q` stops at the first match and closes the
# pipe, and under `pipefail` the writer it left behind — usually curl, mid-page — then fails with a
# write error (curl's 23, or 141 for SIGPIPE) that becomes the pipeline's status. It depends on how
# much is still unwritten, so it passes on one machine and fails on the next, reporting "expected
# 0, got 23" about a page that has what was looked for. Never `| grep -q` here.
has() { grep "$@" >/dev/null; }
# The value of one field on the LAST line naming this event, in the given log file — a bare `null`
# comes back as the literal string "null", so a caller compares it like any other value. Exists
# because "the e-mail is gone and something p_-shaped is there" is a shape check: it passes just as
# well when person and by are swapped, or when the id belongs to a different person entirely. This
# reads the exact value so a test can assert whose id it is, not merely that it looks like one.
# `-E` and an unescaped `|` (extended alternation), never `\|` in a basic regex — see the
# portability list below: BSD sed treats `\|` as a literal pipe character, so the pattern never
# matches and this returns "" on every macOS run rather than failing loudly. `-E` is accepted by
# both BSD and GNU sed, unlike `-r`, which GNU has and BSD does not.
log_field() { grep "\"event\":\"$2\"" "$1" | tail -1 | sed -E -n "s/.*\"$3\":(\"[^\"]*\"|null).*/\1/p" | tr -d '"'; }

# ----------------------------------------------------------------------------- portable, on purpose
# This runs on a developer's macOS or Windows laptop and on CI's Linux, and the three do not ship
# the same tools. Anything below that looks long-winded is avoiding a construct one of them lacks:
#
#   `head -n -1`  is GNU. BSD head refuses a negative count, the variable comes back EMPTY, and
#                 every check that reads it fails in a cascade that names nothing. `sed '$d'` is
#                 POSIX and does the same.
#   `timeout`     is GNU coreutils. macOS and Git Bash do not have it; `run_for` below is the same
#                 idea with a background job and a watchdog.
#   `\|` in a BRE is a GNU extension. BSD sed treats `\|` in a BASIC regex as a literal pipe
#                 character rather than "or", so the pattern never matches and the command returns
#                 EMPTY instead of erroring — the same silent-empty failure shape as `head -n -1`
#                 above, and the one `log_field` hit (issue #127). Use `sed -E` with an unescaped
#                 `|` instead: accepted by both BSD and GNU sed, unlike `-r`, which BSD lacks.
#   brace lists   are expanded out of JSON bodies by bash 3.2 — see `set +B` at the top.
#   fixed /tmp    names collide when two people, or two agents, run this at once — one run reads the
#                 other's log and the assertions about the password move. Every file is a
#                 `mktemp`, so each run owns its own.
#
# The rule for anything added here: if a command only exists on one of the three, it is a bug, even
# while the suite is green on the other two.

# A one-time proof that `log_field` actually reads a value, run before anything else in this file —
# no server, no request, nothing that could itself be the reason a later check fails. Issue #127:
# the `\|`-in-a-BRE break above made `log_field` return "" for every field on macOS, and every
# `expect "…" "$OWNER_ID" "$(log_field …)"` later in this file then compared an empty string with
# an empty string and passed, about 15 of them, having checked nothing. Feeding it a known line here
# and aborting loudly if the known value does not come back is what makes that failure shape
# impossible to repeat quietly — a future regression stops the run with a named reason instead of
# leaking into "all good" by way of two empty strings agreeing.
SELF_CHECK_LOG=$(mktemp)
printf '{"severity":"INFO","event":"self_check","time":"now","person":"p_deadbeef00000000000000","by":null}\n' >"$SELF_CHECK_LOG"
SELF_CHECK_QUOTED=$(log_field "$SELF_CHECK_LOG" self_check person)
SELF_CHECK_NULL=$(log_field "$SELF_CHECK_LOG" self_check by)
rm -f "$SELF_CHECK_LOG"
if [ "$SELF_CHECK_QUOTED" != "p_deadbeef00000000000000" ] || [ "$SELF_CHECK_NULL" != "null" ]; then
  echo "log_field self-check FAILED — it must read a quoted value and a bare null from a known line."
  echo "  quoted field 'person': expected p_deadbeef00000000000000, got '$SELF_CHECK_QUOTED'"
  echo "  null field 'by':       expected null, got '$SELF_CHECK_NULL'"
  echo "  this is the failure issue #127 describes: a sed that returns empty instead of matching,"
  echo "  which every check further down would then read as a vacuous pass. Not running the rest."
  exit 1
fi

# Runs a command with a deadline, and returns its exit code — or 124 when the deadline hit, the
# same number `timeout` uses.
#
# ⚠️ `pkill -P` is the detail. Killing the watchdog is not enough: the `sleep` it forked outlives
# it, and that orphan still holds the stdout it inherited — so inside a `$(...)` the substitution
# waits for every holder of the pipe, and a command that exits at once still costs the caller the
# whole deadline, a slower suite with nothing to say why. Taking the child with the parent ends both
# problems, and nothing is left running after the script exits.
#
# It is not `timeout` in every respect: GNU signals the whole process group, this signals one pid.
# A command that forks and returns keeps its grandchildren. Both callers here `exec` or are simple,
# so it holds — say so if you add a third.
run_for() {
  local seconds=$1; shift
  "$@" & local job=$!
  ( sleep "$seconds"; kill -9 "$job" 2>/dev/null ) & local watchdog=$!
  local code=0; wait "$job" 2>/dev/null || code=$?
  pkill -P "$watchdog" 2>/dev/null; kill "$watchdog" 2>/dev/null; wait "$watchdog" 2>/dev/null
  # kill -9 leaves 137; report the deadline as `timeout` would.
  [ "$code" = 137 ] && code=124
  return "$code"
}

# One folder per run. It is removed by the trap further down — NOT here: bash keeps only the last
# EXIT trap, so a `trap ... EXIT` written at this line is silently replaced by the one that stops
# the server, and every run would leave its folder behind, each holding a server log with a
# generated first-access password in it.
WORK=$(mktemp -d)

# A port already in use is the most treacherous failure there is here: the new server dies with
# EADDRINUSE, the old one keeps answering, and the whole suite ends up testing the previous code —
# enough to make a fix that is actually correct look broken, and get it undone. Better not to run
# than to run while lying.
if curl -s -o /dev/null --max-time 2 $B/api/health; then
  echo "port $PORT is already in use — the test would run against ANOTHER server."
  # Whichever of the three is installed. `ss` is Linux, `lsof` is macOS and most Linuxes, and
  # Windows has neither — so this is a hint, never the check itself.
  { ss -ltnp 2>/dev/null | grep ":$PORT " || lsof -nP -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null; } || true
  echo "  kill the process (or run with PORT=another) and try again."
  exit 1
fi
# A server left behind by an interrupted run also breaks the next round.
PID=
# The ONLY EXIT trap in this file. Stop the server and take the run's folder with it.
trap 'kill $PID 2>/dev/null; rm -rf "$WORK"' EXIT INT TERM
post()  { curl -s -o /dev/null -w '%{http_code}' -H "X-Dev-Email: $1" -H 'Content-Type: application/json' -d "$2" $B/api/events; }
body() { curl -s -H "X-Dev-Email: $1" -H 'Content-Type: application/json' -d "$2" $B/api/events; }
jfield() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const v=process.argv[1].split('.').reduce((o,k)=>(o===undefined||o===null)?o:o[k],JSON.parse(s));console.log(v===undefined||v===null?'':v)})" "$1"; }
new_request()  { body "$1" "$2" | jfield id; }
state()   { post "$1" "{\"type\":\"request_state\",\"page\":\"D02\",\"text\":\"$4\",\"data\":{\"request\":\"$2\",\"state\":\"$3\"${5:-}}}"; }

# Every server here boots under engine/tests/hooks/forbid-optional.js: Firestore and Postgres are
# optional, and a static import that loads them on the SQLite or memory path fails the boot — the
# only place that proof can live, because nothing short of booting runs the startup imports.
# HOLDRIM_DEV_EMAIL empty on purpose: with `development.actAs` in holdrim.json, a request with no
# header would end up identified — which is the right behaviour for opening the browser, but it
# would hide the test that proves that with NO identity at all the response is 401.
HOLDRIM_MODE=local HOLDRIM_ENVIRONMENT=Development HOLDRIM_OWNER=$OWNER HOLDRIM_ADMINS=$LEAD HOLDRIM_DEV_EMAIL= PORT=$PORT \
  HOLDRIM_SITE="$SITE" HOLDRIM_AGENTS=$AGENT \
  node --import ./engine/tests/hooks/forbid-optional.js engine/api/server.ts >$WORK/tests.log 2>&1 & PID=$!
for i in $(seq 40); do curl -s $B/api/health >/dev/null 2>&1 && break; sleep 0.5; done
echo "boot:"
expect "the server comes up without loading an optional package" 200 "$(curl -s -o /dev/null -w '%{http_code}' $B/api/health)"
grep -q 'optional package was loaded' $WORK/tests.log && grep -m1 'optional package was loaded' $WORK/tests.log | sed 's/^/       /'

echo "identity and roles:"
expect "no identity → 401"             401 "$(curl -s -o /dev/null -w '%{http_code}' $B/api/events)"
expect "owner is owner"                owner "$(curl -s -H "X-Dev-Email: $OWNER" $B/api/me | jfield role)"
expect "reviewer is a member"          member "$(curl -s -H "X-Dev-Email: $REVIEWER" $B/api/me | jfield role)"
# What /api/me?page=$2&blocks=$3 says $1 may do on block $3, as "triage approve", or "none" when the
# answer leaves the block out. Its own reader because `jfield` splits its path on ".", and every
# block id holds one. The panel names the blocks it draws, and the server answers exactly those.
may_on() { curl -s -H "X-Dev-Email: $1" "$B/api/me?page=$2&blocks=$3" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const b=JSON.parse(s).here?.blocks?.[process.argv[1]];console.log(b?b.triage+' '+b.approve:'none')})" "$3"; }
echo "what each person may do here (#33, docs/ROLES.md section 2):"
expect "the owner may triage and approve this block"   "true true"   "$(may_on $OWNER A01 A01.1.1)"
expect "an admin may too"                              "true true"   "$(may_on $LEAD A01 A01.1.1)"
expect "a member may neither"                          "false false" "$(may_on $REVIEWER A01 A01.1.1)"
expect "nor may an agent"                              "false false" "$(may_on $AGENT A01 A01.1.1)"
expect "a block the site does not read is answered too" "true true"  "$(may_on $OWNER Y01 Y01.1.1)"
expect "but no block of another page"                  none          "$(may_on $OWNER A01 A02.1.2)"
expect "nor an id no event could name"                 none          "$(may_on $OWNER A01 'A01.1%2F1')"
expect "and what was left out is not echoed back"      1 "$(curl -s -H "X-Dev-Email: $OWNER" "$B/api/me?page=A01&blocks=A02.1.2,A01.%3Cx%3E" | has -e 'A02.1.2' -e '<x>'; echo $?)"
expect "2000 ids are answered"                         200 "$(curl -s -o /dev/null -w '%{http_code}' -H "X-Dev-Email: $OWNER" "$B/api/me?page=A01&blocks=$(node -e "console.log(Array(2000).fill('x').join(','))")")"
expect "2001 ids → 400"                                400 "$(curl -s -o /dev/null -w '%{http_code}' -H "X-Dev-Email: $OWNER" "$B/api/me?page=A01&blocks=$(node -e "console.log(Array(2001).fill('x').join(','))")")"
expect "the page itself: a member may ask for a change" "true false" \
  "$(curl -s -H "X-Dev-Email: $REVIEWER" "$B/api/me?page=A01" | jfield here.may.request) $(curl -s -H "X-Dev-Email: $REVIEWER" "$B/api/me?page=A01" | jfield here.may.triage)"
expect "there is no answer about everywhere any more"  "" "$(curl -s -H "X-Dev-Email: $OWNER" "$B/api/me?page=A01" | jfield canApprove)$(curl -s -H "X-Dev-Email: $OWNER" "$B/api/me?page=A01" | jfield canTriage)"
expect "and no here without a page"                    "" "$(curl -s -H "X-Dev-Email: $OWNER" $B/api/me | jfield here)"
expect "a page that is not a page code → 400"          400 "$(curl -s -o /dev/null -w '%{http_code}' -H "X-Dev-Email: $OWNER" "$B/api/me?page=%3Cscript%3E")"
expect "and what was sent is not echoed back"          1 "$(curl -s -H "X-Dev-Email: $OWNER" "$B/api/me?page=%3Cscript%3E" | has -F '<script>'; echo $?)"
expect "an empty page → 400 too"                       400 "$(curl -s -o /dev/null -w '%{http_code}' -H "X-Dev-Email: $OWNER" "$B/api/me?page=")"

echo "approval:"
expect "reviewer does NOT approve → 403" 403 "$(post $REVIEWER '{"type":"approval","page":"D01","block":"D01.1.4","fingerprint":"abc123"}')"
expect "owner approves → 201"          201 "$(post $OWNER '{"type":"approval","page":"D01","block":"D01.1.4","fingerprint":"abc123"}')"
expect "approval without fingerprint → 400" 400 "$(post $OWNER '{"type":"approval","page":"D01","block":"D01.1.4"}')"
expect "unknown type → 400"            400 "$(post $OWNER '{"type":"delete","page":"D01"}')"
# text_removed is written only by EventStore.removeText, in the same transaction as the row it
# deletes (engine/api/texts.ts) — never by this general path, even signed in as the owner: a route
# that accepted it could claim a removal with nothing to back it, no row actually gone.
expect "text_removed via POST /events → 400, even as the owner" 400 "$(post $OWNER '{"type":"text_removed","page":"D01","data":{"event":"x","field":"text"}}')"
# lock_baseline is written only by ensureLockBaseline, at boot, from HOLDRIM_OWNER — never by a
# client (round 2's review, M-3): a member's own POST could otherwise plant a baseline naming
# themselves as its author, and every one of their unwritten future ✓s would read as a lock.
expect "lock_baseline via POST /events → 400, even from a member" 400 "$(post $REVIEWER '{"type":"lock_baseline","page":"A01"}')"
# A body that parses as JSON but does not say so is what a form on another site can send without the
# browser asking first. Refused before it is read, whoever it claims to come from.
expect "an approval sent as text/plain → 415" 415 "$(curl -s -o /dev/null -w '%{http_code}' -H "X-Dev-Email: $OWNER" -H 'Content-Type: text/plain' -d '{"type":"approval","page":"D01","block":"D01.1.9","fingerprint":"forged"}' $B/api/events)"
expect "and nothing was recorded"      1 "$(curl -s -H "X-Dev-Email: $OWNER" "$B/api/events?page=D01" | has 'forged'; echo $?)"

echo "limits:"
LARGE=$(node -e "console.log('x'.repeat(500))")
expect "giant block → 400"             400 "$(post $OWNER "{\"type\":\"approval\",\"page\":\"D01\",\"block\":\"$LARGE\",\"fingerprint\":\"a\"}")"
expect "invalid page → 400"            400 "$(post $OWNER '{"type":"comment","page":"../etc","text":"hi"}')"
expect "UC-01 is a valid page → 201"   201 "$(post $OWNER '{"type":"comment","page":"UC-01","text":"hi"}')"
# The error has to say WHICH field overflowed, not just "field too big": with seven limits, a
# generic message forces whoever called it to guess.
expect "error says WHICH field"        0 "$(body $OWNER "{\"type\":\"comment\",\"page\":\"D01\",\"text\":\"hi\",\"snapshot\":\"$(node -e "console.log('y'.repeat(20001))")\"}" | has -i snapshot; echo $?)"

echo "request cycle:"
P=$(new_request $REVIEWER '{"type":"request","page":"D02","block":"D02.1.1","fingerprint":"x","text":"change term","snapshot":"the earlier text"}')
expect "reviewer can't triage → 403"   403 "$(state $REVIEWER $P approved 'x')"
expect "reject without a reason → 400" 400 "$(state $OWNER $P rejected '')"
expect "owner rejects → 201"           201 "$(state $OWNER $P rejected 'does not say where')"
expect "rejected → approved → 201"     201 "$(state $OWNER $P approved 'reviewed')"
expect "approved doesn't go back → 409" 409 "$(state $OWNER $P rejected 'changed my mind')"
expect "applied without a commit → 400" 400 "$(state agent@test $P applied 'done')"
expect "applied with a commit → 201"   201 "$(state agent@test $P applied 'done' ',"commit":"abc1234"')"
# A bug report enters as a request like any other — the category is the only difference (docs/BUGS.md).
# The check is here and not only in the unit tests because the category crosses the whole edge: the
# JSON body, the limits on `data`, and the record.
expect "a request categorised as bug → 201" 201 "$(post $REVIEWER '{"type":"request","page":"D02","block":"D02.1.3","fingerprint":"x","text":"the screen does not do what this block says","snapshot":"the earlier text","data":{"category":"bug"}}')"
# A category outside cycle.json's own list is refused before it can silently side-step a toggle:
# `data.category` is compared by exact string in `gatingFeatureOf`, so "Bug" or "page " would
# otherwise reach the store as an ungated category, never having asked the bugCategory/pageRequests
# gate the right spelling would have.
expect "an unknown category → 400"    400 "$(post $REVIEWER '{"type":"request","page":"D02","text":"x","data":{"category":"Bug"}}')"
expect "and the message names it"       0 "$(body $REVIEWER '{"type":"request","page":"D02","text":"x","data":{"category":"Bug"}}' | has 'Bug'; echo $?)"
# MINOR 6: a single-element JSON array stringifies to exactly its element (`String(['bug']) ===
# 'bug'`), so a body naming `"category":["bug"]` used to pass the OLD check — which asked
# `String(category)`, never `typeof category`. The STATUS alone does not prove the fix: overLimit's
# unrelated "a data value has to be text or a number" check refuses an array too, further down, so a
# check that only asked for 400 would still pass with the typeof check deleted — refused for the
# wrong reason, by a check that has nothing to do with categories. The MESSAGE says which one fired:
# only the category check, run BEFORE overLimit, says "unknown request category".
expect "a category smuggled as an array is refused AS AN UNKNOWN CATEGORY, not merely as non-scalar" 0 \
  "$(body $REVIEWER '{"type":"request","page":"D02","text":"x","data":{"category":["bug"]}}' | has 'unknown request category'; echo $?)"
# And the 400 body itself stays small: an unbounded category echoed whole is how a 200 KB category
# once became a 200 KB error body.
BIGCAT=$(node -e "console.log('x'.repeat(5000))")
expect "an oversized category is truncated in the error, not echoed whole" 0 \
  "$(body $REVIEWER "{\"type\":\"request\",\"page\":\"D02\",\"text\":\"x\",\"data\":{\"category\":\"$BIGCAT\"}}" \
    | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).error.length < 100 ? 0 : 1))")"
# The race guard is written INTO the record: `from` names the state the change departed from.
expect "the record says where it came from" approved "$(curl -s -H "X-Dev-Email: $OWNER" "$B/api/events?page=D02" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const e=JSON.parse(s).filter(x=>x.type==='request_state').pop();console.log(e.data.from)})")"

echo "a request from someone who can approve is born approved:"
P2=$(new_request $OWNER '{"type":"request","page":"D02","block":"D02.2.1","fingerprint":"x","text":"my request"}')
expect "already born approved → 409"   409 "$(state $OWNER $P2 approved 'redundant')"
expect "the agent applies directly → 201" 201 "$(state agent@test $P2 applying 'looking')"

echo "status calculated by the server:"
expect "owner's request: applying"     applying "$(curl -s -H "X-Dev-Email: $OWNER" "$B/api/events?page=D02" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const e=JSON.parse(s).find(x=>x.type==='request'&&x.author===process.env.OWNER);console.log(e.status.state)})")"
expect "empty triage when approved"    0 "$(curl -s -H "X-Dev-Email: $OWNER" "$B/api/events?page=D02" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const e=JSON.parse(s).find(x=>x.type==='request'&&x.author===process.env.OWNER);console.log(e.status.triage.length)})")"
expect "the open count says what is left" 1 "$(curl -s -H "X-Dev-Email: $OWNER" $B/api/requests/open | jfield toTriage)"
P3=$(new_request $REVIEWER '{"type":"request","page":"D03","block":"D03.1.1","fingerprint":"x","text":"still open"}')
expect "and counts a request nobody triaged" 2 "$(curl -s -H "X-Dev-Email: $OWNER" $B/api/requests/open | jfield toTriage)"

echo "adding detail to a request:"
# Without these checks, removing the rule on who may add detail would leave every test green:
# nothing else here sends a supplement. Only who asked, or someone who can approve, adds to a request, and only while it is
# still being decided — past that, a change is a new request, not a footnote nobody will read.
P4=$(new_request $REVIEWER '{"type":"request","page":"D03","block":"D03.1.2","fingerprint":"x","text":"needs an example"}')
detail() { post "$1" "{\"type\":\"supplement\",\"page\":\"$2\",\"text\":\"one more thing\",\"data\":{\"request\":\"$3\"}}"; }
expect "someone else adds detail → 403"          403 "$(detail stranger@example.org D03 $P4)"
expect "the requester adds detail → 201"         201 "$(detail $REVIEWER D03 $P4)"
expect "the owner adds detail → 201"             201 "$(detail $OWNER D03 $P4)"
expect "detail on an applied request → 409"      409 "$(detail $REVIEWER D02 $P)"
expect "detail naming no request → 400"          400 "$(post $REVIEWER '{"type":"supplement","page":"D03","text":"x"}')"
expect "detail on another page's request → 404"  404 "$(detail $REVIEWER D01 $P4)"

echo "contract and site:"
ID=$(new_request $OWNER '{"type":"comment","page":"D01","text":"find by id"}')
expect "GET /api/events/{id} → 200"    200 "$(curl -s -o /dev/null -w '%{http_code}' -H "X-Dev-Email: $OWNER" $B/api/events/$ID)"
expect "nonexistent id → 404"          404 "$(curl -s -o /dev/null -w '%{http_code}' -H "X-Dev-Email: $OWNER" $B/api/events/doesnotexist)"
expect "static site serves"            200 "$(curl -s -o /dev/null -w '%{http_code}' $B/pages/A01.html)"
# A page is where the owner clicks ✓, so it is the clickjacking target as much as the sign-in
# screen below. Checking only that screen's header would leave the suite green with the one every
# page gets emptied.
expect "and it refuses to be framed"     1 "$(curl -s -D- -o /dev/null $B/pages/A01.html | grep -ci "frame-ancestors 'none'")"
expect "the engine's own files serve"  200 "$(curl -s -o /dev/null -w '%{http_code}' $B/engine/core/fingerprint.js)"
# Its own prefix check, apart from the site's: without it an escaped `..` walks from engine/core up
# to the repository root and serves whatever is there, package.json and all. Without this check,
# removing it would leave every test green.
expect "and cannot be walked out of"     404 "$(curl -s -o /dev/null -w '%{http_code}' --path-as-is "$B/engine/core/%2e%2e%2f%2e%2e%2fpackage.json")"
expect "root redirects"                302 "$(curl -s -o /dev/null -w '%{http_code}' $B/)"
# And to something that answers: the example names the home by its path, and a renamed route would
# otherwise leave the root redirecting to a 404.
expect "and the root leads to a page that answers" 200 "$(curl -s -L -o /dev/null -w '%{http_code}' -H "X-Dev-Email: $OWNER" $B/)"
# Behind an identity proxy people live in the proxy: the screen does not exist, even for the owner.
expect "no people screen without password sign-in" 0 "$(curl -s -D- -o /dev/null -H "X-Dev-Email: $OWNER" $B/engine/people | has -i 'location: /engine/home'; echo $?)"
# Node's `new URL()` already normalizes `../`, so this vector arrives as /etc/passwd and returns 404
# (it doesn't leak, but for a different reason). What the prefix guard actually catches is the
# ENCODED `..`, which survives parsing and only becomes `..` at decodeURIComponent.
expect "encoded traversal → 403"       403 "$(curl -s -o /dev/null -w '%{http_code}' --path-as-is "$B/%2e%2e%2f%2e%2e%2fetc/passwd")"
expect "raw traversal doesn't leak"    404 "$(curl -s -o /dev/null -w '%{http_code}' --path-as-is $B/pages/../../../etc/passwd)"
# ⚠️ Behind an identity proxy there is no user store at all — who exists is the proxy's directory.
# Answering here would invent a second, empty source of truth for who works at the company, and an
# empty list of people is the kind of screen somebody believes.
expect "no user store, no management → 405" 405 "$(curl -s -o /dev/null -w '%{http_code}' -H "X-Dev-Email: $OWNER" $B/api/users)"

# ----------------------------------------------------------------------------- what the person reads
# Two things are asserted here, and neither is provable by unit test: that the field is called
# `error` everywhere, and that the sentence inside it arrives in the language the reader asked for.
echo "fingerprints of blocks on other pages:"
# The panel computes its own page's fingerprints; one it depends on elsewhere comes from here, and
# has to be the same number the CLI computes from the same file.
cli_fingerprint() { node --input-type=module -e "const { readBlocks } = await import('./engine/cli/pages.ts'); console.log((await readBlocks(process.argv[1])).get(process.argv[2]).fingerprint)" "$SITE" "$1"; }
FP_WANT=$(cli_fingerprint A02.1.1)
FP_GOT=$(curl -s -H "X-Dev-Email: $REVIEWER" "$B/api/fingerprints?ids=A02.1.1,NOPE.1.1")
# By key, not through jfield: a block id is full of dots, and jfield reads dots as a path.
fp_of() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s)[process.argv[1]] ?? ''))" "$1"; }
expect "a block elsewhere → the CLI's own fingerprint" "$FP_WANT" "$(echo "$FP_GOT" | fp_of A02.1.1)"
# Left out, not answered with null: `?? ''` would read both the same, and a key that is there says
# the server knows a block it does not.
expect "and one that does not exist is left out" false "$(echo "$FP_GOT" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(Object.hasOwn(JSON.parse(s),'NOPE.1.1')))")"
# A page that depends on many blocks elsewhere gets every one: an id dropped on the way would read
# as vanished, and paint red a dependency that never moved.
MANY=$(node -e "console.log([...Array(600)].map((_, i) => 'X' + i + '.1.1').concat('A02.1.1').join(','))")
expect "the 601st id is answered like the first" "$FP_WANT" "$(curl -s -H "X-Dev-Email: $REVIEWER" "$B/api/fingerprints?ids=$MANY" | fp_of A02.1.1)"
expect "and nobody unknown asks → 401" 401 "$(curl -s -o /dev/null -w '%{http_code}' "$B/api/fingerprints?ids=A02.1.1")"

echo "the impact radius, from the same walk if-i-touch uses:"
# The hello world declares no dependency at all, so the only thing this proves over HTTP is the
# wiring — the route exists, answers 200, shapes its answer as {ids:[...]}, and is behind the same
# auth as every other block-reading route. The walk ITSELF, including going past one hop, is
# engine/tests/validity.test.js's job (`radiusOf`), which does not need a server to prove.
expect "a block nothing depends on → empty, not missing" '{"ids":[]}' \
  "$(curl -s -H "X-Dev-Email: $REVIEWER" "$B/api/impact-radius?id=A01.1.1")"
expect "a block that does not exist → empty too, never an error" '{"ids":[]}' \
  "$(curl -s -H "X-Dev-Email: $REVIEWER" "$B/api/impact-radius?id=NOPE.1.1")"
expect "and nobody unknown asks → 401" 401 "$(curl -s -o /dev/null -w '%{http_code}' "$B/api/impact-radius?id=A01.1.1")"

echo "the documentation graph (#38), the same computation holdrim graph prints:"
# graphOf ITSELF is holdrim graph's own function (engine/cli/graph.ts); its cases are already proved
# without a server by engine/tests/graph.test.js. What a server has to prove, and only a server can,
# is that this route calls that SAME function rather than a second walk of the same pages, and that
# it sits behind the same session check as every other block-reading route.
CLI_GRAPH_STATES=$(node --input-type=module -e "
  const { readBlocks } = await import('./engine/cli/pages.ts');
  const { loadRegistry } = await import('./engine/cli/validation.ts');
  const { graphOf } = await import('./engine/cli/graph.ts');
  const blocks = await readBlocks(process.argv[1]);
  const registry = loadRegistry(process.argv[1]);
  console.log(JSON.stringify(graphOf(blocks, registry).nodes.map((n) => [n.id, n.state]).sort()));
" "$SITE")
API_GRAPH_STATES=$(curl -s -H "X-Dev-Email: $REVIEWER" "$B/api/graph" | node -e "
  let s='';process.stdin.on('data',d=>s+=d).on('end',()=>
    console.log(JSON.stringify(JSON.parse(s).nodes.map((n) => [n.id, n.state]).sort())))")
expect "the route's nodes are graphOf's own, not a second walk"  "$CLI_GRAPH_STATES" "$API_GRAPH_STATES"
expect "a real block gets a link to open, page and anchor both" 0 \
  "$(curl -s -H "X-Dev-Email: $REVIEWER" "$B/api/graph" | has -F '"href":"/pages/A01.html#A01.1.1"'; echo $?)"
expect "and nobody unknown asks → 401" 401 "$(curl -s -o /dev/null -w '%{http_code}' "$B/api/graph")"

echo "the home counts only the owner's ✓ as waiting for the repository:"
# An admin's ✓ is recorded and stays an opinion: `holdrim sync` brings in the owner's alone. Counted
# on the home as "approved on the site", it would tell the owner a lock is one sync away when the
# sync brings in nothing. Without these checks, dropping that filter would leave every test green.
FP_NEXT=$(cli_fingerprint A02.1.2)
waiting() { curl -s -H "X-Dev-Email: $OWNER" -H 'Accept-Language: en' $B/engine/home | has -F 'not yet in the repository'; echo $?; }
expect "nothing waits before anyone approves"  1 "$(waiting)"
expect "an admin approves the current text → 201" 201 "$(post $LEAD "{\"type\":\"approval\",\"page\":\"A02\",\"block\":\"A02.1.2\",\"fingerprint\":\"$FP_NEXT\"}")"
expect "and the home does not count it"        1 "$(waiting)"
expect "the owner approves the same text → 201" 201 "$(post $OWNER "{\"type\":\"approval\",\"page\":\"A02\",\"block\":\"A02.1.2\",\"fingerprint\":\"$FP_NEXT\"}")"
expect "and now it waits for the repository"   0 "$(waiting)"
# The panel paints only the lock green, and it learns which ✓ is the lock from here: it does not
# know who the owner is, and must not decide it a second way.
locks_of() { curl -s -H "X-Dev-Email: $OWNER" "$B/api/events?page=A02" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).filter(e=>e.type==='approval'&&e.block==='A02.1.2'&&e.author===process.argv[1]).map(e=>e.locks).join(' ')))" "$1"; }
expect "the admin's ✓ is read as no lock"      false "$(locks_of $LEAD)"
expect "and the owner's as the lock"           true "$(locks_of $OWNER)"
LEAD_ID=$(curl -s -H "X-Dev-Email: $OWNER" "$B/api/events?page=A02" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).find(e=>e.type==='approval'&&e.author===process.argv[1]).id))" "$LEAD")
expect "one event read alone says the same"   false "$(curl -s -H "X-Dev-Email: $OWNER" $B/api/events/$LEAD_ID | jfield locks)"

echo "the server writes the lock and a request's own capability itself, never the client's (round 1's review, finding 1):"
# A member holds no 'approve' at all, so the strongest forgery worth proving is an ADMIN's: their ✓ is
# recorded but never a lock, and a forged "locks":"true" in the body must be OVERWRITTEN, not merged
# in after it — a spread in the wrong order would let it through, and nothing above would notice.
FORGED_APPROVAL=$(body $LEAD '{"type":"approval","page":"A02","block":"A02.1.3","fingerprint":"forged","data":{"locks":"true"}}')
expect "an admin's forged locks:true is overwritten by the server"        false "$(echo "$FORGED_APPROVAL" | jfield data.locks)"
expect "and the served .locks agrees: still no lock"                     false \
  "$(curl -s -H "X-Dev-Email: $OWNER" $B/api/events/$(echo "$FORGED_APPROVAL" | jfield id) | jfield locks)"
# Anyone who may file a request at all (a member included) can shape the body; a forged
# "authorCouldTriage":"true" must not let their own request start pre-approved.
FORGED_REQUEST=$(body $REVIEWER '{"type":"request","page":"A02","text":"a forged request","data":{"authorCouldTriage":"true"}}')
expect "a member's forged authorCouldTriage is overwritten by the server" false "$(echo "$FORGED_REQUEST" | jfield data.authorCouldTriage)"
expect "and it starts at triage like any other"                          open "$(curl -s -H "X-Dev-Email: $OWNER" "$B/api/events/$(echo "$FORGED_REQUEST" | jfield id)" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).status.state))")"

echo "an agent is marked on what it writes, and never approves (docs/ROLES.md, section 4):"
# `data.asAgent` comes from who the server saw, on every event: a comment is the plainest thing an
# agent may write, and the one no other written field (`locks`, `authorCouldTriage`) rides along on.
AGENT_COMMENT=$(body $AGENT '{"type":"comment","page":"A02","text":"this change did not reach here"}')
expect "an agent may comment → and it is marked as an agent's"          true "$(echo "$AGENT_COMMENT" | jfield data.asAgent)"
expect "a person's comment is marked as not an agent's"                  false \
  "$(body $REVIEWER '{"type":"comment","page":"A02","text":"a person"}' | jfield data.asAgent)"
# Spread in the wrong order, a client's own field would win: both directions are forgeries worth
# refusing — a person passing as the agent, and the agent passing as a person.
expect "a person's forged asAgent:true is overwritten"                   false \
  "$(body $REVIEWER '{"type":"comment","page":"A02","text":"forged","data":{"asAgent":"true"}}' | jfield data.asAgent)"
expect "the agent's forged asAgent:false is overwritten"                 true \
  "$(body $AGENT '{"type":"comment","page":"A02","text":"forged","data":{"asAgent":"false"}}' | jfield data.asAgent)"
expect "the agent's own request is marked too"                           true \
  "$(body $AGENT '{"type":"request","page":"A02","text":"from the agent"}' | jfield data.asAgent)"
expect "an agent gives no ✓ → 403"                                       403 \
  "$(post $AGENT '{"type":"approval","page":"A02","block":"A02.1.3","fingerprint":"abc123"}')"
expect "and /api/me offers it none"                                      "false false" \
  "$(curl -s -H "X-Dev-Email: $AGENT" "$B/api/me?page=A02" | jfield here.may.approve) $(curl -s -H "X-Dev-Email: $AGENT" "$B/api/me?page=A02" | jfield here.may.triage)"

echo "asking for a page from the home:"
# A plain form, no script: what a person who is not a developer uses to say "this is missing". It
# goes through the same checks as the API, and the author is whoever is signed in, never a field.
ask() { curl -s -o /dev/null -w '%{http_code} %{redirect_url}' -H "X-Dev-Email: $REVIEWER" "$@" $B/engine/home; }
expect "a plain form post → 303, back home" "303 $B/engine/home?asked=1#home-ask" "$(ask -H "Origin: $B" --data-urlencode page=A01 --data-urlencode 'text=Explain how a day is closed')"
expect "and it is a request for a new page, by whoever is signed in" 1 "$(curl -s -H "X-Dev-Email: $OWNER" "$B/api/events?page=A01" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).filter(e=>e.type==='request'&&e.data?.category==='page'&&e.author===process.argv[1]&&e.block==null&&e.text==='Explain how a day is closed').length))" "$REVIEWER")"
expect "and the home lists it"          0 "$(curl -s -H "X-Dev-Email: $OWNER" $B/engine/home | has -F 'Explain how a day is closed'; echo $?)"
expect "a post from another site → 403" "403 " "$(ask -H 'Origin: https://elsewhere.example' --data-urlencode page=A01 --data-urlencode 'text=forged')"
expect "and one that names no origin → 403" "403 " "$(ask --data-urlencode page=A01 --data-urlencode 'text=from nowhere')"
expect "an empty text → 400, on the home itself" "400 " "$(ask -H "Origin: $B" --data-urlencode page=A01 --data-urlencode 'text= ')"
expect "a page that is not a page → 400" "400 " "$(ask -H "Origin: $B" --data-urlencode 'page=../x' --data-urlencode 'text=anything')"
# Without a name, nothing: every event carries its author forever, and one without is never erased.
expect "nobody signed in → 401" "401 " "$(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' -H "Origin: $B" --data-urlencode page=A01 --data-urlencode 'text=from nobody' $B/engine/home)"

echo "deciding from the home:"
# The same decision the panel takes, from a plain form on the home — and through the same checks
# as the API, so who decides, whether a reason is needed and where a request can go are one rule.
H=$(new_request $REVIEWER '{"type":"request","page":"H01","block":"H01.1.1","fingerprint":"x","text":"decide me from the home"}')
decide() { curl -s -o /dev/null -w '%{http_code} %{redirect_url}' -H "X-Dev-Email: $1" -H "Origin: $B" \
  --data-urlencode action=triage --data-urlencode "request=$2" --data-urlencode page=H01 --data-urlencode block=H01.1.1 \
  --data-urlencode "state=$3" --data-urlencode "reason=${4:-}" $B/engine/home; }
expect "the owner sees a form for it"        0 "$(curl -s -H "X-Dev-Email: $OWNER" $B/engine/home | has -F "name=\"request\" value=\"$H\""; echo $?)"
expect "a reviewer sees none"                1 "$(curl -s -H "X-Dev-Email: $REVIEWER" $B/engine/home | has -F 'value="triage"'; echo $?)"
expect "a reviewer deciding anyway → 403"    "403 " "$(decide $REVIEWER "$H" approved)"
expect "a refusal with no reason → 400"      "400 " "$(decide $OWNER "$H" rejected)"
expect "the owner decides → 303, back home"  "303 $B/engine/home?decided=1#home-requests" "$(decide $OWNER "$H" approved)"
expect "recorded as the owner's triage, from where it was" "$OWNER open approved" "$(curl -s -H "X-Dev-Email: $OWNER" "$B/api/events?page=H01" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const e=JSON.parse(s).find(x=>x.type==='request_state'&&x.data.request===process.argv[1]);console.log(e?[e.author,e.data.from,e.data.state].join(' '):'none')})" "$H")"
expect "and deciding it again is refused → 409" "409 " "$(decide $OWNER "$H" approved)"
# The form's own `block` is the client's to write: the decision is judged on where the STORED
# request is (#33). With the shipped roles, unscoped, a forged block changes nobody's answer — the
# stubbed roles of engine/tests/here.test.js prove it is the stored one that is asked — so what this
# proves end to end is that a forged block neither lets a member in nor keeps the owner out.
H2=$(new_request $REVIEWER '{"type":"request","page":"H01","block":"H01.1.1","fingerprint":"x","text":"decide me with a forged block"}')
decide_forged() { curl -s -o /dev/null -w '%{http_code} %{redirect_url}' -H "X-Dev-Email: $1" -H "Origin: $B" \
  --data-urlencode action=triage --data-urlencode "request=$2" --data-urlencode page=H01 --data-urlencode block=A01.1.1 \
  --data-urlencode "state=$3" --data-urlencode "reason=${4:-}" $B/engine/home; }
expect "a reviewer naming another block → still 403" "403 " "$(decide_forged $REVIEWER "$H2" approved)"
expect "the owner naming another block → decided"    "303 $B/engine/home?decided=1#home-requests" "$(decide_forged $OWNER "$H2" approved)"
expect "a triage list only for whoever may triage it" "1 0" "$(for who in $OWNER $REVIEWER; do curl -s -H "X-Dev-Email: $who" "$B/api/events?page=A02" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).some(e=>e.type==='request'&&e.status.triage.length)?1:0))"; done | tr '\n' ' ' | sed 's/ $//')"

echo "the answer speaks the reader's language:"
say_it() { curl -s -H "X-Dev-Email: $OWNER" -H "Accept-Language: $1" "${@:2}"; }
# The panel draws itself in the language this answer names, so it is decided here, by the same
# rule as every other sentence: the person's own choice first, then the browser.
expect "who am I says which language to speak"     pt-BR "$(say_it pt-BR $B/api/me | jfield language)"
expect "and the panel can fetch that dictionary" 200 "$(curl -s -o /dev/null -w '%{http_code}' $B/engine/locales/pt-BR.json)"
expect "and the person's own choice beats the browser" es "$(curl -s -H "X-Dev-Email: $OWNER" -H 'Accept-Language: pt-BR' -H 'Cookie: holdrim_language=es' $B/api/me | jfield language)"
expect "the error field is called error"  0 "$(say_it en $B/api/events/doesnotexist | has '"error"'; echo $?)"
expect "a nonexistent event, in English"  0 "$(say_it en    $B/api/events/doesnotexist | has 'event not found'; echo $?)"
expect "the same one, in Portuguese"      0 "$(say_it pt-BR $B/api/events/doesnotexist | has 'evento não encontrado'; echo $?)"
expect "the same one, in Spanish"         0 "$(say_it es    $B/api/events/doesnotexist | has 'evento no encontrado'; echo $?)"
# A route that does not exist: 405, and a sentence, not a stack trace.
expect "a route nobody wrote, in English" 0 "$(say_it en -X DELETE $B/api/events | has 'no such method or route'; echo $?)"
expect "the same one, in Spanish"         0 "$(say_it es -X DELETE $B/api/events | has 'ese método o esa ruta no existe'; echo $?)"
# A page that is not on disk. Not JSON, and still translated: it is the plainest thing a person
# can be shown, and showing it in the wrong language is a small way of saying nobody was thinking.
expect "a page that isn't there, in Portuguese" "não encontrado" "$(curl -s -H 'Accept-Language: pt-BR' $B/missing.html)"
expect "the same one, in Spanish"         "no encontrado" "$(curl -s -H 'Accept-Language: es' $B/missing.html)"
# ⚠️ `pt-PT` has no dictionary. A near dialect lands on pt-BR rather than falling all the way to
# English: slightly off is closer to right than the wrong language entirely.
expect "pt-PT lands on Portuguese"        0 "$(say_it 'pt-PT,pt;q=0.9' $B/api/events/doesnotexist | has 'evento não encontrado'; echo $?)"
# A language nobody translated is not an error and not a blank page: it is English.
expect "a language nobody has falls back" 0 "$(say_it 'ja-JP' $B/api/events/doesnotexist | has 'event not found'; echo $?)"
# The log is the other audience, and it does NOT follow the reader. Whoever operates greps one
# spelling — so the event name stays English even when the answer above came out in Spanish.
expect "but the log stays English"        0 "$(grep -q '"event":"event_recorded"' $WORK/tests.log; echo $?)"
expect "with the contract values as they are" 0 "$(grep -q '"type":"request_state".*"to":"applied"' $WORK/tests.log; echo $?)"
kill $PID 2>/dev/null; wait $PID 2>/dev/null

# ----------------------------------------------------------------------------- feature toggles
# `npm test` never boots the server (AGENTS.md): `engine/tests/features.test.js` proves
# `readFeatures` validates `holdrim.json` and that no toggle wraps a guard, but not that the SERVER
# actually 403s a `comment` event when `comments: false`. That needs a live process, started twice,
# against projects whose `holdrim.json` disagree about what is on — which is why this lives here and
# not only as a unit test, and why it uses THIS file's own $PORT and the port-in-use guard above,
# rather than a port of its own nobody checks (the stale-server trap AGENTS.md warns about). This
# used to be `scripts/toggle-matrix.sh`, outside every gate; folded in here, `npm test`'s companion
# contract run is the only place it runs, same as every other HTTP check in this file.
echo "feature toggles — every server-gated toggle, off, against something real:"
OFF_SITE="$WORK/off-site"
cp -r "$SITE" "$OFF_SITE"
# ROUND 5: every toggle at the opposite of its default (`everyToggleFlipped`, engine/core/
# features.js), instead of the hand-written four-key literal this used to be — that literal left
# `graph` ON (its default) and `voice`/`sketch` untouched (also their default, `false`), so nothing
# on THIS server ever exercised any of the three in its NON-default state, the exact gap ROUND 4
# closed only on the password server.
node --input-type=module -e '
  const { readFileSync, writeFileSync } = await import("node:fs");
  const { everyToggleFlipped } = await import("./engine/core/features.js");
  const path = process.argv[1];
  const config = JSON.parse(readFileSync(path, "utf8"));
  config.features = everyToggleFlipped();
  writeFileSync(path, JSON.stringify(config, null, 2));
' "$OFF_SITE/holdrim.json"
expect "the derived config turns graph off (on by default)" 0 \
  "$(grep -q '\"graph\": false' "$OFF_SITE/holdrim.json"; echo $?)"
expect "and turns voice on (off by default, not built)" 0 \
  "$(grep -q '\"voice\": true' "$OFF_SITE/holdrim.json"; echo $?)"
expect "and turns sketch on too" 0 \
  "$(grep -q '\"sketch\": true' "$OFF_SITE/holdrim.json"; echo $?)"
HOLDRIM_MODE=local HOLDRIM_ENVIRONMENT=Development HOLDRIM_OWNER=$OWNER HOLDRIM_DEV_EMAIL= PORT=$PORT \
  HOLDRIM_SITE="$OFF_SITE" \
  node --import ./engine/tests/hooks/forbid-optional.js engine/api/server.ts >$WORK/toggles-off.log 2>&1 & PID=$!
for i in $(seq 40); do curl -s $B/api/health >/dev/null 2>&1 && break; sleep 0.5; done
expect "comments OFF: a comment is refused"          403 "$(post $OWNER '{"type":"comment","page":"UC-01","text":"hi"}')"
expect "pageRequests OFF: asking for a page is refused" 403 "$(post $OWNER '{"type":"request","page":"UC-01","text":"a new page","data":{"category":"page"}}')"
expect "bugCategory OFF: a bug report is refused"    403 "$(post $OWNER '{"type":"request","page":"UC-01","text":"broken","data":{"category":"bug"}}')"
# Everything else off must not mean everything off: an ungated category still goes through — S5.
expect "an ungated category still works with the other three off" 201 \
  "$(post $OWNER '{"type":"request","page":"UC-01","text":"still fine","data":{"category":"text"}}')"
# S10: decoration follows the toggle too, on a page nobody's role gates — the OWNER could ask for a
# page either way, so only the toggle explains the form disappearing.
expect "pageRequests OFF: the home has no ask-for-a-page form" 1 \
  "$(curl -s -H "X-Dev-Email: $OWNER" -H 'Accept-Language: en' $B/engine/home | has -F 'Ask for a page'; echo $?)"
# graph OFF (#38, off on THIS server — everyToggleFlipped, above): the home is exactly what it was
# before #38 ever shipped — no section, no script, and a policy that allows none at all. This is the
# other half of the ON proof above; the two together are what "prove both states" (this issue's own
# review) asked for, and neither is provable from the other — a script gated wrong could ship on
# BOTH servers, or on neither, and either mistake would need this exact pairing to show up at all.
GRAPH_OFF_HDR=$(curl -s -H "X-Dev-Email: $OWNER" -D "$WORK/graph-off.h" -o "$WORK/graph-off.html" $B/engine/home; grep -i '^content-security-policy:' "$WORK/graph-off.h")
expect "graph OFF: its policy runs no script at all" 0 \
  "$(echo "$GRAPH_OFF_HDR" | has "default-src 'none'" && ! echo "$GRAPH_OFF_HDR" | has 'script-src'; echo $?)"
expect "graph OFF: and it has none to run"       0 "$(grep -c '<script' "$WORK/graph-off.html")"
expect "graph OFF: and no graph section either"  1 "$(grep -qF 'id="holdrim-graph"' "$WORK/graph-off.html"; echo $?)"
# MINOR (locks): the triage guard's `iap?.localMode && agentState` carve-out is a code path the
# PASSWORD server's own "every toggle OFF" section (further down) never runs, since it never sets
# `HOLDRIM_MODE=local` — so this repeats that check here instead, in local mode, with every toggle
# off, to prove the carve-out for an AGENT state never widens into one for a plain reviewer moving a
# request to `approved`, which is not an agent state at all.
# Filed by the REVIEWER, not the owner: `cycle.json`'s `initial_for_admin` starts an owner's or
# admin's OWN request already at `approved` (they do not triage themselves), which would answer 409
# — "cannot go from approved to approved" — regardless of whether the guard under test refused it.
OFF_P=$(new_request $REVIEWER '{"type":"request","page":"UC-01","text":"local-mode triage check"}')
expect "every toggle off, in local mode: a reviewer moving it to approved → 403" 403 \
  "$(post $REVIEWER "{\"type\":\"request_state\",\"page\":\"UC-01\",\"text\":\"x\",\"data\":{\"request\":\"$OFF_P\",\"state\":\"approved\"}}")"
kill $PID 2>/dev/null; wait $PID 2>/dev/null

echo "feature toggles — one off does not put the others off too:"
# S4: pageRequests and bugCategory each read their OWN key (gatingFeatureOf); a mutant that swaps
# which toggle gates which category survives when a test only ever moves both at once. Here
# pageRequests is off ALONE and bugCategory stays on, so the wrong mapping shows up as one of these
# two failing on the wrong side.
ASYM_SITE="$WORK/asymmetric-site"
cp -r "$SITE" "$ASYM_SITE"
node -e '
  const fs = require("fs");
  const path = process.argv[1];
  const config = JSON.parse(fs.readFileSync(path, "utf8"));
  config.features = { pageRequests: false };
  fs.writeFileSync(path, JSON.stringify(config, null, 2));
' "$ASYM_SITE/holdrim.json"
HOLDRIM_MODE=local HOLDRIM_ENVIRONMENT=Development HOLDRIM_OWNER=$OWNER HOLDRIM_DEV_EMAIL= PORT=$PORT \
  HOLDRIM_SITE="$ASYM_SITE" \
  node --import ./engine/tests/hooks/forbid-optional.js engine/api/server.ts >$WORK/toggles-asym.log 2>&1 & PID=$!
for i in $(seq 40); do curl -s $B/api/health >/dev/null 2>&1 && break; sleep 0.5; done
expect "pageRequests OFF alone: a page request is still refused" 403 \
  "$(post $OWNER '{"type":"request","page":"UC-01","text":"a new page","data":{"category":"page"}}')"
expect "and bugCategory, left on, still works"       201 \
  "$(post $OWNER '{"type":"request","page":"UC-01","text":"broken","data":{"category":"bug"}}')"
kill $PID 2>/dev/null; wait $PID 2>/dev/null

echo "feature toggles — the screen goes dark, the guard behind it does not:"
# Every built toggle at the OPPOSITE of its default, this time under password identity: the
# /api/users* routes are what the finding calls "still enforces its guard" — proved here as more
# than "the owner gets 201", which is all the old matrix checked. A member and an admin get the SAME
# refusals they would with every toggle at its default.
#
# MINOR 5 (D5): `JSON.stringify(project).includes('"peopleScreen":true')` never writes the word
# `features`, so no scan of the SOURCE (engine/tests/features.test.js) can refuse it by name — that
# file says so, in its own header comment, and points here instead. peopleScreen alone used to be the
# only toggle turned off on this server; every OTHER built toggle is at its non-default state here
# too now, so a guard that secretly asked "is anything on" rather than "does roles.can say yes" has
# nowhere left to hide.
#
# ROUND 4: every toggle at the opposite of its default (`everyToggleFlipped`, engine/core/
# features.js) instead of a hand-written subset — the old literal turned four toggles off and left
# `graph` ON (its default) and `voice`/`sketch` untouched (also their default, `false`), so nothing
# here ever exercised `graph`, `voice` or `sketch` in their NON-default state. The helper keeps this
# honest as the list grows: a toggle added to the closed list lands here automatically, at the
# opposite of what it ships with, never at whatever this script happened to hard-code the day it
# was written.
POFF_SITE="$WORK/every-toggle-off-site"
cp -r "$SITE" "$POFF_SITE"
node --input-type=module -e '
  const { readFileSync, writeFileSync } = await import("node:fs");
  const { everyToggleFlipped } = await import("./engine/core/features.js");
  const path = process.argv[1];
  const config = JSON.parse(readFileSync(path, "utf8"));
  config.features = everyToggleFlipped();
  writeFileSync(path, JSON.stringify(config, null, 2));
' "$POFF_SITE/holdrim.json"
# The derivation itself, checked directly against the file it wrote — not only against a route that
# happens to read one of these keys. `graph` and `voice`/`sketch` are read by nothing this server's
# routes touch, so without this a hand-written subset that silently dropped back to leaving them at
# their default would still pass every check below.
expect "the derived config turns graph off (on by default)" 0 \
  "$(grep -q '\"graph\": false' "$POFF_SITE/holdrim.json"; echo $?)"
expect "and turns voice on (off by default, not built)" 0 \
  "$(grep -q '\"voice\": true' "$POFF_SITE/holdrim.json"; echo $?)"
expect "and turns sketch on too" 0 \
  "$(grep -q '\"sketch\": true' "$POFF_SITE/holdrim.json"; echo $?)"
PDATA=$(mktemp -d)
TADMIN=toggle-admin@example.org
TMEMBER=toggle-member@example.org
HOLDRIM_ENVIRONMENT=Production HOLDRIM_OWNER=$OWNER HOLDRIM_ADMINS=$TADMIN HOLDRIM_IDENTITY=password \
  HOLDRIM_EVENTS=sqlite HOLDRIM_USERS_PATH=$PDATA/users.db HOLDRIM_EVENTS_PATH=$PDATA/events.db PORT=$PORT \
  HOLDRIM_SITE="$POFF_SITE" \
  node --import ./engine/tests/hooks/forbid-optional.js engine/api/server.ts >$WORK/toggles-people.log 2>&1 & PID=$!
for i in $(seq 40); do curl -s $B/api/health >/dev/null 2>&1 && break; sleep 0.5; done
TFIRST=$(grep -A2 'FIRST ACCESS' $WORK/toggles-people.log | sed -n -E 's/.*password: *//p' | head -1)
TCOOKIES=$WORK/toggle-owner-cookies.txt
curl -s -c $TCOOKIES -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' \
  -d "{\"email\":\"$OWNER\",\"password\":\"$TFIRST\"}" $B/api/sign-in >/dev/null
tas_owner() { curl -s -b $TCOOKIES -H 'Content-Type: application/json' "$@"; }

expect "peopleScreen OFF: the screen redirects home, even for the owner" 0 \
  "$(curl -s -b $TCOOKIES -D- -o /dev/null $B/engine/people | has -i 'location: /engine/home'; echo $?)"
# S9: canManagePeople has to stay `peopleScreenOn() && managesPeople(viewer)`, not just the second
# half — the owner truly manages people here (a real password session, unlike the dev-mode server
# above, where managesPeople is always false and this same check would prove nothing).
expect "peopleScreen OFF: the owner's own home has no People link either" 1 \
  "$(tas_owner $B/engine/home | has -F 'href="/engine/people"'; echo $?)"
expect "peopleScreen OFF: /api/users still enforces its guard — the owner still creates an access" 201 \
  "$(tas_owner -o /dev/null -w '%{http_code}' -d '{"email":"toggle-new@example.org","name":"New"}' $B/api/users)"

TAPASS=$(tas_owner -d "{\"email\":\"$TADMIN\",\"name\":\"An Admin\"}" $B/api/users | jfield password)
TACOOKIES=$WORK/toggle-admin-cookies.txt
curl -s -c $TACOOKIES -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' \
  -d "{\"email\":\"$TADMIN\",\"password\":\"$TAPASS\"}" $B/api/sign-in >/dev/null
tas_admin() { curl -s -b $TACOOKIES -H 'Content-Type: application/json' "$@"; }

expect "peopleScreen OFF: an admin still cannot create the owner" 409 \
  "$(tas_admin -o /dev/null -w '%{http_code}' -d "{\"email\":\"$OWNER\",\"name\":\"Not Me\"}" $B/api/users)"
expect "peopleScreen OFF: an admin still cannot reset the owner's password" 409 \
  "$(tas_admin -o /dev/null -w '%{http_code}' -X POST $B/api/users/$OWNER/password)"

TMPASS=$(tas_owner -d "{\"email\":\"$TMEMBER\",\"name\":\"A Member\"}" $B/api/users | jfield password)
TMCOOKIES=$WORK/toggle-member-cookies.txt
curl -s -c $TMCOOKIES -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' \
  -d "{\"email\":\"$TMEMBER\",\"password\":\"$TMPASS\"}" $B/api/sign-in >/dev/null
tas_member() { curl -s -b $TMCOOKIES -H 'Content-Type: application/json' "$@"; }

expect "peopleScreen OFF: a member still gets 403 creating an access" 403 \
  "$(tas_member -o /dev/null -w '%{http_code}' -d '{"email":"other@example.org","name":"Other"}' $B/api/users)"
expect "peopleScreen OFF: a member still gets 403 on an approval" 403 \
  "$(tas_member -o /dev/null -w '%{http_code}' -d '{"type":"approval","page":"D01","block":"D01.1.4","fingerprint":"abc"}' $B/api/events)"
#
# MINOR (R-D5b): a reflective read — `JSON.stringify(project).includes('"peopleScreen":true')` — is
# invisible to any scan of the SOURCE (engine/tests/features.test.js's own header comment says so,
# and points here), so THIS server is the only backstop a guard like that has. It is only a backstop
# for what it actually asks, though, so every guard on this server has to be asked here, enumerated
# on purpose rather than left to whichever ones a past round happened to add. The lists below are
# complete as of this round; a route, a `refusalOf` 403 or another guard added later and not added
# here is a gap this comment can no longer claim doesn't exist.
#
# Every `/api/users*` route (`userRoutes`, engine/api/server.ts), and where its `manages()` guard is
# checked on THIS server:
#   GET  /users                 — the list itself                     — below (member)
#   POST /users                 — creating an access                  — owner 201 above; admin→owner
#                                                                        409 above; member 403 below
#   POST /users/me/name         — no role guard: the caller's OWN row, never a refusal path
#   POST /users/:email/password — a new password for somebody         — admin→owner 409 above;
#                                                                        member→another member 403
#                                                                        below
#   POST /users/:email/enabled  — taking the access away               — member 403, admin→owner 409
#                                                                        below; disabling a real
#                                                                        member also below, for the
#                                                                        session check further down
#
# Every `refusalOf` 403 (engine/api/server.ts, the one gate `/api/events` and both home forms share):
#   the feature gate itself     — proved live against comments/pageRequests/bugCategory above
#                                  (OFF_SITE); not re-asked here, where `request` events on purpose
#                                  name no category, to isolate the checks below from it
#   approval, owner/admin only  — member 403 above
#   supplement, owner or author — member (neither) 403 below
#   triage (request_state),
#     owner/admin only          — member 403 below
#   cross-site (`sameOrigin`),
#     both home forms           — below (MINOR X1/P1)
#
# The one guard shaped as neither of the above — `/api/change-password` (engine/api/server.ts),
# whose `checked` refusal is its own `if`, not `userRoutes`' `manages()` nor `refusalOf` — was
# missing from every list above and so from every check below it: changing your own password with
# the wrong current one — below (MINOR PW).
#
# MAJOR (L1): none of the above is shaped as a `refusalOf` 403, but each is exactly the kind of
# question `JSON.stringify(project).includes(...)` could answer instead of asking `roles.can` —
# `asRead`'s `locks:` field, `serveHome`'s `ownerApprovals` count and `serveStatic`'s path guard,
# checked below:
#   only the owner's ✓ becomes the lock — `asRead`'s `locks:` field on an admin's ✓ (false) and the
#     owner's own (true), and the home's "not yet in the repository" count, which must move only
#     when the owner's ✓ lands, never the admin's — below
#   a path outside the site (`site.pathOutside`) — below (MINOR X1/P1)
expect "every toggle OFF: a member listing /api/users → 403" 403 \
  "$(tas_member -o /dev/null -w '%{http_code}' $B/api/users)"
expect "every toggle OFF: a member resetting ANOTHER member's password → 403" 403 \
  "$(tas_member -o /dev/null -w '%{http_code}' -X POST $B/api/users/$TADMIN/password)"
expect "every toggle OFF: a member enabling or disabling an access → 403" 403 \
  "$(tas_member -o /dev/null -w '%{http_code}' -d '{"enabled":false}' $B/api/users/$TADMIN/enabled)"
expect "every toggle OFF: an admin disabling the owner → 409" 409 \
  "$(tas_admin -o /dev/null -w '%{http_code}' -d '{"enabled":false}' $B/api/users/$OWNER/enabled)"
TTRIAGE=$(tas_member -d '{"type":"request","page":"UC-01","text":"toggle triage check"}' $B/api/events | jfield id)
expect "every toggle OFF: a non-owner triaging → refused" 403 \
  "$(tas_member -o /dev/null -w '%{http_code}' -d "{\"type\":\"request_state\",\"page\":\"UC-01\",\"text\":\"x\",\"data\":{\"request\":\"$TTRIAGE\",\"state\":\"approved\"}}" $B/api/events)"
# The supplement guard: filed by the ADMIN, so neither the owner nor its own author is who attempts
# it below — `mayAddDetails` (engine/api/here.ts) has to refuse a member who is truly neither.
TSUPP=$(tas_admin -d '{"type":"request","page":"UC-01","text":"toggle supplement check"}' $B/api/events | jfield id)
expect "every toggle OFF: a non-owner, non-author supplement → 403" 403 \
  "$(tas_member -o /dev/null -w '%{http_code}' -d "{\"type\":\"supplement\",\"page\":\"UC-01\",\"text\":\"me too\",\"data\":{\"request\":\"$TSUPP\"}}" $B/api/events)"
# MINOR (PW): `/api/change-password` is neither a `userRoutes` route nor a `refusalOf` 403, so it
# was never on the lists above and never asked here — the one server where a reflective read could
# have swallowed its `checked` guard without a single check noticing.
expect "every toggle OFF: changing your own password with the wrong current one → 403" 403 \
  "$(tas_member -o /dev/null -w '%{http_code}' -d '{"current":"the-wrong-password","next":"a-long-enough-password"}' $B/api/change-password)"

# MAJOR (L1): `asRead`'s `locks:` field and `serveHome`'s `ownerApprovals` count both decide from
# `roles.can('lock', ...)` — never from anything reflective — so this is the one place either could
# be replaced by `JSON.stringify(project).includes('"peopleScreen":true')` without a single test
# above noticing: every check so far asks whether an action is REFUSED, never what a ✓ that went
# through reads back as.
toff_waiting() { tas_owner $B/engine/home | has -F 'not yet in the repository'; echo $?; }
expect "every toggle OFF: nothing waits before anyone approves" 1 "$(toff_waiting)"
# "waiting" only moves for a ✓ whose fingerprint matches the block's ACTUAL current one
# (`home-page.ts`'s `summarisePages`), so this needs a REAL block — `A01.1.3`, real content nothing
# else in this file's checks against POFF_SITE already touches — and its real fingerprint, not an
# arbitrary string like the ones used above only to exercise a 403/409 refusal.
TLOCK_FP=$(cli_fingerprint A01.1.3)
TLOCK_ADMIN=$(tas_admin -d "{\"type\":\"approval\",\"page\":\"A01\",\"block\":\"A01.1.3\",\"fingerprint\":\"$TLOCK_FP\"}" $B/api/events | jfield id)
expect "every toggle OFF: an admin's ✓, read back, is not the lock" false \
  "$(tas_owner $B/api/events/$TLOCK_ADMIN | jfield locks)"
expect "every toggle OFF: and the home does not count it as waiting" 1 "$(toff_waiting)"
TLOCK_OWNER=$(tas_owner -d "{\"type\":\"approval\",\"page\":\"A01\",\"block\":\"A01.1.3\",\"fingerprint\":\"$TLOCK_FP\"}" $B/api/events | jfield id)
expect "every toggle OFF: the owner's ✓, read back, is the lock" true \
  "$(tas_owner $B/api/events/$TLOCK_OWNER | jfield locks)"
expect "every toggle OFF: and now the home counts it as waiting" 0 "$(toff_waiting)"

# MINOR (X1/P1): the cross-site guard (`sameOrigin`) and the path-outside guard (`site.pathOutside`)
# are both reflective reads' other favourite hiding place — reached by nothing `refusalOf` runs, so
# nothing above asked either. Triage, not "ask for a page": a `request` needing `pageRequests` would
# be refused by the feature gate first here, proving nothing about `sameOrigin` specifically.
# Filed by the MEMBER, not the owner: `cycle.json`'s `initial_for_admin` starts an owner's or admin's
# OWN request already at `approved` (they do not triage themselves), so approving it again would be
# refused with 409 regardless of `sameOrigin` — proving nothing about the guard under test.
TCROSS=$(tas_member -d '{"type":"request","page":"UC-01","text":"toggle cross-site setup"}' $B/api/events | jfield id)
expect "every toggle OFF: a cross-site POST to the home is refused" "403 " \
  "$(curl -s -o /dev/null -w '%{http_code} ' -b $TCOOKIES -H 'Origin: https://elsewhere.example' \
    --data-urlencode action=triage --data-urlencode "request=$TCROSS" --data-urlencode page=UC-01 \
    --data-urlencode state=approved $B/engine/home)"
# With a real session, unlike the default server's check this repeats: with NO session, password
# identity redirects everything but /sign-in and /api/ to sign-in (302) before serveStatic is ever
# reached, so an unauthenticated request here would prove the login guard, not `site.pathOutside`.
expect "every toggle OFF: a path outside the site is refused" 403 \
  "$(curl -s -b $TCOOKIES -o /dev/null -w '%{http_code}' --path-as-is "$B/%2e%2e%2f%2e%2e%2fetc/passwd")"

# MINOR (locks): disabling drops the open session at once (AGENTS.md, "nothing is erased") — this is
# the LAST use of tas_member on this server, because disabling the account it authenticates as makes
# every later call through it answer 401 instead of whatever it meant to prove.
expect "every toggle OFF: the owner disabling a member → 200" 200 \
  "$(tas_owner -o /dev/null -w '%{http_code}' -d '{"enabled":false}' $B/api/users/$TMEMBER/enabled)"
expect "every toggle OFF: their open session dies at once → 401" 401 \
  "$(tas_member -o /dev/null -w '%{http_code}' $B/api/me)"
kill $PID 2>/dev/null; wait $PID 2>/dev/null; rm -rf "$PDATA"

# ----------------------------------------------------------------------------- people.show
# `npm test`'s `engine/tests/people-show.test.js` proves `readPeopleShow`/`personAs` in isolation, but
# not that the SERVER actually applies the setting to what a real reader is sent — the same reasoning
# the feature-toggle section above gives for needing a live process. `people.show: "role"` here, the
# one value furthest from today's default, so a raw address surviving into the answer is easy to see.
echo "people.show — how a person appears, docs/ROLES.md \"How a person appears\":"
PSHOW_SITE="$WORK/people-show-site"
cp -r "$SITE" "$PSHOW_SITE"
node -e '
  const fs = require("fs");
  const path = process.argv[1];
  const config = JSON.parse(fs.readFileSync(path, "utf8"));
  config.people = { show: "role" };
  fs.writeFileSync(path, JSON.stringify(config, null, 2));
' "$PSHOW_SITE/holdrim.json"
# sqlite, not the local default of memory: round 1 of this review's finding 1 needs a text actually
# REMOVED, through `EventStore.removeText` — no route calls it yet (texts.ts's own comment on
# `TEXT_REMOVED` says why), so this reaches the store directly, on the same file the server has
# open, the way the CLI already does against a live server (store-sqlite.ts's WAL comment).
PSHOW_DATA=$(mktemp -d)
HOLDRIM_MODE=local HOLDRIM_ENVIRONMENT=Development HOLDRIM_OWNER=$OWNER HOLDRIM_ADMINS=$LEAD HOLDRIM_DEV_EMAIL= PORT=$PORT \
  HOLDRIM_EVENTS=sqlite HOLDRIM_EVENTS_PATH=$PSHOW_DATA/events.db \
  HOLDRIM_SITE="$PSHOW_SITE" \
  node --import ./engine/tests/hooks/forbid-optional.js engine/api/server.ts >$WORK/people-show.log 2>&1 & PID=$!
for i in $(seq 40); do curl -s $B/api/health >/dev/null 2>&1 && break; sleep 0.5; done

post $REVIEWER '{"type":"comment","page":"UC-01","text":"people-show marker from reviewer"}' >/dev/null
post $LEAD '{"type":"comment","page":"UC-01","text":"people-show marker from lead"}' >/dev/null
# One event by the marker text it carries, never by author: that field is exactly what this section
# proves is no longer always the address.
author_of() {
  curl -s -H "X-Dev-Email: $1" "$B/api/events?page=UC-01" | \
    node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const e=JSON.parse(s).find(x=>x.text===process.argv[1]);console.log(e?e.author:'')})" "$2"
}
expect "people.show: role — another member sees the role" Admin \
  "$(author_of $REVIEWER 'people-show marker from lead')"
expect "and never the address"                     1 \
  "$(author_of $REVIEWER 'people-show marker from lead' | has -F '@'; echo $?)"
expect "the owner sees the real address regardless — the owner always sees names" "$LEAD" \
  "$(author_of $OWNER 'people-show marker from lead')"
expect "and so does an admin, a holder of \`people\`, about someone else's" "$REVIEWER" \
  "$(author_of $LEAD 'people-show marker from reviewer')"
expect "a person sees their own address on their own comment, whatever the setting" "$REVIEWER" \
  "$(author_of $REVIEWER 'people-show marker from reviewer')"

# CRITICAL, round 1 of the issue #31 review, finding 1: `textRemoved.by`/`snapshotRemoved.by` used
# to pass through `asRead` untouched, leaking the remover's raw address to a viewer `people.show`
# was configured to hide it from. `by` is found by the event's OWN id, never its marker text: the
# text is exactly what a removal takes away.
#
# The request is $REVIEWER's, removed by $LEAD, and read by a third address, $PSHOW_VIEWER, that
# holds neither part: an author removing their own text makes `removalSubjectsOf` returning `[]` an
# equivalent mutant, since the removed comment's own `author` field already lands the remover in the
# same distinct-author list `authorDisplaysFor` walks, so `resolveRemovedBy` still finds a display
# for it — coincidentally, with nothing left for `removalSubjectsOf` to have proved. A viewer who is
# also the author or the remover would let the "sees their own address" override (`personDisplay`,
# server.ts) hide the same leak the same way.
PSHOW_VIEWER=viewer@example.org
REMOVE_ID=$(new_request $REVIEWER '{"type":"comment","page":"UC-01","text":"people-show removal marker"}')
node --input-type=module -e "
const { SqliteEventStore } = await import('./engine/api/store-sqlite.ts');
const store = new SqliteEventStore(process.argv[1]);
await store.removeText(process.argv[2], 'text', process.argv[3]);
" "$PSHOW_DATA/events.db" "$REMOVE_ID" "$LEAD"
removed_by() {
  curl -s -H "X-Dev-Email: $1" "$B/api/events?page=UC-01" | \
    node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const e=JSON.parse(s).find(x=>x.id===process.argv[1]);console.log(e&&e.textRemoved?e.textRemoved.by:'')})" "$2"
}
removed_by_one() {
  curl -s -H "X-Dev-Email: $1" "$B/api/events/$2" | \
    node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const e=JSON.parse(s);console.log(e.textRemoved?e.textRemoved.by:'')})"
}
expect "people.show: role — a removal's \`by\` reads as the remover's role too" Admin \
  "$(removed_by $PSHOW_VIEWER $REMOVE_ID)"
expect "and never the remover's address, on the list route"    1 \
  "$(removed_by $PSHOW_VIEWER $REMOVE_ID | has -F '@'; echo $?)"
expect "nor on GET /api/events/{id} alone"                     1 \
  "$(removed_by_one $PSHOW_VIEWER $REMOVE_ID | has -F '@'; echo $?)"
expect "the owner still sees the remover's real address"      "$LEAD" \
  "$(removed_by $OWNER $REMOVE_ID)"

# The home is `serveHome`'s own wiring, not `requestsInProgress`'s (proved in isolation by
# home.test.js): the setting has to actually reach it through a real server.
new_request $LEAD '{"type":"request","page":"UC-01","text":"people-show home marker","data":{"category":"text"}}' >/dev/null
expect "the home shows the role too, never the address" 0 \
  "$(curl -s -H "X-Dev-Email: $REVIEWER" $B/engine/home | has -F '>Admin<'; echo $?)"
expect "and not the address, anywhere on the page" 1 \
  "$(curl -s -H "X-Dev-Email: $REVIEWER" $B/engine/home | has -F "$LEAD"; echo $?)"
kill $PID 2>/dev/null; wait $PID 2>/dev/null; rm -rf "$PSHOW_DATA"

# `people.show: "id"` — the finding's other named case, and the one for which a plain e-mail
# fallback (`personAs`'s own `id || email`) would be the SECOND leak: a remover with no id in hand
# reads as their address, not as nothing.
PSHOW_ID_SITE="$WORK/people-show-id-site"
cp -r "$SITE" "$PSHOW_ID_SITE"
node -e '
  const fs = require("fs");
  const path = process.argv[1];
  const config = JSON.parse(fs.readFileSync(path, "utf8"));
  config.people = { show: "id" };
  fs.writeFileSync(path, JSON.stringify(config, null, 2));
' "$PSHOW_ID_SITE/holdrim.json"
PSHOW_ID_DATA=$(mktemp -d)
HOLDRIM_MODE=local HOLDRIM_ENVIRONMENT=Development HOLDRIM_OWNER=$OWNER HOLDRIM_ADMINS=$LEAD HOLDRIM_DEV_EMAIL= PORT=$PORT \
  HOLDRIM_EVENTS=sqlite HOLDRIM_EVENTS_PATH=$PSHOW_ID_DATA/events.db \
  HOLDRIM_SITE="$PSHOW_ID_SITE" \
  node --import ./engine/tests/hooks/forbid-optional.js engine/api/server.ts >$WORK/people-show-id.log 2>&1 & PID=$!
for i in $(seq 40); do curl -s $B/api/health >/dev/null 2>&1 && break; sleep 0.5; done

# Same split as the role case above — $REVIEWER authors, $LEAD removes, $PSHOW_VIEWER reads — for
# the same reason: remover and author matching would leave this proving nothing.
ID_REMOVE_ID=$(new_request $REVIEWER '{"type":"comment","page":"UC-01","text":"people-show id removal marker"}')
node --input-type=module -e "
const { SqliteEventStore } = await import('./engine/api/store-sqlite.ts');
const store = new SqliteEventStore(process.argv[1]);
await store.removeText(process.argv[2], 'text', process.argv[3]);
" "$PSHOW_ID_DATA/events.db" "$ID_REMOVE_ID" "$LEAD"
ID_BY=$(removed_by $PSHOW_VIEWER $ID_REMOVE_ID)
expect "people.show: id — a removal's \`by\` is the opaque id too" 1 \
  "$(echo "$ID_BY" | grep -cE '^p_[0-9a-f]{24}$')"
expect "and never the remover's address"                      1 \
  "$(echo "$ID_BY" | has -F '@'; echo $?)"
expect "and the single-event route agrees"                    "$ID_BY" \
  "$(removed_by_one $PSHOW_VIEWER $ID_REMOVE_ID)"
kill $PID 2>/dev/null; wait $PID 2>/dev/null; rm -rf "$PSHOW_ID_DATA"

echo "local mode does NOT turn on outside development:"
HOLDRIM_MODE=local HOLDRIM_ENVIRONMENT=Production HOLDRIM_OWNER=$OWNER HOLDRIM_AUDIENCE=/projects/0/x PORT=$PORT \
  HOLDRIM_SITE="$SITE" \
  node --import ./engine/tests/hooks/forbid-optional.js engine/api/server.ts >$WORK/prod.log 2>&1 & PID=$!
for i in $(seq 40); do curl -s $B/api/health >/dev/null 2>&1 && break; sleep 0.5; done
expect "X-Dev-Email ignored → 401"     401 "$(curl -s -o /dev/null -w '%{http_code}' -H "X-Dev-Email: $OWNER" $B/api/me)"
# The EVENT NAME, not the prose: a log line is found by grepping one stable English token, and a
# check that reads the sentence goes red the day somebody improves the wording.
expect "and warns in the log"          0 "$(grep -q '"event":"local_mode_ignored"' $WORK/prod.log; echo $?)"
expect "at a severity a collector reads" 0 "$(grep -q '"severity":"WARNING"' $WORK/prod.log; echo $?)"
expect "forged email → 401"            401 "$(curl -s -o /dev/null -w '%{http_code}' -H 'x-goog-authenticated-user-email: accounts.google.com:x@y' $B/api/me)"
expect "forged JWT → 401"              401 "$(curl -s -o /dev/null -w '%{http_code}' -H 'x-goog-iap-jwt-assertion: eyJhbGciOiJFUzI1NiJ9.eyJlbWFpbCI6ImhhY2tlckB4In0.abc' $B/api/me)"
expect "and the refusal is logged through the shared logger" 0 "$(grep -q '"event":"jwt_rejected"' $WORK/prod.log; echo $?)"
kill $PID 2>/dev/null; wait $PID 2>/dev/null

echo "comes up with no cloud at all (username, password and a single file):"
# This is the path for whoever downloads the image: no Google variable, no project, no IAP.
DATA_DIR=$(mktemp -d); COOKIES=$WORK/cookies.txt
# ADMIN exists so the guards can be told apart: a MEMBER is refused because they manage nobody,
# an ADMIN is allowed to manage and still refused on the owner. Testing only with a member would
# leave the escalation path — admin resets the owner, signs in as the owner — completely uncovered.
ADMIN=admin@example.org
# LOCKED is named in HOLDRIM_LOCKS (docs/ROLES.md, section 3): their account is guarded like the
# owner's, end to end, below.
LOCKED=locked@example.org
# `A0*`, a family this site has pages in: start refuses a HOLDRIM_LOCKS scope that matches no page.
HOLDRIM_ENVIRONMENT=Production HOLDRIM_OWNER=$OWNER HOLDRIM_ADMINS=$ADMIN HOLDRIM_LOCKS="$LOCKED:A0*" \
  HOLDRIM_IDENTITY=password HOLDRIM_EVENTS=sqlite \
  HOLDRIM_USERS_PATH=$DATA_DIR/users.db HOLDRIM_EVENTS_PATH=$DATA_DIR/events.db PORT=$PORT \
  HOLDRIM_SITE="$SITE" \
  node --import ./engine/tests/hooks/forbid-optional.js engine/api/server.ts >$WORK/password.log 2>&1 & PID=$!
for i in $(seq 40); do curl -s $B/api/health >/dev/null 2>&1 && break; sleep 0.5; done

PASSWORD=$(grep -A2 'FIRST ACCESS' $WORK/password.log | sed -n -E 's/.*password: *//p' | head -1)
expect "the first password is said once" 0 "$([ -n "$PASSWORD" ] && echo 0 || echo 1)"
expect "and it isn't 'admin'"          1 "$(echo "$PASSWORD" | has -x 'admin'; echo $?)"
login() { curl -s -c $COOKIES -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' -d "{\"email\":\"$OWNER\",\"password\":\"$1\"}" $B/api/sign-in; }

expect "no session → 401"              401 "$(curl -s -o /dev/null -w '%{http_code}' $B/api/me)"
# There is no IAP at the edge here: if the static site doesn't require a session, the whole
# documentation is left open to anyone who reaches the port — and whoever brought the image up
# believing they had configured login never suspects a thing.
expect "the docs do NOT open without a session" 302 "$(curl -s -o /dev/null -w '%{http_code}' $B/pages/A01.html)"
expect "and sends it to the login screen" 0 "$(curl -s -D- -o /dev/null $B/pages/A01.html | has -i 'location: /sign-in'; echo $?)"
expect "keeping track of where it was headed" 0 "$(curl -s -D- -o /dev/null $B/pages/A01.html | has 'next=%2Fpages%2FA01'; echo $?)"
expect "the people screen does NOT open without a session" 0 "$(curl -s -D- -o /dev/null $B/engine/people | has -i 'location: /sign-in'; echo $?)"
expect "the project home does NOT open without a session" 0 "$(curl -s -D- -o /dev/null $B/engine/home | has -i 'location: /sign-in'; echo $?)"
expect "the login screen opens → 200"  200 "$(curl -s -o /dev/null -w '%{http_code}' $B/sign-in)"
# The language selector is drawn on the login screen, so its route answers before any session:
# behind the guard, the person who most needs it — not signed in yet — would be sent to sign in
# instead. It sends them back where they were, and keeps the choice in a cookie that is `Secure`
# everywhere but development.
curl -s -D "$WORK/language.h" -o /dev/null "$B/language?lang=es&next=%2Fsign-in"
expect "the language switch answers without a session → 302" 1 "$(grep -c '^HTTP/1.1 302' "$WORK/language.h")"
# Exactly there: the guard's own redirect also starts `/sign-in`, and carries `?next=` after it.
expect "and goes back to where the person was" 1 "$(tr -d '\r' < "$WORK/language.h" | grep -ci '^location: /sign-in$')"
expect "and keeps the choice, Secure" 1 "$(grep -ci '^set-cookie: holdrim_language=es;.*; secure' "$WORK/language.h")"
# The one route read before any session: a body of null would reach `body.email` and throw.
expect "a sign-in with a body of null → 400" 400 "$(curl -s -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' -d 'null' $B/api/sign-in)"
# And fields of the wrong kind: an e-mail that is a number would reach `.trim()` and answer 500.
expect "a sign-in whose e-mail is a number → 401, like any wrong one" 401 "$(curl -s -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' -d '{"email":1,"password":["x"]}' $B/api/sign-in)"
# An address longer than any address is refused before the throttle; it must not reach the log whole.
node -e "process.stdout.write(JSON.stringify({email:'x'.repeat(900000),password:'x'}))" > "$WORK/long-email.json"
expect "a sign-in with a 900 KB e-mail → 401" 401 "$(curl -s -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' --data-binary @"$WORK/long-email.json" $B/api/sign-in)"
expect "and the log keeps an address's worth of it, not the megabyte" 0 "$(awk 'length > 2000 { found=1 } END { exit found }' $WORK/password.log; echo $?)"
# The login screen is the clickjacking target: an invisible "Approve" laid over a real one, and an
# approval here is a lock in a repository. It does not go through json() nor through the static
# file path, so neither of the places that set the header for everything else reaches it — checked
# here, because nothing else would notice it missing.
expect "and it refuses to be framed"     1 "$(curl -s -D- -o /dev/null $B/sign-in | grep -ci "frame-ancestors 'none'")"
expect "and it says nosniff"             1 "$(curl -s -D- -o /dev/null $B/sign-in | grep -ci 'x-content-type-options: nosniff')"
# The sign-in page runs only what this server wrote into it. The nonce in the policy has to be the
# one on every script and style of THIS response, new on the next one, and `unsafe-inline` must not
# appear: a policy that allows inline script allows the injected kind too.
SIGNIN_HDR=$(curl -s -D "$WORK/signin.h" -o "$WORK/signin.html" $B/sign-in; grep -i '^content-security-policy:' "$WORK/signin.h")
NONCE=$(echo "$SIGNIN_HDR" | sed -n "s/.*script-src 'nonce-\([A-Za-z0-9+/=]*\)'.*/\1/p")
expect "the sign-in policy runs nothing by default" 1 "$(echo "$SIGNIN_HDR" | grep -c "default-src 'none'")"
expect "and never allows inline script"  0 "$(echo "$SIGNIN_HDR" | grep -c 'unsafe-inline')"
expect "its nonce is on every script and style of the page" "$(grep -cE '<script>|<script nonce|<style' "$WORK/signin.html")" "$(grep -c "nonce=\"$NONCE\"" "$WORK/signin.html")"
expect "and no executable tag is left without it" 0 "$(grep -cE '<script>|<style>' "$WORK/signin.html")"
expect "and the next response gets a new one" 1 "$(curl -s -D- -o /dev/null $B/sign-in | has "nonce-$NONCE"; echo $?)"
expect "an API answer runs nothing at all" 1 "$(curl -s -D- -o /dev/null $B/api/health | grep -ci "content-security-policy: default-src 'none'")"
expect "and it doesn't ask for anything external" 1 "$(curl -s $B/sign-in | has -E '<link|src=\"/pages'; echo $?)"
# The design system arrives INLINE, for the same reason: /engine/web/ is behind the guard, so a
# linked stylesheet on the one page served without a session would be answered with a redirect to
# that same page, and the login screen would arrive unstyled.
expect "and the design system came with it"    0 "$(curl -s $B/sign-in | has -F -- '--holdrim-space-1'; echo $?)"
# ⚠️ hello-world sets no `theme`, so what is served here is the ENGINE's default — and the engine's
# default must not be anybody's brand. Asserted as the exact line, because the point is that
# nothing else got interpolated into it: the theme is the one value on this page that comes from a
# file the engine did not write.
expect "wearing the engine's neutral brand"    0 "$(curl -s $B/sign-in | has -F -- '>:root { --holdrim-brand: #3F4B57; --holdrim-brand-ink: #FFFFFF; }</style>'; echo $?)"
expect "X-Dev-Email doesn't count here → 401" 401 "$(curl -s -o /dev/null -w '%{http_code}' -H "X-Dev-Email: $OWNER" $B/api/me)"
expect "wrong password → 401"          401 "$(login 'not-the-password')"
# A refusal never became a person, so the log keeps the address exactly as it was typed — the one
# line an operator needs to see an attack (docs/PRIVACY.md, section 6).
expect "and a refused sign-in still logs the address that was typed" 1 \
  "$(grep '"event":"sign_in_refused"' $WORK/password.log | grep -Fc -e "\"email\":\"$OWNER\"")"
expect "correct password → 200"        200 "$(login "$PASSWORD")"
expect "and the session identifies the owner" owner "$(curl -s -b $COOKIES $B/api/me | jfield role)"
# Signing in does not ITSELF name a person — but the owner's row already exists by the time anyone
# can sign in: this store's first boot wrote the `lock_baseline` event authored by the owner (decision
# B), which mints their row before any request, comment or ✓ of theirs ever could. So the log finds a
# real person here, never the e-mail — the id it finds is a real one, not merely something id-shaped.
expect "and a sign-in finds the owner's row, made by the baseline at boot" 1 \
  "$(log_field $WORK/password.log signed_in person | grep -cE '^p_[0-9a-f]{24}$')"
expect "and the owner truly approves"  201 "$(curl -s -b $COOKIES -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' -d '{"type":"approval","page":"D01","block":"D01.1.4","fingerprint":"abc123"}' $B/api/events)"
# The owner's first real act mints their row. Captured once here, by name, so every later line that
# claims to be the owner's can be checked against this EXACT id — a shape check alone, "something
# p_-shaped is there", would wave through the owner's id credited to somebody else just as happily.
OWNER_ID=$(log_field $WORK/password.log event_recorded author)
require_id "$OWNER_ID" OWNER_ID
expect "and the recorded event names its author by a real person id" 1 \
  "$(echo "$OWNER_ID" | grep -cE '^p_[0-9a-f]{24}$')"
expect "and never by the e-mail it carried"    0 \
  "$(grep '"event":"event_recorded"' $WORK/password.log | grep -Fc -e "$OWNER")"
expect "the first-access password requires a change" true "$(curl -s -b $COOKIES $B/api/me | jfield mustChangePassword)"
expect "now the docs open → 200"       200 "$(curl -s -b $COOKIES -o /dev/null -w '%{http_code}' $B/pages/A01.html)"
# The project home is mostly a report — and, with graph on (#38's toggle, ON by default), a graph
# of the whole documentation too, which is the one thing on this screen that needs a script. Its
# policy allows exactly that one nonced script and nothing else: a request's text is typed by any
# reviewer and shown there to the owner, and the rest of the screen still runs no script of its own.
HOME_HDR=$(curl -s -b $COOKIES -D "$WORK/home.h" -o "$WORK/home.html" $B/engine/home; grep -i '^content-security-policy:' "$WORK/home.h")
expect "with a session, the project home opens → 200" 200 "$(sed -n 's/^HTTP[^ ]* \([0-9]*\).*/\1/p' "$WORK/home.h" | head -1)"
expect "graph ON (default): its policy allows exactly a nonced script" 0 \
  "$(echo "$HOME_HDR" | has "script-src 'nonce-" && ! echo "$HOME_HDR" | has "'unsafe-inline'"; echo $?)"
expect "and it has exactly the one script to run"      1 "$(grep -c '<script' "$WORK/home.html")"
expect "and it fetches the same graph holdrim graph prints" 0 \
  "$(grep -qF 'src="/engine/web/home-graph.js"' "$WORK/home.html"; echo $?)"
expect "and it links every page it tallies"   0 "$(grep -qF 'href="/pages/A01.html"' "$WORK/home.html"; echo $?)"
# The HTML must NOT be cached: otherwise a text fix never reaches someone who already opened the
# page — and, worse, the fingerprint the browser computes ends up matching text that has already
# changed on disk.
expect "HTML is not cached"            0 "$(curl -s -b $COOKIES -D- -o /dev/null $B/pages/A01.html | has -i 'cache-control: no-cache'; echo $?)"
# Every file served from disk carries what it may run, the engine's own included: a page, only the
# panel; anything else, nothing. Without the second, an HTML file shipped next to the panel one day
# would run whatever it holds with the reader's session.
expect "a page runs only what carries its nonce" 0 "$(curl -s -b $COOKIES -D- -o /dev/null $B/pages/A01.html | has "script-src 'nonce-"; echo $?)"
expect "an engine file runs nothing"   0 "$(curl -s -b $COOKIES -D- -o /dev/null $B/engine/web/panel.css | has "script-src 'none'"; echo $?)"
expect "and /sign-in no longer has anything to do" 302 "$(curl -s -b $COOKIES -o /dev/null -w '%{http_code}' $B/sign-in)"
# A current password that is not a string would reach `.normalize()` and answer 500; it is a wrong one.
expect "a current password that is a number → 403, like any wrong one" 403 "$(curl -s -b $COOKIES -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' -d '{"current":1,"next":"a-long-enough-password"}' $B/api/change-password)"

# Issue #115: a second session for the SAME owner, opened with the CURRENT password — the cookie a
# stolen credential or a second signed-in tab would be — captured BEFORE the change, so a 401 on it
# afterwards means the change dropped it, not that it never existed to begin with.
SECOND_COOKIES=$WORK/cookies-owner-second.txt
curl -s -c $SECOND_COOKIES -o /dev/null -H 'Content-Type: application/json' \
  -d "{\"email\":\"$OWNER\",\"password\":\"$PASSWORD\"}" $B/api/sign-in >/dev/null
expect "that second session is live before the change → 200" 200 \
  "$(curl -s -b $SECOND_COOKIES -o /dev/null -w '%{http_code}' $B/api/me)"

CHANGE=$(curl -s -b $COOKIES -w '\n%{http_code}' -H 'Content-Type: application/json' -d "{\"current\":\"$PASSWORD\",\"next\":\"a-long-enough-password\"}" $B/api/change-password)
CHANGE_CODE=$(echo "$CHANGE" | tail -1); CHANGE=$(echo "$CHANGE" | sed '$d')
expect "changing the password → 200"   200 "$CHANGE_CODE"
# Same distinction as a reset's own answer, above: absent, not merely not-false — a route that always
# sent the field, true on success, would pass a "not false" check and still be wrong on the common path.
expect "and it carries no failed drop"  1 "$(echo "$CHANGE" | has 'sessionsDropped":false'; echo $?)"
expect "and the field is not there at all on success" 1 "$(echo "$CHANGE" | has 'sessionsDropped'; echo $?)"
expect "and the change is logged by id, not by e-mail" 0 \
  "$(grep '"event":"password_changed"' $WORK/password.log | grep -Fc -e "$OWNER")"
expect "as the owner's own id, not merely something id-shaped" "$OWNER_ID" \
  "$(log_field $WORK/password.log password_changed person)"
expect "and nothing is demanded any more" false "$(curl -s -b $COOKIES $B/api/me | jfield mustChangePassword)"
# The whole point of #115: the OTHER session for this account is exactly as exposed as a stolen
# password is, and dies with the change — while the session that CHOSE the new password is not the
# one that pays for it.
expect "the other session for this account is dropped by the change → 401" 401 \
  "$(curl -s -b $SECOND_COOKIES -o /dev/null -w '%{http_code}' $B/api/me)"
expect "while the caller's own session survives the change it just made → 200" 200 \
  "$(curl -s -b $COOKIES -o /dev/null -w '%{http_code}' $B/api/me)"
PASSWORD=a-long-enough-password

# ----------------------------------------------------------------------------- managing people
# Nothing here deletes anybody. An approval signed by somebody who was removed would be a ✓ with no
# owner, and the trail is half of what this tool is for — so the access goes away and the person
# stays. Everything below is about that one decision holding at the edge.
echo "managing people:"
MEMBER=member@example.org
MCOOKIES=$WORK/cookies-member.txt
as_owner()  { curl -s -b $COOKIES  -H 'Content-Type: application/json' "$@"; }
as_member() { curl -s -b $MCOOKIES -H 'Content-Type: application/json' "$@"; }
code_owner()  { as_owner  -o /dev/null -w '%{http_code}' "$@"; }
code_member() { as_member -o /dev/null -w '%{http_code}' "$@"; }
emails() { as_owner $B/api/users | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).users.map(u=>u.email).join(' ')))"; }
mlogin() { curl -s -c $MCOOKIES -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' -d "{\"email\":\"$MEMBER\",\"password\":\"$1\"}" $B/api/sign-in; }
ACOOKIES=$WORK/cookies-admin.txt
as_admin()   { curl -s -b $ACOOKIES -H 'Content-Type: application/json' "$@"; }
code_admin() { as_admin -o /dev/null -w '%{http_code}' "$@"; }
alogin() { curl -s -c $ACOOKIES -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' -d "{\"email\":\"$ADMIN\",\"password\":\"$1\"}" $B/api/sign-in; }

expect "the owner sees the list → 200"  200 "$(code_owner $B/api/users)"
expect "and is in it"                   "$OWNER" "$(as_owner $B/api/users | jfield users.0.email)"
expect "and is able to get in"          true "$(as_owner $B/api/users | jfield users.0.enabled)"

CREATED=$(as_owner -w '\n%{http_code}' -d "{\"email\":\"$MEMBER\",\"name\":\"A Member\"}" $B/api/users)
CREATE_CODE=$(echo "$CREATED" | tail -1); CREATED=$(echo "$CREATED" | sed '$d')
MEMBER_PASSWORD=$(echo "$CREATED" | jfield password)
expect "creating an access → 201"       201 "$CREATE_CODE"
expect "and the password comes back once" 0 "$([ -n "$MEMBER_PASSWORD" ] && echo 0 || echo 1)"
expect "and the new person is enabled"  true "$(echo "$CREATED" | jfield user.enabled)"
expect "and has to change that password" true "$(echo "$CREATED" | jfield user.mustChangePassword)"
# The whole point of "once". A password readable from a listing is a password anyone who can read
# the panel can collect, and one in a log is readable by everybody with access to the collector —
# a far wider audience than the account it opens.
expect "the password is NOT in the listing" 0 "$(as_owner $B/api/users | grep -Fc -e "$MEMBER_PASSWORD")"
expect "nor anywhere in the log"        0 "$(grep -Fc -e "$MEMBER_PASSWORD" $WORK/password.log)"
# The new account and whoever created it, both by id: the log is evidence an operator greps, not a
# second copy of the users table.
expect "and creating an access is logged by id, not by e-mail" 0 \
  "$(grep '"event":"user_created"' $WORK/password.log | grep -Ec -e "$MEMBER" -e "$OWNER")"
# The brand-new account has no row of its own: nobody has acted on anything reviewable as this
# address yet, so `null` is the honest value — not a row minted for a mere administrative act.
expect "the new account itself has no person row yet" null \
  "$(log_field $WORK/password.log user_created person)"
expect "but whoever created it does: the owner's id, not a stranger's" "$OWNER_ID" \
  "$(log_field $WORK/password.log user_created by)"
# Ordered in the store, not by the database's own idea of order: three databases with three natural
# orders would hand the same team three different lists.
expect "the list is ordered by e-mail"  "$MEMBER $OWNER" "$(emails)"

expect "the new person signs in → 200"  200 "$(mlogin "$MEMBER_PASSWORD")"
# Issue #113: this is the cookie a thief would have stolen right now, before any of what follows —
# disabling, resetting, re-enabling. Kept in a file of its own because $MCOOKIES gets overwritten by
# every later `mlogin`, and a check run against THAT would pass for the wrong reason: a fresh
# session, not survival of this one.
STOLEN_COOKIES=$WORK/cookies-member-stolen.txt
cp $MCOOKIES $STOLEN_COOKIES
# An empty or malformed jar would pass every "→ 401" check below for a reason that has nothing to do
# with the fix: curl sends no cookie, the server sees no session, and refuses it the same way it
# would refuse a thief's. Proving the copy actually holds a LIVE session first is what makes a later
# 401 mean "this session died", rather than "this file never had one to begin with".
expect "the cookie just captured is a live session, not an empty jar → 200" 200 \
  "$(curl -s -b $STOLEN_COOKIES -o /dev/null -w '%{http_code}' $B/api/me)"
expect "and it logs no person either — nobody has acted on anything yet" null \
  "$(log_field $WORK/password.log signed_in person)"
expect "and is nobody special"          member "$(as_member $B/api/me | jfield role)"
# One real act, so the member has a row of their own: every later line about their account can then
# be checked against this EXACT id, the way OWNER_ID lets the owner's be checked.
expect "and they may comment → 201" 201 "$(as_member -o /dev/null -w '%{http_code}' -d '{"type":"comment","page":"D01","text":"a comment"}' $B/api/events)"
MEMBER_ID=$(log_field $WORK/password.log event_recorded author)
require_id "$MEMBER_ID" MEMBER_ID
expect "as a real person id" 1 "$(echo "$MEMBER_ID" | grep -cE '^p_[0-9a-f]{24}$')"
expect "and not the owner's" 0 "$([ "$MEMBER_ID" != "$OWNER_ID" ]; echo $?)"
# The people screen draws only what the routes above allow, and is drawn only for who may use them.
expect "the people screen opens for the owner → 200" 200 "$(curl -s -b $COOKIES -o /dev/null -w '%{http_code}' $B/engine/people)"
expect "and lists the new person"       0 "$(curl -s -b $COOKIES $B/engine/people | has -F "$MEMBER"; echo $?)"
# The one row the routes refuse to touch (the owner cannot be reset or disabled) must be the one row
# the screen offers nothing on either — a button drawn there invites a click the server would 409 on.
PEOPLE_HTML=$(curl -s -b $COOKIES $B/engine/people)
expect "and the owner's own row offers no action at all" 1 \
  "$(echo "$PEOPLE_HTML" | grep -F "$OWNER" | has 'data-action='; echo $?)"
expect "while the new member's row still offers reset"  0 \
  "$(echo "$PEOPLE_HTML" | grep -F "$MEMBER" | has 'data-action="reset"'; echo $?)"
PEOPLE_HDR=$(curl -s -b $COOKIES -D- -o /dev/null $B/engine/people | grep -i '^content-security-policy:')
expect "and runs only its own script"   0 "$(echo "$PEOPLE_HDR" | has "script-src 'nonce-" && ! echo "$PEOPLE_HDR" | has 'unsafe-inline'; echo $?)"
expect "somebody who may not manage people is sent home" 0 "$(curl -s -b $MCOOKIES -D- -o /dev/null $B/engine/people | has -i 'location: /engine/home'; echo $?)"
expect "and their home offers no People link" 1 "$(curl -s -b $MCOOKIES $B/engine/home | has '/engine/people'; echo $?)"
expect "while the owner's does"         0 "$(curl -s -b $COOKIES $B/engine/home | has 'href="/engine/people"'; echo $?)"

# Every management route, against somebody who is neither owner nor admin.
expect "not an admin: the list → 403"   403 "$(code_member $B/api/users)"
expect "not an admin: creating → 403"   403 "$(code_member -d '{"email":"x@example.org","name":"X"}' $B/api/users)"
expect "not an admin: disabling → 403"  403 "$(code_member -d '{"enabled":false}' $B/api/users/$OWNER/enabled)"
expect "not an admin: a new password → 403" 403 "$(code_member -X POST $B/api/users/$OWNER/password)"
# The one route that is about the caller's own row. Fixing the spelling of your own name is not a
# privilege, and making it one would send people to an admin over a typo.
expect "but anybody renames themselves → 200" 200 "$(code_member -d '{"name":"Renamed Themselves"}' $B/api/users/me/name)"
expect "and it is logged by id, not by e-mail" 0 \
  "$(grep '"event":"user_renamed"' $WORK/password.log | grep -Fc -e "$MEMBER")"
# The member's own id, resolved independently of the comment that first minted it — the two must
# agree, which they would not if event_recorded had credited that comment to somebody else.
expect "as the member's own id, the one their comment earned them" "$MEMBER_ID" \
  "$(log_field $WORK/password.log user_renamed person)"
expect "and the listing shows the new name" "Renamed Themselves" "$(as_owner $B/api/users | jfield users.0.name)"
expect "an empty name → 400"            400 "$(code_member -d '{"name":"   "}' $B/api/users/me/name)"

expect "an e-mail that is not one → 400" 400 "$(code_owner -d '{"email":"not an address","name":"X"}' $B/api/users)"
# The bad value goes back in the message: "invalid e-mail" next to a form makes the person guess
# which field, and guess what is wrong with it.
expect "and the message quotes what was typed" 0 "$(as_owner -d '{"email":"not an address","name":"X"}' $B/api/users | has 'not an address'; echo $?)"
expect "a name nobody wrote → 400"      400 "$(code_owner -d '{"email":"other@example.org","name":"  "}' $B/api/users)"
expect "an e-mail already here → 400"   400 "$(code_owner -d "{\"email\":\"$MEMBER\",\"name\":\"Twice\"}" $B/api/users)"
expect "and the message names it"       0 "$(as_owner -d "{\"email\":\"$MEMBER\",\"name\":\"Twice\"}" $B/api/users | has "$MEMBER"; echo $?)"
expect "a new password for nobody → 404" 404 "$(code_owner -X POST $B/api/users/nobody@example.org/password)"
# A half-written escape makes decodeURIComponent throw. Uncaught, that is a 500 with an incident
# id — an answer that says "the service is broken" about a request that was merely malformed.
expect "an address nobody can decode → 404" 404 "$(code_owner -X POST --path-as-is "$B/api/users/%zz/password")"
# Below any route, and without a session: a Host header that is not a host, or a request target
# that is not a URL, would throw outside every guard and take the whole process down.
raw() { node -e "const s=require('net').connect(+process.argv[1],'127.0.0.1',()=>s.end(process.argv[2]));
  let got='';s.on('data',d=>got+=d).on('close',()=>console.log(got.split('\r\n')[0]))" "$PORT" "$1"; }
expect "a Host header that is not a host → ignored, not fatal" "HTTP/1.1 200 OK" "$(raw $'GET /api/health HTTP/1.1\r\nHost: a b\r\nConnection: close\r\n\r\n')"
expect "a request target that is not a URL → answered, not fatal" "HTTP/1.1 404 Not Found" "$(raw $'GET http://[ HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n')"
expect "and the service is still up"    200 "$(curl -s -o /dev/null -w '%{http_code}' $B/api/health)"
# The same mistake in a body: JSON.parse throws, and uncaught, a typo would come back as "the
# service is broken".
expect "a body that is not JSON → 400"  400 "$(code_owner -d '{"name":' $B/api/users/me/name)"
expect "and the message says so"        0 "$(as_owner -d '{"name":' $B/api/users/me/name | has 'not a JSON object'; echo $?)"
expect "a body of null → 400"           400 "$(code_owner -d 'null' $B/api/users/me/name)"
# A list has no fields, so every route would read it as "nothing given" and blame a field. The
# message is the check: it has to say what is actually wrong.
expect "a body that is a list → 400, and says why" 0 "$(as_owner -d '[]' $B/api/users | has 'not a JSON object'; echo $?)"
# A real 500 carries its incident id, and the id has to be in the sentence: every screen shows
# `error`, none shows `id`, and a person who cannot see the id has nothing to quote.
node -e "process.stdout.write(JSON.stringify({name:'x'.repeat(1100000)}))" > "$WORK/huge.json"
HUGE=$(as_owner --data-binary @"$WORK/huge.json" $B/api/users/me/name)
expect "a body over 1 MB → the incident id in the sentence" 0 "$(ID=$(echo "$HUGE" | jfield id); [ ${#ID} = 8 ] && echo "$HUGE" | jfield error | has -F "$ID"; echo $?)"

# ⚠️ Not even the owner may disable the owner. The service refuses to start without exactly one,
# so an owner who cannot sign in is a service where nobody can approve and nobody can hand the role
# over — and the only fix is a restart with a different variable, which is not something the person
# locked out can do from the screen they are looking at.
expect "the owner cannot be disabled → 409" 409 "$(code_owner -d '{"enabled":false}' $B/api/users/$OWNER/enabled)"
expect "and the message says how to hand it over" 0 "$(as_owner -d '{"enabled":false}' $B/api/users/$OWNER/enabled | has 'HOLDRIM_OWNER'; echo $?)"
expect "and the owner is still in"      200 "$(code_owner $B/api/me)"

# ⚠️ Nobody resets the OWNER's password but the owner. Without this an admin resets it, reads the
# new password from the response, signs in as the owner — and from then on every ✓ is signed with
# the owner's e-mail. The audit trail becomes a lie, with nothing in the record to show it.
APASS=$(as_owner -d "{\"email\":\"$ADMIN\",\"name\":\"An Admin\"}" $B/api/users | jfield password)
expect "the admin signs in → 200"       200 "$(alogin "$APASS")"
expect "an admin reaches the people screen too → 200" 200 "$(curl -s -b $ACOOKIES -o /dev/null -w '%{http_code}' $B/engine/people)"
expect "and their home links to it"     0 "$(curl -s -b $ACOOKIES $B/engine/home | has 'href="/engine/people"'; echo $?)"
expect "an admin manages people → 200"  200 "$(code_admin $B/api/users)"
expect "an admin cannot reset the owner → 409" 409 "$(code_admin -X POST $B/api/users/$OWNER/password)"
# ⚠️ The twin of the guard above: guarding only the reset leaves this route open. Who the owner IS
# comes from HOLDRIM_OWNER, not from a column, so the row can legitimately be absent — handing the
# role over leaves it missing, because first-access only runs while the store is empty. In that
# window an admin could CREATE the owner's account, read the generated password from the response,
# and be the owner from then on, never touching the reset route the other guard protects.
expect "an admin cannot create the owner → 409" 409 "$(code_admin -d "{\"email\":\"$OWNER\",\"name\":\"Not Me\"}" $B/api/users)"
expect "and the message says it is provisioned at boot" 0 "$(as_admin -d "{\"email\":\"$OWNER\",\"name\":\"Not Me\"}" $B/api/users | has 'HOLDRIM_OWNER'; echo $?)"
OWN_RESET=$(as_owner -w '\n%{http_code}' -X POST $B/api/users/$OWNER/password)
OWN_RESET_CODE=$(echo "$OWN_RESET" | tail -1); OWN_RESET=$(echo "$OWN_RESET" | sed '$d')
NEW_OWNER_PASSWORD=$(echo "$OWN_RESET" | jfield password)
expect "the owner still can, on themselves" 200 "$OWN_RESET_CODE"
# Nothing failed here, so the answer must not carry the field that means it did — see the failure
# phase far below, on its own broken store, for the one case where this is allowed to appear.
expect "and the owner's own reset carries no failed drop" 1 "$(echo "$OWN_RESET" | has 'sessionsDropped":false'; echo $?)"
# Not merely "not false" — absent. A route that always sent the field, true on success and false
# on failure, would still pass the check above and still be a caller reading the wrong thing on
# the far more common path: success.
expect "and the field is not there at all on success" 1 "$(echo "$OWN_RESET" | has 'sessionsDropped'; echo $?)"
expect "and it is logged as the owner's own id, both sides" "$OWNER_ID" \
  "$(log_field $WORK/password.log user_password_reset person)"
expect "and by the owner too — acting on themselves" "$OWNER_ID" \
  "$(log_field $WORK/password.log user_password_reset by)"
# A reset drops every session for the account, and makes no exception for "but I am the one who ran
# it": the row it deletes cannot tell a self-reset apart from one that reached the account through a
# stolen credential, and a special case here would be exactly the gap issue #113 was about. So the
# owner's OWN cookie is dead too, until they sign back in with the password this reset just handed
# them — the same login() every earlier check in this file relied on, now with a new secret.
expect "and it drops the owner's own session too → 401" 401 "$(code_owner $B/api/me)"
expect "signing back in with the password just generated → 200" 200 "$(login "$NEW_OWNER_PASSWORD")"
PASSWORD=$NEW_OWNER_PASSWORD

# ⚠️ HOLDRIM_LOCKS accounts are guarded like the owner's, on all four routes now (docs/ROLES.md, "the
# `people` capability's own table entry: disable and re-enable — never … the account of anyone who
# holds `lock`" — round 2 of #29's review, finding 1: round 1 guarded only re-enabling). Admin manages
# people in general (checked above) and is still refused here, end to end — the escalation this
# closes is the same shape as the owner's, just for whoever HOLDRIM_LOCKS names instead of
# HOLDRIM_OWNER.
#
# None of the four messages say "holds a lock" or name HOLDRIM_LOCKS (round 2's finding 5). This does
# NOT stop an admin from telling a lock-holder's account apart — the refusal necessarily shows that
# the address is reserved, and the lock-holder check runs before the ordinary "already taken" one, so
# even the STATUS CODE differs; the lock markers already in the event history name the holders anyway
# (round 3 of #29's review, finding 5). What "reserved" withholds is only the MECHANISM — that the
# reservation is HOLDRIM_LOCKS specifically, and not something else the deployment did.
expect "an admin cannot create a lock-holder's account → 409" 409 \
  "$(code_admin -d "{\"email\":\"$LOCKED\",\"name\":\"Locked\"}" $B/api/users)"
expect "and the message does not name HOLDRIM_LOCKS" 1 \
  "$(as_admin -d "{\"email\":\"$LOCKED\",\"name\":\"Locked\"}" $B/api/users | has 'HOLDRIM_LOCKS'; echo $?)"
expect "it says the account is reserved instead" 0 \
  "$(as_admin -d "{\"email\":\"$LOCKED\",\"name\":\"Locked\"}" $B/api/users | has 'is reserved'; echo $?)"
LPASS=$(as_owner -d "{\"email\":\"$LOCKED\",\"name\":\"Locked\"}" $B/api/users | jfield password)
expect "the owner creates it → a real password" 0 "$([ -n "$LPASS" ] && echo 0 || echo 1)"
expect "an admin cannot reset the lock-holder's password → 409" 409 "$(code_admin -X POST $B/api/users/$LOCKED/password)"
expect "and the message says only the owner can reset it here" 0 \
  "$(as_admin -X POST $B/api/users/$LOCKED/password | has 'only the owner can reset that password here'; echo $?)"
expect "and the reset message does not name HOLDRIM_LOCKS" 1 \
  "$(as_admin -X POST $B/api/users/$LOCKED/password | has 'HOLDRIM_LOCKS'; echo $?)"
expect "and the reset message does not say the account holds a lock" 1 \
  "$(as_admin -X POST $B/api/users/$LOCKED/password | has 'holds a lock'; echo $?)"
expect "the owner still can" 200 "$(code_owner -X POST $B/api/users/$LOCKED/password)"
# Round 1 reasoned that disabling hands out no password, so it left this direction open — missing
# that an admin who can disable a lock-holder at will can silence their ✓ at the exact moment it
# would matter, no password needed. Both directions are the owner's alone now.
expect "an admin cannot disable the lock-holder either → 409" 409 \
  "$(code_admin -d '{"enabled":false}' $B/api/users/$LOCKED/enabled)"
# Round 3 of #29's review, finding 2: this used to check only the STATUS code on this route — a
# swapped or collapsed ternary in server.ts (picking the Enable text for a disable request, or
# always picking one of the two) still answers 409 and would have slipped past every check here.
expect "and the disable message says only the owner can disable it here" 0 \
  "$(as_admin -d '{"enabled":false}' $B/api/users/$LOCKED/enabled | has 'only the owner can disable it here'; echo $?)"
expect "and the disable message does not name HOLDRIM_LOCKS" 1 \
  "$(as_admin -d '{"enabled":false}' $B/api/users/$LOCKED/enabled | has 'HOLDRIM_LOCKS'; echo $?)"
expect "and the disable message does not say the account holds a lock" 1 \
  "$(as_admin -d '{"enabled":false}' $B/api/users/$LOCKED/enabled | has 'holds a lock'; echo $?)"
expect "an admin cannot give the access back → 409" 409 \
  "$(code_admin -d '{"enabled":true}' $B/api/users/$LOCKED/enabled)"
expect "and the enable message says only the owner can give it back" 0 \
  "$(as_admin -d '{"enabled":true}' $B/api/users/$LOCKED/enabled | has 'only the owner can give that access back'; echo $?)"
expect "and the enable message does not name HOLDRIM_LOCKS either" 1 \
  "$(as_admin -d '{"enabled":true}' $B/api/users/$LOCKED/enabled | has 'HOLDRIM_LOCKS'; echo $?)"
expect "and the enable message does not say the account holds a lock either" 1 \
  "$(as_admin -d '{"enabled":true}' $B/api/users/$LOCKED/enabled | has 'holds a lock'; echo $?)"
expect "the owner CAN disable the lock-holder" 200 "$(code_owner -d '{"enabled":false}' $B/api/users/$LOCKED/enabled)"
expect "the owner re-enables it → 200" 200 "$(code_owner -d '{"enabled":true}' $B/api/users/$LOCKED/enabled)"

DISABLE=$(as_owner -w '\n%{http_code}' -d '{"enabled":false}' $B/api/users/$MEMBER/enabled)
DISABLE_CODE=$(echo "$DISABLE" | tail -1); DISABLE=$(echo "$DISABLE" | sed '$d')
expect "disabling somebody → 200"       200 "$DISABLE_CODE"
expect "and the member's disable carries no failed drop" 1 "$(echo "$DISABLE" | has 'sessionsDropped":false'; echo $?)"
# Same distinction as the owner's own reset above: absent, not merely not-false.
expect "and the field is not there at all on success either" 1 "$(echo "$DISABLE" | has 'sessionsDropped'; echo $?)"
expect "disabling is logged as the member's id, not the owner's" "$MEMBER_ID" \
  "$(log_field $WORK/password.log user_enabled_changed person)"
expect "and it is the owner who did it, not the member themselves" "$OWNER_ID" \
  "$(log_field $WORK/password.log user_enabled_changed by)"
# Without this the revocation would land whenever the cookie happened to expire: up to twelve hours
# of somebody just removed still reading, still commenting, still approving.
expect "their open session dies at once → 401" 401 "$(code_member $B/api/me)"
expect "and the right password no longer gets in → 401" 401 "$(mlogin "$MEMBER_PASSWORD")"
# ⚠️ Reads the member BY E-MAIL, not by position. The list is ordered by e-mail, so `users.0` is
# whoever sorts first, and an admin added to the fixture takes that slot — a test that silently
# changes what it asserts when somebody adds a row is worse than no test.
expect "but they are still on the list"  false "$(as_owner $B/api/users | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const u=JSON.parse(s).users.find(u=>u.email===process.argv[1]);console.log(u?u.enabled:'not listed')})" "$MEMBER")"
expect "disabling is not deleting"      "$ADMIN $LOCKED $MEMBER $OWNER" "$(emails)"
# A missing field is not "false": read as falsy, a typo in the key would silently revoke somebody.
expect "a body with no enabled → 400"   400 "$(code_owner -d '{}' $B/api/users/$MEMBER/enabled)"

ENABLE=$(as_owner -w '\n%{http_code}' -d '{"enabled":true}' $B/api/users/$MEMBER/enabled)
ENABLE_CODE=$(echo "$ENABLE" | tail -1); ENABLE=$(echo "$ENABLE" | sed '$d')
expect "giving the access back → 200"   200 "$ENABLE_CODE"
expect "and it carries no failed drop either" 1 "$(echo "$ENABLE" | has 'sessionsDropped":false'; echo $?)"
# Both the account touched and who touched it, by id — taking access away and giving it back alike.
expect "changing who may sign in is logged by id, not by e-mail" 0 \
  "$(grep '"event":"user_enabled_changed"' $WORK/password.log | grep -Ec -e "$MEMBER" -e "$OWNER")"
expect "re-enabling is logged the same way: the member's id" "$MEMBER_ID" \
  "$(log_field $WORK/password.log user_enabled_changed person)"
expect "and by the owner again"        "$OWNER_ID" \
  "$(log_field $WORK/password.log user_enabled_changed by)"
# Isolates the disable's own delete from the reset's, which happens later in this script and would
# otherwise clean up the same row and hide a disable that forgot to: nothing has been reset yet at
# this point, only disabled and given back, so a 200 here could only mean the session survived the
# disable — the exact resurrection issue #113 was about.
expect "and the session stolen before the disable is still dead now it is re-enabled" 401 \
  "$(curl -s -b $STOLEN_COOKIES -o /dev/null -w '%{http_code}' $B/api/me)"
expect "and the same password works again → 200" 200 "$(mlogin "$MEMBER_PASSWORD")"
# Every other `signed_in` assertion above expects `null`: the member's FIRST sign-in, before they had
# ever acted on anything reviewable. A hard-coded `person: null` at the call site would pass every one
# of those and still be wrong — this is the one that needs a real id, from someone who by now has one.
expect "and a sign-in by someone who has acted logs their own id" "$MEMBER_ID" \
  "$(log_field $WORK/password.log signed_in person)"
# A second cookie, opened fresh after the disable → enable round-trip and never itself disabled —
# the control for the check below: a reset has to kill THIS one too, on its own, with no disabling
# involved anywhere in its story.
ACTIVE_COOKIES=$WORK/cookies-member-active.txt
cp $MCOOKIES $ACTIVE_COOKIES
expect "this cookie is a live session too, not an empty jar → 200" 200 \
  "$(curl -s -b $ACTIVE_COOKIES -o /dev/null -w '%{http_code}' $B/api/me)"

RESET=$(as_owner -X POST $B/api/users/$MEMBER/password)
NEW_PASSWORD=$(echo "$RESET" | jfield password)
expect "a reset gives back a different password" 0 "$([ -n "$NEW_PASSWORD" ] && [ "$NEW_PASSWORD" != "$MEMBER_PASSWORD" ]; echo $?)"
expect "and the member's reset carries no failed drop" 1 "$(echo "$RESET" | has 'sessionsDropped":false'; echo $?)"
# Somebody OTHER than the owner of the account has seen this one — whoever ran the reset, and
# whatever channel carried it over. The window has to be one login long.
expect "and it demands a change"        true "$(echo "$RESET" | jfield user.mustChangePassword)"
expect "the old password stops working → 401" 401 "$(mlogin "$MEMBER_PASSWORD")"
# The reset just run touched only $MCOOKIES's owner by e-mail, never $ACTIVE_COOKIES directly — this
# is the session dying because the reset dropped it, not because anything logged it out by name.
expect "a password reset alone kills a session nobody disabled" 401 \
  "$(curl -s -b $ACTIVE_COOKIES -o /dev/null -w '%{http_code}' $B/api/me)"
expect "the new one gets in → 200"      200 "$(mlogin "$NEW_PASSWORD")"
# The scenario issue #113 reproduced end to end: a lock-holder's cookie is stolen, the owner
# disables the account, resets the password and gives the access back. Without dropping the
# session on the disable AND on the reset, the row outlives all three and this is 200 again — the
# thief still in, on an account everyone in the log above believes was cleaned up.
expect "the cookie stolen before disable → reset → enable is still dead" 401 \
  "$(curl -s -b $STOLEN_COOKIES -o /dev/null -w '%{http_code}' $B/api/me)"
expect "and it is not in the listing"   0 "$(as_owner $B/api/users | grep -Fc -e "$NEW_PASSWORD")"
expect "nor in the log"                 0 "$(grep -Fc -e "$NEW_PASSWORD" $WORK/password.log)"
expect "and a reset is logged by id, not by e-mail" 0 \
  "$(grep '"event":"user_password_reset"' $WORK/password.log | grep -Ec -e "$MEMBER" -e "$OWNER")"
expect "crediting the member's own id, not the owner's" "$MEMBER_ID" \
  "$(log_field $WORK/password.log user_password_reset person)"
expect "and run by the owner, not the member resetting their own" "$OWNER_ID" \
  "$(log_field $WORK/password.log user_password_reset by)"
# Every disable, enable and reset above ran against a store where the delete never fails — the ONE
# broken store lives in its own directory, started further below, with its own log file
# (fail-drop.log), so this count reads only this normal server's log and only what happened before
# that deliberate failure exists at all.
expect "and this normal server never once reports a failed drop" 0 \
  "$(grep -c '\"event\":\"user_sessions_not_dropped\"' $WORK/password.log)"
# The current password, asked for by change-password, is the same secret sign-in guards: guessing it
# with a session in hand has to meet the same wait. Six wrong, then the right one is still refused.
mchange() { curl -s -b $MCOOKIES -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' -d "{\"current\":\"$1\",\"next\":\"a-long-enough-new-password\"}" $B/api/change-password; }
for i in 1 2 3 4 5 6; do mchange "guess-$i" >/dev/null; done
expect "after six wrong current passwords, the right one waits → 403" 403 "$(mchange "$NEW_PASSWORD")"
expect "and so does signing in with it → 401" 401 "$(mlogin "$NEW_PASSWORD")"
rm -f $MCOOKIES

# ------------------------------------------------------------------ handing the owner role over
# ⚠️ THE window, and the one the guard above exists for. Who the owner IS comes from HOLDRIM_OWNER,
# not from a column, and first access only provisions a row while the store is EMPTY. So restarting
# with a NEW owner address over a store that already has people leaves the owner's row missing —
# and an admin who was already there could create it, read the generated password out of the
# response, and be the owner from then on.
#
# The check above the reset route never sees this path: the attacker never resets anything.
#
# The same restart is also the one place this suite can prove issue #35 without waiting for LOCKS
# (docs/ROLES.md §3): HOLDRIM_OWNER is the only way authority moves today, sessions and events both
# persist in $DATA_DIR across it, and $OWNER's own cookie ($COOKIES) is still a valid SESSION after
# the restart — signing in does not stop just because the person it names is no longer the owner.
#
# A REAL block, with its REAL current fingerprint — not D01.1.4, a fixture id that names no actual
# content — so the home's own `ownerApprovals` reading of this ✓ (below) is one `summarisePages` can
# also match against the text on disk, and count as waiting for the repository.
A01_1_1_FP=$(cli_fingerprint A01.1.1)
expect "and the owner approves a real block too, for the home's own count" 201 "$(curl -s -b $COOKIES -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' -d "{\"type\":\"approval\",\"page\":\"A01\",\"block\":\"A01.1.1\",\"fingerprint\":\"$A01_1_1_FP\"}" $B/api/events)"
# `own` (issue #31/#120's own field on `/events`), not a raw address matched against $OWNER: since
# that merge, the owner's OWN approval can print their name instead of their address (`alwaysNamed`,
# server.ts's `personDisplay`) — `own` is exactly the field the panel itself reads instead of
# comparing `author` to `me` (docs/ROLES.md, "The front end obeys the server"), so this script does
# the same rather than re-inventing a raw-address comparison the response no longer promises.
LOCK_ID=$(curl -s -b $COOKIES "$B/api/events?page=A01" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).find(e=>e.type==='approval'&&e.block==='A01.1.1'&&e.own).id))")
expect "the owner's ✓ locks, before any handover" true "$(curl -s -b $COOKIES $B/api/events/$LOCK_ID | jfield locks)"
# The home's OWN reading of the same fact (`ownerApprovals`, round 1's review, finding 3): A01.1.1 is
# locked, matches the text on disk, and was never synced, so the home counts it as waiting.
waiting_password() { curl -s -b $COOKIES -H 'Accept-Language: en' $B/engine/home | has -F 'not yet in the repository'; echo $?; }
expect "the home counts the owner's past ✓ as waiting for the repository" 0 "$(waiting_password)"
HANDOVER=newowner@example.org
kill $PID 2>/dev/null; wait $PID 2>/dev/null
HOLDRIM_ENVIRONMENT=Production HOLDRIM_OWNER=$HANDOVER HOLDRIM_ADMINS=$ADMIN HOLDRIM_IDENTITY=password \
  HOLDRIM_EVENTS=sqlite HOLDRIM_USERS_PATH=$DATA_DIR/users.db HOLDRIM_EVENTS_PATH=$DATA_DIR/events.db \
  PORT=$PORT HOLDRIM_SITE="$SITE" \
  node --import ./engine/tests/hooks/forbid-optional.js engine/api/server.ts >$WORK/handover.log 2>&1 & PID=$!
for i in $(seq 40); do curl -s $B/api/health >/dev/null 2>&1 && break; sleep 0.5; done

expect "the new owner has no account yet" 1 "$(as_admin $B/api/users | has -F "$HANDOVER"; echo $?)"
expect "and no first-access was printed" 0 "$(grep -c 'FIRST ACCESS' $WORK/handover.log)"
expect "an admin still cannot create it → 409" 409 "$(code_admin -d "{\"email\":\"$HANDOVER\",\"name\":\"Taking Over\"}" $B/api/users)"
expect "so nobody signed in as the new owner" 401 "$(curl -s -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' -d "{\"email\":\"$HANDOVER\",\"password\":\"anything-at-all\"}" $B/api/sign-in)"
# The handover itself: $OWNER is no longer HOLDRIM_OWNER in THIS process, and a `roles.can('lock', …)`
# recomputed here would say their past ✓ is not a lock any more. It has to still read as one, from
# what was written on it when it was given — otherwise every ✓ anybody ever gave un-locks the moment
# the owner hands over, which is the exact bug this issue closes.
expect "the old owner is no longer treated as owner"   member "$(curl -s -b $COOKIES $B/api/me | jfield role)"
expect "and their PAST ✓ still locks, mid-handover"    true "$(curl -s -b $COOKIES $B/api/events/$LOCK_ID | jfield locks)"
expect "and the home still counts it (ownerApprovals), mid-handover" 0 "$(waiting_password)"
kill $PID 2>/dev/null; wait $PID 2>/dev/null

HOLDRIM_ENVIRONMENT=Production HOLDRIM_OWNER=$OWNER HOLDRIM_ADMINS=$ADMIN HOLDRIM_IDENTITY=password \
  HOLDRIM_EVENTS=sqlite HOLDRIM_USERS_PATH=$DATA_DIR/users.db HOLDRIM_EVENTS_PATH=$DATA_DIR/events.db \
  PORT=$PORT HOLDRIM_SITE="$SITE" \
  node --import ./engine/tests/hooks/forbid-optional.js engine/api/server.ts >>$WORK/password.log 2>&1 & PID=$!
for i in $(seq 40); do curl -s $B/api/health >/dev/null 2>&1 && break; sleep 0.5; done

expect "logout → 200"                  200 "$(curl -s -b $COOKIES -D "$WORK/logout.h" -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' -X POST $B/api/sign-out)"
# Closing the session on the server is half of it. A browser told nothing keeps the id and sends it
# on every request, on whatever computer was left signed out — dead only for as long as the server
# side holds. Without this check, dropping the header would leave every test green.
expect "and the browser is told to forget the cookie" 1 "$(grep -ci '^set-cookie: holdrim_session=;.*max-age=0' "$WORK/logout.h")"
expect "and after logging out → 401"   401 "$(curl -s -b $COOKIES -o /dev/null -w '%{http_code}' $B/api/me)"

# The local runner has to REFUSE a port that is already answering, and this server is answering
# one. A guard that asked `ss`, which some machines lack, would read every port as free there and
# bring up a second server behind the first — the exact lie the guard exists to prevent.
# `run_for` is this file's own logic, and nothing else reaches its deadline branch: both callers
# below exit in well under a second, so without this check the watchdog, the kill and the 137→124
# translation could all be deleted and the suite would stay green. It costs one second.
echo "the deadline this suite brings its own:"
START=$(date +%s)
expect "a command that overruns comes back 124, as timeout does" 124 "$(run_for 1 sleep 5; echo $?)"
expect "and it comes back at the deadline, not after the command" 0 "$([ $(( $(date +%s) - START )) -lt 4 ] && echo 0 || echo 1)"
expect "a command that ends first keeps its own exit code" 3 "$(run_for 10 bash -c 'exit 3'; echo $?)"
# Inside a command substitution too: the watchdog inherits stdout, and when it holds the pipe open
# the caller waits the whole deadline for a command that already finished.
START=$(date +%s); CAPTURED=$(run_for 10 bash -c 'echo done; exit 0'); CAPTURED_CODE=$?
expect "and does not make the caller wait for it"  0 "$([ $(( $(date +%s) - START )) -lt 4 ] && echo 0 || echo 1)"
expect "with its output and its code intact"       "done 0" "$CAPTURED $CAPTURED_CODE"

echo "the local runner:"
RUNNER=$(PORT=$PORT HOLDRIM_OWNER=$OWNER run_for 10 bash engine/run-local.sh 2>&1); RUNNER_EXIT=$?
expect "refuses a port already in use → exits 1" 1 "$RUNNER_EXIT"
# The guard's OWN sentence, not "already in use": a second server that gets past the guard dies
# with Node's "address already in use" and exit 1 too, which would read as a pass.
expect "and says why, before starting anything" 0 "$(echo "$RUNNER" | has 'the OLD process'; echo $?)"
expect "no second server was started"  1 "$(echo "$RUNNER" | has 'Holdrim local'; echo $?)"
kill $PID 2>/dev/null; wait $PID 2>/dev/null

# The recorded events have to survive shutdown — that's the difference between sqlite and memory.
# Four by now: the owner's two approvals (D01.1.4 and A01.1.1) and the member's comment, minted for
# the exact-id checks above, plus the one `lock_baseline` event this store's first boot wrote and
# every restart since found already there (round 1's review, decision B) — the fact this whole
# section's ✓-through-a-handover checks rest on.
expect "the events are still there after shutdown" 4 "$(node -e "
  const {DatabaseSync}=require('node:sqlite');
  console.log(new DatabaseSync('$DATA_DIR/events.db').prepare('SELECT COUNT(*) c FROM events').get().c)")"
rm -rf $DATA_DIR

echo "a request's start survives an admin's grant changing, in every reader of it (round 1's review, finding 3):"
# Reverting ANY ONE of withStatus, recordEvent's own transition check, /requests/open or the home's
# in-progress list back to a LIVE roles.can('triage', …) survives the whole suite unless the grant
# actually changes between when the request was filed and when it is read again — a fresh store, one
# admin's request filed while they hold the grant, then every reader of it asked again once it is gone.
GRANT_DIR=$(mktemp -d)
GRANT_ADMIN=grant-admin@example.org
HOLDRIM_MODE=local HOLDRIM_ENVIRONMENT=Development HOLDRIM_OWNER=$OWNER HOLDRIM_ADMINS=$GRANT_ADMIN \
  HOLDRIM_DEV_EMAIL= HOLDRIM_EVENTS=sqlite HOLDRIM_EVENTS_PATH=$GRANT_DIR/events.db PORT=$PORT HOLDRIM_SITE="$SITE" \
  node --import ./engine/tests/hooks/forbid-optional.js engine/api/server.ts >$WORK/grant.log 2>&1 & PID=$!
for i in $(seq 40); do curl -s $B/api/health >/dev/null 2>&1 && break; sleep 0.5; done
GRANT_REQUEST=$(new_request $GRANT_ADMIN '{"type":"request","page":"A02","block":"A02.1.1","fingerprint":"x","text":"an admin, for now, asks"}')
gstate() { curl -s -H "X-Dev-Email: $OWNER" "$B/api/events/$GRANT_REQUEST" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).status.state))"; }
expect "born approved, while the grant holds"      approved "$(gstate)"
kill $PID 2>/dev/null; wait $PID 2>/dev/null

# The SAME store, restarted with the grant gone — nobody is $GRANT_ADMIN any more.
HOLDRIM_MODE=local HOLDRIM_ENVIRONMENT=Development HOLDRIM_OWNER=$OWNER HOLDRIM_ADMINS= \
  HOLDRIM_DEV_EMAIL= HOLDRIM_EVENTS=sqlite HOLDRIM_EVENTS_PATH=$GRANT_DIR/events.db PORT=$PORT HOLDRIM_SITE="$SITE" \
  node --import ./engine/tests/hooks/forbid-optional.js engine/api/server.ts >$WORK/grant.log 2>&1 & PID=$!
for i in $(seq 40); do curl -s $B/api/health >/dev/null 2>&1 && break; sleep 0.5; done
expect "the revoked admin is a stranger here now" member "$(curl -s -H "X-Dev-Email: $GRANT_ADMIN" $B/api/me | jfield role)"
expect "still approved (withStatus)"              approved "$(gstate)"
expect "and /requests/open does not count it"     0 "$(curl -s -H "X-Dev-Email: $OWNER" "$B/api/requests/open" | jfield toTriage)"
expect "and the home offers it no triage form (in-progress list, frozen)" 1 \
  "$(curl -s -H "X-Dev-Email: $OWNER" $B/engine/home | has -F "name=\"request\" value=\"$GRANT_REQUEST\""; echo $?)"
# recordEvent's OWN transition check: from the true, frozen 'approved' this transition is refused
# (only open/question go to rejected); a recompute that thought this request was still open — since
# $GRANT_ADMIN no longer holds triage — would let it through.
expect "a transition only valid from open is refused on the true, frozen state" 409 \
  "$(post $OWNER "{\"type\":\"request_state\",\"page\":\"A02\",\"block\":\"A02.1.1\",\"text\":\"no\",\"data\":{\"request\":\"$GRANT_REQUEST\",\"state\":\"rejected\"}}")"
kill $PID 2>/dev/null; wait $PID 2>/dev/null; rm -rf "$GRANT_DIR"

echo "a field written before this version is trusted only after the baseline (round 2's review, CRITICAL):"
# Before this version, recordEvent stored whatever `data` a client sent — so a store from that time can
# hold a plain, unwritten ✓ (`data: null`) from the owner and from an admin, and a CLIENT-FORGED
# `locks:"true"`/`authorCouldTriage:"true"` on someone else's event, exactly as the finding reproduced
# it against the pre-change build. All four are inserted straight into a fresh SQLite file, BEFORE any
# server of this version ever starts against it — so all four predate the ONE `lock_baseline` event the
# boot below is about to write, whichever of them carries a written field and whichever does not.
BASELINE_DIR=$(mktemp -d)
BASELINE_ADMIN=baseline-admin@example.org
BASELINE_MEMBER=baseline-member@example.org
BASELINE_FP=$(cli_fingerprint A01.1.1)
# The admin's unwritten ✓ needs its block's REAL fingerprint, not a placeholder (s4b, round 4's
# review): the home's "awaiting sync" count (below) only ever looks at approvals whose fingerprint
# matches the block's CURRENT one — a mismatched one, like the placeholder every other seeded ✓ here
# still uses, is skipped there regardless of what `isLocked` says about it, so a bug that made this ✓
# lock would pass unnoticed however it was seeded. It also sits on a DIFFERENT page than the owner's
# (A02, not A01): both landing on one page would let a bug swap WHICH of the two counts — the admin's
# in, the owner's now out, since neither is owner any more once HOLDRIM_OWNER moves — while the
# PAGE's total stays "1" either way, hiding the very thing this seeds to catch. On separate pages,
# the owner's page must always read "1" and the admin's must never read anything at all.
BASELINE_FP2=$(cli_fingerprint A02.1.2)
SEEDED=$(node --input-type=module -e "
const { SqliteEventStore } = await import('./engine/api/store-sqlite.ts');
const store = new SqliteEventStore(process.argv[1]);
const [owner, admin, member, fp, fp2] = process.argv.slice(2);
// A genuine pre-version ✓, never written on: locks only via legacyLock, and only for the OWNER.
const ownerNull = await store.append({ type: 'approval', page: 'A01', block: 'A01.1.1', fingerprint: fp, data: null }, owner);
const adminNull = await store.append({ type: 'approval', page: 'A02', block: 'A02.1.2', fingerprint: fp2, data: null }, admin);
// The forgeries the finding reproduced: a field this version never wrote, on an event this old.
const adminForged = await store.append({ type: 'approval', page: 'A01', block: 'A01.1.3', fingerprint: 'x', data: { locks: 'true' } }, admin);
const memberForged = await store.append({ type: 'request', page: 'A02', block: 'A02.1.1', fingerprint: 'x', text: 'a forged request', data: { authorCouldTriage: 'true' } }, member);
console.log(JSON.stringify({ ownerNull: ownerNull.id, adminNull: adminNull.id, adminForged: adminForged.id, memberForged: memberForged.id }));
await store.close();
" "$BASELINE_DIR/events.db" "$OWNER" "$BASELINE_ADMIN" "$BASELINE_MEMBER" "$BASELINE_FP" "$BASELINE_FP2")
OWNER_NULL_ID=$(echo "$SEEDED" | jfield ownerNull)
ADMIN_NULL_ID=$(echo "$SEEDED" | jfield adminNull)
ADMIN_FORGED_ID=$(echo "$SEEDED" | jfield adminForged)
MEMBER_FORGED_ID=$(echo "$SEEDED" | jfield memberForged)

HOLDRIM_MODE=local HOLDRIM_ENVIRONMENT=Development HOLDRIM_OWNER=$OWNER HOLDRIM_ADMINS=$BASELINE_ADMIN \
  HOLDRIM_DEV_EMAIL= HOLDRIM_EVENTS=sqlite HOLDRIM_EVENTS_PATH=$BASELINE_DIR/events.db PORT=$PORT HOLDRIM_SITE="$SITE" \
  node --import ./engine/tests/hooks/forbid-optional.js engine/api/server.ts >$WORK/baseline-forged.log 2>&1 & PID=$!
for i in $(seq 40); do curl -s $B/api/health >/dev/null 2>&1 && break; sleep 0.5; done
event_of() { curl -s -H "X-Dev-Email: $OWNER" "$B/api/events/$1"; }
home_waiting() { curl -s -H "X-Dev-Email: $OWNER" -H 'Accept-Language: en' $B/engine/home | has -F 'not yet in the repository'; echo $?; }
# s4b (round 4's review): the OWNER'S and the ADMIN'S unwritten ✓s are seeded on DIFFERENT pages (A01,
# A02) exactly so each page's own row can be read apart from the other's — `summarisePages` tallies
# `awaitingSync` per PAGE, and once HOLDRIM_OWNER moves to the admin, `roles.can('lock', …)` recomputed
# live (round 1's rule, s4b reverts to it) flips FROM the owner TO the admin: a check on the TOTAL
# count across both pages would read "1" either way and never notice the swap. Per page, the answer
# must never move: the owner's page always "1", the admin's page never any count at all.
home_page_row() { curl -s -H "X-Dev-Email: $OWNER" -H 'Accept-Language: en' $B/engine/home | grep "pages/$1.html\">"; }
home_page_awaiting() { home_page_row "$1" | grep -oE '[0-9]+ approved on the site, not yet in the repository'; }
# Decision B (round 1's review): a genuinely unwritten ✓ from before the field existed at all.
expect "the owner's unwritten pre-version ✓ locks via the baseline"       true  "$(event_of $OWNER_NULL_ID | jfield locks)"
expect "an admin's unwritten pre-version ✓ does not"                      false "$(event_of $ADMIN_NULL_ID | jfield locks)"
expect "and the home counts the owner's as waiting for the repository"    0     "$(home_waiting)"
# s4b: reverting `ownerApprovals` (server.ts) to round 1's rule — an absent `locks` recomputed LIVE as
# `roles.can('lock', author)` — agrees with the correct answer here, since the admin is not yet owner
# in THIS boot either way (`roles.can('lock', admin)` is false regardless). The real proof is after
# the handover below; this is the "before" half a total count could never anchor.
expect "the owner's own page reads exactly 1 awaiting sync"                "1 approved on the site, not yet in the repository" "$(home_page_awaiting A01)"
expect "and the admin's real-fingerprint ✓, on its OWN page, counts toward NOTHING" "" "$(home_page_awaiting A02)"
# Round 2's review, CRITICAL: the forged fields must not fare any better than the unwritten ones above.
expect "an admin's FORGED pre-version locks:true does not lock either"    false "$(event_of $ADMIN_FORGED_ID | jfield locks)"
expect "a member's FORGED pre-version authorCouldTriage:true starts at triage, straight into nobody's queue" \
  open "$(event_of $MEMBER_FORGED_ID | jfield status.state)"
kill $PID 2>/dev/null; wait $PID 2>/dev/null

# Restarted with HOLDRIM_OWNER moved to the admin: the baseline is FROZEN at the first boot (round 2's
# review, CRITICAL(proof), catching the baseline held as `null`) — it does not move with a LATER
# HOLDRIM_OWNER, and an admin who becomes owner earns no lock, retroactively, for a ✓ they gave before
# anyone was, forged field or not.
HOLDRIM_MODE=local HOLDRIM_ENVIRONMENT=Development HOLDRIM_OWNER=$BASELINE_ADMIN HOLDRIM_ADMINS= \
  HOLDRIM_DEV_EMAIL= HOLDRIM_EVENTS=sqlite HOLDRIM_EVENTS_PATH=$BASELINE_DIR/events.db PORT=$PORT HOLDRIM_SITE="$SITE" \
  node --import ./engine/tests/hooks/forbid-optional.js engine/api/server.ts >$WORK/baseline-forged.log 2>&1 & PID=$!
for i in $(seq 40); do curl -s $B/api/health >/dev/null 2>&1 && break; sleep 0.5; done
expect "the admin is owner here now"                                       owner "$(curl -s -H "X-Dev-Email: $BASELINE_ADMIN" $B/api/me | jfield role)"
expect "yet the old owner's pre-version ✓ still locks (the baseline is frozen)" true  "$(event_of $OWNER_NULL_ID | jfield locks)"
expect "and the now-owner's own pre-version ✓ still does not"              false "$(event_of $ADMIN_NULL_ID | jfield locks)"
expect "nor does their forged locks:true, even as owner now"               false "$(event_of $ADMIN_FORGED_ID | jfield locks)"
expect "and the forged request still starts at triage"                     open  "$(event_of $MEMBER_FORGED_ID | jfield status.state)"
# s4b, the real proof: round 1's rule would recompute `roles.can('lock', …)` LIVE — the admin IS the
# owner now, so their own page would newly count their old, real-fingerprint ✓ as "awaiting sync",
# while the OWNER, no longer holding `lock` live, would drop OUT of theirs. A check on the TOTAL
# across both pages would still read "1" — one swapped for the other — and miss exactly this; reading
# each page on its own is what catches the swap.
expect "the owner's page still reads exactly 1, even once the admin is owner (s4b)" \
  "1 approved on the site, not yet in the repository" "$(home_page_awaiting A01)"
expect "and the admin's page still counts nothing, even as owner now (s4b)" \
  "" "$(home_page_awaiting A02)"
kill $PID 2>/dev/null; wait $PID 2>/dev/null; rm -rf "$BASELINE_DIR"

echo "the local runner pins its own environment, even when the caller's shell has one:"
# A shell already exporting HOLDRIM_EVENTS=sqlite or HOLDRIM_IDENTITY=password, left over from some
# OTHER project, must not carry through: server.ts prefers the environment over the local default,
# and this runner's one promise is "test data, disappears when you stop".
LEAK=$(mktemp -d)
HOLDRIM_EVENTS=sqlite HOLDRIM_EVENTS_PATH="$LEAK/events.db" HOLDRIM_IDENTITY=password \
  HOLDRIM_USERS=sqlite:$LEAK/users.db HOLDRIM_USERS_PATH="$LEAK/users.db" PORT=$PORT \
  bash engine/run-local.sh >$WORK/leak.log 2>&1 & RUNNER_PID=$!
for i in $(seq 40); do curl -s $B/api/health >/dev/null 2>&1 && break; sleep 0.5; done
# HOLDRIM_IDENTITY=password would need a session cookie, not this header: 200 here proves the
# runner overrode it back to dev — "straight in, no login", as the top of this file documents.
expect "the caller's HOLDRIM_IDENTITY=password does not reach it" 200 \
  "$(curl -s -o /dev/null -w '%{http_code}' -H 'X-Dev-Email: someone@example.org' $B/api/me)"
kill $RUNNER_PID 2>/dev/null; wait $RUNNER_PID 2>/dev/null
expect "and the caller's HOLDRIM_EVENTS=sqlite wrote no events file: it stayed memory" 1 \
  "$([ -e "$LEAK/events.db" ] && echo 0 || echo 1)"
# The check above looks at one path, the one this test exported; a store opened anywhere else would
# pass it. The server's own boot log names the store it opened (`events: eventsKind` on
# server_listening), whatever path it took. No check looks at ./data/events.db: that is a real
# developer's default store, and a test that inspects or deletes it could destroy their events.
expect "and the server itself reports events: memory" 0 \
  "$(grep -q '\"event\":\"server_listening\".*\"events\":\"memory\"' $WORK/leak.log; echo $?)"
rm -rf "$LEAK"

echo "the local runner, on another project:"
# The README's red example, with no Docker: the runner serves the folder it is given, read from that
# folder's own holdrim.json, and opens it as its owner — the cash register names nobody to act as.
# No HOLDRIM_OWNER, as a newcomer runs it: the file cannot name the owner, so the runner does.
env -u HOLDRIM_OWNER PORT=$PORT bash engine/run-local.sh examples/cash-register >$WORK/runner.log 2>&1 & RUNNER_PID=$!
for i in $(seq 40); do curl -s $B/api/health >/dev/null 2>&1 && break; sleep 0.5; done
expect "serves the project it was given: the cash register's two reds" 2 \
  "$(curl -s $B/engine/home | grep -o '🔴</span> <strong>[0-9]*' | grep -o '[0-9]*$')"
expect "and opens it as its owner, straight in"  owner "$(curl -s $B/api/me | jfield role)"
expect "and says whose the owner is, and why"    0 "$(has -F 'owner: you@example.org, from this runner' $WORK/runner.log; echo $?)"
kill $RUNNER_PID 2>/dev/null; wait $RUNNER_PID 2>/dev/null
# The other half of that same banner line: with HOLDRIM_OWNER set, it has to name THAT as the
# source, not "this runner" — the two share one OWNER_FROM assignment in run-local.sh, and only a
# real boot with the variable set exercises the branch where it is.
HOLDRIM_OWNER=$OWNER PORT=$PORT bash engine/run-local.sh examples/cash-register >$WORK/runner-owner.log 2>&1 & RUNNER_PID=$!
for i in $(seq 40); do curl -s $B/api/health >/dev/null 2>&1 && break; sleep 0.5; done
expect "and with HOLDRIM_OWNER set, names it as the source" 0 \
  "$(has -F "owner: $OWNER, from HOLDRIM_OWNER" $WORK/runner-owner.log; echo $?)"
kill $RUNNER_PID 2>/dev/null; wait $RUNNER_PID 2>/dev/null
# The port comes from the project too, not from this repository's holdrim.json: a copy that declares
# this run's port, started with no PORT at all, has to answer on it.
cp -r examples/cash-register "$WORK/own-port"
node -e "const f=process.argv[1], c=JSON.parse(require('fs').readFileSync(f,'utf8'));
  c.development={port:+process.argv[2]}; require('fs').writeFileSync(f, JSON.stringify(c))" "$WORK/own-port/holdrim.json" "$PORT"
env -u PORT bash engine/run-local.sh "$WORK/own-port" >$WORK/runner-port.log 2>&1 & RUNNER_PID=$!
for i in $(seq 40); do curl -s $B/api/health >/dev/null 2>&1 && break; sleep 0.5; done
expect "and listens on the port that project declares" 200 "$(curl -s -o /dev/null -w '%{http_code}' $B/api/health)"
kill $RUNNER_PID 2>/dev/null; wait $RUNNER_PID 2>/dev/null
# Its own sentence, not only exit 1: under `set -e` the failed `cd` alone would exit 1 in silence.
RUNNER=$(bash engine/run-local.sh no/such/folder 2>&1); RUNNER_EXIT=$?
expect "a folder that is not there is refused"   1 "$RUNNER_EXIT"
expect "and named"                               0 "$(echo "$RUNNER" | has 'no such folder: no/such/folder'; echo $?)"
# A trailing comma in holdrim.json must not read as no file at all, the runner going on without it.
mkdir -p "$WORK/broken-config"; printf '{ "name": "Broken", }' > "$WORK/broken-config/holdrim.json"
RUNNER=$(env -u HOLDRIM_OWNER bash engine/run-local.sh "$WORK/broken-config" 2>&1); RUNNER_EXIT=$?
expect "a holdrim.json that does not parse is refused" 1 "$RUNNER_EXIT"
expect "and named as the problem"                0 "$(echo "$RUNNER" | has 'broken-config/holdrim.json is not valid JSON'; echo $?)"
expect "and nothing was started"                 1 "$(echo "$RUNNER" | has 'Holdrim local'; echo $?)"
mkdir -p "$WORK/not-a-project"
RUNNER=$(env -u HOLDRIM_OWNER bash engine/run-local.sh "$WORK/not-a-project" 2>&1); RUNNER_EXIT=$?
expect "a folder with no holdrim.json is refused" 1 "$RUNNER_EXIT"
expect "and says that is what is missing"        0 "$(echo "$RUNNER" | has 'no holdrim.json in'; echo $?)"

echo "a long history, read in linear time:"
# A list of requests that read each one's state by filtering every event, once per request, would
# cost the square of the history: at 20 000 requests these answers would take seconds each. Reading
# each request's own thread (cycle.threadsOf), they take a fraction of one. The bound is loose on
# purpose.
BIG=$(mktemp -d)
node --input-type=module -e "
const { SqliteEventStore } = await import('./engine/api/store-sqlite.ts');
const store = new SqliteEventStore(process.argv[1]);
for (let i = 0; i < 20000; i++) {
  const r = await store.append({ type: 'request', page: 'A01', block: 'A01.1.1', fingerprint: 'x', text: 'r' + i }, 'reader@example.org');
  await store.append({ type: 'request_state', page: 'A01', block: 'A01.1.1',
    data: { request: r.id, state: 'approved', from: 'open' } }, process.argv[2]);
}" "$BIG/events.db" "$OWNER"
HOLDRIM_MODE=local HOLDRIM_ENVIRONMENT=Development HOLDRIM_OWNER=$OWNER HOLDRIM_DEV_EMAIL= PORT=$PORT \
  HOLDRIM_EVENTS=sqlite HOLDRIM_EVENTS_PATH="$BIG/events.db" HOLDRIM_SITE="$SITE" \
  node engine/api/server.ts >$WORK/big.log 2>&1 & PID=$!
for i in $(seq 40); do curl -s $B/api/health >/dev/null 2>&1 && break; sleep 0.5; done
under() { node -e "process.exit(+process.argv[1] < +process.argv[2] ? 0 : 1)" "$(curl -s -o /dev/null -w '%{time_total}' -H "X-Dev-Email: $OWNER" "$2")" "$1"; echo $?; }
expect "every event, each request with its state → under 2 s"  0 "$(under 2 $B/api/events)"
expect "how many wait for triage → under 2 s"                  0 "$(under 2 $B/api/requests/open)"
expect "the project home, listing them → under 2 s"            0 "$(under 2 $B/engine/home)"
kill $PID 2>/dev/null; wait $PID 2>/dev/null; rm -rf "$BIG"

echo "with no configuration, it won't come up:"
# Outside a project (no holdrim.json) and no variable: there's nowhere to pull the owner from.
EMPTY=$(mktemp -d)
HOLDRIM_SITE=$EMPTY PORT=$PORT run_for 15 node --import ./engine/tests/hooks/forbid-optional.js engine/api/server.ts >"$WORK/no-config.log" 2>&1
expect "no owner anywhere → exits 1"   1 "$?"
expect "and says what's missing"       0 "$(grep -qi 'HOLDRIM_OWNER' $WORK/no-config.log; echo $?)"
rmdir $EMPTY

echo "authority comes from the deployment only:"
# The owner and the admins come from HOLDRIM_OWNER and HOLDRIM_ADMINS, never from holdrim.json: a
# committer, or the agent applying an approved request, could otherwise name a new owner by editing
# one line. Unit tests prove readConfig refuses the keys (engine/tests/owner.test.js); only a boot
# proves the service does not come up anyway, or come up with the file's owner.
FILE_OWNER=$(mktemp -d); cp -r "$SITE/." "$FILE_OWNER"
node -e "const f=process.argv[1]+'/holdrim.json', c=JSON.parse(require('fs').readFileSync(f,'utf8'));
  c.owner=process.argv[2]; require('fs').writeFileSync(f, JSON.stringify(c))" "$FILE_OWNER" "$REVIEWER"
HOLDRIM_MODE=local HOLDRIM_ENVIRONMENT=Development HOLDRIM_DEV_EMAIL= HOLDRIM_SITE="$FILE_OWNER" PORT=$PORT \
  run_for 15 env -u HOLDRIM_OWNER node --import ./engine/tests/hooks/forbid-optional.js engine/api/server.ts >"$WORK/file-owner.log" 2>&1
expect "the owner only in holdrim.json → exits 1"  1 "$?"
expect "and says authority is the deployment's"    0 "$(grep -q 'holdrim.json names "owner", and it may not: authority is set by the deployment' $WORK/file-owner.log; echo $?)"
expect "and names where it actually lives"         0 "$(grep -q '"owner" comes from HOLDRIM_OWNER (one e-mail), set where Holdrim runs' $WORK/file-owner.log; echo $?)"
# refuseToStart prints error.message alone (see the comment above it in server.ts). A stack trace
# reads the same to a human — the message is still in there somewhere — so nothing here would fail
# if refuseToStart were changed to log the raw Error instead: this is what catches that.
expect "printed as ONE line, not a caught exception" 1 \
  "$(grep -cE '^invalid configuration: .*holdrim\.json names \"owner\"' $WORK/file-owner.log)"
expect "with no stack frame trailing it"           1 "$(grep -qE '^ +at ' $WORK/file-owner.log; echo $?)"
# `env` execs node in its own pid, so run_for's single-pid kill still reaches the server.
HOLDRIM_MODE=local HOLDRIM_ENVIRONMENT=Development HOLDRIM_DEV_EMAIL= HOLDRIM_SITE="$FILE_OWNER" PORT=$PORT \
  run_for 15 env HOLDRIM_OWNER=$OWNER node --import ./engine/tests/hooks/forbid-optional.js engine/api/server.ts >"$WORK/file-owner-and-variable.log" 2>&1
expect "and with HOLDRIM_OWNER set as well → exits 1" 1 "$?"
node -e "const f=process.argv[1]+'/holdrim.json', c=JSON.parse(require('fs').readFileSync(f,'utf8'));
  delete c.owner; c.admins=[process.argv[2]]; require('fs').writeFileSync(f, JSON.stringify(c))" "$FILE_OWNER" "$REVIEWER"
HOLDRIM_MODE=local HOLDRIM_ENVIRONMENT=Development HOLDRIM_DEV_EMAIL= HOLDRIM_SITE="$FILE_OWNER" PORT=$PORT \
  run_for 15 env HOLDRIM_OWNER=$OWNER node --import ./engine/tests/hooks/forbid-optional.js engine/api/server.ts >"$WORK/file-admins.log" 2>&1
expect "an admin named in holdrim.json → exits 1"  1 "$?"
expect "and names the key"                         0 "$(grep -q 'holdrim.json names "admins"' $WORK/file-admins.log; echo $?)"
# The same file through the local runner: it reads the config itself, and must say why, not start.
# Under a deadline: a runner that let the file through would serve until killed, and hang the suite.
RUNNER=$(PORT=$PORT HOLDRIM_OWNER=$OWNER run_for 15 bash engine/run-local.sh "$FILE_OWNER" 2>&1); RUNNER_EXIT=$?
expect "the local runner refuses it too → exits 1" 1 "$RUNNER_EXIT"
expect "with the same reason"                      0 "$(echo "$RUNNER" | has 'authority is set by the deployment'; echo $?)"
# "with the same reason" is a substring match, and 'authority is set by the deployment' also
# appears — wrapped — inside run-local.sh's OWN "...is not valid JSON: ✗ ..." sentence, the one it
# prints for a file that will not parse at all. A run-local.sh that fell through the `||` guard on
# line 27 into THAT branch, misreporting a well-formed authority-claiming file as bad JSON, would
# still pass the check above. This one does not.
expect "and does not call it invalid JSON: it is valid JSON, just not allowed to say this" 1 \
  "$(echo "$RUNNER" | has 'not valid JSON'; echo $?)"
# The broken-config case above already proves this for a file that will not parse at all; this is
# the same guarantee for a file that parses fine but claims an authority it may not have.
expect "and never started the server"              1 "$(echo "$RUNNER" | has 'Holdrim local'; echo $?)"
rm -rf "$FILE_OWNER"
# With the variables, the same project comes up: and the admin named by HOLDRIM_ADMINS alone files a
# request that the server AND the agent's CLI both read as past triage.
HOLDRIM_MODE=local HOLDRIM_ENVIRONMENT=Development HOLDRIM_OWNER=$OWNER HOLDRIM_ADMINS=$LEAD HOLDRIM_DEV_EMAIL= PORT=$PORT \
  HOLDRIM_SITE="$SITE" \
  node --import ./engine/tests/hooks/forbid-optional.js engine/api/server.ts >$WORK/variable-owner.log 2>&1 & PID=$!
for i in $(seq 40); do curl -s $B/api/health >/dev/null 2>&1 && break; sleep 0.5; done
expect "HOLDRIM_OWNER alone: it comes up, and names the owner" owner "$(curl -s -H "X-Dev-Email: $OWNER" $B/api/me | jfield role)"
expect "and HOLDRIM_ADMINS names the admin"        admin "$(curl -s -H "X-Dev-Email: $LEAD" $B/api/me | jfield role)"
ADMIN_REQUEST=$(new_request $LEAD '{"type":"request","page":"A01","block":"A01.1.1","fingerprint":"x","text":"an admin asks"}')
expect "the server starts the admin's request approved" approved "$(curl -s -H "X-Dev-Email: $OWNER" "$B/api/events/$ADMIN_REQUEST" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).status.state))")"
# The fact itself, not only its effect: the state above could, in principle, still be a recompute
# that happens to agree because nothing has been revoked yet. This is what proves the server wrote
# the CAPABILITY the admin held at that instant onto the event (docs/ROLES.md §3) — the fact
# `holdrim list` reads instead of asking its own HOLDRIM_ADMINS about a request filed somewhere else.
expect "and the admin's capability at that instant is ON the event, not only its effect" true \
  "$(curl -s -H "X-Dev-Email: $OWNER" "$B/api/events/$ADMIN_REQUEST" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).data.authorCouldTriage))")"
expect "and so does the CLI, from the same variables" approved "$(HOLDRIM_OWNER=$OWNER HOLDRIM_ADMINS=$LEAD HOLDRIM_LOCAL_URL=$B node engine/cli/holdrim.ts list --all --json --local --root "$SITE" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).requests.find(r=>r.id===process.argv[1])?.state))" "$ADMIN_REQUEST")"
kill $PID 2>/dev/null; wait $PID 2>/dev/null
TWO=$(mktemp -d); cp "$SITE/holdrim.json" "$TWO/holdrim.json"
HOLDRIM_SITE="$TWO" PORT=$PORT \
  run_for 15 env HOLDRIM_OWNER=a@example.org,b@example.org node --import ./engine/tests/hooks/forbid-optional.js engine/api/server.ts >"$WORK/two-owners.log" 2>&1
expect "two owners in the variable → exits 1" 1 "$?"
expect "and says it needs exactly one"        0 "$(grep -q 'exactly one e-mail (got 2)' $WORK/two-owners.log; echo $?)"
rm -rf "$TWO"

# Firestore is optional: configured but not installed, the boot has to fail and name the package,
# not come up half-working or die in a module-resolution stack. The forbid-optional hook stands in
# for "not installed" — it refuses the package exactly the way a missing one would.
echo "with Firestore configured but not installed:"
HOLDRIM_EVENTS=firestore HOLDRIM_PROJECT=some-project HOLDRIM_OWNER=$OWNER HOLDRIM_SITE="$SITE" PORT=$PORT \
  run_for 15 node --import ./engine/tests/hooks/forbid-optional.js engine/api/server.ts >"$WORK/no-firestore.log" 2>&1
expect "it refuses to start → exits 1"  1 "$?"
expect "and names the missing package"   0 "$(grep -q 'HOLDRIM_EVENTS=firestore needs the optional package @google-cloud/firestore' $WORK/no-firestore.log; echo $?)"

# ------------------------------------------------------------------ when the session drop itself fails
echo "when the delete behind a reset or a disable fails, not silently:"
# A real failure of \`deleteSessionsForEmail\`, staged from OUTSIDE the store: a trigger on the
# \`sessions\` table that raises for one specific address, added to the file BEFORE the server ever
# opens it — so there is only ever one writer touching it, and nothing here races the server that is
# about to run. The schema comes from opening it through UsersSqlite itself, not a copy of its SQL,
# so this stays true if a column or an index there ever changes.
BROKEN=broken@example.org
FAIL_DIR=$(mktemp -d)
# The owner's row is seeded here too, with a KNOWN password: `firstAccess` only runs while the
# store is still EMPTY, and by the time the server opens this file it already holds Broken's row —
# it would never mint the owner's account or print one to read back out of the log.
node --input-type=module -e "
import { UsersSqlite } from './engine/api/users-sqlite.ts';
import { DatabaseSync } from 'node:sqlite';
const path = process.argv[1] + '/users.db';
const store = new UsersSqlite(path);
await store.create(process.argv[2], 'Owner', process.argv[4], false);
await store.create(process.argv[3], 'Broken', 'a-long-enough-password');
await store.close();
const db = new DatabaseSync(path);
// A SQL string literal, single-quoted — NOT JSON.stringify's double quotes, which SQLite reads as
// an unresolved COLUMN name and refuses on every delete, not only this one address's.
const literal = \"'\" + process.argv[3].replace(/'/g, \"''\") + \"'\";
// The owner's own address is caught too, not only Broken's: issue #115's own drop
// (\`deleteSessionsForEmailExcept\`) is still a DELETE on this same table, and the owner is the one
// account below that calls \`/api/change-password\` on itself — Broken's account is disabled before
// that point and has no session left to call it with.
const ownerLiteral = \"'\" + process.argv[2].replace(/'/g, \"''\") + \"'\";
db.exec('CREATE TRIGGER break_drop BEFORE DELETE ON sessions WHEN OLD.email = ' + literal
  + ' OR OLD.email = ' + ownerLiteral + ' BEGIN SELECT RAISE(ABORT, \\'boom\\'); END;');
db.close();
" "$FAIL_DIR" "$OWNER" "$BROKEN" "a-long-enough-password"
HOLDRIM_ENVIRONMENT=Production HOLDRIM_OWNER=$OWNER HOLDRIM_IDENTITY=password HOLDRIM_EVENTS=sqlite \
  HOLDRIM_USERS_PATH=$FAIL_DIR/users.db HOLDRIM_EVENTS_PATH=$FAIL_DIR/events.db PORT=$PORT HOLDRIM_SITE="$SITE" \
  node --import ./engine/tests/hooks/forbid-optional.js engine/api/server.ts >$WORK/fail-drop.log 2>&1 & PID=$!
for i in $(seq 40); do curl -s $B/api/health >/dev/null 2>&1 && break; sleep 0.5; done
FAIL_COOKIES=$WORK/cookies-fail-owner.txt
curl -s -c $FAIL_COOKIES -o /dev/null -H 'Content-Type: application/json' \
  -d "{\"email\":\"$OWNER\",\"password\":\"a-long-enough-password\"}" $B/api/sign-in >/dev/null
as_fail_owner() { curl -s -b $FAIL_COOKIES -H 'Content-Type: application/json' "$@"; }
# The account needs an open session for a failed drop to mean anything — a row with nothing to
# delete would pass every check below whether or not the trigger even ran.
BROKEN_COOKIES=$WORK/cookies-broken.txt
curl -s -c $BROKEN_COOKIES -o /dev/null -H 'Content-Type: application/json' \
  -d "{\"email\":\"$BROKEN\",\"password\":\"a-long-enough-password\"}" $B/api/sign-in >/dev/null

DISABLE=$(as_fail_owner -w '\n%{http_code}' -d '{"enabled":false}' $B/api/users/$BROKEN/enabled)
DISABLE_CODE=$(echo "$DISABLE" | tail -1); DISABLE=$(echo "$DISABLE" | sed '$d')
expect "disabling still takes effect → 200, not 500" 200 "$DISABLE_CODE"
expect "and the answer says the drop failed"       false "$(echo "$DISABLE" | jfield sessionsDropped)"
expect "the account really is disabled regardless" 401 \
  "$(curl -s -b $BROKEN_COOKIES -o /dev/null -w '%{http_code}' $B/api/me)"

RESET=$(as_fail_owner -w '\n%{http_code}' -X POST $B/api/users/$BROKEN/password)
RESET_CODE=$(echo "$RESET" | tail -1); RESET=$(echo "$RESET" | sed '$d')
expect "a reset still hands back the new password → 200, not 500" 200 "$RESET_CODE"
expect "and the answer says its own drop failed too" false "$(echo "$RESET" | jfield sessionsDropped)"
expect "the credential still changed"          0 "$([ -n "$(echo "$RESET" | jfield password)" ] && echo 0 || echo 1)"

# Issue #115's own drop, staged on the SAME trigger: a second session for the owner, opened only so
# the delete this fires has something in it to fail on — a row with nothing to delete would pass
# whether or not the trigger even ran, same as the note on $BROKEN_COOKIES above.
FAIL_SECOND_COOKIES=$WORK/cookies-fail-owner-second.txt
curl -s -c $FAIL_SECOND_COOKIES -o /dev/null -H 'Content-Type: application/json' \
  -d "{\"email\":\"$OWNER\",\"password\":\"a-long-enough-password\"}" $B/api/sign-in >/dev/null
CHANGE=$(as_fail_owner -w '\n%{http_code}' -d '{"current":"a-long-enough-password","next":"a-long-enough-new-password"}' $B/api/change-password)
CHANGE_CODE=$(echo "$CHANGE" | tail -1); CHANGE=$(echo "$CHANGE" | sed '$d')
expect "changing your own password still takes effect → 200, not 500" 200 "$CHANGE_CODE"
expect "and the answer says this drop failed too"  false "$(echo "$CHANGE" | jfield sessionsDropped)"
# The trigger really did abort the delete, not merely get reported as having done so: the OTHER
# session survives, live, exactly the gap a failed \`deleteSessionsForEmailExcept\` leaves open.
expect "and the other session really is still alive, not merely reported so" 200 \
  "$(curl -s -b $FAIL_SECOND_COOKIES -o /dev/null -w '%{http_code}' $B/api/me)"

# All three failures have to reach the log — silently is the exact bug this closes — and none may
# name an account by e-mail: docs/PRIVACY.md says a log names a person by id, and this is the one
# line that used to carry the address instead, read straight out of \`console.error\` inside the
# store. \`grep -c\` and not \`has\`: a MISSING line is as much a bug here as a line with the e-mail
# in it, and the count catches both while \`has\` alone would only catch the second.
expect "all three are reported at ERROR severity, not swallowed" 3 \
  "$(grep -c '\"event\":\"user_sessions_not_dropped\".*\"severity\":\"ERROR\"\|\"severity\":\"ERROR\".*\"event\":\"user_sessions_not_dropped\"' $WORK/fail-drop.log)"
expect "and none of the three lines carries an e-mail"     0 \
  "$(grep '\"event\":\"user_sessions_not_dropped\"' $WORK/fail-drop.log | grep -Ec -e "$BROKEN" -e "$OWNER")"
kill $PID 2>/dev/null; wait $PID 2>/dev/null
rm -rf "$FAIL_DIR"

echo "tampered texts: the banner's findings, and the owner's acknowledgement (issue #107):"
# SQLite, so a direct writer can reach the file the server has open — the only way a text is ever
# tampered with. The admin ($LEAD), the member ($REVIEWER) and the agent ($AGENT) are each refused.
TAMPER_DIR=$(mktemp -d)
HOLDRIM_MODE=local HOLDRIM_ENVIRONMENT=Development HOLDRIM_OWNER=$OWNER HOLDRIM_ADMINS=$LEAD HOLDRIM_DEV_EMAIL= PORT=$PORT \
  HOLDRIM_EVENTS=sqlite HOLDRIM_EVENTS_PATH=$TAMPER_DIR/events.db HOLDRIM_SITE="$SITE" HOLDRIM_AGENTS=$AGENT \
  node --import ./engine/tests/hooks/forbid-optional.js engine/api/server.ts >$WORK/tamper.log 2>&1 & PID=$!
for i in $(seq 40); do curl -s $B/api/health >/dev/null 2>&1 && break; sleep 0.5; done
tampered() { curl -s -H "X-Dev-Email: $1" $B/api/tampered; }
# `findings.length`, then each finding's kind, then its id, then canAcknowledge — one line to compare.
findings_of() { tampered "$1" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const r=JSON.parse(s);console.log([r.findings.length,...r.findings.map(f=>f.kind+'@'+f.page)].join(' '))})"; }
finding_id() { tampered $OWNER | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).findings[0]?.finding ?? ''))"; }
acknowledge() { curl -s -o /dev/null -w '%{http_code}' ${1:+-H "X-Dev-Email: $1"} -H 'Content-Type: application/json' -d "$2" $B/api/tampered/acknowledge; }
direct_write() { node --no-warnings --input-type=module -e "
  import { DatabaseSync } from 'node:sqlite'; import { hashText, newSalt } from './engine/api/texts.ts';
  const db = new DatabaseSync(process.argv[1]);
  if (process.argv[2] === 'event') db.prepare(\"INSERT INTO events (id, type, page, block, author, happened_at, text_hash) VALUES ('forged1', 'comment', 'A01', 'A01.1.1', 'r@example.org', ?, ?)\").run(new Date().toISOString(), hashText('the real text', newSalt()));
  else db.prepare(\"INSERT INTO texts (event, field, value, salt) VALUES ('forged1', 'text', 'a forged text', ?)\").run(newSalt());
  db.close();" "$TAMPER_DIR/events.db" "$1"; }
criticals() { grep -c '"event":"text_tampered"' $WORK/tamper.log; }

expect "nothing tampered: the banner has nothing to show"   0 "$(findings_of $REVIEWER)"
# A hash with no row, and nothing that says it was let go: unaccounted.
direct_write event
expect "a text a direct writer left with no row: every reader is told" "1 unaccounted@A01" "$(findings_of $REVIEWER)"
expect "and only the owner is offered to acknowledge it"   "true false false false" \
  "$(for who in $OWNER $LEAD $REVIEWER $AGENT; do tampered $who | jfield canAcknowledge; done | tr '\n' ' ' | sed 's/ $//')"
FINDING=$(finding_id); require_id "$FINDING" "the finding id from GET /api/tampered"
expect "an admin cannot acknowledge it → 403"              403 "$(acknowledge $LEAD "{\"finding\":\"$FINDING\"}")"
expect "a member cannot → 403"                             403 "$(acknowledge $REVIEWER "{\"finding\":\"$FINDING\"}")"
expect "an agent cannot → 403"                             403 "$(acknowledge $AGENT "{\"finding\":\"$FINDING\"}")"
expect "nobody signed in cannot → 401"                     401 "$(acknowledge '' "{\"finding\":\"$FINDING\"}")"
expect "an admin sending forged owner fields still cannot → 403" 403 \
  "$(acknowledge $LEAD "{\"finding\":\"$FINDING\",\"owner\":true,\"author\":\"$OWNER\",\"asAgent\":\"false\",\"data\":{\"asAgent\":\"false\"}}")"
expect "nor through POST /events, even as the owner → 400" 400 \
  "$(post $OWNER "{\"type\":\"tamper_acknowledged\",\"page\":\"A01\",\"data\":{\"finding\":\"$FINDING\",\"event\":\"forged1\",\"field\":\"text\"}}")"
# `data` on an ordinary event is the client's to write: a comment naming the finding must quiet
# nothing, or any member — or the agent — walks round the owner-only route.
expect "a member may still comment with the finding's id in its data → 201" 201 \
  "$(post $REVIEWER "{\"type\":\"comment\",\"page\":\"A01\",\"block\":\"A01.1.1\",\"text\":\"hi\",\"data\":{\"finding\":\"$FINDING\"}}")"
expect "and so may the agent → 201"                        201 \
  "$(post $AGENT "{\"type\":\"comment\",\"page\":\"A01\",\"block\":\"A01.1.1\",\"text\":\"hi\",\"data\":{\"finding\":\"$FINDING\",\"asAgent\":\"false\"}}")"
# Identity before the body: a non-owner is told "not yours", never what their body got wrong.
expect "an admin naming no finding → 403, not 400"         403 "$(acknowledge $LEAD '{}')"
expect "an admin sending a body that is not JSON → 403, not 400" 403 "$(acknowledge $LEAD 'not json')"
expect "and none of that quieted it"                       "1 unaccounted@A01" "$(findings_of $REVIEWER)"
expect "the owner naming no finding → 400"                 400 "$(acknowledge $OWNER '{}')"
expect "the owner naming one nobody found → 409"           409 "$(acknowledge $OWNER "{\"finding\":\"$(printf 'a%.0s' $(seq 64))\"}")"
ACK=$(curl -s -H "X-Dev-Email: $OWNER" -H 'Content-Type: application/json' -d "{\"finding\":\"$FINDING\",\"asAgent\":\"true\"}" $B/api/tampered/acknowledge)
expect "the owner acknowledges it: an event, by the owner"  "tamper_acknowledged $OWNER" "$(echo "$ACK" | jfield type) $(echo "$ACK" | jfield author)"
expect "naming what the server found, not what was sent"   "forged1 text unaccounted $FINDING false" \
  "$(for k in event field kind finding asAgent; do echo "$ACK" | jfield data.$k; done | tr '\n' ' ' | sed 's/ $//')"
expect "and the banner has nothing left to show"           0 "$(findings_of $REVIEWER)"
expect "a finding already acknowledged → 409"              409 "$(acknowledge $OWNER "{\"finding\":\"$FINDING\"}")"
expect "the text still reads as tampered: nothing was repaired" true \
  "$(curl -s -H "X-Dev-Email: $OWNER" "$B/api/events?page=A01" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).find(e=>e.id==='forged1').textTampered))")"
# Counted AFTER the acknowledgement and the reads above it, then one read more: the route's own read
# logs the line too, so a count taken before the POST would grow even if acknowledging silenced it.
AFTER_ACK=$(criticals)
curl -s -o /dev/null -H "X-Dev-Email: $REVIEWER" $B/api/tampered
expect "and the CRITICAL line still fires on the next read" 0 "$([ "$(criticals)" -gt "$AFTER_ACK" ]; echo $?)"
ACK_AUTHOR_ID=$(echo "$ACK" | jfield authorId); require_id "$ACK_AUTHOR_ID" "the acknowledgement's authorId"
expect "the log records the acknowledgement, once"         1 "$(grep -c '"event":"tamper_acknowledged"' $WORK/tamper.log)"
expect "naming its author by id"                           "$ACK_AUTHOR_ID" "$(log_field $WORK/tamper.log tamper_acknowledged author)"
expect "and never by address"                              0 "$(grep '"event":"tamper_acknowledged"' $WORK/tamper.log | grep -c -F "$OWNER")"
# The same field, tampered again — a row put back that does not hold the recorded text.
direct_write row
expect "a new tampering of the same field raises it again" "1 overwritten@A01" "$(findings_of $REVIEWER)"
expect "as a finding of its own, not the one acknowledged" 1 "$([ "$(finding_id)" = "$FINDING" ]; echo $?)"
kill $PID 2>/dev/null; wait $PID 2>/dev/null
rm -rf "$TAMPER_DIR"

echo "a grant that names an agent refuses to start (docs/ROLES.md, section 4):"
# The louder of the two layers: `can` would deny the agent anyway (engine/tests/roles.test.js proves
# that one alone), but a deployment that contradicts itself is told so before it serves anything.
# One boot per variable, since each is its own branch of `refuseGrantsToAgents`.
for GRANT in "HOLDRIM_OWNER=$AGENT" "HOLDRIM_ADMINS=$AGENT" "HOLDRIM_LOCKS=$AGENT:A01"; do
  VARIABLE=${GRANT%%=*}
  # In a subshell, so nothing exported here outlives the one boot; `$GRANT` last, so the owner case
  # replaces the plain owner exported before it.
  REFUSED=$(export HOLDRIM_MODE=local HOLDRIM_ENVIRONMENT=Development HOLDRIM_OWNER=$OWNER \
    HOLDRIM_DEV_EMAIL= PORT=$PORT HOLDRIM_SITE="$SITE" HOLDRIM_AGENTS=$AGENT "$GRANT"
    run_for 10 node engine/api/server.ts 2>&1); REFUSED_EXIT=$?
  expect "$VARIABLE naming an agent: the server exits 1"   1 "$REFUSED_EXIT"
  expect "$VARIABLE naming an agent: and says which"       0 \
    "$(echo "$REFUSED" | has "$VARIABLE names $AGENT, which HOLDRIM_AGENTS marks as an agent"; echo $?)"
done

echo "a HOLDRIM_LOCKS scope is checked against the site at start (#33, docs/ROLES.md's attack table):"
# The hello-world site has pages A01 and A02 and nothing else: `P0*` and `A01.9.9` match none of it.
for SCOPE in "P0*" "A01.9.9"; do
  REFUSED=$(export HOLDRIM_MODE=local HOLDRIM_ENVIRONMENT=Development HOLDRIM_OWNER=$OWNER \
    HOLDRIM_DEV_EMAIL= PORT=$PORT HOLDRIM_SITE="$SITE" HOLDRIM_LOCKS="lead@example.org:$SCOPE"
    run_for 10 node engine/api/server.ts 2>&1); REFUSED_EXIT=$?
  expect "a scope matching nothing ($SCOPE): the server exits 1" 1 "$REFUSED_EXIT"
  expect "and says which scope"                                   0 \
    "$(echo "$REFUSED" | has -F "the scope \"$SCOPE\", which matches no page"; echo $?)"
  expect "without naming who it was granted to"                    1 "$(echo "$REFUSED" | has -F 'lead@example.org'; echo $?)"
done
# A scope that does match starts, and the log says what it reaches.
HOLDRIM_MODE=local HOLDRIM_ENVIRONMENT=Development HOLDRIM_OWNER=$OWNER HOLDRIM_DEV_EMAIL= PORT=$PORT \
  HOLDRIM_SITE="$SITE" HOLDRIM_LOCKS="lead@example.org:A0*" \
  node --import ./engine/tests/hooks/forbid-optional.js engine/api/server.ts >$WORK/coverage.log 2>&1 & PID=$!
for i in $(seq 40); do curl -s $B/api/health >/dev/null 2>&1 && break; sleep 0.5; done
expect "a scope that matches: the server comes up"  200 "$(curl -s -o /dev/null -w '%{http_code}' $B/api/health)"
expect "and logs what it reaches"                   0 "$(grep '"event":"lock_scope_coverage"' $WORK/coverage.log | has -F '"scope":"A0*","reaches":["A01","A02"]'; echo $?)"
expect "without naming who it was granted to"       1 "$(grep '"event":"lock_scope_coverage"' $WORK/coverage.log | has -F 'lead@example.org'; echo $?)"
kill $PID 2>/dev/null; wait $PID 2>/dev/null

# ------------------------------------------------------------------ an agent's token of its own
# Issue #122, docs/ROLES.md section 4. Its own server, under password sign-in — the only identity
# with a user store for tokens to live in — with an owner, an admin, a member and a lock-holder, so
# each refusal below is told apart from the others. Every check here is one no unit test reaches:
# the routes, the resolution of a bearer, and the CLI speaking to a real server.
echo "an agent's token of its own (issue #122):"
TOKEN_DIR=$(mktemp -d); TLOG=$WORK/tokens.log
T_ADMIN=tadmin@example.org; T_MEMBER=tmember@example.org; T_LOCKED=tlocked@example.org
BOT=bot@example.org
# Issued a token now, and given a grant by a restart further down: the two ways a token's address can
# end up somebody the deployment trusts, after the owner issued it for an agent.
PROMOTED=promoted@example.org; HEIR=heir@example.org
start_token_server() {
  HOLDRIM_ENVIRONMENT=Production HOLDRIM_OWNER=$1 HOLDRIM_ADMINS=$2 HOLDRIM_LOCKS="$T_LOCKED:A0*" \
    HOLDRIM_IDENTITY=password HOLDRIM_EVENTS=sqlite \
    HOLDRIM_USERS_PATH=$TOKEN_DIR/users.db HOLDRIM_EVENTS_PATH=$TOKEN_DIR/events.db PORT=$PORT \
    HOLDRIM_SITE="$SITE" \
    node --import ./engine/tests/hooks/forbid-optional.js engine/api/server.ts >>$TLOG 2>&1 & PID=$!
  for i in $(seq 40); do curl -s $B/api/health >/dev/null 2>&1 && break; sleep 0.5; done
}
start_token_server $OWNER $T_ADMIN
T_OWNER_PASSWORD=$(grep -A2 'FIRST ACCESS' $TLOG | sed -n -E 's/.*password: *//p' | head -1)
require_id "$T_OWNER_PASSWORD" T_OWNER_PASSWORD
TOC=$WORK/tokens-owner.txt; TAC=$WORK/tokens-admin.txt; TMC=$WORK/tokens-member.txt
t_signin() { curl -s -c "$1" -o /dev/null -H 'Content-Type: application/json' -d "{\"email\":\"$2\",\"password\":\"$3\"}" $B/api/sign-in; }
t_owner()  { curl -s -b $TOC -H 'Content-Type: application/json' -H 'Accept-Language: en' "$@"; }
t_admin()  { curl -s -b $TAC -H 'Content-Type: application/json' -H 'Accept-Language: en' "$@"; }
t_member() { curl -s -b $TMC -H 'Content-Type: application/json' -H 'Accept-Language: en' "$@"; }
t_signin $TOC $OWNER "$T_OWNER_PASSWORD"
# The owner's row exists from boot (the lock baseline), so their sign-in names them by id.
OWNER_LOG_ID=$(log_field $TLOG signed_in person)
require_id "$OWNER_LOG_ID" OWNER_LOG_ID
t_signin $TAC $T_ADMIN "$(t_owner -d "{\"email\":\"$T_ADMIN\",\"name\":\"An Admin\"}" $B/api/users | jfield password)"
t_signin $TMC $T_MEMBER "$(t_owner -d "{\"email\":\"$T_MEMBER\",\"name\":\"A Member\"}" $B/api/users | jfield password)"
expect "(the admin is signed in)"  admin  "$(t_admin $B/api/me | jfield role)"
expect "(the member is signed in)" member "$(t_member $B/api/me | jfield role)"
issue() { "$@" -o /dev/null -w '%{http_code}' -d "{\"email\":\"$BOT\"}" $B/api/agent-tokens; }
say_en() { node -e "console.log(JSON.parse(require('fs').readFileSync('engine/locales/en.json','utf8'))[process.argv[1]].replace('{email}', process.argv[2] ?? ''))" "$@"; }

# Owner decision 1: the owner alone. An admin holds `people`, and `people` does not reach tokens.
expect "a member cannot issue an agent token → 403"                      403 "$(issue t_member)"
expect "an admin cannot issue one either: people does not reach it → 403" 403 "$(issue t_admin)"
expect "and says only the owner does"            "$(say_en api.agentTokens.ownerOnly)" "$(t_admin -d "{\"email\":\"$BOT\"}" $B/api/agent-tokens | jfield error)"
expect "so nothing was issued by either"         ""  "$(t_owner $B/api/agent-tokens | jfield agents.0.email)"
expect "the owner's own address cannot hold one → 409" 409 "$(t_owner -o /dev/null -w '%{http_code}' -d "{\"email\":\"$OWNER\"}" $B/api/agent-tokens)"
expect "nor an admin's → 409"                    409 "$(t_owner -o /dev/null -w '%{http_code}' -d "{\"email\":\"$T_ADMIN\"}" $B/api/agent-tokens)"
expect "nor a lock-holder's → 409"               409 "$(t_owner -o /dev/null -w '%{http_code}' -d "{\"email\":\"$T_LOCKED\"}" $B/api/agent-tokens)"
expect "nor something that is not an address → 400" 400 "$(t_owner -o /dev/null -w '%{http_code}' -d '{"email":"not-an-address"}' $B/api/agent-tokens)"
# By sentence, not by status: the owner is an admin too (`roles.admins`), so the grant check below the
# owner's own would answer the same 409 if the owner's were gone.
expect "and the owner's is refused as the owner's"  "$(say_en api.agentTokens.notForTheOwner)" "$(t_owner -d "{\"email\":\"$OWNER\"}" $B/api/agent-tokens | jfield error)"
# The owner's decision (round 2): an address is a person's or an agent's, never both. Disabled is
# still an account — disabling a person has to stop them, and a token on their address would not.
T_GONE=tgone@example.org
expect "(the owner creates an account, and the admin disables it)" "201 200" \
  "$(t_owner -o /dev/null -w '%{http_code}' -d "{\"email\":\"$T_GONE\",\"name\":\"Gone\"}" $B/api/users) $(t_admin -o /dev/null -w '%{http_code}' -d '{"enabled":false}' $B/api/users/$T_GONE/enabled)"
expect "nor an address with an account, even a disabled one → 409" 409 "$(t_owner -o /dev/null -w '%{http_code}' -d "{\"email\":\"$T_GONE\"}" $B/api/agent-tokens)"
expect "saying the address is a person's"        "$(say_en api.agentTokens.hasAccount $T_GONE)" "$(t_owner -d "{\"email\":\"$T_GONE\"}" $B/api/agent-tokens | jfield error)"

ISSUED=$(t_owner -w '\n%{http_code}' -d "{\"email\":\"$BOT\"}" $B/api/agent-tokens)
ISSUE_CODE=$(echo "$ISSUED" | tail -1); ISSUED=$(echo "$ISSUED" | sed '$d')
BOT_TOKEN=$(echo "$ISSUED" | jfield token)
require_id "$BOT_TOKEN" BOT_TOKEN
BOT_TOKEN_ID=$(echo "$BOT_TOKEN" | sed -E 's/^holdrim_agent_([0-9a-f]{24})_.*/\1/')
BOT_SECRET=${BOT_TOKEN##*_}
expect "the owner issues one → 201"              201 "$ISSUE_CODE"
expect "shaped as an agent token"                1 "$(echo "$BOT_TOKEN" | grep -cE '^holdrim_agent_[0-9a-f]{24}_[0-9a-f]{64}$')"
expect "for the address asked, of kind agent"    "$BOT agent" "$(echo "$ISSUED" | jfield agent.email) $(echo "$ISSUED" | jfield agent.kind)"
# Shown once: in the answer that issued it, and nowhere else a person, a script or a log reader looks.
expect "the list names the agent"                "$BOT" "$(t_owner $B/api/agent-tokens | jfield agents.0.email)"
expect "and when its token was issued (decision 2: it never expires)" 1 "$(t_owner $B/api/agent-tokens | jfield agents.0.issuedAt | grep -cE '^[0-9]{4}-[0-9]{2}-[0-9]{2}T')"
expect "an admin reads the list too"             "$BOT" "$(t_admin $B/api/agent-tokens | jfield agents.0.email)"
expect "a member does not → 403"                 403 "$(t_member -o /dev/null -w '%{http_code}' $B/api/agent-tokens)"
expect "the secret is in no list of tokens"      0 "$(t_owner $B/api/agent-tokens | grep -Fc -e "$BOT_SECRET")"
expect "nor in the people list"                  0 "$(t_owner $B/api/users | grep -Fc -e "$BOT_SECRET")"
expect "nor on the people screen"                0 "$(t_owner $B/engine/people | grep -Fc -e "$BOT_SECRET")"
# The server decides who is drawn the controls (`servePeople`): the owner, who alone may use them.
expect "the people screen offers the owner the issue form and a revoke" "1 1" \
  "$(t_owner $B/engine/people | grep -c 'id="issue"') $(t_owner $B/engine/people | grep -c 'data-action="revoke"')"
expect "and an admin, who sees the list, neither" "0 0 1" \
  "$(t_admin $B/engine/people | grep -c 'id="issue"') $(t_admin $B/engine/people | grep -c 'data-action="revoke"') $(t_admin $B/engine/people | grep -Fc "$BOT")"
# The other side of the owner's decision: an agent's address never becomes a person's.
expect "an account for an address holding a token → 409, from an admin" 409 "$(t_admin -o /dev/null -w '%{http_code}' -d "{\"email\":\"$BOT\",\"name\":\"Bot\"}" $B/api/users)"
expect "and from the owner, saying the address holds a token" "$(say_en api.users.holdsAgentToken $BOT)" "$(t_owner -d "{\"email\":\"$BOT\",\"name\":\"Bot\"}" $B/api/users | jfield error)"
expect "so no account exists for it"             0 "$(t_owner $B/api/users | grep -Fc "\"$BOT\"")"
expect "nor in any event"                        0 "$(t_owner $B/api/events | grep -Fc -e "$BOT_SECRET")"
expect "nor anywhere in the log"                 0 "$(grep -Fc -e "$BOT_SECRET" $TLOG)"
# The trail: who issued, which agent, which token — and the server's own route is the only door.
token_events() { t_owner "$B/api/events?page=_agent_tokens" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).filter(e=>e.type===process.argv[1]&&e.data.tokenId===process.argv[2]).map(e=>[e.own,(String(e.data.agent).startsWith('p_')&&e.data.agent.length===26),e.data.asAgent,e.data.replacedTokenId??'-'].join(' ')).join('|')))" "$@"; }
expect "the issue is recorded: by the owner, naming the agent by its id, none replaced" "true true false " "$(token_events agent_token_issued $BOT_TOKEN_ID)"
# On a real page, and by sentence: on `_agent_tokens` the page check refuses first, so these would
# pass with both types added to EVENT_TYPES.
forged() { t_owner -w '\n%{http_code}' -d "{\"type\":\"$1\",\"page\":\"A01\",\"block\":\"A01.1.1\",\"data\":{\"agent\":\"p_x\",\"tokenId\":\"$BOT_TOKEN_ID\"}}" $B/api/events | { read -r body; read -r code; echo "$code $(echo "$body" | jfield error)"; }; }
expect "POST /events will not write an issue, even from the owner → 400, as an unknown type" \
  "400 $(say_en api.event.unknownType)" "$(forged agent_token_issued)"
expect "nor a revocation → 400, as an unknown type" "400 $(say_en api.event.unknownType)" "$(forged agent_token_revoked)"
# The log says it too, by id, with the event name an alert rule matches on — a field named `event`
# on the line would replace that name, and nothing but this check would notice.
expect "and the log names the issue and who made it, by id"  "$OWNER_LOG_ID" "$(log_field $TLOG agent_token_issued by)"

# What the token reaches: the events, as an agent, and nothing an agent is never given.
as_bot()   { curl -s -H "Authorization: Bearer $BOT_TOKEN" -H 'Content-Type: application/json' -H 'Accept-Language: en' "$@"; }
bot_code() { as_bot -o /dev/null -w '%{http_code}' "$@"; }
A011_FP=$(cli_fingerprint A01.1.1)
expect "the token signs the agent in → 200"      200 "$(bot_code $B/api/me)"
expect "as the address it was issued for"        "$BOT" "$(as_bot $B/api/me | jfield email)"
expect "which may neither approve nor triage"    "false false" "$(as_bot "$B/api/me?page=A01" | jfield here.may.approve) $(as_bot "$B/api/me?page=A01" | jfield here.may.triage)"
BOT_COMMENT=$(as_bot -d '{"type":"comment","page":"A01","block":"A01.1.1","text":"the agent was here","data":{"asAgent":"false"}}' $B/api/events)
expect "a comment through the token is recorded" comment "$(echo "$BOT_COMMENT" | jfield type)"
expect "as an agent's, whatever the body claimed" true "$(echo "$BOT_COMMENT" | jfield data.asAgent)"
# Each read the allowlist opens (`TOKEN_READS`, server.ts), reached: `holdrim` reads them, and one
# dropped from the list would leave the agent blind with every write above still passing.
expect "it reads the fingerprints, the impact radius, the graph and the open requests → 200" "200 200 200 200" \
  "$(bot_code "$B/api/fingerprints?ids=A01.1.1") $(bot_code "$B/api/impact-radius?id=A01.1.1") $(bot_code $B/api/graph) $(bot_code $B/api/requests/open)"
expect "and one event by its id"                 "$(echo "$BOT_COMMENT" | jfield id)" "$(as_bot $B/api/events/$(echo "$BOT_COMMENT" | jfield id) | jfield id)"
expect "a ✓ through the token → 403"             403 "$(bot_code -d "{\"type\":\"approval\",\"page\":\"A01\",\"block\":\"A01.1.1\",\"fingerprint\":\"$A011_FP\"}" $B/api/events)"
# Its own sentence, not the capability's: this refusal is asked on how the request signed in, and
# holds on its own if the token's address ever reads as able to approve.
expect "because a ✓ is given in a session, never with a token" "$(say_en api.approval.sessionOnly)" \
  "$(as_bot -d "{\"type\":\"approval\",\"page\":\"A01\",\"block\":\"A01.1.1\",\"fingerprint\":\"$A011_FP\"}" $B/api/events | jfield error)"
expect "and no ✓ from an agent was recorded"      0 "$(t_owner "$B/api/events?page=A01" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).filter(e=>e.type==='approval'&&e.data.asAgent==='true').length))")"
T_REQUEST=$(t_member -d '{"type":"request","page":"A01","block":"A01.1.1","text":"please fix the wording","data":{"category":"text"}}' $B/api/events | jfield id)
require_id "$T_REQUEST" T_REQUEST
t_state() { "$@" -o /dev/null -w '%{http_code}' -d "{\"type\":\"request_state\",\"page\":\"A01\",\"block\":\"A01.1.1\",\"text\":\"$T_STATE_TEXT\",\"data\":{\"request\":\"$T_REQUEST\",\"state\":\"$T_STATE\"}}" $B/api/events; }
T_STATE=approved T_STATE_TEXT=ok
expect "the token cannot triage a request → 403" 403 "$(t_state as_bot)"
expect "it cannot reach the people → 403"        403 "$(bot_code $B/api/users)"
expect "nor the token list → 403"                403 "$(bot_code $B/api/agent-tokens)"
expect "nor issue a token → 403"                 403 "$(bot_code -d '{"email":"another@example.org"}' $B/api/agent-tokens)"
# The tamper banner (issue #107) is not in TOKEN_READS, and its acknowledgement is not in
# TOKEN_WRITES: neither route existed when TOKEN_READS was written, and an allowlist stays closed
# to a route it never named — the acknowledgement stays refused before `mayAcknowledge` is even
# asked. The status alone cannot tell that refusal apart from `mayAcknowledge`'s own — moving the
# route into an allowlist and leaving the route's owner-only guard to fail (both answer 403) would
# pass a check on the status only; the sentence names which one fired.
expect "nor read the tamper banner → 403"         "403 $(say_en api.token.routeRefused)" \
  "$(as_bot -w '\n%{http_code}' $B/api/tampered | { read -r body; read -r code; echo "$code $(echo "$body" | jfield error)"; })"
expect "nor acknowledge a finding → 403"          "403 $(say_en api.token.routeRefused)" \
  "$(as_bot -w '\n%{http_code}' -d '{"finding":"x","asAgent":"true"}' $B/api/tampered/acknowledge | { read -r body; read -r code; echo "$code $(echo "$body" | jfield error)"; })"
expect "nor change a password → 403"             403 "$(bot_code -d '{"current":"x","next":"y"}' $B/api/change-password)"
expect "nor sign out → 403"                      403 "$(bot_code -X POST $B/api/sign-out)"
expect "and it opens no screen: the people screen still wants a session" 0 \
  "$(curl -s -D- -o /dev/null -H "Authorization: Bearer $BOT_TOKEN" $B/engine/people | has -i 'location: /sign-in'; echo $?)"
expect "nor a page of the documentation"         302 "$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $BOT_TOKEN" $B/pages/A01.html)"
# What an agent keeps (docs/ROLES.md, section 4): moving an approved request through its own states.
expect "(the owner approves the request)"        201 "$(t_state t_owner)"
T_STATE=applying T_STATE_TEXT='picking it up'
expect "the token moves an approved request to applying → 201" 201 "$(t_state as_bot)"
expect "and the move is written as an agent's"   "applying true" "$(t_owner "$B/api/events?page=A01" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const e=JSON.parse(s).filter(x=>x.type==='request_state'&&x.data.request===process.argv[1]).pop();console.log(e.data.state+' '+e.data.asAgent)})" "$T_REQUEST")"
# `holdrim state`, the command the agent actually runs: it reads the events file and writes through
# the API with its token — there is no other way for it to write any more.
T_CLI=$(HOLDRIM_OWNER=$OWNER HOLDRIM_ADMINS=$T_ADMIN HOLDRIM_AGENT_TOKEN=$BOT_TOKEN HOLDRIM_URL=$B \
  node engine/cli/holdrim.ts state "$T_REQUEST" waiting 'a question for the author' --root "$SITE" --db $TOKEN_DIR/events.db 2>&1); T_CLI_EXIT=$?
expect "holdrim state writes through the API with the token → exit 0" 0 "$T_CLI_EXIT"
expect "and the server recorded it as the agent's, from applying" "waiting applying true" "$(t_owner "$B/api/events?page=A01" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const e=JSON.parse(s).filter(x=>x.type==='request_state'&&x.data.request===process.argv[1]).pop();console.log([e.data.state,e.data.from,e.data.asAgent].join(' '))})" "$T_REQUEST")"
T_CLI=$(HOLDRIM_OWNER=$OWNER HOLDRIM_ADMINS=$T_ADMIN HOLDRIM_URL=$B \
  node engine/cli/holdrim.ts state "$T_REQUEST" applying 'back to it' --root "$SITE" --db $TOKEN_DIR/events.db 2>&1); T_CLI_EXIT=$?
expect "and with no token it refuses, before writing anything → exit 1" 1 "$T_CLI_EXIT"
expect "saying which variable it needs"          0 "$(echo "$T_CLI" | has HOLDRIM_AGENT_TOKEN; echo $?)"

# Bearer and cookie. A browser never sends Authorization cross-site without a preflight this server
# never answers; what is left to decide is a request that brings both, and it is refused, not
# resolved: either answer is wrong somewhere (apiViewerOf, server.ts).
expect "a session AND a token in one request → 401, even the owner's session with a live token" 401 \
  "$(curl -s -b $TOC -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $BOT_TOKEN" $B/api/me)"
expect "and a ✓ sent with both is refused the same way → 401" 401 \
  "$(curl -s -b $TOC -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $BOT_TOKEN" -H 'Content-Type: application/json' -d "{\"type\":\"approval\",\"page\":\"A01\",\"block\":\"A01.1.1\",\"fingerprint\":\"$A011_FP\"}" $B/api/events)"
expect "a token's write that is not JSON → 415, the same guard as a session's" 415 \
  "$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $BOT_TOKEN" -H 'Content-Type: text/plain' -d '{"type":"comment","page":"A01","text":"x"}' $B/api/events)"
expect "an Authorization that is no token → 401, never a fall back to no credential" 401 \
  "$(curl -s -o /dev/null -w '%{http_code}' -H 'Authorization: Basic YTpi' $B/api/me)"
# By sentence too: with no cookie, a fall back to "no credential" is a 401 as well.
expect "and says the token is not valid, not that nobody signed in" "$(say_en api.token.invalid)" \
  "$(curl -s -H 'Accept-Language: en' -H 'Authorization: Basic YTpi' $B/api/me | jfield error)"
expect "and logs why"                            1 "$(grep '"event":"agent_token_refused"' $TLOG | grep -c 'not a live agent token' | awk '{print ($1 >= 1)}')"
expect "a live token under another scheme → 401" 401 "$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Token $BOT_TOKEN" $B/api/me)"
expect "a token with its secret changed → 401"   401 \
  "$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer ${BOT_TOKEN%?}$([ "${BOT_TOKEN: -1}" = 0 ] && echo 1 || echo 0)" $B/api/me)"
expect "and the refusals are logged without the token" 0 "$(grep '"event":"agent_token_refused"' $TLOG | grep -Fc -e "$BOT_SECRET")"

# Decision 3: one token per address. Issuing again revokes the previous one, at once.
REISSUED=$(t_owner -d "{\"email\":\"$BOT\"}" $B/api/agent-tokens | jfield token)
require_id "$REISSUED" REISSUED
REISSUED_ID=$(echo "$REISSUED" | sed -E 's/^holdrim_agent_([0-9a-f]{24})_.*/\1/')
expect "re-issuing stops the old token at once → 401" 401 "$(bot_code $B/api/me)"
BOT_TOKEN_OLD=$BOT_TOKEN; BOT_TOKEN=$REISSUED
expect "and the new one works → 200"             200 "$(bot_code $B/api/me)"
expect "and the trail says which token it replaced" "true true false $BOT_TOKEN_ID" "$(token_events agent_token_issued $REISSUED_ID)"
expect "still one token for the address"         1 "$(t_owner $B/api/agent-tokens | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).agents.filter(a=>a.email===process.argv[1]).length))" "$BOT")"
# Revoking: the owner's alone too, and it takes effect before the answer comes back.
revoke() { "$@" -o /dev/null -w '%{http_code}' -X POST $B/api/agent-tokens/$BOT/revoke; }
expect "a member cannot revoke → 403"            403 "$(revoke t_member)"
expect "an admin cannot revoke → 403"            403 "$(revoke t_admin)"
expect "and the token still works after both tried" 200 "$(bot_code $B/api/me)"
expect "the token cannot revoke itself → 403"    403 "$(revoke as_bot)"
expect "the owner revokes → 200"                 200 "$(revoke t_owner)"
expect "the revoked token stops at once → 401"   401 "$(bot_code $B/api/me)"
expect "the revocation is recorded, by the owner" "true true false -" "$(token_events agent_token_revoked $REISSUED_ID)"
expect "and the log names the revocation and who made it, by id" "$OWNER_LOG_ID" "$(log_field $TLOG agent_token_revoked by)"
expect "revoking again finds nothing → 404"      404 "$(revoke t_owner)"
expect "and the list is empty of it"             "" "$(t_owner $B/api/agent-tokens | jfield agents.0.email)"
expect "no secret of either token in the log"    0 "$(grep -Fc -e "$BOT_SECRET" -e "${REISSUED##*_}" $TLOG)"

# A token's address can come to hold a grant after the token was issued, by a restart with a new
# HOLDRIM_ADMINS or HOLDRIM_OWNER — the one path issuance itself cannot refuse. The token has to
# stay an agent's anyway: never a ✓, never triage, and for the owner's address, nothing at all.
PROMOTED_TOKEN=$(t_owner -d "{\"email\":\"$PROMOTED\"}" $B/api/agent-tokens | jfield token)
HEIR_TOKEN=$(t_owner -d "{\"email\":\"$HEIR\"}" $B/api/agent-tokens | jfield token)
require_id "$PROMOTED_TOKEN" PROMOTED_TOKEN; require_id "$HEIR_TOKEN" HEIR_TOKEN
kill $PID 2>/dev/null; wait $PID 2>/dev/null
start_token_server $OWNER "$T_ADMIN,$PROMOTED"
BOT_TOKEN=$PROMOTED_TOKEN
T_REQUEST=$(t_member -d '{"type":"request","page":"A01","block":"A01.1.1","text":"another wording","data":{"category":"text"}}' $B/api/events | jfield id)
require_id "$T_REQUEST" T_REQUEST
T_STATE=approved T_STATE_TEXT=ok
expect "a token whose address is now an admin's still signs in as an agent" "$PROMOTED false" "$(as_bot $B/api/me | jfield email) $(as_bot "$B/api/me?page=A01" | jfield here.may.approve)"
expect "and reads as a member, not an admin"     member "$(as_bot $B/api/me | jfield role)"
expect "and its ✓ is refused → 403"              403 "$(bot_code -d "{\"type\":\"approval\",\"page\":\"A01\",\"block\":\"A01.1.1\",\"fingerprint\":\"$A011_FP\"}" $B/api/events)"
expect "as a ✓ given without a session"          "$(say_en api.approval.sessionOnly)" "$(as_bot -d "{\"type\":\"approval\",\"page\":\"A01\",\"block\":\"A01.1.1\",\"fingerprint\":\"$A011_FP\"}" $B/api/events | jfield error)"
# The layer `roles.isAgent` holds on its own: the explicit refusal above covers only a ✓, so a
# triage refused here is refused because the token makes its bearer an agent, whatever its address.
expect "and it cannot triage, though the address is an admin's → 403" 403 "$(t_state as_bot)"
expect "nor reach the people, though an admin can → 403" 403 "$(bot_code $B/api/users)"
kill $PID 2>/dev/null; wait $PID 2>/dev/null
start_token_server $HEIR $T_ADMIN
BOT_TOKEN=$HEIR_TOKEN
expect "a token whose address is now the owner's opens nothing → 401" 401 "$(bot_code $B/api/me)"
expect "not even a ✓ → 401"                      401 "$(bot_code -d "{\"type\":\"approval\",\"page\":\"A01\",\"block\":\"A01.1.1\",\"fingerprint\":\"$A011_FP\"}" $B/api/events)"
expect "and nothing of any token reached the log" 0 "$(grep -Fc -e "${PROMOTED_TOKEN##*_}" -e "${HEIR_TOKEN##*_}" $TLOG)"
kill $PID 2>/dev/null; wait $PID 2>/dev/null; rm -rf "$TOKEN_DIR"

# Where no user store holds tokens — the local runner here, an identity proxy in production — an
# Authorization header is somebody else's and is left alone (`apiViewerOf`): the runner's identity
# stands, and nothing answers 401 or 500 for it.
PORT=$PORT HOLDRIM_OWNER=$OWNER bash engine/run-local.sh >$WORK/token-runner.log 2>&1 & RUNNER_PID=$!
for i in $(seq 40); do curl -s $B/api/health >/dev/null 2>&1 && break; sleep 0.5; done
LOOSE=holdrim_agent_$(printf '0%.0s' $(seq 24))_$(printf 'f%.0s' $(seq 64))
expect "the local runner leaves a bearer alone, and answers as its identity → 200" "200 agent@local" \
  "$(curl -s -o /dev/null -w '%{http_code}' -H 'X-Dev-Email: agent@local' -H "Authorization: Bearer $LOOSE" $B/api/me) $(curl -s -H 'X-Dev-Email: agent@local' -H "Authorization: Bearer $LOOSE" $B/api/me | jfield email)"
expect "and records a write sent with one → 201" 201 "$(curl -s -o /dev/null -w '%{http_code}' -H 'X-Dev-Email: agent@local' -H "Authorization: Bearer $LOOSE" -H 'Content-Type: application/json' -d '{"type":"comment","page":"A01","block":"A01.1.1","text":"through the runner"}' $B/api/events)"
L_REQUEST=$(curl -s -H "X-Dev-Email: $OWNER" -H 'Content-Type: application/json' -d '{"type":"request","page":"A01","block":"A01.1.1","text":"born approved","data":{"category":"text"}}' $B/api/events | jfield id)
require_id "$L_REQUEST" L_REQUEST
# `--local` against the runner, with a token and a deployed address exported that lead nowhere: the
# write reaches the runner, as its identity, or this fails.
L_CLI=$(HOLDRIM_OWNER=$OWNER HOLDRIM_AGENT_TOKEN=$LOOSE HOLDRIM_URL=http://127.0.0.1:9 HOLDRIM_LOCAL_URL=$B \
  node engine/cli/holdrim.ts state "$L_REQUEST" applying 'picking it up' --local --root "$SITE" 2>&1); L_CLI_EXIT=$?
expect "holdrim state --local writes to the runner, whatever HOLDRIM_URL says → exit 0" 0 "$L_CLI_EXIT"
expect "and the runner recorded it, as agent@local" "applying agent@local" \
  "$(curl -s -H "X-Dev-Email: $OWNER" "$B/api/events?page=A01" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const e=JSON.parse(s).filter(x=>x.type==='request_state'&&x.data.request===process.argv[1]).pop();console.log(e?e.data.state+' '+e.author:'none')})" "$L_REQUEST")"
kill $RUNNER_PID 2>/dev/null; wait $RUNNER_PID 2>/dev/null

echo; [ $FAILURES -eq 0 ] && echo "all good" || { echo "$FAILURES failure(s)"; exit 1; }
