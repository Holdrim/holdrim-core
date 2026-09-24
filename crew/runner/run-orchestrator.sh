#!/usr/bin/env bash
# One unattended pass of the orchestrator (crew/autonomy.md), then exit. A scheduler starts it
# again; nothing here loops, so a pass that goes wrong ends instead of repeating itself.
set -euo pipefail

: "${GH_TOKEN:?GH_TOKEN, the GitHub token of the machine account, is required}"
: "${CLAUDE_CODE_OAUTH_TOKEN:?a Claude token from claude setup-token is required}"

# The run must be the orchestrator's machine account and nobody else. Refusing the owner's id
# alone would let any other credential through; requiring the listed id refuses them all
# (crew/accounts.md, crew/autonomy.md "Before selecting work").
ORCHESTRATOR_ID=333497607
id=$(gh api user --jq .id) || { echo "cannot verify the GitHub identity: not starting"; exit 1; }
if [ "$id" != "$ORCHESTRATOR_ID" ]; then
  echo "this credential is account $id, not the orchestrator's: not starting"
  exit 1
fi

gh auth setup-git
rm -rf holdrim-core
git clone --quiet https://github.com/Holdrim/holdrim-core
cd holdrim-core

# The account list is read from the clone, never from the image, so a change the owner merges
# takes effect on the next pass; an id missing from it means the owner withdrew the account.
grep -q "| $ORCHESTRATOR_ID |" crew/accounts.md || { echo "not listed in crew/accounts.md: not starting"; exit 1; }

# gh and git only: the orchestrator labels, assigns and comments; it never edits a file, and a
# tool it does not have is one a prompt injection cannot talk it into using.
claude -p "You play the orchestrator role in the Holdrim crew, as one unattended pass. Follow
.claude/skills/crew/SKILL.md for the orchestrator role, then crew/orchestrator.md and
crew/autonomy.md. Use gh for every GitHub action. Never merge, never remove needs:owner, never
edit a file. When done, write the state as one comment on the open issue labelled handoff and
end; if nothing needed you and the last handoff comment already says idle, write nothing." \
  --allowedTools "Bash(gh:*)" "Bash(git log:*)" "Bash(git show:*)" "Read" "Grep" "Glob" \
  --max-turns 40
