# A protocol between systems

> Draft · `2026-09-23` · **nothing here is built.** This is the design being discussed, written
> down so it can be argued with. The table at the end says what exists: today, none of it.

## The problem

Two systems that have to talk are usually written by two people who never read each other's
documentation. They agree once — on a call, in a spreadsheet, in an email — and then each side
changes on its own. The first sign that the agreement moved is a failure in production.

A shop's cash register reads its supplier's catalogue and sends it orders. The day the supplier
renames `price` to `unit_price`, the till learns about it when a sale charges nothing.

## The idea in one sentence

**A contract between two systems is a Holdrim page that both of them keep — and a change on one side
turns the other side red before anything breaks.**

Holdrim already does this inside one project: a block that depends on another turns 🔴 when the one
it depends on moves (`docs/IMPACT.md`). The protocol is the same rule, across a boundary.

## How it would work

### 1. The contract is published, read-only

The side that offers the contract publishes its contract pages as static files — `holdrim export`
already produces exactly that: the approved text, without the panel. Each block keeps its `data-id`,
and the published page carries each block's fingerprint, so a reader can tell which text it is.

### 2. The other side mirrors it

The side that consumes the contract keeps a copy of those pages in its own documentation, marked as
**foreign**: it can read them and depend on them, and never approve or edit them. Its own blocks
declare what they rest on, as they do today:

```html
<div class="block" data-id="R04.1.3" data-code="1.3" data-depends="supplier:C02.1.4">
```

### 3. A change on one side reaches the other

When the supplier changes block `C02.1.4` and its owner approves the new text, the published
fingerprint changes. The next time the till's side refreshes its mirror, `R04.1.3` turns 🔴 —
"the text is the same, but the ground moved" — exactly as if the dependency lived next door.

Nobody had to tell anybody. The documents disagreed, and the tool said so.

### 4. A plugin is two documents that already agree

A plugin, in this design, is not code first. It is a Holdrim project whose contract pages are
approved on both sides, and an implementation proved against them. Installing it means mirroring its
contract; upgrading it means seeing, before anything runs, which of your own rules turned red.

## What stays true from the rest of Holdrim

- **Only an owner's ✓ is a lock**, on each side. A foreign block is never approved by the side that
  mirrors it: its authority is the other side's owner.
- **Nothing is erased.** A mirror refresh is an event with a time and a source, like any other.
- **The engine calls no model.** Proposing that two blocks depend on each other is the person's own
  agent's job, the way `apply` already works.

## Open questions

- **Identity of a foreign project.** A URL is enough to read; is it enough to trust? Signing the
  published fingerprints with the owner's key would let the mirroring side prove where a text came
  from.
- **Refreshing.** On demand, by a command the person runs, on a schedule, or pushed by the publisher?
- **Partial contracts.** Can a consumer depend on one block of a page without mirroring the page?
- **Versions.** Is the fingerprint the version, or does a contract also need a human-readable one?

## Built / not built

| Piece | State |
|---|---|
| Dependencies and 🔴 inside one project | built |
| `holdrim export`: the approved text as static pages | built |
| Fingerprints carried on the published page | not built |
| Foreign blocks and `data-depends="project:ID"` | not built |
| A command that refreshes a mirror | not built |
| Signed contracts | not built |
