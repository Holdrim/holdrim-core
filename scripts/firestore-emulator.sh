#!/usr/bin/env bash
# The Firestore emulator on this machine, for the tests that SKIP without it.
#
#   eval "$(bash scripts/firestore-emulator.sh)"      # then: npm test
#
# CI starts the emulator from a pinned container image (.github/workflows/tests.yml, job `stores`).
# A cloud session has no Docker, and many machines have none either, but most have Java. So this
# fetches the emulator's own jar — the one firebase-tools would fetch — pinned by version and by
# checksum, and starts it. Without it, every Firestore test skips outside CI, and a change to that
# store is proved only after the push.
#
# Its standard output is one line, the variable to export, so that `eval` is all it takes. Anything
# else goes to stderr.
set -euo pipefail

VERSION=1.22.0
SHA256=9b6498b7f62714d67f48f59b3818883cd682dbcd46b9f59511de81c97bb5166c
URL="https://storage.googleapis.com/firebase-preview-drop/emulator/cloud-firestore-emulator-v$VERSION.jar"
HOST=127.0.0.1:8433
CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/holdrim"
JAR="$CACHE/cloud-firestore-emulator-v$VERSION.jar"
WAIT=${HOLDRIM_EMULATOR_WAIT:-60}

# The emulator answers "Ok" on its root once it takes requests, and exactly "Ok": anything else on
# that port is not the emulator. `--noproxy`, because the cloud session routes everything through a
# proxy that cannot reach this machine's loopback. `--max-time`, because a process that takes the
# connection and never replies would otherwise hang the session start with it.
answers() { [ "$(curl -s --noproxy '*' --max-time 2 "http://$HOST" || true)" = "Ok" ]; }

# macOS ships `shasum`, Linux `sha256sum`; either prints the digest first.
digest() {
  if command -v sha256sum >/dev/null; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1
}

# One already running — from an earlier call, or started by hand — is used as it is: a second could
# not bind the port anyway, and would fail with a message about the port and not about Firestore.
if answers; then
  echo "export FIRESTORE_EMULATOR_HOST=$HOST"
  exit 0
fi

# `java -version`, not `command -v java`: macOS ships a /usr/bin/java that only says no runtime is
# installed, and would pass the lookup, download 130 MB and then die.
if ! java -version >/dev/null 2>&1; then
  echo "the Firestore emulator needs Java, and none runs here" >&2
  exit 1
fi

if [ ! -f "$JAR" ] || [ "$(digest "$JAR")" != "$SHA256" ]; then
  mkdir -p "$CACHE"
  if ! curl -fsSL -o "$JAR.part" "$URL"; then
    rm -f "$JAR.part"
    echo "could not download $URL" >&2
    exit 1
  fi
  # A jar that is not the one pinned here would run with the rights of whoever started it.
  if [ "$(digest "$JAR.part")" != "$SHA256" ]; then
    rm -f "$JAR.part"
    echo "the emulator downloaded from $URL does not match its pinned checksum; not running it" >&2
    exit 1
  fi
  mv "$JAR.part" "$JAR"
fi

LOG="$CACHE/firestore-emulator.log"
nohup java -jar "$JAR" --host "${HOST%:*}" --port "${HOST#*:}" > "$LOG" 2>&1 &
pid=$!
for _ in $(seq "$WAIT"); do
  if answers; then
    echo "export FIRESTORE_EMULATOR_HOST=$HOST"
    exit 0
  fi
  # Asked after the probe, not before: a process that answered and then exited has still answered.
  kill -0 "$pid" 2>/dev/null || break   # it died: waiting on would only make the failure slower
  sleep 1
done
# Stopped, so that the failure is true: left running, it could start answering after the caller
# was told there is no emulator, and the tests would skip beside a live one.
kill "$pid" 2>/dev/null || true
echo "the Firestore emulator did not answer on $HOST within ${WAIT}s. Its log, $LOG, ends:" >&2
tail -20 "$LOG" >&2
exit 1
