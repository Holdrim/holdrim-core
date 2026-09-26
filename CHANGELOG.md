# Changelog

What changes for a project that moves its pin. One section per version, newest first. A release
tag is refused until its section exists (`scripts/check-release-tag.sh`), so this file cannot
fall behind the images.

Each entry says what an adopter will notice, not which files moved: the commits already say that.
When something breaks a pin — a renamed variable, a changed route, a stricter check — it goes
first, under **Breaking**, with what to change.

## [0.1.0] — unreleased

The first version. Nothing released comes before it; what follows under **Breaking** is for anyone
who ran the engine from `main` before it.

### Breaking

- **The CLI no longer writes to the cloud store directly: every write goes through the server's
  `POST /api/events`, with an agent token the owner issues (#122).** Before this, `holdrim state` in
  cloud mode wrote its event straight into Firestore as `agent via <gcloud account>`, skipping the
  cycle, the roles, the limits and `data.asAgent`; that path, and the name, are gone. **What an
  adopter in cloud mode changes:** (1) the server has to run with password sign-in
  (`HOLDRIM_IDENTITY=password`, the default outside Development when `HOLDRIM_AUDIENCE` is unset),
  since tokens live in its user store. **Behind an identity proxy there is no user store, so no
  token, and `holdrim state` there cannot record a state at all** — a token for that mode is not
  built yet; (2) the owner signs in, opens the people screen, and issues a token for the
  agent's own address — never the owner's, an admin's or a lock-holder's, and never an address that
  has an account here, disabled or not: an address is a person's or an agent's, and creating an
  account for an address holding a token is refused too; (3) wherever `holdrim` runs, export
  `HOLDRIM_AGENT_TOKEN` with that token and `HOLDRIM_URL` with the server's address (`https://…`;
  the CLI refuses plain `http://` to any host but this machine, and sends no token with `--local`). Reading is unchanged:
  `cloud.project`/`HOLDRIM_PROJECT` and gcloud are still what the CLI reads the cloud with, and
  `--local` against `bash engine/run-local.sh` needs neither variable, writing as the runner's
  development identity `agent@local`. Only the owner issues and revokes a token, one per address
  (issuing again revokes the last), and it never expires until revoked; the people screen shows when
  each was issued. A token reaches only the event routes, and a ✓ sent with one is refused whatever
  its address. New on the surface: `GET /api/agent-tokens`, `POST /api/agent-tokens`, `POST
  /api/agent-tokens/:email/revoke`; the event types `agent_token_issued` and `agent_token_revoked`
  (page `_agent_tokens`, data `agent`, `tokenId`, `replacedTokenId`), which only those routes write;
  and an `agent_tokens` table (SQLite, Postgres) or collection (Firestore) in the user store, created
  on start. Two answers change: a request carrying both a session cookie and an `Authorization`
  header is refused (401), and under password sign-in an `Authorization` that is not a live agent
  token is refused (401) instead of ignored. **A password deployment behind an HTTP basic-auth
  gateway stops working**: the browser attaches `Authorization: Basic …` to every request, and
  every API call then answers 401 — the whole panel with it. Remove the gateway's basic auth (the
  sign-in screen is the gate), or have the gateway strip `Authorization` before it forwards. And an agent — named in `HOLDRIM_AGENTS` or come in with
  a token — may now move an approved request through `applying`, `waiting` and `applied` through the
  API, as `docs/ROLES.md` section 4 already said it keeps; before, only the local runner let it.
- **`/api/me`'s `role` answers `member` where it used to answer `other`.** The engine now speaks of
  three shipped roles — `owner`, `admin`, `member` — as sets of a closed capability list
  (`engine/core/roles.js`: `read`, `comment`, `request`, `triage`, `approve`, `lock`, `people`), and
  a role display name that only ever meant "one of the two above" now says so. What to change:
  anything matching `/api/me`'s `role` against `'other'`, and the people screen's `people.role.other`
  translation key, now `people.role.member`. `canApprove`, `canTriage` and every other field of
  `/api/me` are unchanged.
- **`owner` and `admins` are no longer read from `holdrim.json`, and a `holdrim.json` that names
  `owner`, `admins` or `locks` now refuses to start the service and to run the CLI.** Authority is
  set by the deployment: whoever can commit to the file — or the agent applying an approved
  request — is not whoever deploys it. What to change: delete those keys from `holdrim.json`, set
  `HOLDRIM_OWNER` (one e-mail) and `HOLDRIM_ADMINS` (comma separated) where the service runs, and
  export the same two wherever `holdrim` runs (`sync`, `list`, `state` refuse without the owner).
  `holdrim sync` now prints the owner it used and that it came from `HOLDRIM_OWNER`.
  `bash engine/run-local.sh` names `you@example.org` as the owner when the variable is unset.
  `owner` and `admins` leave the `config-keys` of `engine/surface.json`.
- **An event's `author` is stored as the person's id, never as an e-mail.** Every store keeps a
  people table beside its events (an id, `p_` and 24 hex characters, and an address), and every
  reader — the API, the panel, the home, and the CLI reading the events file or the cloud — gets the
  e-mail back, so nothing Holdrim shows changes. What reads the database directly, around Holdrim,
  now sees ids in `events.author`: join them to `people`. Events recorded before keep the e-mail they
  hold and read as it. The CLI's reader of the cloud, like the server, talks to the Firestore
  emulator when `FIRESTORE_EMULATOR_HOST` is set; the CLI no longer writes there at all (the first
  entry above). The development identity (`X-Dev-Email`, `HOLDRIM_DEV_EMAIL`) is lowercased and trimmed, as
  sign-in and the identity proxy already were.
- **An event's `text` and `snapshot` move to a table of their own, one row per event and field; the
  event keeps only a salted hash of each.** Reading an event is unchanged — the API, the panel, the
  CLI reading the events file or the cloud, all still get the plain value back — but four fields are
  new on every event: `textRemoved`/`snapshotRemoved` (`{by, when}` once a field is let go on
  purpose) and `textTampered`/`snapshotTampered` (`true` when a field's hash no longer matches
  anything at hand and no removal accounts for it — missing with nothing to say why, read as
  tampering, never as absence). What reads the database directly now finds `text`/`snapshot` empty
  on a fresh row and the value in the new `texts` table (SQLite) or collection (Firestore), joined
  by event id and field; a row from before this change keeps its own plain value and reads as it. A
  text is removed with `EventStore.removeText(event, field, by)`, which also records a `text_removed`
  event — not reachable through `POST /events` yet, since the door for a person to ask for one, with
  its own permission, is a later issue. A removal is only credited if it is later, in time and in
  the list, than the event it names, so one dated ahead of a real text does not read as though that
  text never existed. `FirestoreEventStore.list` and the CLI's cloud reader read events, people and
  texts as ordinary, unbounded reads, not inside one Firestore transaction — a read-only transaction
  aborts after 270 seconds, and both collections only grow — and correct a field that looks tampered
  by asking once more, later, for the removal it could not have seen yet.
- **Whether a ✓ is a lock, and whether a request's author could already triage it, are now written
  onto the event when it is given or filed, and read from what was written forever after — never
  recomputed from who holds `lock`/`triage` today.** Before this, an owner who handed over silently
  un-locked every ✓ they had given, and revoking `triage` from an admin silently sent their past
  requests back to triage with no event recording either change. The server writes `locks` (an
  approval) and `authorCouldTriage` (a request) at the moment it records the event; every reader —
  the panel, the home, `holdrim sync` and `holdrim list`/`show`/`summary`/`state` — reads what was
  written. A request with nothing written reads as "at triage" (the safe direction: the owner
  triages it again, once). A ✓ with nothing written needs a **baseline**: on its first boot against a
  store, a server of this version writes one `lock_baseline` event, recording who `HOLDRIM_OWNER` was
  at that exact moment; an unwritten ✓ then locks only if its author matches the baseline's and it
  predates the baseline, and a store with no baseline at all trusts no unwritten ✓ from anyone. A
  field written before this version existed is trusted the same way — only when it is dated after
  the store's own baseline — since a client's own POST body could shape `data` freely before this
  change; one that predates the baseline is decided by the baseline rule instead, whatever it claims.
  One exception: a ✓ written `locks:"false"` is trusted even before the baseline, since a forged field
  can only ever help an attacker by claiming `"true"`, never `"false"` — guarding a former owner's own
  ✓ from misreading as a lock should this server's clock ever run behind the baseline's.
  **What to change, before anyone uses this version against a real store:** move ALL traffic to the
  new revision first — an old revision left serving alongside it can still record events with
  client-forged `locks`/`authorCouldTriage`, dated after the new baseline, which the new version would
  then trust as if it had written them itself. **And boot this version once under the `HOLDRIM_OWNER`
  who gave the existing ✓s** (Cloud Run: a revision serving 100% of traffic; anywhere else, once at
  startup): the baseline freezes whoever `HOLDRIM_OWNER` is at that first boot, **permanently** — a
  later handover does not move it, and there is no second chance to set it once a store already holds
  one. `SECURITY.md` has the same two steps, in the place an operator reads before upgrading.
- **`holdrim apply`'s commit no longer carries `Requested-by:`.** Only `Request: <full id>` is
  written; who asked is found from the request, through the people table, the one place it can be
  removed. What to change: anything reading a commit for who asked now reads the request instead.
  Log lines that used to carry an e-mail now carry the person's id — `event_recorded`, `signed_in`,
  `password_changed`, `user_created`, `user_renamed`, `user_password_reset` and
  `user_enabled_changed` name a `person` (and a `by`, where the line also says who acted). A refused
  sign-in (`sign_in_refused`) still logs the address exactly as typed: it never became a person.
  `docs/PRIVACY.md`, section 5, documents the manual procedure for removing a person, until there is
  a screen for it.
- **A SQLite events file refuses a row whose rowid skips past the next one or falls below 1,
  names a file whose rowid its guards cannot see, and a file made before this reads, once, as
  missing those guards.** Four new guards
  ([holdrim#109](https://github.com/Holdrim/holdrim-core/issues/109)): `events_no_high_rowid`
  refuses an insert naming a rowid above `MAX(rowid) + 1`, or above 1 on an empty table, and
  `events_no_first_rowid_below_one` (on an empty `events`), `people_no_rowid_below_one` and
  `texts_no_rowid_below_one` refuse one below 1. Without them, one row written straight into the
  file at the largest rowid SQLite has sent every later append to a rowid below it, where
  `events_no_low_rowid` refused each one — the owner's ✓ included — as a forgery; and one row at
  rowid -1 made every later insert into its table read as a replace: no new person, and no ✓ or
  comment, each of which carries a text. They make that harder, not impossible: a connection with
  triggers turned off, or a guard dropped, a row written and the guard recreated by its exact text,
  still leaves one. So the server on every boot, and the CLI's `--db` reader on every read, now
  also name an `events` table whose highest rowid is the ceiling (`sqlite_guard_missing`,
  `kind: "parked"`), a row below rowid 1 in `events`, `people` or `texts` (`kind: "sunk"`), and a
  column named `rowid`, `oid` or `_rowid_` on any of the three, which hides the real rowid from
  every guard (`kind: "shadowed"`); a write refused on such a file says that is why. None is
  repaired by a boot: it is said on every one, and a person recovers the file by hand
  (SECURITY.md). Holdrim's own writes never name a rowid, so nothing they write changes. What to
  change, for a file an earlier build made: start the server of this version against it before
  anything else. Its first boot says `the database's guard "…" is missing; installing it` for each
  of the four and logs one `sqlite_guard_missing` WARNING for each. That is expected, once, on that
  boot: the file cannot tell a guard never installed from one dropped, so it says both the same
  way, and the same line on any later boot is not the upgrade. Until that boot, `holdrim … --db` of
  this version names them missing on the same file: `list` exits non-zero, `list --json` carries
  `guardsTampered: true` and an empty `requests` — an agent reading it sees an empty queue — and
  `sync`, `apply` and `state` refuse. Moving a pin back below this version drops the four on the
  next boot, each named as a trigger that version does not install.
- **`holdrim sync` and `holdrim restamp` exit non-zero when a ✓ could not be stamped safely.** A ✓
  whose block cannot be written without risking another one (see the entry under **Fixed** about
  stamping only the block a ✓ was given to) is refused, and it used to be refused with exit 0 — the
  registry never got the entry, so a later rewrite of that text passed `holdrim check` in silence.
  What an adopter's CI sees now: a `✗ <id>: <reason>; nothing written` line per refused block, `sync`'s
  summary line counting them (`… · 1 refused · …`), a `⚠ … could not be stamped safely` line, and exit
  code 1. What to change: fix what the reason names on the page — most often two blocks sharing one
  id — and run the command again; nothing to change in the pipeline itself.
- **`holdrim check` now holds each block's seal to the registry, not only its date, and counts a seal
  attribute whose name is not lower case as a problem.** For every registry entry whose block exists,
  `data-validated-fingerprint` has to equal the entry's `fingerprint` (a missing one is a problem too),
  and `data-depended-on` its `dependsOn` (absent and `{}` alike). And a `data-validated`,
  `data-validated-fingerprint` or `data-depended-on` written in any other case, on any block, recorded
  or not, is a problem: a browser reads it under the lower-case name and keeps the first copy, so it
  is the value the panel shows. What an adopter's CI sees: a `✗ <id>: …` line for each, counted in
  `check`'s total, and a non-zero exit where it used to pass. The likeliest source is the re-approval
  bug under **Fixed**: a page synced before this version keeps the earlier ✓'s seal. What repairs it:
  no command overwrites a seal already on a page — `holdrim restamp` writes only what is missing, and
  `holdrim sync` skips a ✓ the registry already holds. `restamp` writes a missing
  `data-validated-fingerprint` or `data-depended-on` from the registry; an attribute that disagrees
  with the registry, or is not in lower case, has to be taken off the block by hand first, and
  `restamp` then writes the registry's value (it refuses a block that still carries a name not in
  lower case). `data-validated`, which `restamp` never writes, still has to carry the registry's
  `date`, as `check` already required.
- **`holdrim check` now reads every block a browser reads.** A `data-id`, `data-code`,
  `data-depends` or seal attribute written in any case other than lower case, on any element of any
  page, is a problem: a browser reads it, and the engine, which reads the lower-case name only, did
  not — a block named that way was on no list `check` printed. And an id carried by more than one
  block, across all pages and read as a browser reads it, is a problem: the registry and every sweep
  judged one of them, while the browser painted a seal on each. What an adopter's CI sees: a
  `✗ <id or page>: carries …` or `✗ <id>: carried by N blocks (…)` line for each, counted in `check`'s
  total, and a non-zero exit. What to change: write the name in lower case, or give each block its own
  id. `holdrim sync` and `holdrim restamp` also refuse, with that reason, to write a seal on a page
  where a block reads differently to a browser — a `data-id`, `data-code` or `data-depends` not in
  lower case, on the page of the block or on any page where a browser finds a block by that id.

### Added

- **Approvals that stop holding.** Every block of a page is approved against its exact text. A
  block whose text changed turns 🟡, and one whose text is intact but whose dependency moved
  turns 🔴.
- **The project home**, `/engine/home`, where `/` leads unless the project names another page:
  every page with its traffic light, and every request still in progress, oldest first — decided
  right there by whoever may decide, with the same checks as the panel.
- **People, from the browser**, `/engine/people`, for the owner and admins with password sign-in:
  create an access, hand out a new password (shown once), take an access away and give it back.
  Nobody is ever deleted.
- **Ask for a new page, in plain words**, from the home (a form that needs no script) or from any
  block (the new `page` category). `holdrim apply` tells the agent to write one new page shaped like
  the one it was asked near, and to mark nothing as validated.
- **Publishing, `holdrim export <folder>`**: the documentation as plain static pages, without the
  panel, for anyone to read. Only what a browser renders goes out; the config, the registry and
  anything unexpected stay home.
- **`site/`**, Holdrim's own site, written and reviewed as a Holdrim project.
- **`examples/cash-register`**, the example to show first: approved rules, one changed and
  re-approved, and the two rules built on it red — one of them on another page. No Docker needed:
  `bash engine/run-local.sh examples/cash-register` serves any project folder, as its owner.
- **The review panel**, in the documentation's own pages: one module, `panel-react.js`, to approve,
  request a change, comment, add details to a request and triage. It paints all four lights,
  including a 🔴 whose cause is on another page — it asks the server for fingerprints it cannot
  see — says so when the review state cannot be loaded, opens the block a link names
  (`#A01.1.3`), which is how the home links a request, and leads back to the project's home from
  every page, so a page needs no link of its own that an exported copy would leave dead.
  Only the owner's ✓ turns a block green, as only theirs becomes a lock: an admin's is recorded,
  and the panel shows it as an admin's.
- **The impact radius.** Selecting a block lights every block that depends on it, directly or
  through another — asked of the server (`GET /api/impact-radius`) and drawn on the page, since a
  dependent three pages away has no element the panel can find on its own. `holdrim if-i-touch`
  still names the ONE hop that would turn 🔴, as the traffic light itself does, and now also lists
  the rest of the radius as worth checking too — the CLI and the panel share the one walk
  (`radiusOf`, `engine/core/validity.js`) rather than each answering "what could this touch" its
  own way.
- **A page runs the panel and nothing else.** Every documentation page is served with a
  Content-Security-Policy whose nonce only the panel's tag carries, so a script written into the
  content — by a person, or by an agent following an instruction hidden in a document — cannot act
  with the reader's session. A page cannot bring scripts of its own.
- **The CLI, `holdrim`**: `lights`, `if-i-touch`, `graph`, `index`, `check`, `kinds`, `export`, and
  the request cycle, `list`, `show`, `impact`, `apply` and `state`. `apply` hands a request to the
  agent CLI the person already has. The engine calls no model and holds no key.
- **`holdrim graph`**: the dependency graph the traffic light already reads, as JSON, Mermaid or
  DOT — for a script, another tool, or a diagram to look at outside the browser. It reads the same
  blocks and the same traffic light every other command does, never a second copy of either.
- **Sign-in** with passwords, or behind an identity proxy. There is exactly one owner, named by
  `HOLDRIM_OWNER`, and the first-access password is printed once.
- **Storage.** Events go to SQLite or Firestore and are only ever appended; SQLite refuses
  `UPDATE` and `DELETE` by trigger. People go to SQLite, Postgres or Firestore. Every event store
  and every user store passes its own conformance suite in CI, against real databases. Reopening a
  SQLite file whose guard was dropped from outside the store now warns, naming it, instead of
  putting it back without a word. The CLI reading that file with `--db` compares the guards too, on
  every read, and repairs nothing: it names each one missing or changed, and each trigger that is
  not a guard, on stderr; `holdrim list --json` carries a `guardsTampered` key; `list` exits
  non-zero when it is set, and its `--json` output carries no `requests` at all while it is —
  `toTriage` and both flags still say what happened, but an agent acting on the JSON gets nothing
  to act on. (The table, with no `--json`, still shows them: the owner judging the file has to be
  able to look at it.) `examples/hello-world/AGENTS.md` and the Claude Code skill now tell the
  agent to stop — apply nothing, change no state — on either flag or a non-zero exit; and `sync`,
  `apply` (`--dry-run` included) and `state` refuse to act on such a file at all, before any lock,
  brief, agent or event. Every guard warning, the server's included, now quotes the trigger's name
  as JSON, with control, C1 and bidirectional characters escaped, and so does every structured log
  line.
- **A text that fails its own hash raises a CRITICAL alert.** Every read that resolves a field to
  tampered — a row edited in place, a hash with no accounting removal, or two removals of the same
  field, or a value with a stripped hash on a row that postdates when text extraction began (SQLite
  only) — logs a CRITICAL `text_tampered` line from the one place every reader shares (`reportTampered`,
  `engine/api/texts.ts`), EVERY time a read resolves it — the owner's acknowledgement, below, quiets
  the panel's banner and never this line, so it repeats rather than go silent after its first
  sighting. The line now carries the `finding` the acknowledgement names. `holdrim list
  --json` now carries a `tampered` key, and `holdrim list`/`sync` warn and exit non-zero when it is
  set. See SECURITY.md for what this can and cannot catch, store by store. No released version
  predates text extraction, so there is nothing to roll a pin back to yet — but once a later version
  exists, moving the pin back to one from before this alert would write fresh events with their text
  stored inline again, above where this version's own hashed rows begin, and every one of those reads
  as `downgraded` tampering the next time any version opens the same file.
- **A banner on every page the panel runs on while a text reads as tampered, and an acknowledgement
  for the owner.** `GET /api/tampered` answers every signed-in reader with the findings still open, as
  ids and locale keys (`panel.tamper.<case>`), and the panel draws one line each, with no control that
  closes it. The owner — only the owner: `admin` does not grant it, and an agent never can — sends
  `POST /api/tampered/acknowledge` with one `finding`, and the server records a `tamper_acknowledged`
  event on the tampered event's own page and block, built from its own read, never from the client's
  body (`POST /events` refuses the type). A finding is the event, the field, the case and what was
  found there, so a NEW tampering of an acknowledged field shows again. Acknowledging repairs nothing:
  the text goes on reading as tampered, and its CRITICAL line on every read. There is no
  `holdrim.json` toggle for the banner, on purpose: an alert the repository can switch off is one a
  committer can hide. `EventStore.list` takes an optional second argument that collects the tampered
  fields a read found; a store written against the interface keeps working without it.
- **English, Portuguese and Spanish**, including the sign-in screen, which the server renders
  already translated, and the review panel, which asks the server which language the person reads.
- **A theme** from `holdrim.json`: a brand colour (hex only), a logo inlined by the server, and a
  name.
- **The image** is published to `ghcr.io/holdrim/holdrim-core` on a version tag, with provenance
  and an SBOM. Pin the version: there is no `latest`.
- **Node 22.18 or newer** to run from a clone. The image carries its own Node.
- **The names you build on, written down.** `engine/surface.json` lists every one of them — the
  `HOLDRIM_*` variables, the keys of `holdrim.json`, the `data-*` attributes, the event types and
  their fields, the request states and categories, the CLI's commands and flags, what
  `holdrim list --json` prints, and the HTTP routes. CI derives each list from the code and fails
  when one moves, naming it, and the failure asks for the change to be recorded here.
- **Feature toggles**, `holdrim.json`'s new `features` block: a closed list — `comments`,
  `pageRequests`, `bugCategory`, `peopleScreen`, `graph`, `voice`, `sketch` — each with a default
  equal to today's behaviour, so a project that sets none sees no change. An unknown key, or a
  value that is not `true`/`false`, refuses to start the service. A toggle never reaches a guard:
  `peopleScreen` off hides the people screen and its nav link, never the `/api/users*` routes' own
  rules. `/api/me` sends the panel the three it needs, and it draws no control a project has turned
  off. A request's category is now checked against `cycle.json`'s own list before anything else, so
  a category the toggles do not recognise (a typo, a different case) is refused with 400 rather than
  quietly bypassing `bugCategory`/`pageRequests`. `bash engine/test-contract.sh` runs every
  server-gated toggle on and off against a real server.
- **`HOLDRIM_LOCKS` names who else holds `lock`** (`docs/ROLES.md`, section 3), next to
  `HOLDRIM_OWNER`: `"ana@example.org:P0*; bea@example.org:F12"`, an e-mail, a colon and a scope per
  entry — a page, a page family (`"P0*"`) or a block id, validated the same way an event's own `page`
  and `block` are. A malformed entry refuses to start, exactly like a malformed `HOLDRIM_OWNER`. Their
  accounts are guarded like the owner's: creating, resetting, disabling and re-enabling one — all four
  routes — is the owner's alone, and none of the four refusals names `HOLDRIM_LOCKS`, so an admin who
  may not act on the address is not told the mechanism that reserved it. `can('lock', …)` does not
  trust one yet — it still asks only whether the caller is the owner — because doing so safely needs
  the session-and-credential-history rule `docs/ROLES.md` section 3 describes, which is not built.
- **`HOLDRIM_AGENTS` marks who is an agent** (`docs/ROLES.md`, section 4), next to `HOLDRIM_LOCKS`:
  `"agent@example.org; ci@example.org"`, `;` separated, each address checked the same strict way. An
  address listed there is refused triage, a ✓, a lock and `people` whatever else it is granted —
  asked before `HOLDRIM_OWNER`, `HOLDRIM_ADMINS` or any role is even read — and it can still comment,
  request, and move a request through the agent's own states. The service refuses to start, and every
  `holdrim` command refuses to run, when `HOLDRIM_OWNER`, `HOLDRIM_ADMINS` or `HOLDRIM_LOCKS` names an
  address `HOLDRIM_AGENTS` also names, and `holdrim.json` refuses an `agents` key like the other
  authority keys. Every event the server records now carries `data.asAgent` (`"true"` or `"false"`),
  written from who the server saw, never from the request body: what reads the database directly
  finds the new key on every event from this version on. What it does not cover yet: the CLI's direct
  write to the cloud still bypasses the server and writes no `asAgent`, and an agent that signs in
  as a person, or with an address not listed, is that person to the server — the agent's own
  credential is a later change.
- **`holdrim.json` refuses `roles` and `grants` too**, alongside `owner`, `admins` and `locks`
  (`docs/ROLES.md`, "Authority comes from the deployment only"): a project's own roles, and who holds
  them, are the owner's to define and grant from a settings screen — a later piece — never a file a
  committer, or the agent applying an approved request, can edit.
- **`people.show`**, `holdrim.json`'s new setting for how a person appears next to a comment, a
  request or a ✓ (`docs/ROLES.md`, "How a person appears"): `name`, `email` (the default, today's
  behaviour), `role` or `id`. An unknown value refuses to start the service, like a misspelled
  feature toggle. Not authority — it decides what a reader is SENT, never what they may do, and
  `holdrim.json` still refuses `owner`, `admins`, `locks`, `roles` and `grants` exactly as before.
  The server applies it before the data leaves: the panel and the home draw whatever they are sent
  and compute nothing themselves. Whatever the setting, the owner and whoever holds `people` always
  see names, and a person always sees their own name on their own requests. The CLI applies the same
  setting to what it prints for a person — `holdrim list`, `holdrim show` and the brief `holdrim
  apply` hands the agent — except that it never reaches the accounts store, so `name` there falls
  back to the address, the same way it does for anyone with no name on record.
- **The documentation graph on the home**, behind `features.graph` (on by default, same as
  `holdrim graph`): every page and block as a node, `data-depends` as edges, the traffic light as
  colour — the SAME `graphOf` `holdrim graph` already prints (`engine/cli/graph.ts`), never a second
  walk of the pages, served as JSON from the new `GET /api/graph` (behind the same session check as
  every other block-reading route, whatever the toggle says — a hidden screen never means a disabled
  guard). Clicking a node opens its block; the view pans and zooms. No bundled library and no
  React: a small hand-rolled SVG renderer and layout, `engine/web/home-graph.js`, its own bundle,
  loaded by the home screen only, and only when the toggle is on — with the toggle off, the home
  stays exactly as script-free as it always was, and its Content-Security-Policy says so.
- **Filters on the home's graph**: a "pages starting with" box, and the legend's rows as ticked
  boxes — one per traffic-light state, plus "not defined" — so a graph of 500+ blocks narrows to
  the pages and states a viewer cares about. The filtered graph is laid out afresh, and an edge is
  drawn only while both of its ends are. It filters in the browser, on what `GET /api/graph`
  already sends: no new route, no new field, and nothing is remembered between visits.

### Security

- **A text edited straight in the store now raises its CRITICAL alert even when a forged removal
  claims it (#133).** Before, a direct writer who edited a text's row and then added one
  `text_removed` event for it, dated and placed after its target, made the field read as a clean
  removal credited to themselves: no `text_tampered` line, no banner finding, no non-zero exit from
  `holdrim list`/`sync`. `EventStore.removeText` deletes the row in the same step as it records the
  removal, so a removal beside a row still there is never its work; the field now reads as
  tampered, of kind `overwritten`, in every store and in the CLI's direct readers. The finding
  includes the removal's id, so an owner who acknowledged the edit before the removal was forged
  sees it again. Nothing to change: an operator whose store holds this forgery sees the alarm on the
  next read of that field.
- **Disabling an account, or resetting its password, now drops every session already open under
  it.** Before, a stolen cookie came back to life the moment the account was re-enabled, or even
  sooner: a reset alone left an already-open session untouched, since only the disabled flag was
  ever checked, at the next request. Resetting your own password now signs you out too — the drop
  cannot tell a self-service reset apart from one that reached the account through a stolen
  credential, so there is no exception for the person who pressed the button. A sign-in racing a
  reset or a disable cannot come away holding a session either. When the drop itself fails — the
  credential or the enabled flag has already changed regardless — the answer from
  `POST /api/users/:email/password` and `.../enabled` carries `sessionsDropped: false`, the log
  gets an `ERROR user_sessions_not_dropped` line naming the person by id, and the people screen
  warns next to their row.
- **`POST /api/change-password` now drops every OTHER session open under the account, keeping only
  the one that just made the change.** Before, a password chosen by its own owner — unlike a reset,
  which already dropped everything — left a session opened under the old, just-abandoned password
  free to keep going for whatever was left of its twelve hours: exactly as exposed as a stolen
  credential, and untouched by the very act meant to shut it out. It is not treated like a reset's
  all-or-nothing drop, because here the caller is sitting in one of those sessions right now, having
  just proved who they are — dropping it too would sign them out of the tab they used to change it.
  Every user store gained a `deleteSessionsForEmailExcept` primitive for this, one atomic delete
  rather than a delete-all followed by re-opening the caller's own session, which would reopen the
  exact race issue #113's fix closed for a window nobody asked to reopen. Same failure reporting as
  above: a failed drop carries `sessionsDropped: false` and an `ERROR user_sessions_not_dropped` line,
  never a 500 for a credential that changed regardless.
- **The CRITICAL line a tampered text raises now reaches the CLI's stderr, never its stdout.**
  `reportTampered` (engine/api/texts.ts) used to log through `log()`'s own default destination,
  `console.log` — the same stream `holdrim list --json` prints its answer on, so a store read back
  as tampered put that JSON-formatted alert ahead of the document and `JSON.parse` failed on exactly
  the read where `tampered: true` mattered most. The server's own logging is unchanged: it still
  goes to stdout, as its service log. Only the CLI's two direct readers of a store (`Source#fromFile`
  and the cloud read in `events()`, both in engine/cli/remote.ts) now pass `console.error` to
  `reportTampered`, the same routing `sqlite_guard_missing` already used for the same reason. Nothing
  to change for a caller of `holdrim list --json`: its stdout was never valid JSON on a tampered
  store before this, and always is now.

### Fixed

- **A ✓ is now stamped only on the one block it was given to — never on a decoy, a duplicate, or
  whichever block a regex happened to match first.** `mark`, `sync` and `restamp` used to locate a
  block by a regex or a CSS selector built straight out of its id, or by the first raw-text match in
  the first file that had it — either could land the seal on the wrong block, or throw, depending on
  characters the id itself carried (a documentation author's choice, not the engine's). A block is
  now resolved the same way the traffic light already reads it, and a write is verified, by
  re-parsing, against the whole page before it lands: the only difference allowed is the attributes
  added to that one block's tag. An attribute the block already carries is never written a second
  time. Three cases now REFUSE, and say why, instead of writing anywhere: an id carried by more than
  one block; an id containing `"` or `&`, which a page normally holds as an entity (`&quot;`,
  `&amp;`) that a literal search cannot find; and a page where the tag cannot be found without
  risking another block. Along the way, writing `data-depended-on` (which carries other block ids
  inside a JSON blob) stopped going through `String.replace` with a string replacement, whose
  `$&`/`$1`/`$$` syntax could corrupt an id containing `$&`, and now escapes `&` as well as `"`: a
  dependency id holding a literal `&quot;` or `&lt;` used to read back, in the browser, as `"` or
  `<` — a dependency naming a block that does not exist.
- **A re-approval synced from the site now replaces the seal on its block (holdrim#140).** `holdrim
  sync` recorded the new ✓ in the registry and kept the page's `data-validated`,
  `data-validated-fingerprint` and `data-depended-on` from the earlier one: the panel showed 🟡 on a
  block just approved, and `holdrim check` failed on the date. A ✓ that `sync` records now rewrites
  those three attributes on its block — once each, in lower case, where the first copy was, with every
  other copy of the same name in any case removed, and a `data-depended-on` the block no longer needs
  dropped — and the write is verified as before, the only difference allowed being that one block's
  seal. A block with no seal is stamped exactly as before. `holdrim restamp` still never overwrites;
  it now refuses, and says why, a block carrying a seal attribute whose name is not in lower case,
  rather than writing a copy the browser would ignore or counting the block as already stamped.
  A re-approval is refused, with the reason, when a `<` inside one of the block's attribute values
  hides where its start tag begins: the seal's every copy could not be seen, so it could not be seen
  to be replaced.
- **`holdrim sync` on a page with many blocks now finishes, in time that grows with the blocks
  (holdrim#144).** It used to re-read, re-parse and re-verify the whole page for every ✓: a first sync
  of 800 blocks on one page took about 30 s, and 3 000 never finished. A page's ✓ are now stamped
  together, with one parse, one verification and one write per page — 3 000 blocks in about a second —
  and a sync holds one page in memory at a time, whatever the size of the site. Every guarantee a stamp
  had is kept: the seal lands only on its block, the page is verified before it is written, and a
  block that cannot be stamped safely is refused alone, with the reason it always gave, while the rest
  of its page is stamped. A page edited while the run is under way is still refused rather than
  overwritten. What an adopter sees differently: the ✓ lines come out a page at a time, as each page
  is written, instead of one by one — in the same order as before.
- **A `holdrim sync` that aborts half-way now records the ✓ it had already stamped
  (holdrim#148).** The registry used to be saved only at the end of a run that finished, while each
  page is written as soon as its seals are stamped: an error in between — a page replaced by a folder
  of the same name, say — left those seals on disk with no registry entry, and `holdrim check` called
  each of those genuine ✓ "marked as validated … and there is NO registry entry" until a later sync
  got all the way through. The registry is now saved on the way out whether the run finished or not,
  with exactly the ✓ whose pages were written and nothing else; the run still fails, and the CLI still
  exits non-zero. A process killed outright between a page write and the save can still leave a seal
  without its entry — never an entry without its seal — and the next `holdrim sync` records it again.
