# Security

## Reporting

Report privately, through GitHub's **Report a vulnerability** button on the Security tab of this
repository. Please do not open a public issue for something exploitable.

Expect an acknowledgement within a week. This is a small project — that is the honest number, not
an SLA.

## What this software touches

Worth knowing before you run it:

- **It stores approvals, and approvals are evidence.** The database refuses `UPDATE`, `REPLACE` and
  `DELETE` through triggers — but only from a program that does not first drop them, and not
  `INSERT`: someone with write access to the file can `DROP TRIGGER` before touching a row, or
  simply insert a forged event, so the triggers stop mistakes and ordinary tools, not that person.
  (A dropped trigger is reinstalled on the next boot, and that boot names it in a warning
  [holdrim#89](https://github.com/Holdrim/holdrim-core/issues/89). The CLI reading the file with
  `--db` makes the same comparison on every read
  ([holdrim#108](https://github.com/Holdrim/holdrim-core/issues/108)), with the file opened
  read-only, so it repairs nothing: it names each guard missing or changed, and each trigger that
  is not a guard, in a `sqlite_guard_missing` warning on stderr; `holdrim list --json` carries
  `guardsTampered`; `list` exits non-zero, and `show`, `impact` and `summary` warn and go on
  reading — reading never refuses. Acting does: `sync`, `apply` (`--dry-run` included) and `state`
  exit non-zero before a lock is written into `approvals.json` or a page, a brief written, an agent
  started or an event recorded, because a guard gone is how a rejection is rewritten into an
  approval, or an old ✓ onto today's text, where no text hash looks. Both checks catch a
  guard left dropped, not a person who puts it back: dropping a guard, changing rows and recreating
  it by its exact text before anything reads the file leaves nothing either check can see, and —
  for the server — neither does emptying every table. Only signed events close that.) For an
  event's own text, moved
  out of the event into its own table, a forged removal dated and ordered after the text it targets
  can still pass as a genuine one; a backdated one cannot (docs/PRIVACY.md, section 4). Closing this
  for every kind of forgery, or for a trigger dropped outright, needs the events themselves signed —
  not built yet.
  People are disabled, never deleted, so every ✓ keeps the name of whoever gave it. What that
  means for personal data, and how a person is removed without breaking the trail:
  [`docs/PRIVACY.md`](docs/PRIVACY.md).
- **A text that fails its own hash raises a CRITICAL alert — but only once something reads it.**
  A row edited in place, a hash with no row and no valid removal, two removals of the same field, or
  (SQLite only — see below) a hash stripped off a row that postdates when extraction began
  ([holdrim#91](https://github.com/Holdrim/holdrim-core/issues/91)) each log a CRITICAL
  `text_tampered` line (`reportTampered`, `engine/api/texts.ts`) the moment the server, or the CLI
  reading the file or the cloud directly, resolves that field — every time, not once: there is no
  acknowledgement yet to quiet it — and `holdrim list`/`sync` warn and exit non-zero on the same
  finding. Nor does it watch on a schedule: it fires when a page, the panel or the CLI actually reads
  the record, so one nobody ever re-reads raises nothing until somebody does. The panel's own banner
  and an acknowledgement event for the owner to clear it — the rest of holdrim#91 — are not built yet;
  today the alert is the log line and the CLI's exit code.

  What a direct writer can still make this alert miss differs by store, and neither is a new gap —
  both are the same one write access to the file or the project always had, made visible for the
  first time here:
  - **SQLite.** The comparison runs fresh from the CURRENT rows on every read, by code the write
    access that forges a row does not reach — forging the evidence and silencing the alarm about it
    need two different footholds. What that write access CAN still do: strip a row's hash back to
    `null` and write the forged value straight into `text`, dressing a fresh event as one of the
    genuine pre-extraction rows the reader has always passed through unchanged. `rowid` closes this
    for anything appended after the FIRST row this database ever hashed (`extractionBoundary`,
    store-sqlite.ts) — a stripped hash on any later row now reads as `downgraded` tampering, since
    rowid only grows and nothing on `events` is ever deleted. Getting there took two guards, not
    one: `events_no_replace` alone only refuses a rowid ALREADY held, which used to leave every
    UNHELD low one — a negative rowid, or 0, are always free; a real `append` never asks for
    anything but the next positive one — open to a plain `INSERT INTO events (rowid, ...) VALUES
    (-7, ...)`, no trigger dropped and nothing replaced, sorting below the boundary with no alert at
    all (round 3 of this review; this paragraph used to claim the closed version of this without it).
    `events_no_low_rowid` closes that: an insert may only ever become this table's new highest
    rowid, so no insert, forged or not, now can land below one already held. `events` has no
    INTEGER PRIMARY KEY, so it is a plain rowid table SQLite's own docs allow `VACUUM` to renumber;
    today's SQLite keeps that renumbering in RELATIVE order, which is what the boundary and this
    guard both rest on, and neither this file nor the code that reads it can make a future SQLite
    promise that. What no guard closes: an attacker who also drops and restores `events_no_delete`
    and `events_no_low_rowid` between two reads (the same gap `sqlite_guard_missing` already admits
    for every other one: the server on its next boot, and the CLI's `--db` reader on every read,
    name a guard still dropped, and neither names one put back) can delete every hashed row and
    start the boundary over, or delete an event and its texts row together and leave nothing to
    compare against at all — an erasure, not a mismatch, and the panel already cannot tell an
    erased event from one that was never made. One more limit worth naming plainly: `hashText`
    (`engine/api/texts.ts`) is an UNKEYED hash — plain sha256 of the salt, a NUL byte and the value,
    with no secret the write access lacks — so that same write access can just as easily compute
    a correct hash as strip one, and append a forged row at `MAX(rowid) + 1` with a matching
    `texts` row and a `text_hash` that checks out. Nothing here catches that: the
    rowid boundary only names a forgery that skips computing the hash and lands BELOW it instead.
  - **Firestore.** No equivalent boundary exists, and none is cheap to build: a direct writer sets
    `when` as a plain field, not a value Firestore itself enforces came from `FieldValue.serverTimestamp()`
    — there are no Firestore Security Rules in this project restricting it (identity is IAM, not
    per-field rules) — so a forged document can claim any `when`, including one that predates the
    real migration. The downgrade this closes for SQLite is therefore open for Firestore: a forged
    event with a stripped hash and an inline value, backdated, reads as a genuine pre-extraction row.
    Closing it needs the events themselves signed, the same "not built yet" this file already says of
    every other forgery a direct writer can date and order correctly (see the bullet above).
  - **The in-process, in-memory store** (`run-local.sh`'s default, and every unit test's) holds
    nothing an outside attacker could write to at all — there is no file, no project, no second
    process — so this class of attack does not apply to it.
- **It serves your documentation over HTTP.** With password identity there is no edge protecting
  it: the guard is in the application. Without a session, every static page redirects to the login
  screen. That guard has a test in the HTTP contract suite, because its absence would be silent:
  every page would simply be served to anyone.
- **It stores passwords** with scrypt, per-user salt, and constant-time comparison. A test asserts
  the password does not appear in the raw database file.
- **The first-access password is random**, printed once, and must be changed at first login. There
  is no default account.
- **Exactly one owner**, and it comes from `HOLDRIM_OWNER`, never from a database column. Zero or
  two and the service refuses to start. Nobody but the owner resets or creates the owner's account.
- **Authority comes from the deployment only.** The owner and the admins are read from
  `HOLDRIM_OWNER` and `HOLDRIM_ADMINS` and from nowhere else; a `holdrim.json` that names `owner`,
  `admins` or `locks` refuses to start the service and to run the CLI. Otherwise anyone who can
  commit to the repository — or an agent applying an approved request — could name a new owner.
- **The theme is untrusted input.** It lands inside CSS and HTML, so the brand colour is accepted
  only as hex and anything else is refused and logged.
- **The sign-in screen runs only what the server wrote into it.** Its Content-Security-Policy
  allows no script and no style without that response's nonce, new on every response, and no
  `unsafe-inline` anywhere. API answers carry a policy that runs nothing.
- **A documentation page runs the panel and nothing else.** The pages are served from the same
  origin as the API, so a script in one would run with the reader's session — for the owner, an
  approval in their name, and a lock after `holdrim sync`. Content is written by people and by
  agents, and an agent can be steered by text hidden in the documents it edits. So every page gets a
  nonce, new on every response, written into the panel's own tag and no other: an inline script, an
  `onerror=`, a script file added to the site, a `<base>` pointing elsewhere are all refused by the
  browser, and every other file of the site runs no script at all. The price: a page cannot bring
  scripts of its own.
- **The build is guarded against its own supply chain.** CI actions are pinned to commits, not
  tags; every checkout drops its token; no workflow can write to the repository or run on
  `pull_request_target`; `npm audit` blocks a known high-severity advisory in what ships; CodeQL
  reads the code weekly once the repository is public (GitHub offers it free only there);
  Dependabot proposes every update as a pull request that goes through the same proofs. `engine/tests/workflows.test.js` fails when a workflow loosens any of these.

## Running it safely

- **Put it behind TLS.** The session cookie is `Secure` outside development, which means it will not
  travel over plain HTTP anywhere but localhost.
- **Use a named volume for `/data`**, not a host folder. A host folder arrives with the host's
  ownership, and the process runs as an unprivileged user.
- **Never put a key in `holdrim.json`.** That file is versioned. Secrets go in the environment or
  in `.env`, which is git-ignored. The engine itself needs no model key: it calls no model.
- **Upgrading to a version that writes the lock baseline (CHANGELOG.md), move ALL traffic to the new
  revision before anyone uses it, and boot it once under the `HOLDRIM_OWNER` who gave the existing
  ✓s.** The first server of that version to read a store writes one `lock_baseline` event, freezing
  who `HOLDRIM_OWNER` was at that exact instant — **permanently**: a later handover does not move it,
  and there is no second chance to set it once a store already holds one. An old revision left
  serving in parallel can still record events during the switch; see "Known limits" below for what
  that costs if it does.

## Known limits

- The agent's CLI can read the event store directly, bypassing the API — and therefore the cycle,
  the roles and the limits. It only reads, and it is marked in the code. The right fix is the agent
  having an identity of its own.
- **An old revision still taking traffic after the new one has written its lock baseline can record
  events the new version will trust as if it had written them itself.** `locks` and
  `authorCouldTriage` are trusted on any event dated after the baseline, whichever revision recorded
  it — there is no signature tying the field to the process that wrote it, only the timestamp. A
  multi-instance rollout (Cloud Run gradually shifting traffic, a rolling Kubernetes deploy) can leave
  an old-revision replica answering requests for a window after the new revision's first boot; if it
  does, it still writes whatever `data` a client's own POST sends, unguarded by this version's checks,
  and dated after the baseline that same window created. This is not closed in code: closing it needs
  every writer to agree, cross-process, on when the baseline exists, which no store here can promise
  without a lock this method does not have. It is closed by deployment discipline instead — move all
  traffic to the new revision first, the same step named above — not by a check this file's tests run.
- Identity is password or an identity proxy. OIDC, Google and LDAP are not implemented.
- **Wrong passwords are counted per process, in memory.** Five free attempts per e-mail, then a
  wait that doubles up to fifteen minutes. With several instances each counts on its own, and a
  restart forgets the count, so the real ceiling is the one per instance times the instances. It is
  not in the user store on purpose: a write on every wrong password is a load anyone could cause
  without an account. If the service is reachable from the internet, rate-limit
  `POST /api/sign-in` at your edge as well.
