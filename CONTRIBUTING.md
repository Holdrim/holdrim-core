# Contributing

Thank you for looking. A few things are true about this project that are worth knowing before you
spend time on it.

## How this is built

**This code is written with an AI agent and reviewed by a human.** Every commit carries
`Co-Authored-By`, and that is deliberate — you can see exactly how each line got here.

That is not an excuse for anything. The bar is the opposite: because the code is generated fast,
the proof has to be stronger than usual. So:

- **Every lock is verified by mutation.** Not "there is a test" — the test was broken on purpose to
  watch it fail. The fingerprint check, the traffic light, the missing-translation check, the
  sign-in guard: each one was sabotaged, observed failing, and restored, and the commit that
  brought it says how many mutants it took and what killed them. If a test cannot fail, it is not
  a test.
- **Comments explain why, not what.** Most of them record the failure a line is there to prevent,
  and they exist so nobody "simplifies" the line back into the bug.
- **Nothing ships without the HTTP contract green.** It starts a real server and talks to it.

If you think a decision here is wrong, the commit message probably says why it was made. Argue with
that.

## What a change needs

Five proofs, before every commit:

| | |
|---|---|
| Types | `npx tsc --noEmit` — clean |
| Lint | `npx eslint engine examples` |
| Tests | `npm test` — green, and a new test for what you changed |
| Contract | `bash engine/test-contract.sh` — it starts a server and speaks HTTP, and must end in "all good" |
| Language | `bash scripts/check-language.sh --comments=en $(git ls-files '*.ts' '*.js' '*.sh')` |

When the panel (`engine/web`) or the API changed, also run `npm run browser`: the panel, driven in
a real Chromium against a real server. It is the only proof that sees what the page actually loads.

Run them on the Node named in `.nvmrc` (`nvm use` reads it). CI runs them there, and runs the unit
tests and the contract again on the oldest Node that `package.json` promises. There is no build
step to wait for: Node runs the TypeScript as it is.

`npm test` is unit only and **never boots the server**, and the pre-commit hook does not run the
contract test. Run the contract test yourself.

Every change with logic gets a **mutation**: break it on purpose, watch a *named* test fail, restore
it — then say so in the pull request. A green test nobody has seen fail proves nothing. When there is
no logic to mutate — a pure removal, a translation — say that instead of inventing one.

## And the six lenses

The proofs answer "does it run". They cannot answer whether a string slipped into Portuguese,
whether a guard is one reorder away from being useless, whether a rule now exists twice, or whether
the next reader will undo a fix because nobody wrote down why it is there. Six reviewers do, one
question each, and they live in `.claude/agents/` as plain Markdown — `review-language`,
`review-proof`, `review-locks`, `review-engine`, `review-correctness` and `review-craft`. Each file
says what its lens asks and why, and `.claude/skills/full-review/SKILL.md` says how to run them.
What each lens ASKS is described in exactly two places — its own file, and the table in that
skill — and nowhere else. The names appear in a few more, which is fine; a second description of
what a lens looks for is not, because it goes on answering a question the lens has stopped asking.

**The rite is proportional to what a mistake would cost, not to the size of the diff.** Every
change, at every tier, passes the five proofs, gets a mutation when it has logic, and merges only on
green CI. What varies is the review:

| Tier | What it covers | Lenses | Rounds |
|---|---|---|---|
| **1 · Critical** | an invariant in `AGENTS.md`, the event format, sign-in, signatures, privacy, permissions | all six | until clean |
| **2 · Product** | engine logic that touches no invariant: screens, CLI, the graph, toggles | proof, correctness, craft | one, and one more if a fix changed logic |
| **3 · Support** | documentation, configuration, development scripts, CI, examples | language, craft — and locks when an invariant's wording changes | one |

The pull request names its tier, and when in doubt the tier goes up, never down. A MINOR never opens
another round: it rides the next commit when it is trivial, or becomes an issue. A later round reads
only what the fix changed.

Read `LESSONS.md` first, its Security section above all: it is what earlier reviews missed, and
the three questions every pull request answers. Then run them over your change and come back with
no blocker before you open the pull request. Say in the pull request what they found and what you
did with it.

**Whichever agent you use.** Holdrim was built and proved with Claude Code, and there it is one
command, `/full-review`. It picks no vendor: the six lenses are Markdown files any agent can be
handed, and `.claude/skills/full-review/SKILL.md` is the recipe — what to diff, how to run the six in a
worktree, how to verify a finding before repeating it, and what the report looks like. It is
written for Claude Code, and names its tools where it has to; the six lens files are the part that
transfers unchanged.
Running them well with Codex, with Gemini, or with something not written yet is work we have not
done — the shape of it is `examples/hello-world/AGENTS.md`, which already carries the method for
agents that are not Claude Code. If you make one of them work, that is a contribution worth more than most: open a pull
request.

If you have no agent at all, read the six files yourself. They are six checklists, and a person
with the diff open can work them.

## Contributing from a fork

Read access is enough to contribute: the proposed change lives in your fork and reaches the
project through a pull request, so you do not need write access to the original repository.
Create a fork of `Holdrim/holdrim-core` in your own GitHub account, then clone that fork. Keep
`Holdrim/holdrim-core` as the read-only `upstream` remote; do your work on a local branch or
worktree, and push only to your fork (`origin`). For example, replace `YOUR-LOGIN` with your GitHub
login:

```bash
git clone https://github.com/YOUR-LOGIN/holdrim-core.git
cd holdrim-core
git remote add upstream https://github.com/Holdrim/holdrim-core.git
git config remote.upstream.pushurl disabled://upstream-is-read-only
git fetch upstream
git switch -c YOUR-LOGIN/short-change-name upstream/main
# Commit after the five proofs, then review before publishing, as the sections above require.
git push -u origin HEAD
```

Open a pull request from your fork's branch to `Holdrim/holdrim-core`'s `main`. The push URL guard
makes an accidental push to `upstream` fail; keep pushing explicitly to `origin` after the existing
proofs and the review for your tier are complete. Follow [What a change needs](#what-a-change-needs)
and [And the six lenses](#and-the-six-lenses), then fill
[the pull request template](.github/PULL_REQUEST_TEMPLATE.md) with the evidence from your run.

## Working unattended

`.claude/settings.json` allows, without a prompt, the commands a session needs to get through the
rite on its own, and denies a force push in any of its spellings; the list is there, not here, so
that it has one copy. Anything outside it still asks.

A person who wants a session that runs start to finish with no prompt at all starts it in a mode
that skips them — in Claude Code that is the `--permission-mode` flag on the command line, and
another agent has its own equivalent. That is a choice made when the session starts, by the person
starting it; no file in this repository turns it on for them.

## JavaScript or TypeScript

`engine/api/` and `engine/cli/` are TypeScript. `engine/core/` is JavaScript, and that is a
constraint, not a leftover. The core is the one code the server, the CLI and the browser all
share: the panel imports `engine/core/fingerprint.js` exactly as the server serves it, and a
browser strips no types. So a fingerprint computed in the browser and one computed on the server
come from the same file, and a `.ts` in the core would break the panel on its first import.
The TypeScript that imports it gets its types from the JSDoc (`allowJs`); the core itself is not
type-checked (`checkJs` is off), which is the price of the split.

The tests (`engine/tests/`, `engine/test-browser.js`) are JavaScript too, and there it is only
convention: they run in Node alone, so nothing forces it, but every one of them is `.js` and a
reader should not have to guess which kind the next one is.

A new file in `engine/api/` or `engine/cli/` is `.ts`. A new file in `engine/core/` is `.js`, and
imports only the core and `node:` — and whatever the browser loads imports no `node:` at all.
`engine/tests/core-layout.test.js` holds those three. A new test is a `.test.js`, like its
neighbours.

## Language

Everything in the code is English: identifiers, comments, strings, test names, file names, table
names, column names and commit messages. `scripts/check-language.sh` enforces the comments in CI.

Messages a reviewer reads go through `engine/core/i18n.js` and live in `engine/locales/`. Logs stay
English always — a log is evidence, and evidence that changes wording by locale cannot be grepped.

The two exceptions are the translated values in `engine/locales/pt-BR.json` and
`engine/locales/es.json` — their keys are English, and so is every variable, attribute and command —
and the README's translations, `README.pt-BR.md` and `README.es.md`, which a test keeps in step with
the English they translate.

## Kinds of pull request

Every pull request names one kind, in its description and as a `kind:` label, so a reader of the
history can find all the fixes, or everything that changed how people contribute, without reading
every diff. The kind says what the change is for; the tier above says how hard it is reviewed. The
two are separate on purpose: a `docs` change that rewords an invariant is still tier 1.

| Kind | For |
|---|---|
| `feature` | something the engine could not do before |
| `fix` | the engine did something wrong; the description says what, and how it was found |
| `security` | a lock, sign-in, a permission or an attack surface; always tier 1 |
| `docs` | documentation only |
| `tests` | proofs only: a test, a mutation that was missing, a flake with its root cause |
| `tooling` | CI, scripts, hooks, agent configuration |
| `refactor` | the same behaviour, arranged better; never mixed with a change of behaviour |
| `lessons` | what a review missed, turned into a rule in a lens and an entry in `LESSONS.md` (full-review, step 6) |
| `contributor-experience` | what it takes to clone, build, run and contribute, found by doing it |

Commit messages carry no kind prefix: the first line says what changed, in plain words, as the
section below asks. The kind lives on the pull request, where it is read.

**Say which agent made it.** This repository is built with AI agents and reviewed by people, and
contributions come from more than one vendor's agent. The pull request names the agent and the
model as its vendor names them, or says it was written by hand. That is how a reader weighs what
it claims, and how the project learns which rules each agent follows well and which it does not.

## Commit messages

Long ones. The first line says what changed, and the body says **why it was needed** — with the
accident, if there was one. A message that could have been written without running the code is not
worth the line it takes.

The hooks live in `.githooks/`. Turn them on once per clone:

```bash
git config core.hooksPath .githooks
```

`commit-msg` enforces the shape: first line between 15 and 72 characters, no trailing period, blank
second line, and not just "tweaks", "fixes", "wip" or "update". `pre-commit` is deliberately fast —
syntax, lint and JSON of what is staged, a scan for secrets, the core tests when the engine changed,
the types when a `.ts` changed, `holdrim check` when an example's pages or JSON changed, and a
rebuild of the panel's bundle when it or anything it is built from changed, English dictionary
included — refused while any of those has changes left unstaged, since the build reads the working
tree.

## What is not welcome

- A pull request that adds a dependency without saying what it replaces.
- A test that only proves the happy path.
- A rename that mixes into a behaviour change — they become one unreadable diff.
