# Privacy: what Holdrim keeps about people, and how it lets go

> Design · `2026-09-23` · decided by the owner, **not built yet**. The table at the end says what
> exists. All of it ships in 0.1.0, because a format changed after the first release is a format
> every adopter's history already holds.

## The problem

"Nothing is erased" is what makes an approval evidence: every ✓, request and comment is a new
event, and no event is ever altered or deleted. Today every event also carries the e-mail of the
person who made it, and the text they wrote. So an event log is a log of personal data that can
never shrink — and data protection law (LGPD in Brazil, GDPR in Europe) gives a person the right to
have their data eliminated. A comment that mentions a patient, a CPF typed into a request, the
e-mail of someone who left the company: today there is no way to remove any of it without breaking
the one guarantee the product rests on.

Holdrim is software. The project that runs it is the controller of the data and chooses the legal
basis. What the engine owes that project is a map of what it keeps and a way to let go of it that
does not break the trail.

## The idea in one sentence

**The facts stay; the person and what they wrote can go.** Who did what, when, to which text, is
the trail, and it is kept. The e-mail behind "who" and the words of a comment are personal data,
and they live outside the trail, where they can be removed.

## What changes

### 1. An event names its author by an id, not an e-mail

Every event's `author` becomes an opaque id, random, one per person (`p_` and 24 hex characters).
The id means something only through the **people table**: the id and the e-mail, and nothing else.
It lives next to the events, in the same store, because that is what every reader of events can
reach — the CLI reads a local events file or the cloud directly, and never the accounts. It exists
in every identity mode: behind a proxy a person is added the first time they are seen; with
passwords, when their account is. Names stay where they already are, in the accounts of password
sign-in; the people table does not copy them, so there is one place each fact can disagree with.

Readers go on getting e-mails. Today four places build an event from what is stored: the two stores
the server uses, and the two readers of the CLI — the local events file and the cloud over REST
(`engine/cli/remote.ts`). Each will hand its rows, and the people table's, to one resolver that
all four import, so the rule of what an id means is written once. The panel, the home and the CLI's
output do not change.

The people table can lose an e-mail and can never gain another: the store refuses any change to a
row but emptying it, by trigger where the database allows one. A person whose address changes is a
new person, with a new id. Otherwise a row re-pointed at another address would make every event
behind that id someone else's.

**Why random, and not a hash of the e-mail.** A keyed hash can be recomputed by whoever holds the
key: try an e-mail, compare, and the person is back. That is pseudonymisation, and the law treats
pseudonymous data as personal data still. A random id whose row has been emptied points at nobody.

### 2. What an event means is decided when it is written

Worked out on every read, whether a ✓ is a lock would ask whether its author is the owner **now**
— the server for the panel, `holdrim sync` for the repository, and the cycle the same for "an
admin's request starts triaged". A fact recorded years ago could then change meaning without a single
event changing: the owner hands over, and every ✓ of theirs not yet synced stops being a lock, with
nothing in the trail to say so. An anonymised person would lose it the same way.

So the author's authority is written on the event when the server records it, from the
configuration and the grants in force at that moment, and every reader uses what is written: on a ✓,
whether it is a lock (`data.locks`), and on a request, whether its author could triage it
(`data.authorCouldTriage`) — read by `isLocked` and `authorCouldTriage` in `engine/api/types.ts`. The
role the author acted under is not written yet. Which roles exist, and who may lock, is
`docs/ROLES.md`. A ✓ given by the owner stays the owner's lock after they hand over, after they are
removed, after anything. The owner is still named only by `HOLDRIM_OWNER`, and the server writes the
lock from it: what changes is that authority, once written on a fact, is part of the fact. What that
rests on, and what it does not, is the next section.

### 3. Who can write the store

Every guarantee here — an event never altered, a people row never re-pointed, a role written by the
server from `HOLDRIM_OWNER` — holds against the people who use Holdrim. Against someone who can
write the database directly, it holds only as far as the database is made to hold it:

- **SQLite**, by trigger, and by the file belonging to the server's user.
- **Firestore**, by the code alone. Whoever the project's IAM lets write can write anything, events
  and people included; what they write without the signing key counts for nothing (below).
- **The CLI** (`engine/cli/remote.ts`) no longer writes around the server: every event it records
  goes through `POST /api/events` with the agent's own token, and is held to the same checks, and
  given the same `asAgent`, as any other (`docs/ROLES.md`, section 4). It still READS the cloud and
  the events file directly, which writes nothing. The token itself lives in the user store, beside
  the passwords: the agent's address, a hash of the secret and when it was issued — never the
  secret. The events that record issuing and revoking one name the agent by its person id and the
  token by a public id, never an address.

A role on the event does not widen this: a direct writer could forge the owner's ✓ by writing the
owner's id as its author and `locks:"true"` beside it, since neither is a secret. What closes it is
a **signature** (#50): the server signs each event with a key only it holds — from its environment,
never the store — and every reader, `holdrim sync` included, trusts a written role only on a fact
the server signed, checked against the public keys the deployment names (`HOLDRIM_PUBLIC_KEYS`).
An event a direct writer inserts, or a signed one they change, is shown, marked "not signed by this
server", and decides nothing: no lock, no triage, no request state, no removal, no grant
(`engine/api/signing.ts`; SECURITY.md, "The signing key").

What the signature binds and what it leaves out, on purpose:

- **Bound:** the event's id, type, page, block, fingerprint, its author's person id, its time, its
  `data` — the written role included — and the salted hashes of its `text` and `snapshot`. The
  texts themselves stay outside, in their own table: removing one (section 4) takes its row and its
  salt, and leaves the signed hash untestable against a guess, as it must.
- **The people table, by a seal of its own on each row**, never by the event: an address signed
  into an event could never be emptied, and a keyed hash of it would be the pseudonymisation
  section 1 rejects. Each row carries a seal over its id and its address (`sealPerson`,
  `engine/api/signing.ts`), made with the same key when the row is made — in SQLite a column beside
  the row, in Firestore a field on the row and on its pointer. Forgetting empties the seal with the
  address, so nothing is left that could confirm a guess of it. A row whose seal does not hold for
  its id and address — re-pointed, or inserted, by someone without the key — is nobody: no grant
  reaches it, no request reads as theirs, and their events read as the id, as a forgotten person's
  do (`trustedEmail`, `engine/api/people.ts`); it is said once, by id, CRITICAL. A row with no seal
  at all — every row made before rows were sealed — reads as nobody too, said as a WARNING: sealing
  it afterwards would vouch for whatever was written into it, so nothing does. Removing the person
  (section 5) empties it, and their address is then a new, sealed person.
- **What a signature cannot show** is an event that is gone. Deleting a genuine event leaves nothing
  to check; that needs the events chained in a signed sequence, planned for 0.2.

The store is still part of what a deployment has to guard — a writer can delete, and can delay — but
it is no longer where authority can be written.

### 4. Free text lives outside the trail

The text of a request, a comment, a reply or a supplement, and the `snapshot` of the block at the
moment of an event, move out of the event into a table of texts, one row per event and field. The
event keeps a salted hash of each text; the salt lives with the text.

- While the text is there, the hash proves it is the text that was recorded.
- When the text is removed, the salt goes with it, so the hash can no longer be tested against a
  guess — a CPF has few enough possibilities that an unsalted hash of it would be the CPF.
- Every removal is itself an event. A reader is told a text was removed, when and by whom; a text
  that is missing with no such event is shown as missing, which is what tampering looks like.

A `snapshot` is not the person's words: it is the block's text at that moment, the documentation's
own. It is kept out of the event for the same reason — it can hold what the documentation should
not have held — but it is removed only on its own account, never because the person who happened
to act on it was removed. It is, with the fingerprint, what an approval vouches for.

The documentation's own text lives in the project's repository, and removing a sentence from it is a
commit, with its own history.

### 5. Removing a person: anonymised, never deleted

"People are disabled, never deleted" stays. The owner has one more step, at the person's request, on
the settings screen — "Remove a person" (`engine/api/person-removal.ts`): the person's address, a
box ticked to confirm they asked, and one button.

- the person's row in the people table keeps its id and loses its e-mail;
- their account, under password sign-in, loses its e-mail and name, its password and its open
  sessions. The row stays, closed — disabled, and found by nothing — under a random key that is not
  an address, so the address is free: an account made for it later is a new person, with a new id;
- every `text` they wrote is removed, as above — the snapshots on their events stay;
- every grant of the project's roles in force for them is revoked, by a later `grant_revoked` — the
  grant itself stays in the trail;
- a `person_removed` event, on the page `_people`, records that a person was removed, by whom and
  when — with ids and counts only: the texts removed, those that could not be, the older events
  that still name the address, the grants revoked, and whether there was an account.

Nothing an approval stands on is touched: the event, its fingerprint, its snapshot and the role it
was given with all stay, so a lock stays a lock and says what it locked.

The owner alone does it, from their own session: the owner comes from `HOLDRIM_OWNER`, and an admin
can ask the owner but not act, for the same reason only the owner resets the owner's account. It is
refused, with nothing touched:

- without the box ticked — it cannot be undone;
- for the owner, who has to hand over before leaving;
- for an address `HOLDRIM_ADMINS`, `HOLDRIM_LOCKS` or `HOLDRIM_AGENTS` still names: the deployment
  would go on naming it after the row was emptied. Out of the variable and restarted, first;
- for an address holding an agent token, which would go on writing, as a new person: revoked first;
- for an address with no account and no row in the people table — nobody to remove, which is also
  what a second run answers. When only events from before authors were ids name it, the refusal says
  so: nothing rewrites them, and there is nothing else to let go of.

A text is left where it is, and counted, when it reads as tampered with — a removal beside it would
read as the reason its row is gone, and silence the finding — or when it is held inside its event,
from before texts moved out of events. The screen says how many were left.

**Events from before authors were ids** name the address itself, and nothing rewrites an event. Their
texts are removed where they have a row of their own, and the address stays taken: under password
sign-in the closed account keeps it, emptied, so nobody new becomes the author of those events. The
screen says how many such events there are.

**In what order, and if it stops.** The account is closed first, keyed by its address, so no session
of theirs acts while the rest runs and the address stays taken — under password sign-in, a person
with no account of their own has a closed row written in its place, for the same reason; the grants go before the texts; the
account is emptied before the row is forgotten; and the address is freed only after that. At no point
is the address free while the row still leads to the person. A removal a failure stopped is finished
by running it again, and writes `person_removed` once. If the very last step — freeing the address —
fails, the address stays taken by the emptied account, as it does for older events.

**One removal of a person at a time.** A removal sent twice — a form submitted twice, two tabs, two
server instances — would otherwise run twice side by side, each writing a `person_removed` and each
counting only what it reached first. So a removal first claims the person's id, in the events store
every instance shares (`EventStore.claimRemoval`, `engine/api/person-removal.ts`), and a second one is
refused while the claim holds, saying the removal is already running. The claim is let go of when
the run ends, whether it finished or failed, so a removal a failure stopped is run again at once. A
run whose process died cannot let go of it: the claim lapses two minutes later, and the removal is
run again then. It holds across instances in every deployment: in memory there is only one process,
a SQLite file is shared by every process on the machine, and Firestore decides the claim in a
transaction. A run renews its claim as it goes, and again before closing the account and before
each of its last writes, and stops if another run has taken it over, or if the address no longer
leads to the person; its last steps only ever empty an account a removal closed, never one open at
the address. What it cannot hold is a run that stalls, between a renewal and the write right after
it, for longer than the claim itself: that one write can then land after another run has finished.
Written that late, a `person_removed` is a second one for the person; an account closed that late
can be one somebody new opened at the freed address — closed, not emptied, and theirs to have
reopened; and an address freed that late can be one a later removal, of whoever took the address
next, has closed and is still working on — left free before that person's row is forgotten.

**Behind an identity proxy** there is no account to empty, and Holdrim holds no list of who the proxy
admits: take the address out of the IAP, or whatever Cloud access policy is in front of Holdrim,
before removing the person, not after. Until then their next visit makes them a new person — any
identity that can still reach `POST /api/events` makes a new row the moment it next acts — and the
screen says so. The rest of the removal is the same.

What none of this reaches is listed once, in "What Holdrim cannot remove" below — not repeated here
so the two lists cannot drift apart.

### 6. What the engine writes elsewhere

- **Commits.** The brief that `holdrim apply` hands the agent asks for one trailer, `Request:` with
  the request's id — a commit stays in the project's history for good, and who asked is found from
  the request instead, in the place where it can be removed. A commit made before this change still
  carries a `Requested-by:` with the e-mail; that is in "What Holdrim cannot remove", below.
- **Logs.** Log lines carry the person's id instead of the e-mail wherever there is one. Two
  addresses are the deliberate exceptions: a refused sign-in still logs the address that was typed,
  since that is the line an operator needs to see an attack and there is no person behind it yet;
  and the first-access banner at boot still names the owner, since it is the one line that tells
  whoever is standing at the terminal which address to sign in with — configuration, not a user's
  personal data.
- **Refused sign-ins.** The user store counts wrong passwords per address as it was typed — an
  address with no account here included — and keeps each count under a key derived from the address
  with scrypt and a salt of this deployment's own, never the address itself, for no more than an hour
  and a quarter after the last wrong password. Past ten thousand rows some go, and a row still
  counting towards a wait is never evicted before one that is not. The key is not anonymous: the
  salt lives in the same store, so anyone holding a copy and an address they suspect can find its
  row, one slow derivation per address tried. What it refuses is reading the table as a list of who
  tried to sign in.
- **The repository.** The registry of approvals holds the file, the date, the fingerprint, the
  start of the block's own text and the event's id; the page's `data-validated` holds a date. Neither
  names anybody.

### 7. What changes with it

These describe today's format and move in the same change that replaces it, so no document goes on
describing the old one: `docs/GLOSSARY.md` (the event fields `author`, `text` and `snapshot`, and
**disabled**, which says a person cannot be removed), `docs/METHOD.md` (the commit trailers of the
request cycle), `docs/BUGS.md` (why the trailer carries the person), and, in `AGENTS.md`, the
invariants "Nothing is erased" and "Only the owner's ✓ becomes a lock" — the second in the words
`docs/ROLES.md` section 3 gives it.

## What Holdrim cannot remove

Said here so nobody promises it:

- the project's git history — a commit made before `Requested-by:` went keeps the e-mail;
- an exported copy of the documentation, once published;
- log lines already shipped to a collector, and backups of the database — the operator's retention;
- anything in the documentation text itself, which is the project's content.
- events written before authors were ids: they name the address itself, and keep it. Under password
  sign-in the address stays taken, by the removed person's emptied account;
- a text held inside its event, from before texts moved out of events: it has no row of its own to
  remove.

## What exists today

| Piece | Status |
|---|---|
| Events never altered or deleted (SQLite by trigger) | ✅ built |
| People disabled, never deleted | ✅ built |
| `author` as an opaque id, a people table in every mode, one resolver | ✅ built — a person gets their row the first time they act |
| On a ✓ whether it is a lock, and on a request whether its author could triage it, written on the event, never recomputed | ✅ built — `data.locks` and `data.authorCouldTriage`, read by `isLocked` and `authorCouldTriage` (`engine/api/types.ts`) |
| The author's role written on the event | ⬜ 0.1.0 |
| Free text and snapshot outside the event, salted hash inside, removals as events | ✅ built — `EventStore.removeText`, reached by removing a person (section 5), never through `POST /events` |
| Commits without `Requested-by:`, ids in logs | ✅ built |
| Removing a person, documented procedure | ✅ built — section 5 |
| Removing a person, from a screen | ✅ built (#37) — the settings screen, the owner's alone (`engine/api/person-removal.ts`); section 5 |
| Events signed by the server, and readers that trust only signed roles | ✅ built (#50) — `engine/api/signing.ts`; every store seals on write and verifies on read, the CLI's readers too; section 3 |
| A signed sequence, so a deleted event shows | ⬜ 0.2 |
| The agent writing through the API with its own credential, and no direct write to the cloud | ✅ built (#122) — `docs/ROLES.md` §4 |
