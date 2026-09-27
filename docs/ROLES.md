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

The engine already speaks in capabilities (`can(capability, who, where)`) and never in a role's name.
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

A role the **project** defines holds any of them but `lock` and `people` (`PROJECT_CAPABILITIES`,
`engine/core/roles.js`). `lock` for the reason above. `people` because its holder creates accounts and
resets passwords: a project role holding it would let whoever the owner granted it to hand out the
very accounts other grants trust, and be an admin in all but name without `HOLDRIM_ADMINS` naming
them. Its name is lower-case words of letters, digits and `-`, never one of the three this version
ships (`isValidRoleName`).

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

**A request skips or passes triage only by someone who could have triaged it wherever it may
reach; a scoped triager never decides their own.** Could-have-triaged-it-anywhere means may triage
everywhere: the owner, an admin, or a project grant with no scope. A grant limited to some pages or
blocks lets its holder decide other people's requests there, while their own requests — even on a
page inside the scope, from the panel or from the home's form — start at triage like anybody's and
wait for someone else to decide them. Two checks hold it: the starting state is written from
`can('triage', author, EVERYWHERE)` when the request is filed (section 3), and deciding a request
that is the asker's own asks `triage` everywhere too (`mayTriage`, `engine/api/here.ts`), which also
leaves the panel and the home offering them nothing to press on it.

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
  author could triage everywhere at that moment (section 2) — is written on the request when it is filed, and
  never recomputed from what its author may do later: recomputed on every read, granting someone
  triage would silently decide every open request of theirs, with no triage event written. A request filed before the field existed reads as at triage:
missing, the field fails closed, and no request's starting state is derived from its author's
current authority after 0.1.0. The
  panel, the home and `holdrim sync` read what was written and never recompute it — this is
  `docs/PRIVACY.md` section 2, whose role field it extends with the lock bit. Removing someone from
  `HOLDRIM_LOCKS` leaves their past ✓s locks, as an owner's ✓s stay locks after they hand over: they
  were locks when given, and the trail says who could give them.

### 4. An agent never gives a ✓

Refusing an agent by the name it writes is not enough: the name `agent via <account>` the CLI's old
direct write chose for itself was the CLI's to choose, and an agent that reaches the server another
way arrives as whoever it borrowed from. So:

- **Who is an agent is set by the deployment, in `HOLDRIM_AGENTS`**, next to `HOLDRIM_LOCKS`:
  addresses separated by `;`, checked as strictly as a `HOLDRIM_LOCKS` entry, read from the
  environment only (a `holdrim.json` naming `agents` refuses to start, since the file is what the
  agent applying a request can edit). Being an agent is a property of the identity, like being the
  owner, never a capability a role grants or withholds.
- **An agent never holds `triage`, `approve`, `lock` or `people`**, whatever else it is granted.
  `can` asks whether the identity is an agent FIRST, before `isOwner`, `HOLDRIM_ADMINS` or any
  role's capabilities, so no grant is read for those four at all. What an agent keeps is `read`,
  `comment`, `request`, and moving a request through the states the agent owns (`applying`,
  `waiting`, `applied`). A request it files starts at triage, since `authorCouldTriage` is written
  from `can('triage', …)`.
- **A grant that names an agent refuses to start.** `HOLDRIM_OWNER`, `HOLDRIM_ADMINS` or
  `HOLDRIM_LOCKS` naming an address `HOLDRIM_AGENTS` also names stops the service and every CLI
  command, from `rolesOf`, the one resolution both share. `can` still denies on its own, so either
  layer holds if the other is ever broken, and each has a test that fails without it.
- **Every event says whether its author was an agent.** `recordEvent` writes `data.asAgent`
  (`"true"` or `"false"`) on every event from the identity the server saw, replacing whatever the
  client sent — written at the moment, read forever after, like `locks` in section 3.
- **An agent has a credential of its own (#122)** — a token the owner issues on the people screen,
  so the server knows an agent by how it signed in, not only by an address the deployment listed.
  It is a second source of the same identity flag `can` already asks: `roles.isAgent` answers true
  for whoever comes in with one, whatever its address, and `isOwner` answers false. Only the owner
  issues and revokes one — the `people` capability does not reach it. One token per address:
  issuing again revokes the previous one at once. A token does not expire; it lasts until it is
  revoked, and the people screen says when it was issued. The owner's address cannot be issued one,
  nor an admin's or a lock-holder's, for the reason a grant cannot name an address `HOLDRIM_AGENTS`
  marks; a token whose address becomes the owner's after a restart opens nothing at all, and one
  whose address becomes an admin's reads as a member. An address is a person's or an agent's, never
  both: no token is issued for an address with an account, disabled or not, and no account is
  created for an address holding one — each store decides it in the same per-address turn as the
  write, so neither can be raced into existing beside the other. Issuing
  and revoking are events, `agent_token_issued` and `agent_token_revoked`, written only by the
  owner's own routes (`POST /events` refuses both), naming the agent by its person id.
- **The token opens the API's event routes, and nothing else.** No account route, no token route,
  no screen: a page, the home and the people screen still want a session. It is shown once, when
  it is issued, and kept as a hash (`engine/api/users.ts`). A request that carries a session and a
  token at once is refused rather than resolved to either, since whichever won would be wrong for
  somebody. With it the CLI writes only through `POST /api/events` (`HOLDRIM_AGENT_TOKEN`, at
  `HOLDRIM_URL`, over https or to this machine only, and never to `--local`'s runner), and its
  direct path to the cloud is gone (`docs/PRIVACY.md`, section 3). Tokens
  live in the user store, so they exist under password sign-in only; behind an identity proxy,
  where people live in the proxy, an agent is marked by `HOLDRIM_AGENTS` alone.
- **A ✓ is given in an interactive session** — a person signed in, in a browser — never with a
  token. A ✓ sent with a token is refused outright, the owner's or an admin's address included,
  asked on how the request signed in before any capability is read (`refusalOf`,
  `engine/api/server.ts`).
- **What remains open, said plainly:** an agent that signs in with a password, under an address
  `HOLDRIM_AGENTS` does not name, is still that person to the server — the token marks an agent that
  uses it, not one that avoids it. And an agent running on a person's machine that reuses that
  person's signed-in browser session is, to the server, that person. Nothing in 0.1.0 tells them
  apart, and the method's answer until signed events and a second factor exist (phase E) is the one
  it has always had: the ✓ is the person's, given with their session, and they are answerable for it.

### 5. Where everything lives

| What | Where | Who changes it | Why there |
|---|---|---|---|
| The owner | `HOLDRIM_OWNER` | whoever deploys | today's rule |
| Who holds `admin` | `HOLDRIM_ADMINS` | whoever deploys | it exists before anyone signs in |
| Who holds `lock`, and where | `HOLDRIM_LOCKS` | whoever deploys | a forgery must not reach a lock |
| Who is an agent | `HOLDRIM_AGENTS` | whoever deploys | the agent can edit the repository, never the deployment |
| Role definitions | events, from the settings screen | the owner | a click, with a trail |
| Grants of the project's roles | events, from the settings screen | the owner | a click, with a trail |
| How a person appears, feature toggles | `holdrim.json` | the repository | decide nothing about authority |

Roles and grants are events on the reserved page `_roles` (`engine/api/role-grants.ts`), written by
the owner's own routes — `POST /api/roles`, `POST /api/grants` and `POST /api/grants/<id>/revoke`, and
the settings screen's forms, which call the same functions — and by nothing else: `role_defined`,
`role_granted` and `grant_revoked` are not in `EVENT_TYPES`, so `POST /api/events` refuses all three.

- **Only the owner** defines, grants and revokes: not an admin, and not a holder of `people`, who
  could otherwise make themselves or an accomplice an approver. Only the owner opens the screen.
- **Redefined in place.** Defining a role that exists replaces it: the latest `role_defined` is the
  role, every grant of it holds the new capabilities from the next request, and every earlier
  definition stays in the trail.
- **A grant names a person by id**, never by address (`docs/PRIVACY.md`, section 1), with one role
  and one scope — a page, a family or a block — or none, for everywhere. The owner, an admin and an
  agent are never grantees: the owner is not a role, an admin already holds everything a project
  role could add, and an agent is never granted what a person is.
- **Revoking is a later event** naming the grant; the grant itself stays. Nothing is erased.
- **A scope reaches something.** A grant's scope is refused when it reaches no page and no block of
  the site, measured as the lock composer measures one (`lockCoverage`).
- **Read per request.** The server folds the `_roles` events on every signed-in request (`rolesAt`,
  `engine/api/server.ts`) and asks `can` with those grants in force, so a grant counts from the next
  request after it is given, and stops from the next request after it is revoked, on every instance
  at once. Each request reads the page once — a grant reads it once more, right before it writes, to
  narrow the window in which two identical grants both pass — with `listBare`: one query of that page alone, with no
  people or texts joined, plus one look-up of the viewer's person id when any grant is in force —
  the cost every signed-in request pays, growing with the number of `_roles` events, not with the
  rest of the store. It fails closed: a store that cannot be read answers the request with a 500,
  never as though no grant existed, which for a revocation would be the wrong way round. What a ✓ or a request was given under is written on it at that moment (section 3) and never
  re-read from the grants: a ✓ given under a grant stays exactly what it was written as — never a
  lock, since no grant reaches `lock` — after the grant is revoked.
- **A stored grant naming an agent is ignored and logged** — an address `HOLDRIM_AGENTS` marks, or
  one holding an agent token. It is logged once per grant (`role_grant_ignored`), on the agent's first
  request after start that reads it, not at start itself, and whether or not its role holds anything;
  the settings screen marks it ignored. The service starts anyway: such a grant comes about by a
  restart that marks the address as an agent after the grant, by an agent token issued for the
  address later, or by a direct write, and refusing to start would let anyone able to write the
  store stop the service. `can` refuses an agent `AGENT_NEVER` before any grant is read anyway.
- **Listable by anyone signed in**, through `GET /api/events?page=_roles`, as the agent tokens'
  events are on `_agent_tokens`: who may do what is not a secret from the people it applies to.

They carry `docs/PRIVACY.md` section 3's caveat: a direct writer to the store can forge one. What
that buys is bounded — a role or grant without `lock` or `people`, since the reader checks every
definition again and a forged one holding either reads as holding nothing; so a recorded, attributed
decision that is never a lock, and never `people` over anyone's account. Signed events (phase E)
close it.

### 6. How a person appears

The store names a person by an opaque id, never by e-mail (`docs/PRIVACY.md`, section 1). That is not
configurable: it is what lets a person be removed without rewriting the trail.

What **is** configurable is what a reader is sent next to a comment, a request or a ✓. The server
applies it before the data leaves: a reader who may not see names never receives them.

| `people.show` | A reader is sent |
|---|---|
| `name` | the person's name, or their e-mail when they have no name |
| `email` (default) | the address, today's behaviour |
| `role` | the person's current role — Owner, Admin or Member — looked up the same way `roles.roleOf` answers it anywhere else; localized for the panel and the home, the raw English key for the CLI |
| `id` | the opaque id — for audits that must not see names |

Only the three shipped roles are shown: a project role a person holds through a grant is not, since
it may hold only on some pages, and one word next to a comment could not say where. Nothing writes
the role an event's author acted under onto the event itself, so `role` reads a
person's role today, not the one they held at the time — a promotion or a demotion changes what
every past event of theirs is shown as. Once an event carries that role, `role` will read it from
there instead.

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
| An agent triages, or files a request that starts approved | `can` refuses an agent `triage` before any grant is read, and the starting state written on its requests is therefore always triage |
| Granting someone triage decides their open requests after the fact | A request's starting state is written when it is filed and never recomputed |
| An admin resets an unguarded account, then changes its password through the self-service route | The test reads the whole history: the latest issuance or reset by anyone but the person must be the owner's |
| An admin keeps a session open across the owner's re-issue of a lock-holder's password | A lock needs a session opened with a credential the person set after the owner's latest issuance; each issuance drops every session |
| A direct writer to the store writes a ✓ with the lock bit set | Nothing stops it before signed events, exactly as for the owner's ✓ today (`docs/PRIVACY.md` §3); phase E closes it |
| A commit renumbers a page into a lock-holder's scope | Not closed by design: the repository decides what a code means. Start logs each scope's coverage and refuses a scope that matches no page; the renumbering itself is a reviewed change |
| An admin resets a lock-holder's password and signs in as them | Their accounts are the owner's to reset, create, disable and re-enable, on all four routes |
| An admin disables a lock-holder to silence their ✓ right when it would matter | The same four routes: disabling one is the owner's alone too |
| An admin probes candidate addresses to reconstruct the `HOLDRIM_LOCKS` list from which ones 409 | Not stopped, and not meant to be: the 409 itself already shows an address is reserved. What the refusal withholds is only the MECHANISM — that the reservation is `HOLDRIM_LOCKS` specifically — which is acceptable because the lock markers already in the event history name the holders anyway |
| Someone with `people` makes themselves or an accomplice an approver | Only the owner grants roles |
| The owner grants a project role holding `people`, and its holder hands out approvers' accounts | A project role cannot hold `people`: refused when it is defined, and read as holding nothing if one is stored anyway |
| A client posts a `role_granted` naming itself | `POST /api/events` refuses the three event types of roles, as it refuses `text_removed` |
| A direct writer to the store forges a grant | Buys a role without `lock` or `people`; closed by signed events |
| A direct writer stores a grant naming an agent, to stop the service at its next start | The grant is ignored and logged, and the service starts; `can` refuses the agent `AGENT_NEVER` before any grant is read |
| A grant is revoked, and a server goes on answering it | Grants are read from the store on every request, never cached; a store that cannot be read fails the request |
| A grant limited to some pages is used to skip triage | A request skips or passes triage only by someone who may triage everywhere; a scoped triager's own requests start at triage and are decided by someone else |
| An agent approves its own text | An identity `HOLDRIM_AGENTS` names, and anyone who comes in with an agent token, is refused any ✓ and any lock by `can`, before any grant is read; a ✓ sent with a token is refused outright, whatever its address. Reuse of a person's session, and an agent signing in with a password under an unlisted address, are the open gaps in section 4 |
| An admin issues an agent token and acts through it | Only the owner issues or revokes one; `people` does not reach it |
| A disabled person's address keeps writing through a token, or an admin gives the agent's address a password | An address is a person's or an agent's, never both: issuing refuses an address with an account, creating an account refuses an address holding a token, both decided in the store's per-address turn (`AddressInUse`, `engine/api/users.ts`) |
| A token outlives its revocation, or its replacement | The token is one row per address, overwritten on re-issue and deleted on revoke, and looked up on every request |
| A copy of the user store hands over working tokens | Only a hash of each secret is stored |
| A misconfigured grant hands an agent a lock: `HOLDRIM_OWNER`, `HOLDRIM_ADMINS` or `HOLDRIM_LOCKS` names it | The service and the CLI refuse to start; and `can` would deny it anyway, the agent check coming before the grant |
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
| Capabilities instead of role names (`can(capability, who, where)`) | built |
| Owner and admins, from configuration | built |
| The closed capability list, and roles as sets of it | built — `engine/core/roles.js`, `CAPABILITIES` and `capabilitiesOf` |
| The scope grammar a grant, and `HOLDRIM_LOCKS`, will be checked against | built (#29) — `isValidScope`, `engine/core/roles.js`, proved both by `HOLDRIM_LOCKS`'s own real use and by its tests. A project role's own NAME grammar came with its first caller, the settings screen below (`isValidRoleName`) |
| `holdrim.json` refusing `roles` and `grants`, like `owner`, `admins` and `locks` | built (#29) — `engine/core/config.js`'s `AUTHORITY_KEYS`. Authority comes from the deployment only; a project's own roles are the owner's to define and grant, from the settings screen below, never a file a committer or the applying agent can edit |
| `HOLDRIM_LOCKS`, parsed and validated at start | built (#29) — `engine/core/roles.js`'s `parseLocks`, validating the address with the same `isEmailAddress` account creation uses (`engine/core/email.js`) |
| Lock-holders' accounts guarded like the owner's, on all four routes | built (#29) — `roles.isLockHolder`, asked by `engine/api/server.ts`'s create, reset, disable and re-enable routes, none of the four messages naming who holds a lock; proved end to end in `engine/test-contract.sh` |
| `can('lock', …)` actually trusting a `HOLDRIM_LOCKS` entry | not built — stays owner-only until the rule below exists; see the comment on `can` |
| The session-and-credential-history rule (a lock only from a session opened with a credential the person set after the owner's latest issuance) | not built |
| The settings screen | built (#36) — `/engine/settings` (`engine/api/settings-page.ts`), the owner's alone: the shipped roles from `SHIPPED_ROLES` and `capabilitiesOf`, who holds what with the variable it comes from and each `HOLDRIM_LOCKS` scope's `lockCoverage`, `features` and `people.show` with their source, the project's own roles and grants (below), and a composer, posted as a form, that answers the full `HOLDRIM_LOCKS` line to set, single-quoted, checked by `isValidScope`, `parseLocks`, `lockCoverage` and `refuseGrantsToAgents` as start checks it, and holding the address to plain characters so the line pastes safely into a shell. The composer writes nothing |
| Roles and grants as events, from the settings screen, by the owner | built (#36) — section 5: `role_defined`, `role_granted` and `grant_revoked` on `_roles` (`engine/api/role-grants.ts`), the owner's routes and the screen's forms, `PROJECT_CAPABILITIES` and `isValidRoleName` (`engine/core/roles.js`), and `rolesAt` handing `withProjectGrants` the grants in force on every request. Lock grants from the screen are not part of it (#54) |
| Scopes actually consulted by `can`, with a page or block in hand | built (#33) — `can(capability, who, where)` refuses to answer without `where` (a page, a block, or `EVERYWHERE`), and reads grants through `scopeCovers` (`engine/core/roles.js`): a page covers its blocks by each block's own page, a family `P0*` the prefix and exactly one character more, a block id that block alone, and a scoped grant never answers `EVERYWHERE`. Every check in `engine/api/server.ts` asks with the place (`engine/api/here.ts`): a ✓ by its block, triage and adding details by the stored request's. `POST /api/here` answers per page and for each block the panel names on it (`blocksAsked`), and the panel draws its ✓, its triage and its "Add details" from it. The shipped roles are unscoped — owner, admins and members name no pages — and a project's own grant carries its scope (section 5); `HOLDRIM_LOCKS` scopes are logged at start and refused when they match no page, and `lock` stays owner-only |
| The lock written on the event, never recomputed | built — `data.locks`, written by `recordEvent` and read by `isLocked` (`engine/api/types.ts`); the author's role is not written yet (`docs/PRIVACY.md` section 2) |
| Agents marked by the deployment (`HOLDRIM_AGENTS`), refused `triage`, `approve`, `lock` and `people` before any grant is read | built (#30) — `engine/core/roles.js`'s `parseAgents`, `isAgent`, `AGENT_NEVER` and `can` |
| A grant naming an agent refusing to start, on the server and in the CLI | built (#30) — `refuseGrantsToAgents`, called by `rolesOf`; `holdrim.json` refuses `agents` too |
| Every event marked with whether its author was an agent | built (#30) — `data.asAgent`, written by `recordEvent` (`engine/api/server.ts`), on every event, the CLI's included since it writes through the server (#122) |
| An agent's own credential (a token the owner issues), and the agent writing through the API only | built (#122) — `issueAgentToken`/`fromAgentToken` (`engine/api/users.ts`, all three stores), `agentByToken` (`engine/core/roles.js`), `apiViewerOf` and the `/api/agent-tokens` routes (`engine/api/server.ts`), the people screen, and `Source.add` (`engine/cli/remote.ts`) |
| `people.show`, applied by the server | built (#31) — `engine/core/people-show.js`, `engine/api/server.ts`'s `personDisplay`/`authorDisplaysFor`, `engine/cli/requests.ts`'s `personLabel`. The CLI applies it too, though it can show no name and no id it has no accounts store to look either up in (docs/PRIVACY.md, section 1) — `personLabel` passes `id: null` as well as `name: null`, so both fall back to the address, the same as an event from before ids existed |
| `features`, with both states tested | built — `engine/core/features.js`, `engine/api/server.ts`, `engine/cli/graph.ts`, `engine/web/src/Panel.jsx`, `engine/test-contract.sh` |
