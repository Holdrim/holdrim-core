# Changelog

What changes for a project that moves its pin. One section per version, newest first. A release
tag is refused until its section exists (`scripts/check-release-tag.sh`), so this file cannot
fall behind the images.

Each entry says what an adopter will notice, not which files moved: the commits already say that.
When something breaks a pin — a renamed variable, a changed route, a stricter check — it goes
first, under **Breaking**, with what to change.

## [0.1.0] — unreleased

The first version. There is nothing before it to break.

- **Approvals that stop holding.** Every block of a page is approved against its exact text. A
  block whose text changed turns 🟡, and one whose text is intact but whose dependency moved
  turns 🔴.
- **The project home**, `/engine/home`, where `/` leads unless the project names another page:
  every page with its traffic light, and every request still in progress, oldest first — decided
  right there by whoever may decide, with the same checks as the panel.
- **People, from the browser**, `/engine/people`, for the owner and admins with password sign-in:
  create an access, hand out a new password (shown once), take an access away and give it back.
  Nobody is ever deleted.
- **Ask for a new page, in plain words**, from the home (a form that needs no script) or from any
  block (the new `page` category). `holdrim apply` tells the agent to write one new page shaped like
  the one it was asked near, and to mark nothing as validated.
- **Publishing, `holdrim export <folder>`**: the documentation as plain static pages, without the
  panel, for anyone to read. Only what a browser renders goes out; the config, the registry and
  anything unexpected stay home.
- **`site/`**, Holdrim's own site, written and reviewed as a Holdrim project.
- **`examples/cash-register`**, the example to show first: approved rules, one changed and
  re-approved, and the two rules built on it red — one of them on another page. No Docker needed:
  `bash engine/run-local.sh examples/cash-register` serves any project folder, as its owner.
- **The review panel**, in the documentation's own pages: one module, `panel-react.js`, to approve,
  request a change, comment, add details to a request and triage. It paints all four lights,
  including a 🔴 whose cause is on another page — it asks the server for fingerprints it cannot
  see — says so when the review state cannot be loaded, opens the block a link names
  (`#A01.1.3`), which is how the home links a request, and leads back to the project's home from
  every page, so a page needs no link of its own that an exported copy would leave dead.
  Only the owner's ✓ turns a block green, as only theirs becomes a lock: an admin's is recorded,
  and the panel shows it as an admin's.
- **The CLI, `holdrim`**: `lights`, `if-i-touch`, `index`, `check`, `kinds`, `export`, and the request
  cycle, `list`, `show`, `impact`, `apply` and `state`. `apply` hands a request to the agent CLI the
  person already has. The engine calls no model and holds no key.
- **Sign-in** with passwords, or behind an identity proxy. There is exactly one owner, named by
  `HOLDRIM_OWNER`, and the first-access password is printed once.
- **Storage.** Events go to SQLite or Firestore and are only ever appended; SQLite refuses
  `UPDATE` and `DELETE` by trigger. People go to SQLite, Postgres or Firestore. Every event store
  and every user store passes its own conformance suite in CI, against real databases.
- **English, Portuguese and Spanish**, including the sign-in screen, which the server renders
  already translated, and the review panel, which asks the server which language the person reads.
- **A theme** from `holdrim.json`: a brand colour (hex only), a logo inlined by the server, and a
  name.
- **The image** is published to `ghcr.io/holdrim/holdrim-core` on a version tag, with provenance
  and an SBOM. Pin the version: there is no `latest`.
- **Node 22.18 or newer** to run from a clone. The image carries its own Node.
