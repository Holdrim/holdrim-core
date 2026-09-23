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

### 1. An event is signed by an id, not an e-mail

Every event's `author` becomes an opaque id, random, one per person (`p_` and 24 hex characters).
The id means something only through a registry of people — id, e-mail, name — kept next to the
events in the same store, in every identity mode: with passwords, where people already have
accounts, and behind a proxy, where a person is added the first time they are seen.

Everything that reads events goes on reading e-mails: the store resolves ids on the way out, in the
one function every reader uses — the server, `holdrim sync` reading a local file, and the CLI
reading the cloud directly. The panel, the home and the CLI's output do not change.

**Why random, and not a hash of the e-mail.** A keyed hash can be recomputed by whoever holds the
key: try an e-mail, compare, and the person is back. That is pseudonymisation, and the law treats
pseudonymous data as personal data still. A random id whose registry row has been emptied points
at nobody.

### 2. Free text lives outside the trail

The text of a request, a comment, a reply or a supplement, and the `snapshot` of the block at the
moment of an event, move out of the event into a table of texts, one row per event and field. The
event keeps a salted hash of each text; the salt lives with the text.

- While the text is there, the hash proves it is the text that was recorded.
- When the text is removed, the salt goes with it, so the hash can no longer be tested against a
  guess — a CPF has few enough possibilities that an unsalted hash of it would be the CPF.
- The event stays, and readers are told the text was removed and when, instead of seeing nothing.

The documentation's own text is not in here: it lives in the project's repository, and removing a
sentence from it is a commit, with its own history.

### 3. Removing a person: anonymised, never deleted

"People are disabled, never deleted" stays. It gains one step, taken only by the **owner**, at the
person's request:

- the person's registry row keeps its id and loses its e-mail and name;
- their password and open sessions are dropped, as disabling already does;
- every text they wrote is removed, as above;
- an event records that a person was removed, by whom and when — with ids only.

The owner cannot remove themselves: the owner comes from `HOLDRIM_OWNER`, and has to hand over
before leaving. An admin can ask the owner; only the owner acts, for the same reason only the owner
resets the owner's account.

Until the tool exists, the same steps are a documented procedure the operator runs on the database.

### 4. What the engine writes elsewhere

- **Commits.** The brief `holdrim apply` hands the agent asks for a `Requested-by:` trailer with the
  requester's e-mail, and a commit is forever in the project's history. The trailer becomes the
  request's id alone; who asked is one lookup away, in the place where it can be removed.
- **Logs.** Log lines carry the person's id instead of the e-mail wherever there is one. A refused
  sign-in still logs the address that was typed: that is the line an operator needs to see an
  attack, and there is no person behind it yet.
- **The repository.** The registry of approvals holds the file, the date, the fingerprint, the
  start of the block's own text and the event's id; the page's `data-validated` holds a date. Neither
  names anybody.

## What Holdrim cannot remove

Said here so nobody promises it:

- the project's git history — a commit made before the trailer changed keeps the e-mail;
- an exported copy of the documentation, once published;
- log lines already shipped to a collector, and backups of the database — the operator's retention;
- anything in the documentation text itself, which is the project's content.

## What exists today

| Piece | Status |
|---|---|
| Events never altered or deleted (SQLite by trigger) | ✅ built |
| People disabled, never deleted | ✅ built |
| `author` as an opaque id, registry of people in every mode | ⬜ 0.1.0 |
| Free text and snapshot outside the event, salted hash inside | ⬜ 0.1.0 |
| `Requested-by:` without an e-mail, ids in logs | ⬜ 0.1.0 |
| Removing a person, documented procedure | ⬜ 0.1.0 |
| Removing a person, from the people screen | ⬜ 0.2 |
