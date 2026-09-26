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
  A row edited in place, a hash with no row and no valid removal, two removals of the same field,
  or (SQLite only — see below) a hash stripped off a row that postdates when extraction began
  ([holdrim#91](https://github.com/Holdrim/holdrim-core/issues/91)) each log a CRITICAL
  `text_tampered` line (`reportTampered`, `engine/api/texts.ts`) the moment the server, or the CLI
  reading the file or the cloud directly, resolves that field — every time, not once, acknowledged
  or not — and `holdrim list`/`sync` warn and exit non-zero on the same finding. Nor does it watch
  on a schedule: it fires when a page, the panel or the CLI actually reads the record, so one
  nobody ever re-reads raises nothing until somebody does. Every page the panel runs on shows a
  banner, with no control that closes it, while any finding is open
  ([holdrim#107](https://github.com/Holdrim/holdrim-core/issues/107)); the owner alone can
  acknowledge one finding, which records a `tamper_acknowledged` event and takes that one line of
  the banner down — never the log line, never the CLI's exit code, and never the text's own
  tampered reading, which nothing repairs. A finding is its event, field and case plus three
  things found there (`observedOf`, `engine/api/texts.ts`): the hash the event itself carries, the
  row's own hash under the row's own salt, and the ids of every valid removal of the field (placed
  after its target and not dated before it). Changing any of the three, or the case, is a new
  finding, and shows again while the field still reads as tampered. Two re-tamperings of the field
  stay the same finding, because none of the three sees them: a `downgraded` field's inline value
  edited again (it has no salt of its own, and an unsalted hash of it is what docs/PRIVACY.md
  section 4 forbids), and a field put right and then tampered back into exactly the state that was
  acknowledged. Nor is anything the three do not hash a new finding: a removal event rewritten in
  place — its author, say — keeps its id, and so the finding, which is the limit the first item
  above already names for every event rewritten in place, closed only by signed events. Only a
  `tamper_acknowledged` event counts, and only one marked `asAgent: "false"`, the one form the
  route writes: the same id in any other event's `data`, which a client writes, quiets nothing.
  The banner has a weaker footing than the log line, said plainly: the log line comes from code a
  direct writer to the store does not reach, while an acknowledgement is an event, and that same
  direct writer can insert one naming the finding — the banner then goes quiet while the CRITICAL
  line keeps firing. Closing that needs the events signed, like every other forgery this file
  names.

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
    promise that. Its counterpart, `events_no_high_rowid`
    ([holdrim#109](https://github.com/Holdrim/holdrim-core/issues/109)), refuses an insert naming a
    rowid above `MAX(rowid) + 1`, or above 1 on an empty table: without it, one event parked at the
    largest rowid SQLite has sends every later append to a random rowid below it, where
    `events_no_low_rowid` refuses each one — the owner's ✓ included — calling a genuine write a
    forgery, and the parked row cannot be deleted. Between the two, an insert into a table that
    holds a row takes exactly the next rowid. The other end is a trap as well: in a `BEFORE INSERT`
    trigger SQLite gives an insert that names no rowid the placeholder -1, so one row held at rowid
    -1 makes `events_no_replace`, `people_no_replace` or `texts_no_replace` read every genuine
    insert into its table as a replace — no first event on an empty `events`, no new person (a new
    reviewer, or the owner after a handover), no ✓ and no comment, since each carries a text — and
    on `events` and `people` that row cannot be deleted either. A genuine insert takes a rowid
    below 1 only when a row below 1 is already there (SQLite gives it `MAX(rowid) + 1`), so
    `events_no_first_rowid_below_one` (an empty `events`, where `events_no_low_rowid` has nothing to
    compare with), `people_no_rowid_below_one` and `texts_no_rowid_below_one` refuse one.
    What no trigger can close from inside the file: a connection that turns triggers off for
    itself (`SQLITE_DBCONFIG_ENABLE_TRIGGER`, `.dbconfig enable_trigger off` in the `sqlite3`
    shell) runs no guard at all, and any of these guards dropped, a row written and the guard
    recreated by its exact text leaves every guard as it was. For those, the rows are only
    detected afterwards, and only the rows that still show it: an `events` table whose highest
    rowid is the ceiling (`kind: "parked"`), and a row below rowid 1 in `events`, `people` or
    `texts` (`kind: "sunk"`), however either got there, are named by the server on every boot and
    by the CLI's `--db` reader on every read (a `sqlite_guard_missing` WARNING; `guardsTampered`,
    so `sync`, `apply` and `state` refuse), and a write refused because of one says that is the
    cause instead of calling the write a forgery. No boot repairs either. A parked row, and a row
    below 1 on `events` or `people`, cannot be deleted, so a person recovers such a file by hand;
    a row below 1 on `texts` that names an existing event can be removed with `removeText`
    (docs/PRIVACY.md, section 5), which records a `text_removed` event for it. A row one short of
    the ceiling traps nothing until a genuine append takes the ceiling, and is named from then on.
    A column named `rowid`, `oid` or `_rowid_`, in any case and generated ones included, on
    `events`, `people` or `texts`, takes that name from the real rowid for every guard that says it,
    and `ALTER TABLE ... ADD COLUMN` makes one with every trigger's text unchanged. While it is
    there, a row can go in at any rowid through `_rowid_` — below the boundary, or at the ceiling —
    a DEFAULT on it makes every append collide, and an `UPDATE OR REPLACE` onto another person's
    rowid erases that person's row. The server on every boot and the CLI's `--db` reader on every
    read name such a column (`kind: "shadowed"`), the CLI refuses to act, and nothing repairs it.
    Once the column is dropped again, only a row it left at the ceiling or below rowid 1 is still
    named (above); a row it let in between 1 and the boundary, or a person's row it erased, leaves
    nothing any check here can find — the same gap as a guard dropped and put back. What no guard closes: an attacker who
    also drops and restores `events_no_delete` and `events_no_low_rowid` between two reads (the
    same gap `sqlite_guard_missing` already admits for every other one: the server on its next
    boot, and the CLI's `--db` reader on every read, name a guard still dropped, and neither names
    one put back) can delete every hashed row and start the boundary over, or delete an event and
    its texts row together and leave nothing to compare against at all — an erasure, not a
    mismatch, and the panel already cannot tell an erased event from one that was never made.
    Dropping and restoring `events_no_high_rowid` the same way parks a row at the ceiling; that
    one is still named afterwards, by the row it leaves (above), and a row parked short of the
    ceiling is not. One more limit worth naming plainly: `hashText`
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
- **It stores agent tokens** (`docs/ROLES.md`, section 4) as SHA-256 of a 256-bit random secret,
  compared in constant time. A token is shown once, to the owner who issued it, and never again: not
  in a list, an event or a log line. It opens the API's event routes and nothing else, never gives a
  ✓, and is refused when the same request also carries a session. A copy of the user store hands
  over no token anyone can present.
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

- The agent's CLI can read the event store directly, bypassing the API. It only reads, and it is
  marked in the code: every write it makes goes through the API with the agent's own token, and the
  code that wrote to the cloud directly is gone (#122).
- **An agent token does not expire.** It lasts until the owner revokes it or issues the address a
  new one, so a token that leaks is good until someone notices. Revoke it on the people screen the
  moment it may have been seen. The CLI sends it over https only, or over http to this machine, and
  never to the local runner `--local` names.
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
