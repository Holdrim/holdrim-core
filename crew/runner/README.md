# The orchestrator's runner

One unattended pass of the orchestrator, in a container that holds only the machine account's
credential. The rules it follows are [`../autonomy.md`](../autonomy.md); this folder only starts it.

## What a pass does

1. Checks that the GitHub token is @holdrim-orchestrator's and that `../accounts.md` still lists it.
2. `board.js snapshot` reads every open issue and pull request into files: title, body, draft
   state, labels, comments, the label timeline, head commit, checks, reviews and the inline review
   comments on a pull request's lines. If the owner put `paused` on the handoff issue, the
   pass ends here; if nothing changed since the last pass that ran the model, it ends here too.
3. The model reads those files and the crew rules and answers in JSON. It runs as its own user,
   `model`, which the operating system keeps out of `crew`'s home, where both tokens are stored,
   and out of `crew`'s processes. Its environment carries only the Claude token it needs, and it
   runs with `Read`, `Grep` and `Glob` only, confined to `/work` by `--restricted`, with no MCP
   server: it cannot run a command, reach the network, or read the GitHub token.
4. `board.js publish` applies the answer, and only the part the orchestrator may do: comments and
   existing `needs:`/`working:` labels on items already open, one comment per item (bar the note of
   what it refused), never twice
   under the same key, never removing `needs:owner`, never carrying a token, in the body or the
   key. Everything else is refused and said on the handoff issue. Before every write it reads the
   owner's `paused` again, since the model may have run for minutes: paused, or unreadable, and
   nothing more is written. An answer that is missing or unreadable applies nothing and
   is tried again on the next pass.

Behind a proxy, set `HTTPS_PROXY` (and `NO_PROXY`, `NODE_EXTRA_CA_CERTS` if needed) in the
environment; the model gets them too. A proxy URL with a user or password in it, with a scheme or
without, stops every pass before anything runs: it would reach the model as a command-line
argument, which any process in the container can read.

Pause it from GitHub by adding `paused` to the handoff issue from the owner's account; remove the
label, from the owner's account too, to resume. A `paused` added or removed by any other account is
logged and ignored, and a pass that finds no handoff issue, or more than one, stays idle. A pause
that lands while the model is running stops the pass before its next write.

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
docker run --rm --env-file /etc/holdrim/orchestrator.env -v holdrim-orchestrator-state:/home/crew/.state holdrim-orchestrator
```

Every two hours, from the host's crontab:

```
0 */2 * * * docker run --rm --env-file /etc/holdrim/orchestrator.env -v holdrim-orchestrator-state:/home/crew/.state holdrim-orchestrator
```

## Turning it off

Revoke the machine account's token, or remove the account from the repository. That is the off
switch (#87, decision 4); stopping the cron only pauses it.
