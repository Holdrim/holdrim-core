# Roadmap

Where Holdrim is going, in the order it is being built. The mission and the vision behind it are in
[`docs/VISION.md`](docs/VISION.md); what already works is in the [README](README.md), and what each
release changed is in [`CHANGELOG.md`](CHANGELOG.md).

A line moves to the changelog when it ships, not when it starts. Nothing here is a promise of a
date: it is the order, and the reason for the order.

## Now — 0.1.0, the first version an adopter can pin

The engine that keeps documentation honest, run by one person or a small team.

- ✅ Approvals that stop holding when the text changes (🟡) or when what it depends on moves (🔴).
- ✅ The review panel inside the documentation's own pages, and the CLI for the same checks.
- ✅ Sign-in with passwords or behind an identity proxy; one owner; users in SQLite, Postgres or
  Firestore.
- ✅ The request cycle: a reviewer asks, the owner triages, the person's own agent applies, the
  commit closes it. The engine calls no model and holds no key.
- ✅ English, Portuguese and Spanish; a theme per project; an image published on every version tag.
- ✅ A home for the project: every page with its traffic light, and every request in progress in one
  list, instead of block by block inside each page.
- ✅ People, from the browser: create an access, hand out a new password, take an access away and
  give it back, without a terminal.
- ✅ An example worth showing: a small shop's till and its supplier's system, where one rule
  changed and two rules on top of it — one on another page — turned red.
- ✅ Ask for a page in plain language: a reviewer describes what is missing, from the home or from a
  block; the owner's own agent writes it through `holdrim apply`; the owner approves it like any other
  text.

- ✅ Triage from the home: every request in progress, decided in one place, with the same checks as
  the panel.
- ✅ Comments in the panel: a remark that asks for nothing, kept in the block's history and in
  nobody's queue.
- ✅ One panel: the one that paints all four lights, says when it cannot load, and opens the block a
  link names.
- ✅ A site that explains it: mission, method and first steps, for someone who will never read the
  code — written as a Holdrim project (`site/`), reviewed in the engine and published as plain pages
  with `holdrim export`.

## Next — what a newcomer sees first

Ordered by who it serves: the person who opens Holdrim for the first time, technical or not.

1. **Groups: who reviews which part.** Today every signed-in person may request on any page and only
   the owner and admins decide. A large documentation has parts, and parts have people. The design,
   and what it leaves open — above all, whether a group's approval may ever be a lock:
   `docs/GROUPS.md`.

## Later — what makes it a platform

- **Roles beyond owner and admin**, once groups exist.
- **Identity**: OIDC, Google and LDAP next to passwords and the identity proxy.
- **Generated diagrams and proposed dependencies**: two blocks that talk about the same term
  probably depend on each other, and the tool should say so.
- **A protocol between systems built on Holdrim**: contracts described in one shape, so a cash register
  and its supplier's system connect by reading two documents that already agree — a plugin, not a
  project. The design, and what of it exists: `docs/PROTOCOL.md`.

## How to move a line

Open an issue with the idea form: it asks for the problem before the solution. A line enters this
file when someone has said why it matters more than the one above it.
