# Roles: who may do what, set by the project

> Design · `2026-09-24` · decided by the owner; phase B of 0.1.0 is building it, piece by piece.
> It takes over the groups draft (removed in the commit that added this file; it is in the history),
> whose question — who reviews which part — becomes one case of this one. The table at the end says
> what exists.

## The problem

Today there are three kinds of person, fixed in the engine (`engine/core/roles.js`): the **owner**
(exactly one), **admins**, who may do everything but be the owner, and **everybody else**, who may
read, comment and ask. Only the owner's ✓ becomes a lock.

Real teams do not come in three kinds. A clinic has pharmacists who decide the requests on the
medication pages and nothing else; a reviewer from legal who comments and never decides; a lead the
owner trusts to approve like the owner does, so that the owner is not the only door every text goes
through. Today each of them is either an admin — and may decide everything — or nobody.

## The idea in one sentence

**A role is a named set of capabilities, optionally limited to some pages or blocks; the deployment
names the owner, the admins and who may lock, and only the owner defines and grants every other role;
the engine asks about capabilities, never about names; and a ✓ is a lock only from someone the
deployment itself names as holding `lock`.**

## What changes

### 1. Capabilities are the engine's, roles are the project's

The engine already speaks in capabilities (`can(capability, email)`) and never in a role's name.
This makes the list explicit and closed — one list, in `engine/core/roles.js`, and a project cannot
invent a capability, only combine them:

| Capability | What it lets a person do |
|---|---|
| `read` | see the documentation and its lights |
| `comment` | leave a remark that asks for nothing |
| `request` | ask for a change, and add to their own request |
| `triage` | decide a request: approve it, reject it, ask its author |
| `approve` | give a ✓ to a block — recorded and shown as theirs, never a lock |
| `people` | create accesses, hand out passwords, disable and re-enable — never the owner's account, never the account of anyone who holds `lock` |
| `lock` | turn a ✓ into the one the repository trusts — never granted like the six above (below) |

`lock` is in the list — `engine/core/roles.js` validates `can('lock', …)` against it exactly as it
validates the other six, so a typo there fails the same way — but it is never part of a GRANTABLE
set: no role a project defines holds it, the owner's `capabilitiesOf` entry does not carry it either,
and asking `can('lock', someone)` never consults a role's capabilities at all. It answers straight
from identity — today, "is this the owner?"; once `HOLDRIM_LOCKS` exists (section 3), "is this the
owner, or is this address in `HOLDRIM_LOCKS` for this block?" — because a capability granted through
a role is exactly the kind of thing an admin, or a future project-defined role, could end up holding
by a table edit, and this is the one answer that must never move that way.

A role is a name and a subset of that list. Two roles ship, and with the owner they are today's
behaviour exactly, so a project that configures nothing sees nothing change: **`admin`** holds every
capability, and **`member`** holds `read`, `comment` and `request`. `HOLDRIM_ADMINS` goes on meaning
what it means today: the people it names hold `admin`. It is a grant made by the deployment, like
`HOLDRIM_OWNER` — the one grant that is not the owner's to make on a screen, because it exists before
anyone can sign in.

**Authority comes from the deployment only.** `HOLDRIM_OWNER`, `HOLDRIM_ADMINS` and the lock-holders
of section 3 are read from the environment and from nowhere else. Today the owner and the admins fall
back to `holdrim.json` when the variable is unset; that fallback goes, and a `holdrim.json` that names
an owner, admins or lock-holders refuses to start. Otherwise any committer — or the agent applying an
approved request — could edit the file and, at the next deploy, name a new owner.

The **owner is not a role** and cannot be granted. The owner comes from `HOLDRIM_OWNER`, holds every
capability and `lock` whatever the configuration says, and alone does what belongs to no capability:
**defining roles, granting them, resetting or creating the owner's account and the account of anyone
who holds `lock`, handing over, and removing a person** (`docs/PRIVACY.md`, section 5).

### 2. A grant can be limited to pages or to blocks

A grant carries a scope: exact page codes (`P03`), a page family written with an explicit wildcard
(`P0*` covers `P01` to `P09` and nothing that merely begins with `P`), or single block ids
(`P03.2.1`). No scope means everywhere. Scopes are validated against those three shapes and nothing
else, since they land in HTML.

Every capability is then asked with the page and the block in hand — "may this person triage
**here**?". The server answers per page: the payload it sends with a page says what the viewer may
do on it and on each of its blocks, and the panel draws its buttons from that and learns nothing
about roles.

A request on a block that depends on another page is decided by whoever may triage **the block the
request is on**. The lights already tell the other page's people that something moved under them.

### 3. The lock

The invariant "only the owner's ✓ becomes a lock" becomes:

> **A ✓ is a lock only when its author held `lock` for that block at the moment they gave it. Who
> holds `lock` besides the owner is set by the deployment, in a variable next to `HOLDRIM_OWNER`
> — `HOLDRIM_LOCKS` below, named for good by the change that builds it — never by the repository,
> the store or a screen. An agent never gives a ✓.**

- **Set where the owner is set.** `HOLDRIM_LOCKS` names people and scopes, for example
  `ana@example.org:P0*; bea@example.org:F12`. It is read at start, by the same hands that set
  `HOLDRIM_OWNER`: whoever configures the server. A committer to the repository cannot grant a lock,
  and an agent applying an approved request cannot. A direct writer to the store cannot grant one
  either, though until signed events they can forge a ✓ that claims to be a lock (the attack table
  below). Changing it
  means restarting the service, which is the point. The addresses stay out of git and out of the
  store; the store sees only ids (`docs/PRIVACY.md`, section 1).
- **Their accounts are guarded like the owner's.** Resetting, creating, disabling and re-enabling the
  account of a person named in `HOLDRIM_LOCKS` belong to the owner alone, on all four routes, the same
  set the `people` capability's own table entry names in section 1 above ("disable and re-enable —
  never … the account of anyone who holds `lock`"). Creating and resetting hand out a password, a lock
  handed out with it; disabling and re-enabling do not, but an admin who could disable a lock-holder
  at will could still silence their ✓ at the exact moment it would matter — round 2 of #29's own review
  found round 1 had guarded only re-enabling. Guarding one route leaves the others open, as `AGENTS.md`
  already says of the owner's. None of the four refusals name `HOLDRIM_LOCKS` or say "holds a lock" —
  but that wording does NOT stop an admin from telling a lock-holder's account apart from an ordinary
  one: the lock-holder check runs before the ordinary conflict, so even the STATUS CODE the refusal
  carries differs, and the refusal necessarily shows the address is reserved regardless of what its
  text says. That is acceptable because the lock markers already in the event history name the
  holders anyway (round 3 of #29's own review, finding 5: round 2's wording overclaimed this). What
  the message withholds is only the MECHANISM — that the reservation comes from `HOLDRIM_LOCKS`
  specifically — never the reservation itself.
- **A lock comes from a session, and it fails closed.** A ✓ is a lock only when the latest
  credential issued or reset for that account by anyone but the person was issued by the owner, and
  the session was opened after it with a credential the person set themselves after that issuance —
  the password the owner hands out opens a session, never a lock, since it passed through other
  hands. The test reads the account's whole credential history, never
  only the current credential: a password the person changes afterwards cannot wash out an admin's
  reset, because the server cannot tell the person from someone holding their password. The store
  records who issued, reset or set each credential; an account with no owner issuance on record —
  every account that predates that record included — gives no lock until the owner issues one. Every issuance by the owner drops all of the account's sessions, and a
  credential created or changed by anyone other than the owner or the person — an admin creating the
  account, or resetting it while it was not yet guarded — leaves it unable to lock until the owner
  issues again. Otherwise an admin could reset an account before its promotion, keep
  a session open across the owner's re-issue, and give locks in the person's name; and "newly named"
  would need a definition that someone taken out of `HOLDRIM_LOCKS` and put back would slip through.
- **One parser, one question.** `HOLDRIM_LOCKS` is parsed once at start, with the addresses normalized by
  the same function the store uses; the account guard and the lock check both ask one function in
  `engine/core/roles.js`, and neither compares strings on its own.
- **Written at the moment, read forever after.** When the server records a ✓, it writes on the event
  the author's authority at that moment: their role, and whether this ✓ is a lock for this block.
  The same holds for a request: the state it starts in — at triage, or already decided because its
  author could triage that block at that moment — is written on the request when it is filed, and
  never recomputed from what its author may do later. Today it is recomputed on every read
  (`engine/core/cycle.js`), so granting someone triage would silently decide every open request of
  theirs, with no triage event written. A request filed before the field existed reads as at triage:
missing, the field fails closed, and no request's starting state is derived from its author's
current authority after 0.1.0. The
  panel, the home and `holdrim sync` read what was written and never recompute it — this is
  `docs/PRIVACY.md` section 2, whose role field it extends with the lock bit. Removing someone from
  `HOLDRIM_LOCKS` leaves their past ✓s locks, as an owner's ✓s stay locks after they hand over: they
  were locks when given, and the trail says who could give them.

### 4. An agent never gives a ✓

Refusing an agent by the name it writes is not enough: `agent via <account>` is chosen by the CLI,
and an agent that reaches the server another way arrives as whoever it borrowed from. So:

- **An agent has a credential of its own**, with a fixed set of capabilities no role can extend:
  `read`, `comment`, `request`, and moving a request through the states the agent owns (`applying`,
  `waiting`, `applied`). Never `triage`, `approve`, `people` or a ✓, whatever its account holds, and a
  request it files always starts at triage — never at the state an admin's request starts in. The CLI's direct path to the cloud goes (`docs/PRIVACY.md`, section 3), and
  the agent writes through the API with that credential.
- **A ✓ that is a lock is given in an interactive session** — a person signed in, in a browser —
  never with a token.
- **What remains open, said plainly:** an agent running on a person's machine that reuses that
  person's signed-in browser session is, to the server, that person. Nothing in 0.1.0 tells them
  apart, and the method's answer until signed events and a second factor exist (phase E) is the one
  it has always had: the ✓ is the person's, given with their session, and they are answerable for it.

### 5. Where everything lives

| What | Where | Who changes it | Why there |
|---|---|---|---|
| The owner | `HOLDRIM_OWNER` | whoever deploys | today's rule |
| Who holds `admin` | `HOLDRIM_ADMINS` | whoever deploys | it exists before anyone signs in |
| Who holds `lock`, and where | `HOLDRIM_LOCKS` | whoever deploys | a forgery must not reach a lock |
| Role definitions | events, from the settings screen | the owner | a click, with a trail |
| Grants of the project's roles | events, from the settings screen | the owner | a click, with a trail |
| How a person appears, feature toggles | `holdrim.json` | the repository | decide nothing about authority |

Roles and grants as events carry `docs/PRIVACY.md` section 3's caveat: a direct writer to the store
can forge one. What that buys is bounded — a role or grant without `lock`, so a recorded, attributed
decision that is never a lock, and never `people` over a lock-holder's account. Signed events
(phase E) close it.

### 6. How a person appears

The store names a person by an opaque id, never by e-mail (`docs/PRIVACY.md`, section 1). That is not
configurable: it is what lets a person be removed without rewriting the trail.

What **is** configurable is what a reader is sent next to a comment, a request or a ✓. The server
applies it before the data leaves: a reader who may not see names never receives them.

| `people.show` | A reader is sent |
|---|---|
| `name` (default) | the person's name, or their e-mail when they have no name |
| `email` | the address |
| `role` | only the role the author acted under, as written on the event — "Approver" |
| `id` | the opaque id — for audits that must not see names |

The owner and whoever holds `people` are always sent names, because they are the ones who answer a
person's request to be removed; and every person is sent their own name on their own requests.

### 7. Feature toggles

`holdrim.json` gains `features`: a closed list the engine knows — one list, next to the capability
list — each with a default that is today's behaviour. An unknown key refuses to start the service:
a toggle misspelled is a toggle that silently did nothing. First candidates: `comments`,
`pageRequests`, `bugCategory`, `peopleScreen`, `voice`, `sketch`, `graph`.

- **A toggle never turns off a guard.** Locks, the owner's powers, "nothing is erased", the theme
  validation: none of these is a feature, and none gets a toggle.
- **Every toggle is tested in both states.** A toggle whose "off" nobody ran is a branch nobody
  proved.

## What stays true

- **Exactly one owner**, from `HOLDRIM_OWNER`. Roles add capabilities to other people; none adds a
  second owner, and none can take a capability from the owner.
- **Nothing is erased.** A grant revoked is an event after the grant, not the grant removed.
- **Configuration is untrusted input.** Role names, scopes and `HOLDRIM_LOCKS` are validated against
  known shapes before anything uses them.
- **The front end obeys the server.** The panel draws what the server says this person may do here.

## The attacks this was checked against

| Attempt | What stops it |
|---|---|
| An admin grants themselves `lock` | `lock` is not granted by anyone in the product: only `HOLDRIM_LOCKS`, set by whoever deploys |
| A committer, or the agent applying an approved request, adds a lock-holder or names a new owner | Authority is read from the environment only, and a `holdrim.json` that names any refuses to start |
| An admin prepares an account before it is promoted, and keeps its session | A credential changed by anyone but the owner or the person leaves the account unable to lock until the owner issues again |
| An agent triages, or files a request that starts approved | Its credential never holds `triage`, and the starting state written on its requests is always triage |
| Granting someone triage decides their open requests after the fact | A request's starting state is written when it is filed and never recomputed |
| An admin resets an unguarded account, then changes its password through the self-service route | The test reads the whole history: the latest issuance or reset by anyone but the person must be the owner's |
| An admin keeps a session open across the owner's re-issue of a lock-holder's password | A lock needs a session opened with a credential the person set after the owner's latest issuance; each issuance drops every session |
| A direct writer to the store writes a ✓ with the lock bit set | Nothing stops it before signed events, exactly as for the owner's ✓ today (`docs/PRIVACY.md` §3); phase E closes it |
| A commit renumbers a page into a lock-holder's scope | Not closed by design: the repository decides what a code means. Start logs each scope's coverage and refuses a scope that matches no page; the renumbering itself is a reviewed change |
| An admin resets a lock-holder's password and signs in as them | Their accounts are the owner's to reset, create, disable and re-enable, on all four routes |
| An admin disables a lock-holder to silence their ✓ right when it would matter | The same four routes: disabling one is the owner's alone too |
| An admin probes candidate addresses to reconstruct the `HOLDRIM_LOCKS` list from which ones 409 | Not stopped, and not meant to be: the 409 itself already shows an address is reserved. What the refusal withholds is only the MECHANISM — that the reservation is `HOLDRIM_LOCKS` specifically — which is acceptable because the lock markers already in the event history name the holders anyway |
| Someone with `people` makes themselves or an accomplice an approver | Only the owner grants roles |
| A direct writer to the store forges a grant | Buys a role without `lock`, never `people` over a lock-holder; closed by signed events |
| An agent approves its own text | An agent's credential is refused for any ✓; a lock ✓ needs an interactive session. Reuse of a person's session is the open gap in section 4 |
| A revoked lock-holder's past ✓s are re-read as not locks | The lock is written on the event when given |
| A scope meant for one page covers others | Scopes are exact, an explicit `*`, or block ids |
| A role named `<script>` | Names and scopes validated against known shapes |

## What changes with it

In the same pull request that changes the format, as `docs/PRIVACY.md` asks of its own: `AGENTS.md`
(the invariant "Only the owner's ✓ becomes a lock", in the words of section 3, which replace the
wording `docs/PRIVACY.md` section 7 proposed for it; "Exactly one owner", to say it comes from the
environment only; and "Nobody but the owner resets or creates the owner's account", extended to
lock-holders and to re-enabling), `docs/GLOSSARY.md` (role, capability, grant, lock),
`engine/core/roles.js`, whose header states the three fixed roles, `engine/core/config.js`, which
loses the file fallback for the owner and the admins, and the templates, which stop shipping an
`owner`.

## Open questions

- **Undoing a lock.** Removing someone from `HOLDRIM_LOCKS` does not undo their past locks. Should the
  owner be able to mark the locks someone gave as no longer trusted, turning those blocks yellow for
  review again?

## Built / not built

| Piece | State |
|---|---|
| Capabilities instead of role names (`can(capability, email)`) | built |
| Owner and admins, from configuration | built |
| The closed capability list, and roles as sets of it | built — `engine/core/roles.js`, `CAPABILITIES` and `capabilitiesOf` |
| The scope grammar a grant, and `HOLDRIM_LOCKS`, will be checked against | built (#29) — `isValidScope`, `engine/core/roles.js`, proved both by `HOLDRIM_LOCKS`'s own real use and by its tests. A project role's own NAME grammar is not built ahead of its first caller any more: a format nothing calls is untested by construction, so it waits for the settings screen below |
| `holdrim.json` refusing `roles` and `grants`, like `owner`, `admins` and `locks` | built (#29) — `engine/core/config.js`'s `AUTHORITY_KEYS`. Authority comes from the deployment only; a project's own roles are the owner's to define and grant, from the settings screen below, never a file a committer or the applying agent can edit |
| `HOLDRIM_LOCKS`, parsed and validated at start | built (#29) — `engine/core/roles.js`'s `parseLocks`, validating the address with the same `isEmailAddress` account creation uses (`engine/core/email.js`) |
| Lock-holders' accounts guarded like the owner's, on all four routes | built (#29) — `roles.isLockHolder`, asked by `engine/api/server.ts`'s create, reset, disable and re-enable routes, none of the four messages naming who holds a lock; proved end to end in `engine/test-contract.sh` |
| `can('lock', …)` actually trusting a `HOLDRIM_LOCKS` entry | not built — stays owner-only until the rule below exists; see the comment on `can` |
| The session-and-credential-history rule (a lock only from a session opened with a credential the person set after the owner's latest issuance) | not built |
| Roles and grants as events, from a settings screen, by the owner | not built |
| Scopes actually consulted by `can`, with a page or block in hand | not built — the grammar is validated (`isValidScope`), nothing reads it yet |
| The lock written on the event, never recomputed | not built — `docs/PRIVACY.md` section 2 |
| An agent's own credential, refused for any ✓ | not built |
| `people.show`, applied by the server | not built |
| `features`, with both states tested | built — `engine/core/features.js`, `engine/api/server.ts`, `engine/cli/graph.ts`, `engine/web/src/Panel.jsx`, `engine/test-contract.sh` |
