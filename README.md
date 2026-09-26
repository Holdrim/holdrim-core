# Holdrim

Documentation that tells you when it stopped being true.

[Português](README.pt-BR.md) · [Español](README.es.md)

**Mission.** The approved document is the system's source of truth: the people who know the business
write it and approve it, an AI agent facilitates the building, and the code stays in view of anyone
who wants to validate it.

**Vision.** Technical and non-technical people alike create, maintain and refactor complex systems
starting from their business rules. The reviewed and approved documentation comes before any line of
code or any screen, so nobody redoes work for want of a rule — neither the people nor an agent
spending tokens on a guess.

## How it works

1. **Say what the product must do, in plain words.** Ask for a page from the project's home, or for
   a change to any block of one; once the request is accepted, your own AI agent writes it. Every
   rule of the product lives in the documentation before it lives anywhere else.
2. **Approve it, block by block.** An approval records who approved, when, and **which exact text**.
   Change one letter and it stops holding, because nobody approved the new text. Only the owner's ✓
   becomes a lock; an agent may apply a change, and never approve one.
3. **Build from what was approved.** The approved pages — screens, data model, use cases, contracts —
   are what your agent and your engineers build from, and the code sits in its repository for anyone
   to read against them.
4. **Know when it stopped being true.** When a rule changes, every block that rested on it turns 🔴,
   on its own page, without a letter of it changing.

The agent is whichever one you already use — Claude Code, Codex, Gemini — on your machine and your
account. The engine calls no model and holds no API key.

Holdrim is the engine, the way Keycloak is the engine behind a sign-in: a Docker image your project
runs and configures, while your documentation keeps its own repository and mounts into it. More of
the vision, and what the agent does and never does, in [`docs/VISION.md`](docs/VISION.md); what is
being built next, in [`ROADMAP.md`](ROADMAP.md).

## In two minutes

```bash
git clone https://github.com/holdrim/holdrim-core
cd holdrim-core
HOLDRIM_OWNER=you@example.org docker compose up
```

Open `http://localhost:8080`. The first-access password is printed **once** in the log, and the
first login forces you to change it. There is no `admin/admin`: internal tools stay up for years.

You land on the project's home, `/engine/home`: every page with its traffic light, and every
request someone is still waiting on. The pages are `examples/hello-world` — two of them, explaining
in their own text everything a page needs to work here.

No Docker? `bash engine/run-local.sh` serves the same two pages at `http://localhost:8095`, as part
of this repository's own project (the files in `examples/hello-world/pages/`, served under that same
path), straight in with no login, and keeps its events in memory — stopping it erases them, so
working on the engine cannot touch anybody's real approvals.

## The traffic light

Every block has a state, and the state is computed — never declared by anyone.

| | State | Meaning | What to do |
|---|---|---|---|
| ⚪ | not validated | nobody has looked yet | read and approve, or ask for a change |
| 🟢 | validated | approved by the owner, and nothing changed since | nothing |
| 🟡 | stale | **this** block's text changed after the ✓ | re-approve the new text |
| 🔴 | suspect | the text is unchanged, but something it **depends on** moved | check whether it still holds |

Red is what separates this from version control with a badge. It catches the case nobody notices
while reading the page — because **on the page, nothing changed**.

```
  "The response deadline is 24 hours."       ← someone edits this…
  "Since the deadline is short, the alert
   fires the same day."                      ← …and this turns red, untouched
```

**Red is a question, not an error.** The engine does not know the block became wrong; it knows it
became suspect. Treating it as an error would make people switch the check off at the first false
positive, and then the whole lock is pointless.

<!-- translated: everything above this line is also in README.pt-BR.md and README.es.md -->

## See it turn red

`examples/cash-register` is the example to show someone who has never seen the method: a small
shop's till and the contract with its supplier's system, every block approved by the owner. Then
the shop extended its return period from 7 to 14 days, and the owner approved the new sentence —
and two rules written on top of the old one, one of them on another page, turned 🔴 without a
letter of them changing.

```bash
bash engine/run-local.sh examples/cash-register
```

Open `http://localhost:8095`: you are in as the owner, and the project home shows the two reds; each
links to its page, where the block says what moved under it. With Docker, the image has to be built
first — Compose builds it under a name of its own:

```bash
docker build -t holdrim .
docker run -p 8080:8080 -v data:/data -v "$PWD/examples/cash-register:/content" \
  -e HOLDRIM_SITE=/content -e HOLDRIM_OWNER=owner@example.org holdrim
```

## For your own documentation

The image is built from this repository, under the tag the `Dockerfile` itself uses:

```bash
docker build -t holdrim .
docker run -p 8080:8080 -v data:/data \
  -v "$PWD/my-docs:/content" -e HOLDRIM_SITE=/content \
  -e HOLDRIM_OWNER=you@example.org holdrim
```

`my-docs/` needs a `holdrim.json` saying where the pages live. Copy `examples/template/` and edit
— it is a template with eleven sections: kinds, discovery, roles, design system, screens, decisions,
stack, data model, use cases, architecture (C4) and contracts. With Compose, uncomment the
`./my-docs:/content:ro` volume in `compose.yaml` and set `HOLDRIM_SITE=/content`.

## What your page needs

The review panel **switches itself off silently** if any of these is missing. On purpose: better
absent than wrong.

| # | Requirement |
|---|---|
| 1 | an element with class `doc-title__code` holding the page code (`A01`) |
| 2 | a `<main>`. Nothing outside it is reviewable |
| 3 | every block carrying `data-id` **and** `data-code` |
| 4 | `data-code` shaped `section.number` (`1.2`) |
| 5 | the block with `position: relative` in CSS |
| 6 | **everything JavaScript injects inside `<main>` marked `data-review-ui`** |
| 7 | the panel: `<script type="module" src="/engine/web/panel-react.js"></script>`, one module |
| 8 | `panel.css` |

Number 6 is the one that hurts when forgotten: injected text enters the fingerprint and knocks down
**every** approval on the page at once, with no error at all.
`examples/hello-world/pages/A01.html` has it commented at the exact place it happens.

**A page runs the panel and nothing else.** It is served with a Content-Security-Policy whose
nonce only the tag in row 7 carries, so any other `<script>`, an `onclick=`, a `<base>` — whatever
a person or an agent writes into the content — is refused by the browser. A script in a page would
run with the reader's session, and for the owner that is an approval in their name. See
[`SECURITY.md`](SECURITY.md).

## Kinds of content

Every reviewable piece is of one kind, and each kind knows what it demands of itself.

| Kind | Demands | Why |
|---|---|---|
| `image` | an `alt` | text inside an image never enters the fingerprint; the description is its only reviewable part |
| `diagram` | to be text, not an image | a PNG has no useful fingerprint: recompressing changes the bytes without changing the meaning |
| `table` | a header row | without `<th>` the table is unreadable by a screen reader |
| `decision` | an owner and a deadline (`data-owner`, `data-deadline`) | without them it is not a pending decision, it is a lost one |
| `colors` | the value | "primary blue" is not a value; `#2E6E5B` is |
| `list` | two items | a one-item list is a paragraph in bad clothing |
| `rule` | the test that defends it (`data-proof`) | a rule nobody proved is a rule nobody can check |

Plus `title`, `subtitle`, `text`, `box`, `config`, `contract`, `model` and `rationale` — fifteen in
all, in `engine/core/kinds.js`. A kind never changes who approves or how the fingerprint is
computed — only what is demanded before a block counts as ready.

## How it is stored

Nothing is erased. Every ✓, every request, every rejection becomes a new event with author and
timestamp. The database refuses `UPDATE` and `DELETE` — through triggers, not through discipline.
The one thing that can go is an event's own `text` or `snapshot`, held apart in its own table, and
even that only as a recorded removal: `removeText` deletes the row and writes a `text_removed` event
naming who and when, in the same transaction, so what changed is never silent.

Events live in a SQLite file on the `/data` volume by default (`HOLDRIM_EVENTS_PATH`). The same
interface, `EventStore` in `engine/api/types.ts`, already takes Firestore (`HOLDRIM_EVENTS=firestore`);
Postgres or MySQL is one more implementation of it.

There is also an **index** — blocks, kinds, dependencies, issues — rebuilt on demand. That one is
*not* truth and can be deleted without loss: the truth is the file, versioned in git, which is what
has diffs, history and authorship.

## Asking for what is missing

Anyone signed in can ask for a page that does not exist yet, in their own words: from the project
home ("Ask for a page", a plain form next to the page it belongs near) or from any block's panel
(the "Ask for a new page" category). It is a request like any other: the owner triages it, and
`holdrim apply` hands it to the owner's own agent, which writes one new page shaped like its
neighbour and marks nothing as validated. The owner reads it and approves it — or does not.

## Who can get in

With password sign-in, the owner and the admins manage people at `/engine/people`, linked from the
project home: give someone access, hand out a new password, take an access away and give it back.
A generated password is shown **once**, on that screen, and is never written to a log. Nobody is
ever deleted — an approval is signed by an e-mail, and deleting the person would leave a ✓ with no
owner — so an access is taken away instead, and the name stays on everything it signed.

Behind an identity proxy there is no such screen: people live in the proxy.

## Where the users live

The people who log in are stored separately from the events, and the storage is **pluggable**, the
way Keycloak's is: a file to run it on a laptop, a real database for a deployment whose instances
come and go. One variable, `HOLDRIM_USERS`:

| `HOLDRIM_USERS` | Where people and sessions go |
|---|---|
| *(not set)* | SQLite, at `HOLDRIM_USERS_PATH` or `./data/users.db` (the image sets `/data/users.db`) |
| `sqlite:/data/users.db` | SQLite in that file |
| `firestore` | Firestore, in the project named by `HOLDRIM_PROJECT` |
| `postgres://user:pass@host/db` | Postgres. `postgresql://…` works too |

Postgres needs the `pg` package and Firestore needs `@google-cloud/firestore`, and both are
**optional** dependencies: an install where one cannot be built does not fail, and each is imported
only when a `postgres://` URL or `firestore` is configured. Nobody running on SQLite loads a driver
they will never open — or carries its advisories. The HTTP contract boots every server with a hook
that fails the boot if either is loaded on a path that does not need it.

> ⚠️ **On Cloud Run, do not leave this on SQLite.** The disk there is ephemeral and per instance:
> an access created today disappears when the platform recycles the instance, with **no error and
> no log**. The person whose account was created simply stops getting in, and nobody connects the
> two events. Use `firestore` or `postgres://…`.
>
> The service says so itself: when it starts on a runtime that looks ephemeral (`K_SERVICE`,
> which Cloud Run sets) with people kept in a file, it logs a `WARNING` naming what will be lost
> and what to set instead. It **warns and starts** — the configuration works, it just forgets
> people, and refusing to come up would be a worse surprise.

All three implementations are checked by **the same suite**,
`engine/tests/users-conformance.test.js`. A store that does not pass it is not supported. In CI all
three run, against a real Postgres and the Firestore emulator. On a machine without them, the suite
names what it could not reach instead of passing quietly.

## The tool

```bash
docker run --rm -v "$PWD:/work" -w /work --user "$(id -u):$(id -g)" holdrim \
  node /app/engine/cli/holdrim.ts lights
```

From a clone of this repository it is `npm run cli -- lights`, or
`node engine/cli/holdrim.ts lights --root examples/hello-world` to point it at a project elsewhere.

| Command | What it does |
|---|---|
| `lights` | the state of the whole documentation: 🟢 🟡 🔴 ⚪ |
| `if-i-touch <id>` | what will need checking if you edit this |
| `graph --json\|--mermaid\|--dot` | the dependency graph the traffic light reads, for a script or a diagram |
| `index` | rebuilds the index: kinds, dependencies, what is missing |
| `sync` | pulls in the ✓ given on the site |
| `list` | approved requests, waiting to be applied |
| `show <id>` | the request, the text then, and the text now |
| `impact <id>` | where else the subject shows up, and what is validated |
| `apply <id>` | hands the request to **your** agent CLI — Claude Code, Codex, Gemini |
| `state <id> applied "msg" --commit <sha>` | closes the loop, naming the commit that carried the change |
| `check` | a validated block that changed, and an approval with no trail |
| `kinds` | the catalogue of content kinds |
| `export <folder>` | the documentation as plain static pages, without the panel, for a public host |

`list`, `show`, `sync` and the rest of the request commands need to know where the events are:
`--local` against `bash engine/run-local.sh`, `--db <file>` for a SQLite events file, or
`cloud.project` in `holdrim.json` for Firestore. `state` writes, and writes only through the server:
`HOLDRIM_URL` names it, and `HOLDRIM_AGENT_TOKEN` carries the token the owner issued the agent on the
people screen. Run it with no command for the full help.

**The engine calls no model and holds no API key.** `apply` writes a brief and hands it to whichever
agent CLI the person already has, running with their own account. Nothing here runs unattended on
somebody's subscription.

The separation of powers is tested: **the agent applies, but refuses to approve.** Triage belongs to
whoever owns the documentation.

## Publishing it

Reviewing needs the engine: a session, the events, the panel. Reading does not, and some
documentation is meant for anyone — an open-source project's site, a public API's contract.
`holdrim export public` copies what a reader needs into a new or empty folder, ready for any static
host: pages, stylesheets, images and fonts, with the panel's tags taken out. Everything else stays
home by rule, not by list — the config, the approvals registry, a `.env`, a database. A link is
not followed, and nothing is ever deleted to make room.

`site/` is Holdrim's own site, written as a Holdrim project: every sentence on it is a block the
owner approves, and it is published the same way.

## Language

The engine ships **English, Portuguese and Spanish** (`engine/locales/`). Messages the reviewer
reads go through `engine/core/i18n.js`, so adding a fourth is copying one file — see
`engine/locales/README.md`.

The **login screen** is in there too. The server renders its text before sending the page, so there
is no untranslated flash and the labels are there with JavaScript off. The language control sits
beside the product name on that screen, and it works with JavaScript off as well: it is a form that
submits a `GET /language`. The choice is kept in a cookie and **beats the browser's `Accept-Language`** —
it is the only one the person made on purpose. With neither, the project's default: set `language`
in `holdrim.json` (or `HOLDRIM_LANGUAGE`); with none of the three, English.

The **review panel** speaks the same language. It asks the server first (`/api/me` says which), so
the choice made on the sign-in screen holds on every page, and fetches that one dictionary from
`/engine/locales/` before drawing anything. English travels in the panel itself, as the fallback;
every other language is the folder's, so the one you add by copying a file reaches the panel too.

Logs stay English always: a log is evidence, and evidence that changes wording by locale cannot be
grepped.

## Theme

The engine ships a complete look and the **project** dresses it, the way a Keycloak theme dresses
Keycloak. One optional block in `holdrim.json`, all three keys optional:

```json
"theme": { "brand": "#0B5FA5", "logo": "theme/logo.svg", "name": "Handbook · Product" }
```

- `brand` — the brand colour (or `HOLDRIM_THEME_BRAND`). **Hex only**, three or six digits. Anything
  else is refused, the engine default is used instead, and the refusal is logged: a value from a
  config file ends up inside a stylesheet, and `red; } body { display: none } /*` is what happens
  to whoever interpolates it raw.
- `logo` — a path inside the project (`svg`, `png`, `webp`, `jpg`, `gif`, up to 64 KiB). The server
  **reads the file and inlines it**; the browser never fetches the path. The login screen is the
  one page served without a session, so a linked image there would be redirected to the login
  screen. Without a logo, the name is shown.
- `name` — what to call the product on the sign-in screen. Defaults to the project's own `name`.

**The engine's default is nobody's brand**: a slate lifted from its own neutral ramp, which says
"no brand has been set" rather than asserting one that is not yours. The tokens live in
`engine/web/base.css` — colour, type scale, reading width, spacing, radius, shadow, focus ring and
two breakpoints — and every engine screen composes them. What goes *on* the brand colour is
measured, not assumed: a light brand gets dark text instead of the white that would have made the
button unreadable.

## Feature toggles

`holdrim.json` can turn parts of the engine off, in an optional `features` block — a **closed** list
(`engine/core/features.js`), so a misspelled toggle refuses to start instead of silently doing
nothing:

```json
"features": { "bugCategory": false, "peopleScreen": false }
```

| Toggle | Default | What it gates |
|---|---|---|
| `comments` | on | the panel's "Comment" button, and the server's acceptance of a `comment` event |
| `pageRequests` | on | the home's "ask for a page" form, the panel's `page` category, and a request categorised `page` |
| `bugCategory` | on | the panel's "Report a bug" category, and a request categorised `bug` |
| `peopleScreen` | on | the people-management screen and its link in the nav |
| `graph` | on | `holdrim graph` |
| `voice` | off | not built yet — the key exists so a project can name it today |
| `sketch` | off | not built yet, same reasoning |

A toggle only ever hides or refuses a FEATURE, never a guard: turning `peopleScreen` off hides the
screen, and the `/api/users*` routes behind it keep every rule they always had — who may create,
reset or disable an access is unaffected. The panel obeys the same toggles: `/api/me` sends it
`comments`, `pageRequests` and `bugCategory`, and it draws no control a project has turned off, so
nobody types into a form the server would then refuse (docs/ROLES.md, "The front end obeys the
server"). `docs/ROLES.md`, section 7, is the design; `bash engine/test-contract.sh` runs every
server-gated toggle on and off against a real server.

## Design documents

The design behind the engine, not repeated here:

| Document | What is in it |
|---|---|
| `docs/METHOD.md` | what exists today — the method, written down straight |
| `docs/GLOSSARY.md` | every term, as the code spells it |
| `docs/VISION.md` | where this is going, and what the agent does and never does |
| `docs/IMPACT.md` | the funnel that decides who has to look at a change: silent, agent, or person |
| `docs/BUGS.md` | a bug report treated as documentation catching up with behaviour, not a ticket |
| `docs/PRIOR-ART.md` | the field this belongs to — DOORS, Jama, Polarion, Swimm — and what is actually new here |
| `docs/LAYERS.md` | the Fundamental and the Application, and why one lock covers both |
| `docs/PRIVACY.md` | what is kept about people, and how a person is removed without breaking the trail |

Each opens with a design date and closes with an honest built / not-built table — read those before
assuming a section describes running code.

## What does not work yet

Honest, as of `2026-09-22`:

- **Generation.** Today a human writes and the tool keeps it honest. The intent is a first draft
  written from the business by the person's **own** agent, the same way `apply` works, and the human
  correcting — never by a model the engine calls.
- **Generated diagrams.** Diagrams are text and enter the lock, but nothing produces them yet.
- **A public image.** Every version tag publishes the image to this repository's container registry,
  `ghcr.io/holdrim/holdrim-core`, with provenance and an SBOM attached. While the repository is private,
  so is the image, and pulling it needs a GitHub login with access; the commands above build it from
  the repository instead.
- **Identity beyond password and an identity proxy.** OIDC, Google and LDAP are missing; the switch
  (`HOLDRIM_IDENTITY`) is there, the piece is not.
- **SQLite loses users on Cloud Run.** Not a bug to fix — a property of the platform. The disk is
  ephemeral and per instance, so `users.db` goes away with the instance, silently. The fix is
  configuration (`HOLDRIM_USERS=postgres://…` or `firestore`); the service warns about it at start,
  and does not refuse to come up, on purpose.
- **Nothing is erased, in Firestore, by the code alone.** SQLite refuses `UPDATE` and `DELETE` by
  trigger; Firestore's store only ever creates events, and CI's `stores` job runs every event store,
  Firestore's included, against one conformance suite on the emulator. The one delete the code itself
  issues is a text document, and only through `removeText`, which pairs it with a `text_removed`
  event in the same transaction — an adopter who hands the service create-only IAM would be taking
  away the one operation it legitimately needs. Beyond that, the project's IAM still lets someone
  with access delete a document by hand. Locking that is the deployment's to do.

## Licence

MIT. See `LICENSE`.
