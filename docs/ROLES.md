# Roles: who may do what, set by the project

> Design · `2026-09-24` · **nothing here is built yet; it is what 0.1.0 builds** (phase B of the
> roadmap). It takes over the earlier draft on groups, whose question — who reviews which part —
> becomes one case of this one. The table at the end says what exists.

## The problem

Today there are three kinds of person, fixed in the engine (`engine/core/roles.js`): the **owner**
(exactly one), **admins**, who may do everything but be the owner, and **everybody else**, who may
read, comment and ask. Only the owner's ✓ becomes a lock.

Real teams do not come in three kinds. A clinic has pharmacists who approve the medication pages and
nothing else; a reviewer from legal who comments and never decides; a lead the owner trusts to
approve like the owner does, so that the owner is not the only door every text goes through. Today
each of them is either an admin — and may decide everything — or nobody.

## The idea in one sentence

**A role is a named set of capabilities, optionally limited to some pages; the owner defines the
roles and who holds them; the engine asks about capabilities and never about names; and a ✓ becomes
a lock only from someone who held the one capability that only the owner grants.**

## What changes

### 1. Capabilities are the engine's, roles are the project's

The engine already speaks in capabilities (`canApprove`, `canTriage`) and never in a role's name.
This makes the list explicit and closed — a project cannot invent a capability, only combine them:

| Capability | What it lets a person do |
|---|---|
| `read` | see the documentation and its lights |
| `comment` | leave a remark that asks for nothing |
| `request` | ask for a change, and add to their own request |
| `triage` | decide a request: approve it, reject it, ask its author |
| `approve` | give a ✓ to a block — recorded, shown as theirs, not a lock |
| `lock` | give a ✓ that **is** a lock. Implies `approve`. |
| `people` | create accesses, hand out passwords, disable and re-enable, grant roles that carry no `lock` — never the owner's account, never to themselves |

A role is a name and a subset of that list. Three roles ship, and they are today's behaviour
exactly, so a project that configures nothing sees nothing change:

| Role | Capabilities |
|---|---|
| `owner` | all, and the acts below that belong to no role |
| `admin` | all but `lock` |
| `member` | `read`, `comment`, `request` |

Some acts belong to no capability and cannot be granted, because granting them is how an attacker
would get them: **defining roles, granting `lock`, resetting or creating the
owner's account, handing over, and removing a person** (`docs/PRIVACY.md`, section 5). They are the
owner's, from `HOLDRIM_OWNER`, and the owner holds every capability whatever the configuration says —
there is no way to configure the owner out of their own project.

### 2. A role can be limited to pages, or to single items

A grant can carry page prefixes, as the earlier groups draft proposed — `P0` covers `P01` to
`P09` — or a list of block ids, for a grant over single items. A pharmacist holds `approver` on
`P`, and nowhere else. Every capability is then asked with the page and the block in hand — "may
this person triage **here**?" — and the server answers; the panel keeps drawing its buttons from
what the server says, and learns nothing about roles.

A request on a block that depends on another page is decided by whoever may triage **the page the
request is on**. The lights already tell the other page's people that something moved under them.

### 3. The lock

The invariant "only the owner's ✓ becomes a lock" becomes:

> **A ✓ is a lock only when its author held `lock` for that page at the moment they gave it. Only the
> owner grants `lock`. An agent never holds it, whatever the configuration says.**

Three things make that hold:

- **Written at the moment, read forever after.** When the server records a ✓, it writes on the event
  whether it is a lock, from the grants in force at that moment. `holdrim sync`, the panel and the
  home read what was written and never recompute it. This is `docs/PRIVACY.md` section 2 — "what an
  event means is decided when it is written" — generalised from three fixed roles to any. Revoking
  someone's `lock` later leaves their past ✓s locks, exactly as an owner's ✓s stay locks after they
  hand over: they were locks when given, and the trail says who could give them.
- **An agent is marked as one.** The identities the CLI writes with (`agent via <account>`) are
  agents by construction, and the engine refuses `approve` and `lock` to them before it looks at any
  grant. An agent may still *close* an impact, as today.
- **Nobody grants what they do not have, and nobody grants to themselves.** Holding `people` lets a
  person manage accesses and grant roles that carry no `lock`, never to themselves; only the owner
  grants `lock`, and only the owner defines roles. Every grant and every revocation is an event, so
  who gave whom what is always in the trail.

### 4. Where the roles live

Two places are possible, and they differ in who can forge a grant.

**A. In `holdrim.json`, in the repository.** A change to who may lock is a commit, reviewed like any
other text, with a history. Forging one takes write access to the repository and a deploy. This is
where the owner already comes from, and where the groups draft put them, for that reason. Its cost:
changing a role takes a commit, not a click.

**B. In the store, as events written from a settings screen.** A click, an immutable trail of every
grant and revocation. Its cost is `docs/PRIVACY.md` section 3: whoever can write the store directly
can write a grant of `lock` to themselves, and nothing tells it from a real one until events are
signed by the server.

**Both, split by what a forgery would buy.**

- **Roles, and every grant that includes `lock`**, live in `holdrim.json`. The settings screen shows
  them, and to change one it hands the owner the exact change to commit.
- **Grants without `lock`** — who is a member, who triages the pharmacy pages — are made on the
  settings screen by the owner or by someone holding `people`, and are recorded as events. The worst a
  forged one buys is a decision that is recorded, shown as its author's, and not a lock.
- When events are signed (`docs/PRIVACY.md`, section 3), `lock` grants can move to the screen too.

### 5. How a person appears

The store names a person by an opaque id, never by e-mail (`docs/PRIVACY.md`, section 1). That is not
configurable: it is what lets a person be removed without rewriting the trail.

What **is** configurable is what a reader sees next to a comment, a request or a ✓:

| `people.show` | A reader sees |
|---|---|
| `name` (default) | the person's name, as the people screen has it |
| `email` | the address |
| `role` | only the role — "Approver" — for projects where reviewers must not know who decided |
| `id` | the opaque id — for audits that must not see names |

The owner and whoever holds `people` always see the name, because they are the ones who answer a
person's request to be removed. It is set in `holdrim.json` and shown on the settings screen; it
decides nothing, so it may be edited there too.

### 6. Feature toggles

`holdrim.json` gains `features`: a closed list the engine knows, each with a default that is today's
behaviour. An unknown key refuses to start, as an invalid theme colour does — a toggle misspelled is
a toggle that silently did nothing. First candidates: `comments`, `pageRequests`, `bugCategory`,
`peopleScreen`.

Two rules keep toggles from becoming a hole:

- **A toggle never turns off a guard.** Locks, the owner's powers, "nothing is erased", the theme
  validation: none of these is a feature, and none gets a toggle.
- **Every toggle is tested in both states.** A toggle whose "off" nobody ran is a branch nobody
  proved, and the conformance helper that runs each suite with each toggle is part of adding one.

## What stays true

- **Exactly one owner**, from `HOLDRIM_OWNER`. Roles add capabilities to other people; none adds a
  second owner, and none can take a capability from the owner.
- **Nothing is erased.** A grant revoked is an event after the grant, not the grant removed.
- **Configuration is untrusted input.** Role names and page prefixes land in HTML: they are validated
  against a known format, like theme colours.
- **The front end obeys the server.** The panel draws what the server says this person may do on this
  page, and knows no role.

## The attacks this was checked against

| Attempt | What stops it |
|---|---|
| An admin grants themselves `lock` | Granting `lock` belongs to no capability; only the owner, and only in `holdrim.json` |
| Someone with `people` makes themselves an approver | Nobody grants to themselves; a grant to an accomplice is an event, attributed, and never a lock |
| An agent approves its own text | Agents are refused `approve` and `lock` before any grant is read |
| A lock-holder is revoked and their past ✓s are re-read as not locks | The lock is written on the event when given, and never recomputed |
| A direct writer to the store forges a `lock` grant | `lock` grants are not in the store (section 4) |
| A direct writer forges a non-lock grant | Buys a recorded, attributed, non-lock decision; closed for good by signed events |
| A role named `<script>` | Names and prefixes validated against a known format |

## What changes with it

In the same pull request that changes the format, as `docs/PRIVACY.md` asks of its own:
`AGENTS.md` (the invariant "Only the owner's ✓ becomes a lock", in the words of section 3),
`docs/GLOSSARY.md` (role, capability, grant, lock), and `engine/core/roles.js`, whose header states
the three fixed roles.

## Open questions

- **Undoing a lock.** Revoking `lock` does not undo past locks. Should the owner be able to mark a
  lock given by someone else as no longer trusted, turning those blocks yellow for re-review?
- **Settings screen for everything but `lock`.** Is handing the owner a change to commit acceptable
  for lock grants, or is the click worth waiting for signed events?
- **Role-only display for the requester.** With `people.show: role`, does a person still see their own
  name on their own requests? (Proposed: yes.)

## Built / not built

| Piece | State |
|---|---|
| Capabilities instead of role names (`canApprove`, `canTriage`) | built |
| Owner and admins, from configuration | built |
| The closed capability list, and roles as sets of it | not built |
| Roles and lock grants in `holdrim.json` | not built |
| Non-lock grants as events, from a settings screen | not built |
| Grants limited to page prefixes | not built |
| The lock written on the event, never recomputed | not built — `docs/PRIVACY.md` section 2 |
| Agents refused `approve` and `lock` by construction | not built |
| `people.show` | not built |
| `features`, with both states tested | not built |
