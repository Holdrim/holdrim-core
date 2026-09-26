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
  hold and read as it. The CLI's direct write to the cloud names its `agent via <account>` by an id
  too, and, like the server, now talks to the Firestore emulator when `FIRESTORE_EMULATOR_HOST` is
  set. The development identity (`X-Dev-Email`, `HOLDRIM_DEV_EMAIL`) is lowercased and trimmed, as
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
  not a guard, on stderr; `holdrim list --json` carries a `guardsTampered` key; `list` and
  `sync` exit non-zero when it is set; and `apply` (`--dry-run` included) and `state` refuse to
  act on such a file at all, before any brief, agent or event. Every guard warning, the server's
  included, now quotes the trigger's name as JSON, so a name carrying control characters is
  printed escaped.
- **A text that fails its own hash raises a CRITICAL alert.** Every read that resolves a field to
  tampered — a row edited in place, a hash with no accounting removal, or two removals of the same
  field, or a value with a stripped hash on a row that postdates when text extraction began (SQLite
  only) — logs a CRITICAL `text_tampered` line from the one place every reader shares (`reportTampered`,
  `engine/api/texts.ts`), EVERY time a read resolves it: there is no acknowledgement yet to quiet it
  (a follow-up issue), so it repeats rather than go silent after its first sighting. `holdrim list
  --json` now carries a `tampered` key, and `holdrim list`/`sync` warn and exit non-zero when it is
  set. See SECURITY.md for what this can and cannot catch, store by store. No released version
  predates text extraction, so there is nothing to roll a pin back to yet — but once a later version
  exists, moving the pin back to one from before this alert would write fresh events with their text
  stored inline again, above where this version's own hashed rows begin, and every one of those reads
  as `downgraded` tampering the next time any version opens the same file.
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

### Fixed

- **A block id containing a regex or CSS metacharacter (`+ * ( [ | ? \` and more) is now marked,
  synced and restamped correctly, instead of possibly hitting the wrong block, missing the right
  one, or throwing.** `mark`, `sync` and `restamp` built a regex, and in one place a CSS selector,
  straight out of the id — which is page text a documentation author writes, not something the
  engine controls. The opening tag is now located by plain string search on `data-id="..."`
  (`engine/cli/pages.ts`), so the id's own characters no longer choose what matches. Along the way,
  writing `data-depended-on` (which carries other block ids inside a JSON blob) stopped going
  through `String.replace` with a string replacement, whose `$&`/`$1`/`$$` syntax could corrupt an
  id containing `$&`.
