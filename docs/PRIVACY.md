# Privacy: what Holdrim keeps about people, and how it lets go

> Design · `2026-09-23` · decided by the owner, **not built yet**. The table at the end says what
> exists. The event format ships in 0.1.0, because a format changed after the first release is a
> format every adopter's history already holds; the tool that removes a person comes in 0.2.

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

Today, whether a ✓ is a lock is worked out every time it is read, by asking whether its author is
the owner **now** — the server does it for the panel, `holdrim sync` does it for the repository, and
the cycle does the same for "an admin's request starts triaged". So a fact recorded years ago can
change meaning without a single event changing: the owner hands over, and every ✓ of theirs not yet
synced stops being a lock, with nothing in the trail to say so. An anonymised person would lose it
the same way.

So the role of the author — owner, admin or other — is written on the event when the server records
it, from `HOLDRIM_OWNER` and `HOLDRIM_ADMINS` at that moment, and every reader uses what is written.
A ✓ given by the owner stays the owner's ✓ after they hand over, after they are removed, after
anything. The owner is still named only by `HOLDRIM_OWNER`, and the server writes the role from it:
what changes is that a role, once written on a fact, is part of the fact. What that rests on, and
what it does not, is the next section.

### 3. Who can write the store

Every guarantee here — an event never altered, a people row never re-pointed, a role written by the
server from `HOLDRIM_OWNER` — holds against the people who use Holdrim. Against someone who can
write the database directly, it holds only as far as the database is made to hold it:

- **SQLite**, by trigger, and by the file belonging to the server's user.
- **Firestore**, by the code alone. Whoever the project's IAM lets write can write anything, events
  included — the gap events already have there, now shared by the people table.
- **The CLI's own path to the cloud** (`engine/cli/remote.ts`) writes events around the server, the
  one sanctioned door that does. It goes when the agent writes through the API with an identity of
  its own.

A role on the event does not widen this: a direct writer can forge the owner's ✓ today by writing the
owner's e-mail as its author, and the owner's e-mail is no secret. What closes it is a **signature**:
the server signs each event with a key only it holds, and every reader — `holdrim sync` included —
trusts a role only on a fact the server signed. Not built; see the table at the end. Until then,
the store is part of what a deployment has to guard, like the machine the server runs on.

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

"People are disabled, never deleted" stays. It gains one step, taken only by the **owner**, at the
person's request:

- the person's row in the people table keeps its id and loses its e-mail;
- their account, under password sign-in, loses its e-mail and name, its password and its open
  sessions — disabling already drops the last two;
- every `text` they wrote is removed, as above — the snapshots on their events stay;
- an event records that a person was removed, by whom and when — with ids only.

Nothing an approval stands on is touched: the event, its fingerprint, its snapshot and the role it
was given with all stay, so a lock stays a lock and says what it locked.

The owner cannot remove themselves: the owner comes from `HOLDRIM_OWNER`, and has to hand over
before leaving. An admin can ask the owner; only the owner acts, for the same reason only the owner
resets the owner's account.

Until the tool exists, the same steps are a documented procedure the operator runs on the database.

### 6. What the engine writes elsewhere

- **Commits.** The brief that `holdrim apply` hands the agent asks for two trailers, `Request:` with
  the request's id and `Requested-by:` with the requester's e-mail — and a commit stays in the
  project's history for good. `Requested-by:` goes. `Request:` already names the request, and who
  asked is found from it, in the place where it can be removed.
- **Logs.** Log lines carry the person's id instead of the e-mail wherever there is one. A refused
  sign-in still logs the address that was typed: that is the line an operator needs to see an
  attack, and there is no person behind it yet.
- **The repository.** The registry of approvals holds the file, the date, the fingerprint, the
  start of the block's own text and the event's id; the page's `data-validated` holds a date. Neither
  names anybody.

### 7. What changes with it

These describe today's format and move in the same change that replaces it, so no document goes on
describing the old one: `docs/GLOSSARY.md` (the event fields `author`, `text` and `snapshot`, and
**disabled**, which says a person cannot be removed), `docs/METHOD.md` (the commit trailers of the
request cycle), `docs/BUGS.md` (why the trailer carries the person), and, in `AGENTS.md`, the
invariants "Nothing is erased" and "Only the owner's ✓ becomes a lock" — the second to say a lock is
the ✓ of whoever was the owner when it was given.

## What Holdrim cannot remove

Said here so nobody promises it:

- the project's git history — a commit made before `Requested-by:` went keeps the e-mail;
- an exported copy of the documentation, once published;
- log lines already shipped to a collector, and backups of the database — the operator's retention;
- anything in the documentation text itself, which is the project's content.

## What exists today

| Piece | Status |
|---|---|
| Events never altered or deleted (SQLite by trigger) | ✅ built |
| People disabled, never deleted | ✅ built |
| `author` as an opaque id, a people table in every mode, one resolver | ⬜ 0.1.0 |
| The author's role written on the event, never recomputed on read | ⬜ 0.1.0 |
| Free text and snapshot outside the event, salted hash inside, removals as events | ⬜ 0.1.0 |
| Commits without `Requested-by:`, ids in logs | ⬜ 0.1.0 |
| Removing a person, documented procedure | ⬜ 0.1.0 |
| Removing a person, from the people screen | ⬜ 0.2 |
| Events signed by the server, and readers that trust only signed roles | ⬜ not scheduled |
| The agent writing through the API, and no direct write to the cloud | ⬜ not scheduled |
