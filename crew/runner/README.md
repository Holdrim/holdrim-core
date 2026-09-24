# The orchestrator's runner

One unattended pass of the orchestrator, in a container that holds only the machine account's
credential. The rules it follows are [`../autonomy.md`](../autonomy.md); this folder only starts it.

## Credentials

Two, both passed at `docker run` and kept in a file that lives on the host, never in git:

| Variable | What | How to get it |
|---|---|---|
| `GH_TOKEN` | @holdrim-orchestrator's GitHub token | `gh auth login` signed in as that account, then `gh auth token` |
| `CLAUDE_CODE_OAUTH_TOKEN` | the Claude subscription that pays for the run | `claude setup-token` |

The owner's GitHub token never goes here. The script refuses to start unless the token is the
orchestrator's own account, listed in [`../accounts.md`](../accounts.md); that check catches a
mistake, and the real guarantee is that the owner's token is never on the host that runs this.

## With Docker Compose (one command after a one-time setup)

```bash
cd crew/runner
docker compose --profile setup run --rm setup   # once: two sign-ins in a browser
docker compose up -d orchestrator               # then a pass every two hours, for good
docker compose logs -f orchestrator             # watch it
```

`setup.sh` signs in to GitHub **as @holdrim-orchestrator** and refuses, logging out again, if the
account is anyone else. It then stores a Claude token from `claude setup-token`. Both live in the
compose volumes `secrets` and `gh-config`, never in the image or the repository. To start over,
`docker compose down -v` deletes them.

## Running it by hand

```bash
docker build -t holdrim-orchestrator crew/runner
docker run --rm --env-file /etc/holdrim/orchestrator.env holdrim-orchestrator
```

Every two hours, from the host's crontab:

```
0 */2 * * * docker run --rm --env-file /etc/holdrim/orchestrator.env holdrim-orchestrator
```

## Turning it off

Revoke the machine account's token, or remove the account from the repository. That is the off
switch (#87, decision 4); stopping the cron only pauses it.
