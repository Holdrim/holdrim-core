#!/usr/bin/env bash
# Refuses a release tag that would publish something other than what it claims to be.
#
#   bash scripts/check-release-tag.sh v0.2.0
#
# Four rules, each one a way a published image has lied before somewhere:
#   - the tag is vMAJOR.MINOR.PATCH, because adopters PIN it, and a pin they cannot parse is a pin
#     they cannot move on purpose;
#   - it equals the version in package.json, so the image, the tag and the package never disagree
#     about which release they are — bump the version in the same commit that is tagged;
#   - the commit it points at is on main, because AGENTS.md says a tag points at a commit whose CI
#     is green, and only main's commits went through the pull request that proved them. A tag on a
#     side branch would publish code nobody reviewed;
#   - CHANGELOG.md has a section for it, because adopters move a pin only when they can read what
#     moving it changes, and a note that "will be written later" is a note that never is.
# MAIN_REF names the branch to check against; the release workflow uses origin/main.
set -euo pipefail
TAG=${1:-}
MAIN=${MAIN_REF:-origin/main}

if ! [[ "$TAG" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]; then
  echo "✗ '$TAG' is not vMAJOR.MINOR.PATCH"
  exit 1
fi
VERSION=$(node -p "require('./package.json').version")
if [ "$TAG" != "v$VERSION" ]; then
  echo "✗ the tag is $TAG but package.json says $VERSION — bump the version in the commit you tag"
  exit 1
fi
if ! grep -Eq "^## \[${VERSION//./\\.}\]" CHANGELOG.md 2>/dev/null; then
  echo "✗ CHANGELOG.md has no '## [$VERSION]' section — say what this release changes before tagging it"
  exit 1
fi
# Both refs are looked up before they are compared. `merge-base` exits 128 on a ref it cannot find,
# the `if !` below read that as "not an ancestor", and a clone that had simply not fetched main was
# told its tag was off main — the one answer that sends a person looking for a problem they do not
# have. And under `set -e` a tag that does not exist ended the script on git's own line, unexplained.
COMMIT=$(git rev-parse -q --verify "$TAG^{commit}") || {
  echo "✗ there is no tag $TAG here — create it on the commit to release, or fetch it"
  exit 1
}
git rev-parse -q --verify "$MAIN^{commit}" >/dev/null || {
  echo "✗ $MAIN is not here to compare against — fetch it first (git fetch origin main)"
  exit 1
}
if ! git merge-base --is-ancestor "$COMMIT" "$MAIN"; then
  echo "✗ $TAG points at $COMMIT, which is not on $MAIN — a release is cut from main only"
  exit 1
fi
echo "✓ $TAG is a version, matches package.json, has a changelog entry, and is on $MAIN"
