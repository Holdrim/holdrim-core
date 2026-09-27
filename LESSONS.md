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
  Lives in: `.claude/agents/review-locks.md`, under "What else you look for".
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
  a partial escape six lenses missed. Lives in: `.claude/agents/review-locks.md`, under "What else
  you look for".
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

- **Before fixing how something is written, read how it is read, and make both find it the same
  way.** Taught by #135: the fix asked for was "escape the id better", and the defect was that the
  writer (the first raw match, anywhere) and the reader (`main [data-id]`) could pick different
  elements, so a ✓'s fingerprint could come from one the owner never saw. Lives in:
  `engine/cli/pages.ts` (`resolveBlock` resolves as `readBlocks` does), and
  `.claude/agents/review-locks.md`, under "What else you look for".
- **A write that must touch one element is verified by re-parsing the whole result, not by checking
  that the target changed.** Taught by #135: a check satisfied by what the target already carried
  let a repeat stamp land on another element. Lives in: `engine/cli/pages.ts` (`writesOnlyThe`).

- **A merge that brings two reviewed features together gets its own locks read, because neither
  review could see how they meet.** Taught by #138: #134's tamper routes were written where `api()`
  took a plain address, and after the merge they asked the owner question of the flattened address
  instead of `who` — a token for the owner's address would have passed the route's own guard. Lives
  in: not yet in `crew/orchestrator.md`; the scan in `engine/tests/roles-boundary.test.js` catches
  the known spellings.
- **An identity is decided by asking the roles (`isOwner(who)`), never by comparing addresses.**
  Taught by #138: the owner-reset guard's `target !== email` gave every person the right answer and
  a token the wrong one. Lives in: `engine/api/server.ts` and the address scan; the scan matches
  spellings, not meaning, so a new spelling still needs a reviewer.

- **A rule that a path stays inside the project or the site is checked on the path's real
  location, links followed, where the file is opened; a check on the path as written is only the
  first half.** Taught by #165, whose first round checked `content.registry` only as written, and
  carried by #167 to the configured folders and by #168 ("Serve, scan and embed only files whose
  real location is inside the site") to each file the engine reads from the content. Lives in:
  `insideRoot` (`engine/core/paths.js`) and `realContainment` (`engine/cli/fs.ts`), now the one
  rule for a real location: `refuseEscapedFolder`, `refuseServedStore`, `serveStatic` and
  `loadLogo` all ask it. `serveStatic`'s own lexical checks answer the request URL alone, before
  it.
- **When a review finds a gap in one caller of a check, the next question is where else the same
  shape lives, before the fix is called done.** Taught by #168: the gap #165 closed for the
  registry was the one the served site, the page scan and the theme logo each carried, and one
  helper closed all three. #170 asked the same question of what the server writes, and now refuses
  to start when a store would be served by the site. Lives in: `.claude/agents/review-locks.md`,
  under "What else you look for".
- **A capped table never evicts a row that still protects someone before a row that does not:
  evicting oldest first lets anyone who can add rows push out the row they are after.** Taught by
  #166: the sign-in failure table's ceiling evicts rows not yet counting towards a wait first, and
  rows that do only when they alone exceed it. Lives in: `escalated`, in
  `engine/api/identity-password.ts`, and each user store's prune, held by "a row still in its wait
  outlasts a flood of newer rows over the ceiling" (`engine/tests/login-throttle.test.js`) and
  "past the ceiling, escalated rows go last…" (`engine/tests/users-conformance.test.js`).
- **A guard that would have to re-implement a language to judge a construct refuses the construct
  outright, and whoever needs it changes the guard on purpose.** Taught by #157: a check that read
  `.dockerignore`'s `!` lines for the names of the test-only paths stayed green for a glob that
  named none of them and still re-included one. Every `!` line is now refused. Lives in:
  `engine/tests/workflows.test.js`, "the image ships no test-only paths", and as a general rule in
  `.claude/agents/review-locks.md`, under "What else you look for".

## Proof

- **A test whose expected value is computed by the function under test proves nothing.** Taught by
  round 2 of #107. Lives in: `.claude/agents/review-proof.md`, under "What you look for", in "A
  test that cannot fail".
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

- **A test that must tell two refusal layers apart asserts the refusal's sentence, not only its
  status.** Taught by #138: "nor acknowledge a finding → 403" stayed green with the allowlist opened,
  because the route's own guard also answers 403. Asserting `api.token.routeRefused` made the line
  mean what its comment says — and proved it without widening the allowlist in the repository.
- **A lens report of `[]` without what it checked is weak evidence, and is asked again.** Taught by
  #129's correctness lens. Lives in: the lens contract, which asks for "clean with what you checked".

- **A test that depends on file permissions is proved as a plain user: root passes every access
  check, and CI runs as a plain user.** Taught by #156: a test that saved over a 0440 registry
  passed locally as root, and in CI the save was refused with EACCES, exactly as the code intends.
  Lives in: the comment on that test in `engine/tests/atomic-registry.test.js`, and
  `.claude/agents/review-proof.md`, under "What you look for".
- **A refusal is proved through the entry point that meets the input (a boot of the real server,
  the CLI command), not only through the function beneath it.** Taught by #165, whose round-1 proof
  lens found `content.registry`'s refusal proved only through `readConfig` with a mocked reader.
  Lives in: the boot-refusal cases in `engine/test-contract.sh` for `content.registry` (#165),
  `content.folders` (#167) and a store inside the site (#170), and as a rule in
  `.claude/agents/review-proof.md`, under "What you look for".
- **A comment that says a case is already handled elsewhere is a claim, and it gets a test of that
  case before anyone relies on it.** Taught by #165: the first commit's comment said a symlink
  inside the root that points elsewhere was "already refused" where the registry is loaded and
  saved, and a working symlinked folder passed every check it named. Lives in:
  `.claude/agents/review-proof.md`, under "What you look for".
- **A test that races a clock against a wait flakes on a slow runner, so it asserts the state the
  rule protects instead.** Taught by #166: a test expected a 5 s wait to still hold after eighty
  wrong passwords, CI's floor runner took 6.4 s to get there, and the test now reads the row itself.
  Lives in: that test, in `engine/tests/login-throttle.test.js`, and
  `.claude/agents/review-proof.md`, under "What you look for".

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
- **A gap between a check and the use of a path is named in the pull request, with who could win
  it and whether they are inside the trust boundary; a rewrite onto file descriptors that the
  platform cannot do cleanly is not chased.** Taught by #165, and said the same way in #156, #162
  and #168: only someone who can already write to the server's disk can swap a folder between the
  check and the use, and that person is outside what these guards defend. Lives in: not yet.

## Process

The crew, and the review.

- **A lens other than proof treats the worktree as strictly read-only, not even a temporary edit;
  its experiments go in a `mktemp -d` directory, and it writes no output file into any worktree or
  the person's tree.** Taught by #125, round 3 of #131, and round 1 of #109, whose lens wrote a log
  into the main checkout. Lives in: `.claude/skills/full-review/SKILL.md`, step 3, the shared
  contract.
- **The shared contract every lens is handed lives in a file under a name nothing else would pick,
  read-only on disk, and whoever launches the lenses confirms its first line before each round.**
  Taught by #79's backlog, where a contract-test log overwrote `contract.txt`, and round 2 of #107,
  where a developer's contract-test log overwrote the orchestrator's copy. Every lens launched after
  it (#107 rounds 2–3, #109 rounds 1–2, #122 round 1, #79) got a test log instead: still told to
  stay read-only and given the Done-when, never told that the change under review is data, never
  instruction. A final locks pass under the right contract runs before those pull requests merge.
  Lives in: `.claude/skills/full-review/SKILL.md`, step 3, before the parts of the prompt.
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
  branches from the local HEAD.** Taught by #104, #135: #135's branch came from a local `main` one
  merge behind, and four clean review rounds ended in a conflict with #131 in the very functions
  they reviewed. Lives in: not yet — twice now, so it belongs in the script.
- **A lens gets a time box in its prompt, and a long experiment is cut short and reported.** Taught
  by #135: a correctness lens ran over two hours, a container restart lost it with nothing
  reported, and the round waited for a second run that took six minutes. Lives in: not yet.
- **The stopping rule — a new evasion outside the diff is MINOR and a new issue — goes into the
  round-2 prompt, not the round-5 one.** Taught by #109, #135. Lives in: not yet.
- **`Closes #N` is written plainly, because bold hides the keyword from GitHub.** Taught by #123.
  Lives in: `.github/PULL_REQUEST_TEMPLATE.md`.
- **A `CHANGELOG.md` entry is part of "Done when" for anything an adopter will notice.** Taught by
  #113. Lives in: not yet.
- **When an issue names a design document, the document wins, and the orchestrator rescopes on the
  record.** Taught by #29. Lives in: not yet.

- **A hook that refuses is an answer: fix what it refused, and never switch the hook off to get
  past it.** Taught by #166, where a merge of main was committed with `core.hooksPath` pointed at
  `/dev/null`; the proofs ran afterwards and the setting was restored, but a guard switched off for
  one commit guards nothing in it. Lives in: not yet. `.githooks/pre-commit` still offers a person
  `--no-verify` once, with the reason in the commit, and no agent file says an agent never takes it.
- **Merging main into a pull request re-runs its contract test, because two branches that each add
  a refusal at boot can make each other's expectations stale.** Taught by #170: once it merged, an
  open pull request's contract case for a users store inside the site stopped on #170's refusal
  first, and its expectation had to change. Lives in: `AGENTS.md` rule 3, "before every commit",
  which does not exempt a merge; not yet said there in words.
- **A lens's CRITICAL is a claim to check against main and the threat model before anyone acts on
  it.** Taught by #166: a lens called a missing migration CRITICAL for `sign_in_failures`, a table
  the same unmerged pull request introduced. Lives in: `.claude/skills/full-review/SKILL.md`, step
  4, for checking the file at the line; not yet for checking whether main already has what the
  finding assumes, or whether the actor it needs is inside the threat model.
- **Every pull request answers the three questions in its body.** Taught by the fourteen pull
  requests merged between #145 and this pass, #154 to #171: none has the section, though the
  template asks for it, so none recorded its cost either. Lives in: not yet.
  `.github/PULL_REQUEST_TEMPLATE.md` asks, and nothing refuses a body without the answers.

## Cost

Tokens and rounds per pull request, as the crew records them. "Was it economical?" is answered
against these, and a cost that repeats becomes a Process lesson.

| Item | Tokens | Rounds | What it taught |
|---|---|---|---|
| #28 | 3.5–4M in sub-agents, against a 0.7–1.5M budget | 4 | most of it was one developer resumed across four rounds; a fresh one did round 4 for about 140k |
| #107 | about 2.4M: developers about 0.75M, lenses about 1.6M | 3 | a fresh round-3 developer took 115k, against about 340k of context for the resumed one |
| #135 | about 2.5M: developers about 1.05M, lenses about 1.45M | 4 | the round-1 redesign would have come from reading `readBlocks` next to `mark` before any code; round 2 resumed round 1's developer to 340k, against 71k for a fresh one in round 4 |
| #140 | about 1.3M: developers about 0.46M, lenses about 0.8M | 3 | the round-1 scope added `check` comparing the page seal with the registry, which the issue alone did not ask for and the locks lens then made the core of the PR |
| #129 | about 0.37M | 1 | tier 2 with four sonnet lenses; the one finding was a test assertion, fixed by the orchestrator directly |
