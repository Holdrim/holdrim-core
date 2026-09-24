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

**The rite is proportional to what changed, not to how it feels to skip it.** A change with logic,
or that touches one of the invariants in `AGENTS.md`, gets all six lenses, and as many rounds as it
takes to reach a clean verdict. A change that is only documentation or configuration — nothing a
proof exercises — gets one round of the lenses that apply: `review-language` and `review-craft` at
least, and `review-locks` too when the wording of an invariant itself changed. A change that reads
small is exactly the one most likely to go unchecked; the size of the diff is not the test.

Run them over your change and come back with no blocker before you open the pull request. Say in
the pull request what they found and what you did with it.

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

## Working unattended

`.claude/settings.json` allows, without a prompt, the commands a session needs to get through the
rite on its own: `npm`, `npx`, `node`, `git` short of a force push, this project's own scripts and
engine commands, and the tools that read, edit, write and delegate work. That is the allowlist a
long session needs to reach the five proofs without stalling on something it was always going to be
asked to run anyway; anything outside it still asks.

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
