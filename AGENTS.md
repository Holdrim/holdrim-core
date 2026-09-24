# Working on Holdrim

Read this before changing anything, whoever you are: a person, or an agent in any tool. It is short
on purpose, and every rule in it guards against a mistake that is easy to make and expensive to find.
(`CLAUDE.md` only imports this file, for the one tool that reads that name instead.)

## What this is

**An engine, not a project.** Holdrim is the review machinery — fingerprints, the traffic light,
the approval lock, the panel, the CLI — distributed as a public Docker image. Documentation projects
**consume** it: they keep their own content and mount it into the image, the way Keycloak is used.

It names no company, no product and no person. Whatever varies is configuration in the adopting
project's `holdrim.json`. If you find yourself writing a client's name, colour or e-mail in here,
it belongs in their config instead.

## The rules that do not bend

**1. Nothing in Portuguese.** Not an identifier, a comment, a string, a test name, a column or a
commit message. The repository is public, and someone who opens it and sees another language closes
the tab. `scripts/check-language.sh` enforces comments in CI.
*The two exceptions:* the translated values in `engine/locales/pt-BR.json` and `es.json`, and the
README's translations, `README.pt-BR.md` and `README.es.md`, which `engine/tests/docs.test.js` keeps
in step with the English they translate. Everything that is contract — event vocabulary, `data-*` attributes, `HOLDRIM_*` variables, the keys of
`holdrim.json` — is English, and there is no layer that translates any of it on read.

**2. Green is not proof.** A passing suite is not the same claim as "it works". A suite stays green
while the server does not boot, while the traffic light calls every approval stale, while the local
runner exits before starting, while the one page the security headers protect goes without them —
whenever no test runs that path. A test that passes with its guard deleted guards nothing.
So every change with logic gets a **mutation**: break it on purpose, watch a *named* test fail,
restore it. If nothing fails, the test proves nothing and needs fixing before the change lands.
When there is no logic to mutate — a pure removal, a translation — say so instead of inventing one.

**3. The five proofs, before every commit.**
```bash
npx tsc --noEmit
npx eslint engine examples
npm test
bash engine/test-contract.sh          # must end in "all good"
bash scripts/check-language.sh --comments=en $(git ls-files '*.ts' '*.js' '*.sh')
```
The pre-commit hook is deliberately fast and does **not** run the contract test. `npm test` is unit
only and **never boots the server**. Run the contract test yourself.
When the panel (`engine/web`) or the API changed, also run `npm run browser`: the panel, driven in
a real Chromium against a real server. It is the only proof that sees what the page actually loads.

**Then the six lenses, before every pull request.** The proofs answer "does it run"; the lenses
answer what no command can. What they are, how to run them, and what to do with what they find:
`CONTRIBUTING.md`, under "And the six lenses". Everything about the gate is written there, and a
second description of it here is how the two start disagreeing.

**4. Comments say *why*, not *what*.** The code already says what. Keep the reasoning, the rejected
alternative and what breaks without it — that is what this codebase's comments are for, and it is
how the next reader avoids making the mistake. Say it in the present: "without this, X", not a story
of when X happened.

## Git

- **Never `git add -A`**, and never while another agent is working: it sweeps another agent's
  half-finished work into an unrelated commit. Add by path.
- **Parallel work goes in a worktree:** `bash scripts/worktree.sh <name>`. Two agents in one tree
  overwrite each other. The script links `node_modules` — replace the link with a real copy before
  installing anything, or you write into the main tree.
- ⚠️ **Never run `git init` with an inherited `GIT_DIR`**, which is what you get inside a git hook.
  It writes `bare = true` into the main repository's config, and every git command in that tree
  stops working until someone finds out why. `engine/core/git.js` strips the `GIT_*` variables; use
  it, and the test helper in `engine/tests/git.test.js`, rather than improvising.
- Hooks: `git config core.hooksPath .githooks`. The commit-msg hook wants a first line of 15 to 72
  characters, no trailing period, and a blank second line. The body that says why is not checked by
  any hook, and is expected all the same.
- `main` is protected: linear history, and the `test` check is required. No force push.

## Invariants the security of the product rests on

Each has a test. If you change the code around one, run the contract test and read it.

- **Exactly one owner**, and it comes from `HOLDRIM_OWNER`, never from a database column and never
  from `holdrim.json`: the admins likewise, from `HOLDRIM_ADMINS`. Zero or two owners and the service
  refuses to start; a `holdrim.json` naming `owner`, `admins` or `locks` refuses too, on the server
  and in the CLI, because whoever commits to the file is not whoever deploys.
  (`engine/core/roles.js`, `engine/core/config.js`)
- **Nobody but the owner resets or creates the owner's account.** Both routes are guarded, because
  guarding only one leaves the other open — an admin could create the owner's account during a
  handover and read the generated password out of the response.
- **Nothing is erased.** Events refuse `UPDATE` and `DELETE` by trigger. People are *disabled*, never
  deleted, and disabling drops the open session.
- **Only the owner's ✓ becomes a lock.** An agent may *close* an impact — "this change did not reach
  here" — and never *approve* — "this text is correct".
- **The theme is untrusted input.** It lands inside CSS and HTML. Colours are validated against a
  known format; interpolating a raw string lets `red; } body { display:none } /*` through.

## Running it

```bash
bash engine/run-local.sh                              # straight in, no login, events in memory
HOLDRIM_OWNER=you@example.org docker compose up       # the real sign-in screen, data in a volume
```
Working on the engine cannot touch anybody's real approvals: the local runner keeps events in
memory. The first-access password is printed once, in the log.

⚠️ If the port is taken, the OLD process keeps answering and you end up testing the previous build
without knowing it. `run-local.sh` refuses to start rather than lie; stop the process **by port**,
not by name.

## The agent

The agent **applies approved requests on its own**. A request approved by
the owner or an admin is the agent's to pick up, move through `applying` and `waiting`, and close as
`applied` with the commit that carried it. What the agent never does is approve: only the owner's
✓ becomes a lock, and an agent may close an impact ("this change did not reach here") but never
say a text is correct.

**The engine calls no model and holds no API key.** The agent is whichever CLI the person has on
their machine — Claude Code, Codex, Gemini — running with their own account. `holdrim list --json`
is the queue as data, `holdrim apply <id>` writes the brief and hands it to that CLI
(`engine/cli/agent.ts`), and `holdrim state <id> applied --commit` closes the loop. The plugin in
`plugins/holdrim/` teaches Claude Code the method; `examples/hello-world/AGENTS.md` teaches any other
agent. Nothing here runs unattended on somebody's subscription: it is always a person, at their own
computer, starting their own tool.

## Releasing

Tags are `vMAJOR.MINOR.PATCH`, and **a tag must point at a commit whose CI is green** — a tag on a
red commit forces a next version whose only content is "use this one instead".
`.github/workflows/release.yml` enforces it rather than trusting anyone to remember: a pushed tag is
published only if `scripts/check-release-tag.sh` accepts it — a version, equal to `package.json`, with
its section in `CHANGELOG.md`, on main — and the whole test workflow passes again on that exact
commit. So a release is: bump the version in `package.json` and date its `CHANGELOG.md` section
through a pull request, merge it, tag the merge commit, push the tag. There is no `latest`: adopters
pin.

Projects that consume the engine **pin** a version. A new command or behaviour reaches them only
when they move the pin — so change a caller of a new feature in the same commit that bumps the
version that contains it, never before.
