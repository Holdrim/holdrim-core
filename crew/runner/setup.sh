#!/usr/bin/env bash
# The one step that needs a person: signing the machine account in to GitHub and the owner's
# Claude subscription in to Claude, once, in a browser. Both answers stay in the compose volumes;
# nothing is written to the image or to the repository.
set -euo pipefail
ORCHESTRATOR_ID=333497607

echo "1/2 GitHub: sign in AS holdrim-orchestrator (a private window helps), never as the owner."
gh auth login --hostname github.com --git-protocol https --web
id=$(gh api user --jq .id)
if [ "$id" != "$ORCHESTRATOR_ID" ]; then
  # Keeping a wrong account's token around would only wait to be used by mistake.
  gh auth logout --hostname github.com || true
  echo "signed in as account $id, not the orchestrator ($ORCHESTRATOR_ID): logged out, run setup again"
  exit 1
fi
echo "GitHub: signed in as the orchestrator."

echo "2/2 Claude: the next command prints a link and then a long-lived token."
claude setup-token
read -rsp "Paste the token it printed (hidden): " token; echo
[ -n "$token" ] || { echo "no token given: run setup again"; exit 1; }
umask 077
printf '%s' "$token" > "$HOME/.secrets/claude-token"
echo "Done. Start it with: docker compose up -d orchestrator"
