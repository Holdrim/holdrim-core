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
# The value of one field on the LAST line naming this event, in the given log file — a bare `null`
# comes back as the literal string "null", so a caller compares it like any other value. Exists
# because "the e-mail is gone and something p_-shaped is there" is a shape check: it passes just as
# well when person and by are swapped, or when the id belongs to a different person entirely. This
# reads the exact value so a test can assert whose id it is, not merely that it looks like one.
log_field() { grep "\"event\":\"$2\"" "$1" | tail -1 | sed -n "s/.*\"$3\":\(\"[^\"]*\"\|null\).*/\1/p" | tr -d '"'; }

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
expect "reviewer is a member"          member "$(curl -s -H "X-Dev-Email: $REVIEWER" $B/api/me | jfield role)"
expect "capability instead of role"    true "$(curl -s -H "X-Dev-Email: $OWNER" $B/api/me | jfield canApprove)"
expect "the owner can triage"          true "$(curl -s -H "X-Dev-Email: $OWNER" $B/api/me | jfield canTriage)"
expect "a member cannot"               false "$(curl -s -H "X-Dev-Email: $REVIEWER" $B/api/me | jfield canTriage)"

echo "approval:"
expect "reviewer does NOT approve → 403" 403 "$(post $REVIEWER '{"type":"approval","page":"D01","block":"D01.1.4","fingerprint":"abc123"}')"
expect "owner approves → 201"          201 "$(post $OWNER '{"type":"approval","page":"D01","block":"D01.1.4","fingerprint":"abc123"}')"
expect "approval without fingerprint → 400" 400 "$(post $OWNER '{"type":"approval","page":"D01","block":"D01.1.4"}')"
expect "unknown type → 400"            400 "$(post $OWNER '{"type":"delete","page":"D01"}')"
# text_removed is written only by EventStore.removeText, in the same transaction as the row it
# deletes (engine/api/texts.ts) — never by this general path, even signed in as the owner: a route
# that accepted it could claim a removal with nothing to back it, no row actually gone.
expect "text_removed via POST /events → 400, even as the owner" 400 "$(post $OWNER '{"type":"text_removed","page":"D01","data":{"event":"x","field":"text"}}')"
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
# LOCKED is named in HOLDRIM_LOCKS (docs/ROLES.md, section 3): their account is guarded like the
# owner's, end to end, below.
LOCKED=locked@example.org
HOLDRIM_ENVIRONMENT=Production HOLDRIM_OWNER=$OWNER HOLDRIM_ADMINS=$ADMIN HOLDRIM_LOCKS="$LOCKED:P0*" \
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
# Signing in does not itself name a person: nobody has a row until they file a request, a comment
# or a ✓. This is the owner's first action of any kind against this fresh server, so there is no
# row yet to find — and the log says so honestly, `null`, never the e-mail it also must not carry.
expect "and a sign-in with no act behind it yet logs no person" null \
  "$(log_field $WORK/password.log signed_in person)"
expect "and the owner truly approves"  201 "$(curl -s -b $COOKIES -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' -d '{"type":"approval","page":"D01","block":"D01.1.4","fingerprint":"abc123"}' $B/api/events)"
# The owner's first real act mints their row. Captured once here, by name, so every later line that
# claims to be the owner's can be checked against this EXACT id — a shape check alone, "something
# p_-shaped is there", would wave through the owner's id credited to somebody else just as happily.
OWNER_ID=$(log_field $WORK/password.log event_recorded author)
expect "and the recorded event names its author by a real person id" 1 \
  "$(echo "$OWNER_ID" | grep -cE '^p_[0-9a-f]{24}$')"
expect "and never by the e-mail it carried"    0 \
  "$(grep '"event":"event_recorded"' $WORK/password.log | grep -Fc -e "$OWNER")"
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
# Every file served from disk carries what it may run, the engine's own included: a page, only the
# panel; anything else, nothing. Without the second, an HTML file shipped next to the panel one day
# would run whatever it holds with the reader's session.
expect "a page runs only what carries its nonce" 0 "$(curl -s -b $COOKIES -D- -o /dev/null $B/pages/A01.html | has "script-src 'nonce-"; echo $?)"
expect "an engine file runs nothing"   0 "$(curl -s -b $COOKIES -D- -o /dev/null $B/engine/web/panel.css | has "script-src 'none'"; echo $?)"
expect "and /sign-in no longer has anything to do" 302 "$(curl -s -b $COOKIES -o /dev/null -w '%{http_code}' $B/sign-in)"
# A current password that is not a string would reach `.normalize()` and answer 500; it is a wrong one.
expect "a current password that is a number → 403, like any wrong one" 403 "$(curl -s -b $COOKIES -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' -d '{"current":1,"next":"a-long-enough-password"}' $B/api/change-password)"
expect "changing the password → 200"   200 "$(curl -s -b $COOKIES -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' -d "{\"current\":\"$PASSWORD\",\"next\":\"a-long-enough-password\"}" $B/api/change-password)"
expect "and the change is logged by id, not by e-mail" 0 \
  "$(grep '"event":"password_changed"' $WORK/password.log | grep -Fc -e "$OWNER")"
expect "as the owner's own id, not merely something id-shaped" "$OWNER_ID" \
  "$(log_field $WORK/password.log password_changed person)"
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

# The recorded events have to survive shutdown — that's the difference between sqlite and memory.
# Two by now: the owner's approval and the member's comment, minted for the exact-id checks above.
expect "the events are still there after shutdown" 2 "$(node -e "
  const {DatabaseSync}=require('node:sqlite');
  console.log(new DatabaseSync('$DATA_DIR/events.db').prepare('SELECT COUNT(*) c FROM events').get().c)")"
rm -rf $DATA_DIR

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
db.exec('CREATE TRIGGER break_drop BEFORE DELETE ON sessions WHEN OLD.email = ' + literal
  + ' BEGIN SELECT RAISE(ABORT, \\'boom\\'); END;');
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

# Both failures have to reach the log — silently is the exact bug this closes — and neither may
# name the account by e-mail: docs/PRIVACY.md says a log names a person by id, and this is the one
# line that used to carry the address instead, read straight out of \`console.error\` inside the
# store. \`grep -c\` and not \`has\`: a MISSING line is as much a bug here as a line with the e-mail
# in it, and the count catches both while \`has\` alone would only catch the second.
expect "both are reported at ERROR severity, not swallowed" 2 \
  "$(grep -c '\"event\":\"user_sessions_not_dropped\".*\"severity\":\"ERROR\"\|\"severity\":\"ERROR\".*\"event\":\"user_sessions_not_dropped\"' $WORK/fail-drop.log)"
expect "and neither line carries the e-mail"     0 \
  "$(grep '\"event\":\"user_sessions_not_dropped\"' $WORK/fail-drop.log | grep -Fc -e "$BROKEN")"
kill $PID 2>/dev/null; wait $PID 2>/dev/null
rm -rf "$FAIL_DIR"

echo; [ $FAILURES -eq 0 ] && echo "all good" || { echo "$FAILURES failure(s)"; exit 1; }
