# Two layers, one lock

> Design, `2026-09-22`. Partly built — see the table at the end.

## 1. Two documentations, one lock

Every project ends up writing two documents whether or not it names them. The **Fundamental** is
the blueprint: what must be true of the system — its rules, contracts, data model, configuration.
The **Application** is the house: what was built, screen by screen. The business reads and approves
both, but they are not peers: the Application *depends on* the Fundamental, never the reverse. A
screen exists because a rule permits it; a rule does not exist because a screen needs it.

Both live under the same fingerprint, traffic light and event log — one lock, not two, and that is a
decision. A second lock, with independent approval on each side, would let the two drift: someone
changes the rule, re-approves it, and the screen built on the old wording stays green because
nothing told its lock to open. Two truths each "approved" while disagreeing are worse than one truth
that is sometimes stale — the stale one at least turns 🔴. The dependency edge between the documents
is what keeps them one lock: it makes a change on one side visible on the other.

## 2. The layers are already in the kind catalogue

This is the finding this document exists to write down: the layer was already expressed, one
property at a time, before it had a name. `engine/core/kinds.js` declares fifteen kinds, each with
a `gravity` and a `sensitivity`. Grouped by both:

| kind | gravity | sensitivity | layer |
|---|---|---|---|
| `config` | binding | brittle | **Fundamental** |
| `contract` | binding | brittle | **Fundamental** |
| `model` | binding | brittle | **Fundamental** |
| `rule` | binding | brittle | **Fundamental** |
| `title` | substantive | normal | Application |
| `subtitle` | cosmetic | robust | Application |
| `text` | substantive | normal | Application |
| `list` | substantive | normal | Application |
| `box` | substantive | normal | Application |
| `table` | substantive | normal | Application |
| `image` | cosmetic | robust | Application |
| `diagram` | substantive | normal | Application |
| `colors` | cosmetic | robust | Application |
| `rationale` | substantive | robust | Application |
| `decision` | binding | normal | Application |

Exactly four kinds are both `binding` and `brittle`: `config`, `contract`, `model`, `rule` — a
configuration value, a public promise, the shape of the data, a rule that holds regardless of how
the system is built. That is the Fundamental; the other eleven are the Application.

The honest qualification is `decision`: gravity `binding` — an open decision binds the project's
future once it lands — but sensitivity `normal`, not `brittle`. So `layer` is **not** simply
`gravity === 'binding'`: that test would pull `decision` into the Fundamental alongside the other
four, and a decision is not a blueprint fact — it is a placeholder for one. `rationale` shows the
opposite edge, `substantive`/`robust`, though it shares a file section with `decision` and could be
mistaken for its neighbour by anyone reading the section comment rather than the fields.

The conclusion is not to refine the inference. It is to declare `layer: 'fundamental' |
'application'` on the kind, next to `gravity` and `sensitivity`, instead of computing it from them.
An inference right fourteen times out of fifteen is worse than a flat declaration: the fourteen
correct answers make the fifteenth look checked when it was only guessed.

## 3. The invariant: dependencies point down

A `data-depends` edge may run from an Application block to a Fundamental one, or between two blocks
in the same layer. It may never run from a Fundamental block to an Application one. That is what
makes "an agent implements from the documentation without ambiguity" possible: an agent resolving a
rule reads down the chain until it reaches a block that depends on nothing above it — a bottom that
does not move while it stands there. If the Fundamental could depend on a screen, there would be no
bottom: reading down from the rule into the screen, the screen's own dependencies could lead back
toward the rule that started the chain. There would be no fixed place to start reading, only a
graph.

This is checkable the way the fingerprint and traffic light are, and since `2026-09-22` it is
checked: `holdrim check` walks every `data-depends` edge, asks each endpoint's kind for its `layer`,
and refuses an edge from `fundamental` to `application`, naming both blocks (`upwardDependencies`,
in `engine/cli/validation.ts`). It stays quiet when either kind is undeclared, because `layerOf`
returns `null` rather than a default and an unknown kind must not be judged by a rule nobody
declared for it.

## 4. What the layers change in the traffic light: nothing

Said explicitly: this section adds no mechanism. A Fundamental block changing is, by definition, a
`binding`-gravity kind changing. `config`, `contract`, `model` and `rule` are the only `brittle`
kinds and all four are Fundamental, so an edge from the Fundamental into the Application always
lands on a `normal` or `robust` dependent. In `engine/core/impact.js`, `MATRIX.binding = { robust:
'agent', normal: 'person', brittle: 'person' }`: a binding change reaching `normal` already routes
to `person` — the loudest a non-brittle dependent produces.

The layer model does not change that cell, add a cell, or add a code path. It names *why* that cell
is loud — the Fundamental disturbing the Application — but the routing was correct before the name
existed. That is a feature: the two-layer model reads the existing engine; it does not add to it.

## 5. The deploy carries the documentation, so a release is a baseline

The image that deploys is built from the same repository as the documentation it implements — code
and blueprint travel together. That makes every release a freezing point: at deploy time, record
every block id, its fingerprint, its light, and which version of the Fundamental the deployed code
claims to implement. Months later, "what did the business approve, in the version running right
now" is answerable from one baseline instead of reconstructed per-block history.

`docs/PRIOR-ART.md` already lists "baselines as frozen snapshots by git tag," from Polarion, among
the ten things worth taking. This moves it up the list: without the two-layer model a baseline is a
convenience; with it, it is closer to a requirement, since per-block fingerprints alone cannot
answer that question, which spans blocks and layers. A git tag, already what a release is cut
from — and one that must point at a commit whose CI is green — is the obvious carrier.

## 6. No ambiguity for the agent is checkable, partly

Restricted to the four Fundamental kinds, a `demands`-style lint can refuse hedging vocabulary an
agent would otherwise guess at: *should*, *ideally*, *if possible*, *as appropriate*, *and so on*,
or a size word — *fast*, *quick*, *large* — with no number. On a `text` block those words are
ordinary prose. On a `rule` or `contract` they are a defect: the agent resolves the hedge by
guessing, silently, and nobody downstream sees the guess.

The honest limit: this catches words, not vagueness. "The system must be reliable" has no hedge word
from that list and is exactly as unimplementable as "the system should probably be reliable." A
lint over a fixed vocabulary cannot tell the two apart. So the check matches that limit: a warning
naming the word, on the Fundamental layer only, never a block on the commit — the posture
`demands` already takes toward a missing `alt`.

## 7. The navigable mock is a screen's proof

A screen kind in the Application can carry `data-proof` pointing at the mock route that renders it,
the way a `rule` block carries `data-proof` pointing at the test that defends it. The business
navigates the running mock, approves the screen, and the approval is for that screen at that
fingerprint — the same act, on different evidence.

What has to change: `check` today, in `engine/cli/validation.ts` (`missingProofs`), reads a
`data-proof` value as `path::name of the test`, checks only that the path exists on disk relative
to the content project's root, and carries the name after `::` unconfirmed — exactly as
`docs/BUGS.md` already describes for `rule`. Nothing in it fetches a URL. A route cannot be
verified by `stat`-ing a path — it is an address a server answers to, not a path on disk. Verifying
it means fetching the route, which `check` does not do today: a new capability, not an extension of
the file check.

## 8. Built, and not built

| | |
|---|---|
| ✅ | fifteen kinds with `gravity` and `sensitivity`, `engine/core/kinds.js` |
| ✅ | matrix routing a `binding` change to `person`, `engine/core/impact.js` |
| ✅ | dependency declared by block id (`data-depends`) |
| ✅ | `layer: 'fundamental' \| 'application'` declared on all fifteen kinds, `engine/core/kinds.js` |
| ✅ | the downward-only edge check, `upwardDependencies` in `engine/cli/validation.ts`, wired into `check` |
| ⬜ | the release baseline — ids, fingerprints, lights and Fundamental version, frozen at deploy |
| ⬜ | the hedging lint on the Fundamental layer |
| 🟡 | `data-proof`: `check` accuses a missing path; fetching a route is not built |
| ⬜ | the subject — linking by name, not block id, needed for the Application to point at the Fundamental without numbers that move on reorder; same gap `docs/IMPACT.md` already lists |

## 9. What this does not solve

Nothing here makes a Fundamental block *correct* — only consistent with what depends on it. A
blueprint can be unambiguous and simply wrong; only a person reading it against the world can say
so. The downward-edge check catches a dependency pointed the wrong way, not one that should exist
and was never declared. Layers organise what is already checked; they add no judgement the engine
lacked before.
