# The method

> `2026-09-22`. This describes **what exists today**, not the intention. Anything not built yet is
> in "Not built yet" at the end, and in the README under what does not work yet.

Holdrim is an engine, not a project. Everything here has to hold on a documentation project it has
never seen: nothing in the engine names a company, a product or a person — whatever varies is
configuration.

## The cycle

```
Write (agent + owner)  →  Publish when the owner says so  →  Review (people, in the browser)
        ↑                                                            │
        └──── Apply, after impact analysis (agent) ←──── Request recorded
```

| Step | Who | How |
|---|---|---|
| **Write** | the agent, with the owner | HTML pages, one `data-id` per block, in the standard of whoever adopts the method |
| **Publish** | the owner decides when | outside the engine: the content is a repository, and publishing it is that repository's business |
| **Review** | whoever has access | in the browser, block by block: **Approve · Ask for a change · Comment** |
| **Apply** | **the agent only**, with the owner | reads the request, measures the impact, asks about anything ambiguous, applies it, commits with `Request:`, closes the request |
| **Learn** | the agent | a repeated correction becomes a written lesson in the adopting project |

## The six rules

1. **Git is the source of the content.** Nothing changes a page outside a commit. The site never
   edits content — it only records what people said about it.
2. **Review is a log of events that never get erased.** Approved, asked, commented, answered,
   applied, refused: each with **who** (verified identity), **when** (the server's clock), **where**
   (page and block) and **the fingerprint of the text** at that instant.
3. **An approval is for a text, not for a block.** Change the text and the approval drops on its
   own — nobody has to remember to drop it.
4. **Every change is born from a request or from a session with the owner**, and the commit says
   which.
5. **Impact before change.** The agent never applies a request without looking at everywhere else it
   touches.
6. **Minimum cost.** A container and a file. No managed database is required to start.

## The traffic light

Rule 3 gives you yellow. Rule 5, written down, gives you red.

| | State | Meaning |
|---|---|---|
| ⚪ | `none` | nobody has validated it yet |
| 🟢 | `valid` | validated, and nothing has changed since |
| 🟡 | `stale` | **this** block's text changed after the ✓ |
| 🔴 | `broken` | the text is unchanged, but something it **depends on** moved |

Red is the reason the method exists. It catches what nobody notices while reading the page, because
**on the page, nothing changed**: the deadline in section 2 was edited, and the sentence in section 7
that reasoned from that deadline is now standing on nothing.

It works because the ✓ records more than the block's own fingerprint. At the moment of approval,
`mark()` also writes the fingerprint **each declared dependency had right then** (`dependsOn` in
the record, `data-depended-on` in the HTML). `stateOf()` compares those with today's. A dependency
that vanished counts as moved: the block is pointing at something that no longer exists.

Yellow beats red, deliberately. If the text itself changed, saying "something it depends on also
changed" adds nothing — re-approving the new text is the next step either way.

⚠️ **Red is a question, not an error.** The engine does not know the block became wrong; it knows it
became suspect. Treat it as an error and people switch the check off at the first false positive —
and then the whole lock is worth nothing.

Code: `engine/core/validity.js` (`stateOf`, `trafficLight`, `dependentsOf`).
Commands: `holdrim lights`, `holdrim if-i-touch <id>`.

## Kinds of content

Every reviewable piece is of one kind, and each kind knows what it demands of itself. `title`,
`subtitle`, `text`, `list`, `box`, `table`, `image`, `diagram`, `colors`, `config`, `contract`,
`model`, `rule`, `rationale`, `decision` — fifteen, in `engine/core/kinds.js`.

The kind is **declared** (`data-kind`) or **inferred** from how the block was written (a `<table>`
is a table, a `<pre>` is a diagram). Inference exists so the method does not open by demanding:
documentation that already exists gets kinds without anyone rewriting anything.

⚠️ A kind **never** changes who approves, nor how the fingerprint is computed. It changes only
**what is demanded** before a block counts as ready. There is one lock, and it is the same for all
fifteen.

## Roles

The engine knows three: **owner**, **admin** and everyone else. Product roles — clinical lead,
manager, auditor — belong to whoever adopts the method, and usually come from their identity
provider. If the engine named a product role, it would stop being an engine.

| Who | Can |
|---|---|
| **owner** | exactly one, always the same. Everything, including granting admin |
| **admin** | everything the owner does, **except** being the owner or changing who that is |
| **anyone else with access** | see, ask for a change, comment, answer an open decision |

- **A single owner is an invariant, not a convention.** Zero or two owners **do not bring the
  service up**, with a legible message. It is tested.
- **The owner is an admin by consequence**, not by configuration — there is no way to strip their
  power by accident.
- **Only the owner's ✓ becomes a lock in the repository.** Anyone else's approval is recorded as an
  event, and stays an opinion.
- **A request from an owner or an admin is born approved.** Nobody triages themselves.

Code: `engine/core/roles.js`. Configuration: `HOLDRIM_OWNER`, `HOLDRIM_ADMINS`.

## The request cycle

```
somebody asks ──► To triage ──► owner: Approve ──► agent: Applying ──► Applied (commit)
                     │  ▲
                     │  └── whoever asked adds detail
                     ▼
               owner: Reject (reason) · Ask ──► can be revisited and approved
```

- **Rejected can be revisited**: whoever asked adds detail and it goes back to "To triage".
- **Approved never goes back**, and takes no supplement. Changing something already approved is a
  **new request** linked to the previous one — even when it means returning to the earlier text.
- **Snapshot of the text**: every request and every approval keeps the text of the block at that
  instant. Git stays the version history; the snapshot shows *what* was approved or asked.

Which transitions are legal lives in one file, `engine/cycle.json`, read by `engine/core/cycle.js` —
server, CLI and browser all obey the same table.

## How the ✓ gets back into the repository

The owner validates **in the browser, not in the terminal**. The site does not write to the
repository; the agent closes the loop.

```
owner clicks ✓ ──► event in the store ──► holdrim sync
                                     ──► the approvals file + three attributes in the HTML
```

The approvals file is the project's, not the engine's: `content.registry` in `holdrim.json` says
where it goes. A fixed file name inside the engine would be one project's decision imposed on every
other.

| In the HTML | Holds | Without it |
|---|---|---|
| `data-validated` | when it was validated | there is no ✓ |
| `data-validated-fingerprint` | the text that was approved | there is no 🟡 |
| `data-depended-on` | the ground it stood on at that moment | there is no 🔴 |

- **A stale ✓ does not lock.** If the text changed between the click and the sync, the command warns
  and ignores it: the lock exists only for the text they actually read.
- **One fingerprint, of the visible text.** It is what the browser computes, so it is the one that
  matches the site. The price is known: it reads words, not markup, so a change of **formatting**
  alone — the same words, bolded or linked — does not move it and does not drop the ✓.
- **One implementation.** Browser, server and CLI import the same `engine/core/fingerprint.js`. Two
  implementations of the same hash is two implementations that will drift.

## How the agent applies a request

```bash
node engine/cli/holdrim.ts <command>    # --local to talk to the local server
```

1. **See** — `list` (only the ones the owner approved) and `show <id>`: what was asked, by whom, the
   text then and now, and whether the block is validated.
2. **Mark it as being applied** — `state <id> applying "…"`. Whoever asked sees it in the panel.
3. **Measure the impact** — `impact <id> --term "…"` for each subject in the request, and
   `if-i-touch <id>` for what the block holds up. Dependency of meaning counts: remove a use case,
   and whatever cited that use case is now suspect.
4. **Ask the owner** about anything ambiguous, and about anything touching a validated block — "only
   in this block, or in the other N as well?". If the answer belongs to whoever asked,
   `state <id> waiting "question"`.
5. **Apply** it, then run `check` (a validated block changes only with the owner's ok) and
   `index`.
6. **Commit** with the trailer:
   ```
   Request: <full id>
   ```
   Who asked is not in the commit any more: `Request:` already names the request, and the person
   behind it is found from there, in the people table, the one place it can be removed
   (`docs/PRIVACY.md`, section 6).
7. **Close** — `state <id> applied "what changed" --commit <sha> --blocks A01.2.1,A01.2.2`.

`holdrim apply <id>` writes the brief for one request — the request, its impact, these steps — and
hands it to the agent CLI the person already has (`--agent claude`, `codex`, `gemini`, or a whole
command; `--dry-run` prints the brief instead). The engine calls no model and holds no API key: the
agent runs on the person's own account, at their own computer, started by them.

**The separation of powers is tested:** the agent applies, and refuses to approve. `state` accepts
only `applying`, `waiting` and `applied` — rejecting, like approving and asking, is the owner's
triage, on the site. Triage belongs to whoever owns the documentation, and the API answers 403 to
anyone else.

## The pieces

| Piece | Where | Note |
|---|---|---|
| The lock | `engine/core/fingerprint.js` | one implementation, shared by browser, server and CLI |
| The traffic light | `engine/core/validity.js` | ⚪ 🟢 🟡 🔴, computed — never declared |
| Kinds | `engine/core/kinds.js` | fifteen, and what each demands of itself |
| The cycle | `engine/cycle.json` + `engine/core/cycle.js` | the legal transitions, in one table |
| Roles | `engine/core/roles.js` | owner, admin, everyone else |
| Language | `engine/core/i18n.js` + `engine/locales/` | the reviewer's messages; logs stay English |
| Server | `engine/api/server.ts` | Node 24 running TypeScript directly — no build step |
| Event store | `engine/api/store-sqlite.ts` | SQLite on `/data`; the interface takes other stores |
| Index | `engine/api/index-store.ts` | derived, disposable, rebuilt by `index` |
| Identity | `engine/api/identity-password.ts`, `identity-iap.ts` | password, or a signed header from an identity proxy |
| User store | `engine/api/users.ts` + `users-sqlite.ts`, `users-firestore.ts`, `users-postgres.ts` | one interface, three databases; the hashing lives in the interface so none of them can diverge |
| Review panel | `engine/web/` | React, bundled into `panel-react.js` |
| The agent's tool | `engine/cli/holdrim.ts` | the commands above |
| The agent bridge | `engine/cli/agent.ts` | `holdrim apply`: the brief, handed to the person's own agent CLI |
| Example content | `examples/template/`, `examples/hello-world/` | a template with eleven sections, and a two-page tour |

**Configuration** (all of it optional except the first):

| Variable | What it is |
|---|---|
| `HOLDRIM_OWNER` | who approves. Their ✓ is what becomes a lock |
| `HOLDRIM_ADMINS` | e-mails, comma separated |
| `HOLDRIM_AGENTS` | the agents' e-mails, `;` separated: never a ✓, a lock, triage or people, whatever they are granted, and the service refuses to start if a grant names one |
| `HOLDRIM_OWNER_NAME` | the owner's display name on their first access (default: `Owner`) |
| `HOLDRIM_SITE` | the root of the documentation project, where its `holdrim.json` is (default: the engine's own folder; the image sets `/app/examples/hello-world`) |
| `HOLDRIM_EVENTS` | where the events live: `sqlite`, `memory` or `firestore` (default: `sqlite`; `memory` in local mode) |
| `HOLDRIM_EVENTS_PATH` | the events file (default: `./data/events.db`) |
| `HOLDRIM_IDENTITY` | `password`, `iap`, or `dev` — never `dev` outside Development |
| `HOLDRIM_USERS` | where the people who log in are kept — see below |
| `HOLDRIM_USERS_PATH` | the SQLite users file, when `HOLDRIM_USERS` is not set (default: `./data/users.db`) |
| `HOLDRIM_LANGUAGE` | the project's default language, when the reader has no preference (default: `en`) |

**Where the users live.** People and sessions are stored apart from the events, and the storage is
pluggable for the same reason Keycloak's is — a file is right on a laptop and wrong on a platform
that recycles its instances.

| `HOLDRIM_USERS` | Store |
|---|---|
| *(not set)* | SQLite, at `HOLDRIM_USERS_PATH` or `./data/users.db` |
| `sqlite:/data/users.db` | SQLite in that file |
| `firestore` | Firestore, in the project named by `HOLDRIM_PROJECT` |
| `postgres://…` | Postgres, through the optional `pg` package. `postgresql://…` too |

The scrypt hashing, the salt, the constant-time comparison and the session lifetime live in
`UserStoreBase`, not in the implementations. That is not tidiness: a password hashed one way in
SQLite and another way in Postgres is an account that works in one deployment and not in the other,
and the person is told "e-mail or password do not match" while holding the right password. The
implementations know about rows; none of them knows about scrypt.

`engine/tests/users-conformance.test.js` runs **one** suite against every available store. An
implementation that does not pass it is not supported. When a store cannot be reached — no Docker
for Postgres, no emulator for Firestore — its tests **skip with the reason printed**, because a
green test that never ran buys confidence with nothing behind it. CI's `stores` job starts both and
sets `HOLDRIM_TEST_REQUIRE=postgres,firestore`, which turns that skip into a failure: there, a store
that did not run means the setup broke.

## Truth and index

Two databases, and only one of them is truth.

- **`events`** is fact. Triggers refuse `UPDATE` and `DELETE` — through the database, not through
  discipline. Nothing is ever erased; a correction is a new event.
- **`blocks`, `dependencies`, `issues`** are derived. `index` wipes and rewrites them inside a
  transaction. Delete the file and you lose nothing.

They are separate because files answer some questions badly — "every suspect diagram in the
project", "every decision with no owner", "what breaks if I touch this". Those are database
questions. But if both were truth, one day they would disagree, and there would be no way to know
which to believe.

## Language

The engine is in English and ships three dictionaries — English, Portuguese and Spanish, in
`engine/locales/`. Messages the reviewer reads go through `engine/core/i18n.js`; adding a fourth is
copying one file (`engine/locales/README.md` says how).

Three audiences, and they are not the same:

| Who | Reads | Language |
|---|---|---|
| the reviewer | the panel, in the browser | theirs — person, then `Accept-Language`, then the project's default |
| whoever operates | logs | English, always. A log is evidence, and evidence that changes wording by locale cannot be grepped |
| whoever installs | boot errors | English, hard-coded. A service refusing to start has no session and no chosen language yet |

A missing key returns the key itself. A page showing `cycle.approved` is ugly and diagnosable in a
second; a page showing nothing is a bug someone chases for an afternoon. `missing()` lists every
hole, and a test calls it.

## Not built yet

Honest, `2026-09-22`:

- **Generation.** Today a human writes and the tool keeps it honest. The intent is the tool writing
  the first draft, and the human correcting it.
- **Generated diagrams.** `diagram` exists as a kind and enters the lock; nothing produces one.
- **Automatic dependencies.** Dependencies are declared by hand. The tool should propose them: two
  blocks using the same term probably depend on each other.
- **Identity beyond password and identity proxy.** OIDC, Google, LDAP: `HOLDRIM_IDENTITY` knows
  `password`, `iap` and `dev`, and nothing else is written.
- **On Cloud Run, SQLite loses users on instance recycling.** The disk there is ephemeral and per
  instance. An access created at 10:00 lives on the instance that served the request; when the
  platform recycles it, `users.db` goes with it, and the person who had an account simply stops
  getting in — **no error, no log, nothing to grep**. Nobody finds this on the day they deploy;
  they find it weeks later, from "it forgot me again". `HOLDRIM_USERS` is the way out
  (`postgres://…` or `firestore`), and it is configuration, not a fix. At boot the service logs
  one line at `WARNING` (`ephemeral_user_store`) when it sees a file-backed store on a runtime that
  looks ephemeral — but **it still starts happily in the losing combination**, on purpose, and the
  only signal it reads today is Cloud Run's `K_SERVICE`. Another platform with no volume loses the
  file just as quietly and gets no warning.
- **Firestore events can still be deleted.** In SQLite, "nothing is erased" is a trigger. In
  Firestore it is only the code: `FirestoreEventStore` writes with `create`, so no path overwrites
  a fact, but the project's IAM still allows a delete.

## What is not in here, and why

⚠️ **The survey of similar methodologies came after the engine stood on its own** — it is
[PRIOR-ART.md](PRIOR-ART.md), not a section of this file. Build first, compare after: comparing
first turns into designing for a comparison table.

**Who can implement is still not a permission.** Approving is: it is the owner's, and the code
enforces it. Running the agent is whoever has the repository in hand. That is a real gap, it is
known, and it is not being papered over.
