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
PORT=${PORT:-18095}; B=http://127.0.0.1:$PORT; FAILURES=0
export OWNER=owner@example.org; export REVIEWER=reviewer@example.org
LEAD=lead@example.org
SITE="$PWD/examples/hello-world"

expect() { if [ "$2" = "$3" ]; then echo "  ok   $1"; else echo "  FAIL $1 — expected $2, got $3"; FAILURES=$((FAILURES+1)); fi; }
# Whether the input has a match, reading ALL of it. `grep -q` stops at the first match and closes the
# pipe, and under `pipefail` the writer it left behind — usually curl, mid-page — then fails with a
# write error (curl's 23, or 141 for SIGPIPE) that becomes the pipeline's status. It depends on how
# much is still unwritten, so it passes on one machine and fails on the next, reporting "expected
# 0, got 23" about a page that has what was looked for. Never `| grep -q` here.
has() { grep "$@" >/dev/null; }

# ----------------------------------------------------------------------------- portable, on purpose
# This runs on a developer's macOS or Windows laptop and on CI's Linux, and the three do not ship
# the same tools. Anything below that looks long-winded is avoiding a construct one of them lacks:
#
#   `head -n -1`  is GNU. BSD head refuses a negative count, the variable comes back EMPTY, and
#                 every check that reads it fails in a cascade that names nothing. `sed '$d'` is
#                 POSIX and does the same.
#   `timeout`     is GNU coreutils. macOS and Git Bash do not have it; `run_for` below is the same
#                 idea with a background job and a watchdog.
#   brace lists   are expanded out of JSON bodies by bash 3.2 — see `set +B` at the top.
#   fixed /tmp    names collide when two people, or two agents, run this at once — one run reads the
#                 other's log and the assertions about the password move. Every file is a
#                 `mktemp`, so each run owns its own.
#
# The rule for anything added here: if a command only exists on one of the three, it is a bug, even
# while the suite is green on the other two.

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
  HOLDRIM_SITE="$SITE" \
  node --import ./engine/tests/hooks/forbid-optional.js engine/api/server.ts >$WORK/tests.log 2>&1 & PID=$!
for i in $(seq 40); do curl -s $B/api/health >/dev/null 2>&1 && break; sleep 0.5; done
echo "boot:"
expect "the server comes up without loading an optional package" 200 "$(curl -s -o /dev/null -w '%{http_code}' $B/api/health)"
grep -q 'optional package was loaded' $WORK/tests.log && grep -m1 'optional package was loaded' $WORK/tests.log | sed 's/^/       /'

echo "identity and roles:"
expect "no identity → 401"             401 "$(curl -s -o /dev/null -w '%{http_code}' $B/api/events)"
expect "owner is owner"                owner "$(curl -s -H "X-Dev-Email: $OWNER" $B/api/me | jfield role)"
expect "reviewer is other"             other "$(curl -s -H "X-Dev-Email: $REVIEWER" $B/api/me | jfield role)"
expect "capability instead of role"    true "$(curl -s -H "X-Dev-Email: $OWNER" $B/api/me | jfield canApprove)"

echo "approval:"
expect "reviewer does NOT approve → 403" 403 "$(post $REVIEWER '{"type":"approval","page":"D01","block":"D01.1.4","fingerprint":"abc123"}')"
expect "owner approves → 201"          201 "$(post $OWNER '{"type":"approval","page":"D01","block":"D01.1.4","fingerprint":"abc123"}')"
expect "approval without fingerprint → 400" 400 "$(post $OWNER '{"type":"approval","page":"D01","block":"D01.1.4"}')"
expect "unknown type → 400"            400 "$(post $OWNER '{"type":"delete","page":"D01"}')"
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
HOLDRIM_ENVIRONMENT=Production HOLDRIM_OWNER=$OWNER HOLDRIM_ADMINS=$ADMIN HOLDRIM_IDENTITY=password HOLDRIM_EVENTS=sqlite \
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
expect "correct password → 200"        200 "$(login "$PASSWORD")"
expect "and the session identifies the owner" owner "$(curl -s -b $COOKIES $B/api/me | jfield role)"
expect "and the owner truly approves"  201 "$(curl -s -b $COOKIES -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' -d '{"type":"approval","page":"D01","block":"D01.1.4","fingerprint":"abc123"}' $B/api/events)"
expect "the first-access password requires a change" true "$(curl -s -b $COOKIES $B/api/me | jfield mustChangePassword)"
expect "now the docs open → 200"       200 "$(curl -s -b $COOKIES -o /dev/null -w '%{http_code}' $B/pages/A01.html)"
# The project home is a report and needs no script, so its policy allows none at all: a request's
# text is typed by any reviewer and shown there to the owner.
HOME_HDR=$(curl -s -b $COOKIES -D "$WORK/home.h" -o "$WORK/home.html" $B/engine/home; grep -i '^content-security-policy:' "$WORK/home.h")
expect "with a session, the project home opens → 200" 200 "$(sed -n 's/^HTTP[^ ]* \([0-9]*\).*/\1/p' "$WORK/home.h" | head -1)"
expect "and its policy runs no script at all" 0 "$(echo "$HOME_HDR" | has "default-src 'none'" && ! echo "$HOME_HDR" | has 'script-src'; echo $?)"
expect "and it has none to run"               0 "$(grep -c '<script' "$WORK/home.html")"
expect "and it links every page it tallies"   0 "$(grep -qF 'href="/pages/A01.html"' "$WORK/home.html"; echo $?)"
# The HTML must NOT be cached: otherwise a text fix never reaches someone who already opened the
# page — and, worse, the fingerprint the browser computes ends up matching text that has already
# changed on disk.
expect "HTML is not cached"            0 "$(curl -s -b $COOKIES -D- -o /dev/null $B/pages/A01.html | has -i 'cache-control: no-cache'; echo $?)"
expect "and /sign-in no longer has anything to do" 302 "$(curl -s -b $COOKIES -o /dev/null -w '%{http_code}' $B/sign-in)"
# A current password that is not a string would reach `.normalize()` and answer 500; it is a wrong one.
expect "a current password that is a number → 403, like any wrong one" 403 "$(curl -s -b $COOKIES -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' -d '{"current":1,"next":"a-long-enough-password"}' $B/api/change-password)"
expect "changing the password → 200"   200 "$(curl -s -b $COOKIES -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' -d "{\"current\":\"$PASSWORD\",\"next\":\"a-long-enough-password\"}" $B/api/change-password)"
expect "and nothing is demanded any more" false "$(curl -s -b $COOKIES $B/api/me | jfield mustChangePassword)"
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
# Ordered in the store, not by the database's own idea of order: three databases with three natural
# orders would hand the same team three different lists.
expect "the list is ordered by e-mail"  "$MEMBER $OWNER" "$(emails)"

expect "the new person signs in → 200"  200 "$(mlogin "$MEMBER_PASSWORD")"
expect "and is nobody special"          other "$(as_member $B/api/me | jfield role)"
# The people screen draws only what the routes above allow, and is drawn only for who may use them.
expect "the people screen opens for the owner → 200" 200 "$(curl -s -b $COOKIES -o /dev/null -w '%{http_code}' $B/engine/people)"
expect "and lists the new person"       0 "$(curl -s -b $COOKIES $B/engine/people | has -F "$MEMBER"; echo $?)"
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
expect "the owner still can, on themselves" 200 "$(code_owner -X POST $B/api/users/$OWNER/password)"

expect "disabling somebody → 200"       200 "$(code_owner -d '{"enabled":false}' $B/api/users/$MEMBER/enabled)"
# Without this the revocation would land whenever the cookie happened to expire: up to twelve hours
# of somebody just removed still reading, still commenting, still approving.
expect "their open session dies at once → 401" 401 "$(code_member $B/api/me)"
expect "and the right password no longer gets in → 401" 401 "$(mlogin "$MEMBER_PASSWORD")"
# ⚠️ Reads the member BY E-MAIL, not by position. The list is ordered by e-mail, so `users.0` is
# whoever sorts first, and an admin added to the fixture takes that slot — a test that silently
# changes what it asserts when somebody adds a row is worse than no test.
expect "but they are still on the list"  false "$(as_owner $B/api/users | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const u=JSON.parse(s).users.find(u=>u.email===process.argv[1]);console.log(u?u.enabled:'not listed')})" "$MEMBER")"
expect "disabling is not deleting"      "$ADMIN $MEMBER $OWNER" "$(emails)"
# A missing field is not "false": read as falsy, a typo in the key would silently revoke somebody.
expect "a body with no enabled → 400"   400 "$(code_owner -d '{}' $B/api/users/$MEMBER/enabled)"

expect "giving the access back → 200"   200 "$(code_owner -d '{"enabled":true}' $B/api/users/$MEMBER/enabled)"
expect "and the same password works again → 200" 200 "$(mlogin "$MEMBER_PASSWORD")"

RESET=$(as_owner -X POST $B/api/users/$MEMBER/password)
NEW_PASSWORD=$(echo "$RESET" | jfield password)
expect "a reset gives back a different password" 0 "$([ -n "$NEW_PASSWORD" ] && [ "$NEW_PASSWORD" != "$MEMBER_PASSWORD" ]; echo $?)"
# Somebody OTHER than the owner of the account has seen this one — whoever ran the reset, and
# whatever channel carried it over. The window has to be one login long.
expect "and it demands a change"        true "$(echo "$RESET" | jfield user.mustChangePassword)"
expect "the old password stops working → 401" 401 "$(mlogin "$MEMBER_PASSWORD")"
expect "the new one gets in → 200"      200 "$(mlogin "$NEW_PASSWORD")"
expect "and it is not in the listing"   0 "$(as_owner $B/api/users | grep -Fc -e "$NEW_PASSWORD")"
expect "nor in the log"                 0 "$(grep -Fc -e "$NEW_PASSWORD" $WORK/password.log)"
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

# The recorded event has to survive shutdown — that's the difference between sqlite and memory.
expect "the event is still there after shutdown" 1 "$(node -e "
  const {DatabaseSync}=require('node:sqlite');
  console.log(new DatabaseSync('$DATA_DIR/events.db').prepare('SELECT COUNT(*) c FROM events').get().c)")"
rm -rf $DATA_DIR

echo "the local runner, on another project:"
# The README's red example, with no Docker: the runner serves the folder it is given, read from that
# folder's own holdrim.json, and opens it as its owner — the cash register names nobody to act as.
PORT=$PORT bash engine/run-local.sh examples/cash-register >$WORK/runner.log 2>&1 & RUNNER_PID=$!
for i in $(seq 40); do curl -s $B/api/health >/dev/null 2>&1 && break; sleep 0.5; done
expect "serves the project it was given: the cash register's two reds" 2 \
  "$(curl -s $B/engine/home | grep -o '🔴</span> <strong>[0-9]*' | grep -o '[0-9]*$')"
expect "and opens it as its owner, straight in"  owner "$(curl -s $B/api/me | jfield role)"
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
# A trailing comma in holdrim.json must not read as no file at all, with a missing owner blamed.
mkdir -p "$WORK/broken-config"; printf '{ "owner": "x@example.org", }' > "$WORK/broken-config/holdrim.json"
RUNNER=$(env -u HOLDRIM_OWNER bash engine/run-local.sh "$WORK/broken-config" 2>&1); RUNNER_EXIT=$?
expect "a holdrim.json that does not parse is refused" 1 "$RUNNER_EXIT"
expect "and named as the problem"                0 "$(echo "$RUNNER" | has 'broken-config/holdrim.json is not valid JSON'; echo $?)"
expect "and the owner is not blamed for it"      1 "$(echo "$RUNNER" | has 'missing the owner'; echo $?)"
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

# Firestore is optional: configured but not installed, the boot has to fail and name the package,
# not come up half-working or die in a module-resolution stack. The forbid-optional hook stands in
# for "not installed" — it refuses the package exactly the way a missing one would.
echo "with Firestore configured but not installed:"
HOLDRIM_EVENTS=firestore HOLDRIM_PROJECT=some-project HOLDRIM_OWNER=$OWNER HOLDRIM_SITE="$SITE" PORT=$PORT \
  run_for 15 node --import ./engine/tests/hooks/forbid-optional.js engine/api/server.ts >"$WORK/no-firestore.log" 2>&1
expect "it refuses to start → exits 1"  1 "$?"
expect "and names the missing package"   0 "$(grep -q 'HOLDRIM_EVENTS=firestore needs the optional package @google-cloud/firestore' $WORK/no-firestore.log; echo $?)"

echo; [ $FAILURES -eq 0 ] && echo "all good" || { echo "$FAILURES failure(s)"; exit 1; }
