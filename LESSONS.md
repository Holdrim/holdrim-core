# Lessons

What each review round and each merged pull request taught, kept where the next contributor meets
it. **Read it before you open or update a pull request**, and read the Security section first: a
lesson there is a lock, a guard or a claim that was found weaker than it looked.

It is written after a pull request merges, by the lessons pass
(`.claude/skills/full-review/SKILL.md`, step 6), and whenever a review round finds something a lens
should have seen.

This is not a second rulebook. Each entry is one rule, the pull request or issue that taught it, and
where the rule now lives: the lens file, the `AGENTS.md` invariant, the test or the script that
enforces it. Once it lives there, that place is the authority and the entry is only a pointer and a
reason. **Not yet** means nothing enforces it, and that is the next lessons pass's work: move the
rule into its place, then update the entry.

## The questions every pull request answers

Three to start with. The list is meant to grow, and a new question is added the way a lesson is:
with the pull request that taught it. The pull request template asks them; this is what they mean.

- **Did it make sense?** It solves the issue's Why, and it is the simplest thing that does. The
  owner would recognise it as what they asked for. A good answer names the Why and says what was
  left out on purpose.
- **Was it economical?** The tokens and review rounds it took, per agent and model where the vendor
  reports them, against the tier's budget when one exists. A good answer gives the numbers, and
  when a round or a resumed context cost more than it had to, says why.
- **Can it expose an error?** Three kinds, and a good answer names what was checked for each:
  - *security*: a guard, a lock, an invariant, or a claim in `SECURITY.md`;
  - *amateurism*: an untested branch, a comment that lies, a copied rule, a half-translated
    string, a check reported as run that did not run;
  - *AI delusion*: an invented API, file, flag, test result or past event, or a claim nobody
    checked against the code.

## Security

Locks, tamper detection, the stores, and who holds authority.

- **Every claim in `SECURITY.md` is attacked store by store, SQLite with its triggers and Firestore
  with none, because security wording overclaims easily.** Taught by #28, #91, #107, #109.
  Lives in: not yet. `review-locks` reads `SECURITY.md` but is not told to attack each claim per
  store, and it takes the invariants from `AGENTS.md` alone, so a new exception has to be stated
  there, exactly.
- **A table the security rests on is a frozen array, and callers get a copy: `Object.freeze` on a
  `Set` freezes the binding, not its contents.** Taught by #104. Lives in: `engine/core/roles.js`
  (the comment on `ROLE_CAPABILITIES`) and `engine/tests/roles.test.js`, for the roles table.
- **A scanner that matches the shape of a value is evaded by a variable, a `switch`, `.includes` or
  a lookup, so it tracks where the value comes from, and each known evasion gets a self-test.**
  Taught by #34, #104. Lives in: `engine/tests/roles-boundary.test.js`, for role names.
- **A text scan that enumerates guards can always be beaten, so it is paired with a live backstop: a
  real server with every toggle at its non-default value, and a refusal checked per guard.** Taught
  by #34. Lives in: `engine/test-contract.sh`, through `everyToggleFlipped` in
  `engine/core/features.js`.
- **Data interpolated into a pattern (a RegExp, SQL, a shell line) is a finding; prefer the
  construct that needs no escaping, such as comparing strings.** Taught by #83, where CodeQL caught
  a partial escape six lenses missed. Lives in: not yet. `review-locks` refuses raw interpolation
  into CSS, HTML and SQL, not into a RegExp or a shell line.
- **An output identifier is synthetic, a real id appears only inside an escaped label, and hostile
  ids prove it: `"`, `\`, `<`, `#`, the keyword `end`, two ids that sanitise alike.** Taught by
  #106. Lives in: `engine/tests/graph.test.js`.
- **Authority written into a document an agent reads is an attack surface, so a tier-3 change that
  grants rights gets the locks lens.** Taught by #82. Lives in: not yet. The tier-3 row in
  `CONTRIBUTING.md` calls locks only when an invariant's wording changes.
- **A read-side check that trusts an event's type is proved against a forged one: a comment
  carrying `data.finding` does not quiet a finding; only the owner route's event, with `asAgent`
  "false", does.** Taught by #107. Lives in: not on main. Open pull request #134 enforces it, with
  its tamper test.
- **A guard that reads `rowid` is blinded by a user column named `rowid`, `oid` or `_rowid_`, so the
  shared guard check names such columns.** Taught by #109. Lives in: not on main. The open work on
  #109 enforces it, in `guardMismatches` (`engine/api/store-sqlite.ts`).
- **A BEFORE INSERT trigger sees `NEW.rowid` as -1 when SQLite picks the rowid, so one row parked at
  rowid -1 makes every later insert read as a replace to a guard that compares rowids.** Taught by
  round 2 of #109. Lives in: not yet. `events_no_replace` still compares `rowid = NEW.rowid` before
  the insert, and #109 is fixing it.
- **A tampered row stays tampered whatever is forged beside it: today one row that fails its hash,
  plus one forged removal naming it, reads as a clean removal and silences the CRITICAL line.**
  Taught by the review of #107, filed as #133. Lives in: not yet.
- **Acting on a file whose guards are broken refuses (sync, apply, state); reading only warns, and
  `list --json` hands an agent no requests.** Taught by #128, #131. Lives in:
  `refuseToActOnBrokenGuards`, in `engine/cli/requests.ts`.
- **A merge of main into a branch that touches a security route gets a locks read of the
  resolution.** Taught by #117. Lives in: not yet.

## Proof

- **A test whose expected value is computed by the function under test proves nothing.** Taught by
  round 2 of #107. Lives in: not yet. The nearest is `review-proof`'s test that "asserts on a value
  it just built".
- **Each condition in a trigger's `WHEN` gets its own test: dropping any one conjunct fails a named
  test.** Taught by #28. Lives in: not yet.
- **A ROLLBACK is proved only by a failure that comes after a write.** Taught by #28. Lives in: not
  yet.
- **A test helper that returns empty on a failed parse turns every "expect equal" into a vacuous
  pass, so the helper proves itself first.** Taught by #127, #130. Lives in:
  `engine/test-contract.sh`, in `log_field`'s self-check and `require_id`.
- **A test that skips where it matters is not a test: every skip condition has a CI job that sets
  it and fails when the test did not run.** Taught by #26, #71. Lives in: the `stores` job of
  `.github/workflows/tests.yml`, with `HOLDRIM_TEST_REQUIRE`, held by
  `engine/tests/workflows.test.js`, for the store suites. Not yet for any new skip condition.
- **A merge of two reads is tested for the identity, length and order of what comes back, not only
  for the resolved values.** Taught by #28. Lives in: not yet.
- **A test that cannot fail, guarding a lock, is CRITICAL whatever the tier.** Taught by #34. Lives
  in: `.claude/agents/review-proof.md`, under Severity.
- **An equivalent mutant is read as a sign that the comment's reason is wrong, not only that the
  test is.** Taught by round 1 of #109. Lives in: not yet.

## Correctness

- **A read-consistency fix on Firestore stays inside the 270-second transaction limit: read
  normally, and re-read only on suspicion.** Taught by #28. Lives in: not yet as a rule. The reason
  is recorded where it applies, in `engine/api/texts.ts` and `engine/api/store-firestore.ts`.
- **A re-read that borrows other rows to resolve its own returns only the caller's rows.** Taught by
  #28. Lives in: `engine/api/texts.ts` and `engine/tests/texts.test.js`, for `withTextsRetrying`.
- **Wall-clock order is not causal order: a writer never dates a removal before its target.**
  Taught by #28. Lives in: `notBefore`, in `engine/api/texts.ts`, with its test in
  `engine/tests/texts.test.js`.
- **A document that restates a table drifts from the code, so a document is read against the code
  it describes.** Taught by #104. Lives in: not yet.
- **A form's submit is cancelled before the data it filters loads, not once it is drawn.** Taught by
  #42, #132. Lives in: `engine/test-browser.js`.
- **SQLite's largest rowid does not fit a JavaScript integer and throws `RangeError`, so a rowid a
  hostile file can set is read as REAL.** Taught by round 2 of #109. Lives in: not on main. The
  open work on #109 enforces it.

## Process

The crew, and the review.

- **A lens other than proof treats the worktree as strictly read-only, not even a temporary edit;
  its experiments go in a `mktemp -d` directory, and it writes no output file into any worktree or
  the person's tree.** Taught by #125, round 3 of #131, and round 1 of #109, whose lens wrote a log
  into the main checkout. Lives in: `.claude/skills/full-review/SKILL.md`, step 3, the shared
  contract.
- **A lens cannot read GitHub, so the issue's "Done when" and the owner's decisions on it are pasted
  into every lens prompt.** Taught by #91. Lives in: `.claude/skills/full-review/SKILL.md`, step 3,
  the parts of the prompt.
- **Before a merge, every lens the tier requires has read the final head, not an earlier round.**
  Taught by #29, #35, #91. Lives in: not yet. `crew/orchestrator.md` asks for the tier's review,
  not which commit it read.
- **From round 3, a fix goes to a fresh developer with a brief, not to a resumed one whose context
  has grown to hundreds of thousands of tokens.** Taught by #28, #107 (see Cost). Lives in: not yet.
- **Every run that boots a server gets its own `PORT`.** Taught by #104, #128. Lives in:
  `engine/test-contract.sh`, which spreads its default port and refuses one already taken. Not yet
  for `npm run browser`, which defaults to one fixed port.
- **Before trusting a contract failure as your own, run it on the base.** Taught by #126, #127.
  Lives in: not yet.
- **Before pushing, check that the remote branch does not already exist; never force.** Taught by
  #128. Lives in: `.claude/settings.json`, which denies a force push. The check before pushing: not
  yet.
- **A worktree for new work is created from `origin/main` by name, because `scripts/worktree.sh`
  branches from the local HEAD.** Taught by #104. Lives in: not yet.
- **`Closes #N` is written plainly, because bold hides the keyword from GitHub.** Taught by #123.
  Lives in: `.github/PULL_REQUEST_TEMPLATE.md`.
- **A `CHANGELOG.md` entry is part of "Done when" for anything an adopter will notice.** Taught by
  #113. Lives in: not yet.
- **When an issue names a design document, the document wins, and the orchestrator rescopes on the
  record.** Taught by #29. Lives in: not yet.

## Cost

Tokens and rounds per pull request, as the crew records them. "Was it economical?" is answered
against these, and a cost that repeats becomes a Process lesson.

| Item | Tokens | Rounds | What it taught |
|---|---|---|---|
| #28 | 3.5–4M in sub-agents, against a 0.7–1.5M budget | 4 | most of it was one developer resumed across four rounds; a fresh one did round 4 for about 140k |
| #107 | about 2.4M: developers about 0.75M, lenses about 1.6M | 3 | a fresh round-3 developer took 115k, against about 340k of context for the resumed one |
