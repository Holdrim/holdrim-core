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
- **A page runs the panel and nothing else.** Every documentation page is served with a
  Content-Security-Policy whose nonce only the panel's tag carries, so a script written into the
  content — by a person, or by an agent following an instruction hidden in a document — cannot act
  with the reader's session. A page cannot bring scripts of its own.
- **The CLI, `holdrim`**: `lights`, `if-i-touch`, `index`, `check`, `kinds`, `export`, and the request
  cycle, `list`, `show`, `impact`, `apply` and `state`. `apply` hands a request to the agent CLI the
  person already has. The engine calls no model and holds no key.
- **Sign-in** with passwords, or behind an identity proxy. There is exactly one owner, named by
  `HOLDRIM_OWNER`, and the first-access password is printed once.
- **Storage.** Events go to SQLite or Firestore and are only ever appended; SQLite refuses
  `UPDATE` and `DELETE` by trigger. People go to SQLite, Postgres or Firestore. Every event store
  and every user store passes its own conformance suite in CI, against real databases.
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
