# Glossary: the concepts of the method

**Nothing in Portuguese in the code.** Identifier, comment, file name, table name, column name,
data key — all English.

The reason is the reader. The repository is public and MIT, and a comment is the part of the code
an outsider reads most before deciding whether to adopt it. A comment that person cannot read is
worth less than no comment at all.

The **content** follows a different rule: each project's documentation pages are written in the
language of whoever reviews them. Messages the reviewer reads go through `engine/core/i18n.js`, and
the translated values in `engine/locales/` are the one place another language is expected.

This file exists so the same concept does not end up with two names in two files. **Before
inventing a new name, look here.** If one is missing, add it on the same line you write the code.

---

## The unit of review

| Concept | What it is |
|---|---|
| **block** | the piece of text that gets approved, one at a time. In the HTML it is the element carrying `data-id` and `data-code`, inside `<main>`. Everything outside `<main>` is not reviewable |
| **sheet** | one page of documentation, identified by a page code (`A01`, `D01`, `UC-01`) |
| **kind** | what a block *is*: `title`, `subtitle`, `text`, `list`, `box`, `table`, `image`, `diagram`, `colors`, `config`, `contract`, `model`, `rule`, `rationale`, `decision`. Declared in `data-kind`, or inferred. Catalogue in `engine/core/kinds.js` |
| **demand** | what a kind requires of itself before a block counts as ready. An image demands an `alt`; a table demands a header row; a `decision` demands `data-owner` and `data-deadline`. ⚠️ A kind never changes **who** approves, nor **how** the fingerprint is computed — only what is demanded first |

Kinds exist because "is this good?" is not the same question for a heading and for a diagram.
Without kinds those rules become spoken convention, and spoken convention dies with the third
person who joins the project.

## The lock

| Concept | What it is |
|---|---|
| **fingerprint** | SHA-256 of the block's visible text, 16 characters. `engine/core/fingerprint.js`. One implementation only — it runs in the browser and on the server, with no build step |
| **normalize** | how the fingerprint reads text: whitespace collapsed, ends trimmed. Rewrapping a paragraph must not drop a human approval. Only the words count |
| **validation** | a human ✓ tied to **one fingerprint**, not to a block. Change one letter and the approval stops holding, because nobody approved the new text |
| **lock** | the consequence of that ✓ in the repository. Only the owner's ✓ locks; a reviewer's approval is recorded but does not lock |
| **registry** | the approvals file of the adopting project, where each lock is written with its `fingerprint` and, when the block declares any, its `dependsOn`. Its path is `content.registry` in `holdrim.json` |
| **dependency** | block B stands on block A. Declared by hand today, in `data-depends` |
| **proof** | the test that defends a `rule`. Declared in `data-proof`, as `path/to/file.test.js::name of the test`, with the path relative to the content project root. It is the only demand satisfied by something OUTSIDE the documentation, so it is the only one that stops being true without anybody touching the page — `holdrim check` accuses a path that is gone (`missingProofs`) |

Three copies of the fingerprint, in three languages, would agree only by luck — a copy that did not
strip the review UI (`data-review-ui`) would turn every approval into "an earlier version of the
text" the moment a marker was saved into the HTML, silently, with nobody able to say why. A rule
like that is not kept identical in three places by discipline. It is kept by being one.

## The traffic light

The state of a validation. It is **computed, never declared** — `engine/core/validity.js`. The
question it answers is not "did someone approve it?" but "**does the approval still hold?**".

| | State | Meaning |
|---|---|---|
| ⚪ | `none` | nobody has validated it yet |
| 🟢 | `valid` | validated, and nothing has changed since |
| 🟡 | `stale` | **this** block's text changed after the ✓ — nobody approved the new text |
| 🔴 | `broken` | this block's text is unchanged, but something it **depends on** changed |

Yellow was always visible through the fingerprint. Red is what makes documentation living rather
than merely traceable: it says *"this is still written exactly as approved, but the rule it stood
on moved — go check whether it is still true"*.

⚠️ **Red is not an error. It is a question.** The engine does not know the block became wrong — it
knows it became **suspect**, and that a human needs to look. Treating it as an error would make
people switch the check off at the first false positive, and then the whole lock is pointless.

Yellow beats red: if the block's own text changed, that is the problem to fix first.

## The cycle

The state machine of a change request. Single source: `engine/cycle.json`, read by the API and by
the agent's tool. The front end computes no state at all — it receives one.

| State | Owned by | Meaning |
|---|---|---|
| `open` | owner | waiting for triage |
| `approved` | owner | approved |
| `rejected` | owner | rejected, with a reason |
| `question` | owner | a question back to whoever asked |
| `applying` | agent | being applied |
| `waiting` | agent | being applied, with a query outstanding |
| `applied` | agent | applied, with a commit |

The words a person reads for each state are not here: the CLI prints `label` from `cycle.json`, and
the panel resolves `cycle.<state>` from `engine/locales/`, in the reader's language.

| Concept | What it is |
|---|---|
| **request** | somebody asking for a change to a block. The starting point of the cycle |
| **triage** | deciding the fate of a request: approve, reject, or ask. It belongs to the owner or an admin. ⚠️ Nobody triages themselves — a request from an owner or an admin is born `approved` (design decision, `2026-09-17`) |
| **supplement** | detail added to a request that is `open`, `rejected` or `question`. A supplement on a `rejected` or `question` one sends it back to `open` |
| **snapshot** | the text of the block at the instant of the request or the approval. Git stays the version history; the snapshot shows *what* was approved or asked |
| **agent queue** | what `holdrim list` shows as waiting to be applied: `approved`, `applying`, `waiting` |
| **doubt** | a category of request — "I do not understand this". ⚠️ `doubt`, not `question`: `question` is already a **state** of the cycle. Both travel as loose text, and the same name on both would make a `grep` lie |

`approved` **never goes back** to `rejected`. Changing something approved means a **new request**
linked to the previous one (`data.related`) — even if the change is going back to the earlier text.

A state machine written **five** times ends up as five machines that are not equal, only similar:
different labels between one language and another, seven transitions on one side and eleven on the
other. Changing the cycle would cost a commit in every language, and nothing would warn you if you
forgot one.

## Who can do what

| Concept | What it is |
|---|---|
| **owner** | exactly one, always the same: the founding architect. Can do everything, including creating the roles. Zero or more than one **does not bring the service up** — it is an invariant, not a convention. It comes from `HOLDRIM_OWNER`, never from a database column and never from `holdrim.json`, which refuses to load if it names one |
| **admin** | every capability but `lock`. A role of the **project**, not of the method. Named by `HOLDRIM_ADMINS`, and only there |
| **member** | `read`, `comment`, `request` — any other allowed identity |
| **founder** | a tag that grants the power to see the whole documentation. It sits **on the role, not on the person**, so the second holder of that role sees it too, without an exception. ⚠️ A concept of the method only: no code reads it yet |
| **capability** | what the engine actually asks about — one of a closed list, `engine/core/roles.js`'s `CAPABILITIES`: `read`, `comment`, `request`, `triage`, `approve`, `lock`, `people`. A role is a name and a subset of it (`capabilitiesOf`); every caller asks `roles.can(capability, email)`, never a role's name — role names change with every company, capabilities do not. `lock` is validated the same as the other six but never part of a role's GRANTABLE set (`docs/ROLES.md`, "Capabilities are the engine's") |

The method defines only `owner` and the `founder` tag. `admin`, clinical lead, operator, auditor —
those belong to the project adopting the method. If the engine named a product role, it would stop
being an engine. `engine/core/roles.js`.

The owner is an admin by consequence, not by configuration: there is no way to strip their power by
accident.

## How it is stored

| Concept | What it is |
|---|---|
| **event** | every ✓, request, rejection and comment, with author, timestamp, page, block and the fingerprint at that moment. Nothing is erased |
| **store** | where the events live — memory, SQLite or Firestore, behind one interface (`EventStore`, `engine/api/types.ts`). In SQLite the database refuses `UPDATE` and `DELETE` — through triggers, not through discipline |
| **index** | blocks, kinds, dependencies and issues, rebuilt on demand by `holdrim index`. `engine/api/index-store.ts`. ⚠️ The index is **not** truth and can be deleted without loss: the truth is the file, versioned in git, which is what has diffs, history and authorship |
| **limits** | the size and shape of everything crossing the boundary. `engine/core/limits.js`. It exists because without it a POST with 500 KB per field would be accepted and then served back to everyone, on every page load, into a collection nobody can delete from |
| **source** | where the agent's tool reads events from: the cloud, a SQLite file (`--db`), or a local server (`--local`). `engine/cli/remote.ts` |
| **user store** | where the people who log in, and their sessions, are kept — apart from the events. SQLite, Firestore or Postgres, chosen by `HOLDRIM_USERS`. `engine/api/users.ts` |
| **disabled** | what happens to a person instead of deletion. There is no way to delete one: every ✓ they gave names them, and deleting them would leave approvals nobody can attribute. Disabling takes the access away, drops the open session, and keeps the history. The owner can go further, at the person's request: forget them (`EventStore.forget`, which only ever empties the row's e-mail) and remove the free text they wrote (`EventStore.removeText`) — the id, and every event, fingerprint and snapshot it is on, stay untouched, so a lock keeps saying what it locked. `docs/PRIVACY.md`, section 5, is the procedure |

## Around the edges

| Concept | What it is |
|---|---|
| **config** | the configuration of the project using the method, in `holdrim.json` at the root. It exists so the **engine** does not know the product. Environment variables beat the file, so the same repository serves more than one environment — except `language`, where `HOLDRIM_LANGUAGE` counts only when the file names none. Authority is not in it at all: a file naming `owner`, `admins` or `locks` refuses to load. `engine/core/config.js` |
| **theme** | how the project dresses the engine: `theme.brand`, `theme.logo`, `theme.name` in `holdrim.json`. ⚠️ Untrusted input — it lands inside CSS and HTML, so it is validated in `engine/api/theme.ts`, next to the code that writes it |
| **i18n** | the core returns **keys**; the edge turns them into sentences, in the reader's language. `engine/core/i18n.js` |
| **brief** | everything an agent needs to act on one approved request, in plain text. `holdrim apply <id>` writes it and hands it to the person's own agent CLI. `engine/cli/agent.ts` |

⚠️ Three audiences, and they are not the same. **The reviewer** reads messages in the browser, in
their own language, always translated. **Whoever operates** reads logs: English always, and not
through `i18n.js` — a log is evidence, and evidence that changes wording by locale cannot be
grepped. **Whoever develops** reads configuration errors at boot: English, hard-coded, because a
service that refuses to start has no session, no person and no chosen language yet.

---

# Names in the code

The identifiers themselves, for when a concept above has to be found in a file, a row or a payload.
They are contract: a value that changes with the reader's locale is a value nobody can match on.

## Event fields

`engine/api/types.ts`, and the same names in the core.

| Field | What it holds |
|---|---|
| `type` | one of the event types below |
| `page` | the page code (`D01`, `UC-01`) |
| `block` | the block's `data-id`, or null when the event belongs to the page or to a decision |
| `fingerprint` | of the block's text at that moment: an approval holds for THIS text |
| `text` | what the person wrote. Stored outside the event, in a table of texts (`engine/api/texts.ts`); the event keeps a salted hash. Reads as the plain value while its row holds one, as `null` with `textRemoved: {by, when}` once `EventStore.removeText` has let it go on purpose, and as `null` with `textTampered: true` when the hash no longer matches anything at hand and no such removal explains why — missing with nothing to say why, never shown as plain absence. An event from before texts were extracted holds its own value directly, with no hash, and reads as it |
| `snapshot` | the text of the block at that instant. The same table, the same hash, the same three readings as `text` — `snapshotRemoved`, `snapshotTampered` |
| `author` | who made it. Stored as the person's opaque id (`p_` and 24 hex characters) from the people table, never as an e-mail; every reader gets the e-mail back, as verified by whichever identity is in charge — or the id, once the person is forgotten. An event written before ids holds the e-mail itself, and reads as it |
| `when` | ISO, the server's clock. Stored in the column `happened_at`, since `WHEN` is an SQL keyword |
| `data` | a small map of scalars: `request`, `state` and `from` on `request_state`, `commit` and `blocks` on an applied one, `category` on a request, `related` on a request that follows an approved one |

## Event types

| Type | What it records |
|---|---|
| `approval` | a ✓ on a block, for one fingerprint |
| `request` | somebody asking for a change to a block |
| `comment` | something said about a block, asking for nothing |
| `decision_reply` | an answer to an open decision. The API accepts it; nothing in the panel writes one yet |
| `request_state` | a request moving from one state of the cycle to another |
| `supplement` | detail added to a request by whoever asked |
| `text_removed` | a `text` or `snapshot` let go on purpose, naming the event and the field in `data`. Written only by `EventStore.removeText`, never through `POST /events` — deliberately not in `EVENT_TYPES`, since the removal has to delete the row in the same step, which that door does not do |

## Request categories

`request_categories` in `engine/cycle.json`.

| Category | Means |
|---|---|
| `text` | adjust the text |
| `term` | replace a term |
| `remove` | remove |
| `doubt` | "I do not understand this" — see **doubt** above |
| `bug` | the documentation and the behaviour disagree — see [BUGS.md](BUGS.md) |
| `page` | a page that does not exist yet, asked for in plain words; the agent that applies it writes a new page (`engine/cli/agent.ts`) |

## The database

| Table | Where | What it is |
|---|---|---|
| `events` | `engine/api/store-sqlite.ts` | the facts. Triggers `events_no_update` and `events_no_delete` refuse to alter or erase a row |
| `texts` | `engine/api/store-sqlite.ts` | an event's `text` and `snapshot`, one row per event and field: `value`, `salt`. Trigger `texts_no_update` refuses to edit a row; `EventStore.removeText` is the only code that deletes one, and only together with the event that records why |
| `blocks` | `engine/api/index-store.ts` | derived: every block, its kind, its fingerprint |
| `dependencies` | `engine/api/index-store.ts` | derived: `block` → `depends_on`, with the `severity` of the pair |
| `issues` | `engine/api/index-store.ts` | derived: what each block is `missing` |
| `index_meta` | `engine/api/index-store.ts` | one row: the commit and the instant the index was built from |
| `users` | `users-sqlite.ts`, `users-postgres.ts` | people: `email`, `name`, `salt`, `hash`, `must_change`, `created_at`, `enabled` |
| `sessions` | `users-sqlite.ts`, `users-postgres.ts` | open sessions: `id`, `email`, `created_at`, `expires_at` |

⚠️ Renaming a table or a column **breaks stored data**. Every change here needs a migration that
reads the old format: history does not get rewritten.

## The core

`engine/core/` — the same files in the browser, on the server and in the CLI.

| Name | Where | What it does |
|---|---|---|
| `createCycle` | `cycle.js` | builds the cycle from `cycle.json`, refusing a table with no states or a dangling transition |
| `currentState` | `cycle.js` | reduces a request's history to one state |
| `status` | `cycle.js` | what the front end needs about a state: `state`, `triage`, `requiresReason`, `acceptsSupplement`, `canGoTo`, `ownedBy` |
| `canGo` / `exists` | `cycle.js` | is this transition legal / is this a state |
| `ownerStates` / `agentStates` | `cycle.js` | the states each side owns |
| `requiresReason` / `requiresCommit` | `cycle.js` | states that demand a reason / a commit |
| `acceptsSupplement` | `cycle.js` | states a supplement can reach |
| `createRoles` | `roles.js` | the roles, from `HOLDRIM_OWNER` and `HOLDRIM_ADMINS`; throws on zero or two owners |
| `isOwner` / `isAdmin` | `roles.js` | who someone is |
| `canApprove` / `canTriage` | `roles.js` | what someone can do |
| `roleOf` | `roles.js` | returns `owner`, `admin` or `other` |
| `overLimit` | `limits.js` | the first limit an event breaks, as a key and its parameters |
| `validCommit` | `limits.js` | `applied` without a real commit is a hollow trail |
| `LIMITS` | `limits.js` | the sizes themselves |
| `normalize` | `fingerprint.js` | whitespace collapsed, ends trimmed |
| `fingerprintOfText` / `fingerprintOfElement` | `fingerprint.js` | the fingerprint, of text or of a DOM element |
| `textOfElement` | `fingerprint.js` | the visible text, without `data-review-ui` — also the snapshot |
| `SIZE` | `fingerprint.js` | 16, the length of a fingerprint |
| `stateOf` / `trafficLight` / `dependentsOf` | `validity.js` | the traffic light of one block, of all of them, and what stands on a block |
| `kindOf` / `whatIsMissing` / `layerOf` | `kinds.js` | a block's kind, its unmet demands, and its layer ([LAYERS.md](LAYERS.md)) |
| `severityOf` | `impact.js` | how loud a change is for the block that stands on it ([IMPACT.md](IMPACT.md)) |
| `readConfig` | `config.js` | `holdrim.json`, with the environment on top (`language` aside) |
| `createI18n` | `i18n.js` | the translator: `t`, `choose`, `missing` |
| `currentCommit` | `git.js` | the commit of a tree, with the inherited `GIT_*` variables stripped |

`label` and `short` in `cycle.json` are for the edge, not for the rule: the core never reads them.

## The user store

`engine/api/users.ts`, and one file per database.

| Name | What it is |
|---|---|
| `UserStore` | the interface every store implements |
| `UserStoreBase` | where the scrypt hashing, the salt, the constant-time comparison and the session lifetime live, so no store can diverge |
| `UsersSqlite` / `UsersFirestore` / `UsersPostgres` | the three implementations, in `users-sqlite.ts`, `users-firestore.ts`, `users-postgres.ts` |
| `User` | a person as the rest of the service sees them: `email`, `name`, `mustChangePassword`, `createdAt`, `enabled`. No secret in it |
| `StoredUser` | a `User` plus `salt` and `hash`, which never leave the store |
| `create` / `check` / `find` / `isEmpty` | create a person, check a password, look one up, and the first-access condition |
| `changePassword` / `resetPassword` | the person's own change / a new generated password, shown once, that must be changed |
| `list` / `setEnabled` / `rename` | everyone, disabled included / take the access away or give it back / change the display name |
| `openSession` / `fromSession` / `closeSession` / `purgeExpiredSessions` | sessions |
| `close` | release the database |

`/api/me` answers in the same vocabulary: `email`, `role`, `canApprove`, `canTriage`, `owner`,
`admins`, `language` (the one the panel draws itself in) and `mustChangePassword` when it applies.
