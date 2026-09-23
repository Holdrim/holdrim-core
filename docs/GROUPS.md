# Groups: who reviews which part

> Draft · `2026-09-23` · **nothing here is built.** Written down to be argued with before any of it
> touches the rules the product's security rests on. The table at the end says what exists.

## The problem

Today there are three kinds of person: the **owner** (exactly one), **admins**, and everybody else
who can sign in. Everybody else may read and ask; the owner and the admins decide requests and
approve text. That is enough for one documentation and a few people.

It stops being enough the day a documentation has parts, and parts have people. A clinic's
documentation has a part the pharmacists own and a part the front desk owns. Today either every
pharmacist is an admin — and may decide a request about the front desk — or none is, and every
request about medication waits for the owner.

## The proposal in one sentence

**A group is a set of people and a set of pages; its members may decide the requests on those
pages, and nothing else changes.**

## How it would work

### 1. Declared in the project, not in a database

```json
"groups": {
  "pharmacy": { "members": ["ana@example.org", "bea@example.org"], "pages": ["P0", "P1"] },
  "front-desk": { "members": ["cid@example.org"], "pages": ["F"] }
}
```

`pages` are prefixes of page codes: `P0` covers `P01` to `P09`. The file is in the repository:
a change to who may decide what goes through review like any other change, and has a history.

A database column would be quicker to change and would be the first thing an attacker changes. The
owner already comes from configuration and never from a column, for the same reason.

### 2. One more capability, per page

The engine speaks in capabilities (`canApprove`, `canTriage`), never in role names. A group adds
one question, asked with the page in hand: **may this person triage requests on this page?** The
answer is yes for the owner, the admins, and the members of a group whose prefixes cover the page.

The home already offers triage only where the server says the viewer may decide, request by
request. The panel draws its buttons from the request's `status.triage`, but decides whether to show
them from one `canApprove` for the whole page; it would need that answer per page from the server —
which is still the server deciding, and the panel knowing nothing of groups.

### 3. What a group never does

- **A group member's ✓ is not a lock.** Only the owner's approval reaches the registry — `holdrim
  sync` takes theirs alone — exactly as an admin's does not today. A member may approve on the
  site, and that approval is recorded, but the lock stays the owner's.

  The panel already draws that line for admins: only the owner's ✓ turns a block green, as on the
  home and in the registry, and anyone else's is shown as theirs. The server says which ✓ is the
  lock (`locks` on each approval it returns), so a member's ✓ needs no new rule in the panel.
- **A group never contains the owner's powers.** Resetting the owner's account, and creating it,
  stay the owner's, whatever the file says.
- **A group changes no one's identity.** Membership is read by e-mail from the file; signing in is
  unchanged.

## What stays true from the rest of Holdrim

- **Exactly one owner**, from `HOLDRIM_OWNER`. Groups do not add a second.
- **Nothing is erased.** A person removed from a group keeps every decision they took, with their
  name.
- **The theme and the configuration are untrusted input.** Group names and prefixes land in pages,
  so they are validated against a known format like colours are.

## Open questions

- **Approval inside a group.** Should a group's approval count as a lock for its own pages, with the
  owner delegating? It would make the owner optional for most of the text, which is the point, and
  it would change the one invariant most of the security rests on.
- **Requests that cross parts.** A request on a block that depends on another group's page: whose
  is it to decide?
- **A group's own view of the home.** Listing only its pages and requests is easy; is it wanted, or
  does everybody want to see everything?

## Built / not built

| Piece | State |
|---|---|
| Owner and admins, from configuration | built |
| Capabilities (`canApprove`, `canTriage`) instead of role names | built |
| Triage buttons drawn from what the server says | built |
| `groups` in the project's configuration | not built |
| Triage per page for group members | not built |
| The panel telling the owner's ✓ from anybody else's | not built |
| Approval inside a group as a lock | not decided |
