# Prior art

> Research, `2026-09-22`. What already exists, so the contribution is not overstated.

Holdrim's core primitive is not new. "A link becomes suspect when either end changes, and stays
suspect until a person clears it" is the suspect-link pattern from requirements traceability —
over twenty years old in IBM DOORS, Jama Connect, Helix ALM and Visure Solutions, theorised by
Bohner and Arnold in *Software Change Impact Analysis* (1996). Swimm does the equivalent for code
references inside docs. Ketryx sells "AI keeps the trace, a human confirms" for medical device
software. Comala does page-level approval states inside Confluence. Kiro gates an agent on a human
sign-off per spec document. None of that is being reinvented by accident — it is the field Holdrim
belongs to. **Holdrim is requirements traceability rebuilt for prose, in the open, for the age of
coding agents.**

## The theory, as three claims

- **Approval is a claim about a text, so it is content-addressed.** Not about a block, a version
  number or a date — about the exact bytes a person read. The lock is a SHA-256 of the normalized
  text, not a flag.
- **Impact is a property of the pair of kinds, not of the change**, so it is a table. What matters
  is not "this changed" but "a change of *this* kind touched a dependent of *that* kind" — gravity
  crossed with sensitivity, a small table instead of one suspect bit.
- **An agent can verify a relation between two texts, but not a truth about the world**, so it
  closes and never approves. "This still holds" is checkable from the repository; "this is
  correct" is a claim about reality nothing in a repository can check.

## What no surveyed tool has

1. **Approval bound to a SHA-256 of the normalized text** — a fact about bytes, not a date, a
   version pointer or an attribute flag. Every surveyed tool keys off a timestamp or version ID.
2. **A computed four-state light**, separating "this text changed" (🟡) from "the ground moved"
   (🔴). Every surveyed tool has one flag, and cannot say which happened.
3. **Severity as a small gravity×sensitivity table**, plus deliberate one-hop anti-transitivity —
   against the industry's single flag, which propagates transitively into "suspect storms" that
   make teams switch the check off.
4. **The agent barred from approving, constitutionally** — it may close, never approve. The
   2025-26 spec-driven wave (Spec Kit, Kiro, OpenSpec, Tessl, BMAD) has nothing like this.
5. **A bug as a contradiction between two documents**, with a third outcome — the hole — for
   behaviour nobody wrote down. Every tracker loses this case as "works as intended."
6. **Git as the only writer of content**; the site only records append-only events, trigger-enforced.

## Spec-driven development & docs-as-code

| Tool | What it is | Shares | Lacks | URL |
|---|---|---|---|---|
| README-Driven Development | write the README before the code | doc precedes code | no fingerprint, no lock, no event log | tom.preston-werner.com/2010/08/23/readme-driven-development |
| Docs as Code (Write the Docs) | docs reviewed like source: git, PR, CI | git as truth, PR review | no per-block state, no expiry on text change | writethedocs.org/guide/docs-as-code |
| Architecture Decision Records | one file per decision, never edited | append-only log, close to `decision` | no fingerprint, no dependency graph, no light | adr.github.io |
| GitHub Spec Kit | Specify→Plan→Tasks→Implement, markdown feeding an agent | spec as artifact agents act on | no ownership model; agent can approve its own spec | github.com/github/spec-kit |
| AWS Kiro "specs" | requirements/design/tasks, human approves each stage | closest to fingerprint-bound blocking approval | no drift detection after; no closing-vs-approving split | kiro.dev |
| OpenSpec | ADDED/MODIFIED/REMOVED delta-spec per change | change-as-diff-to-a-block | deltas archived, not held under a persistent lock | github.com/Fission-AI/OpenSpec |

## Requirements traceability

| Tool | What it is | Shares | Lacks | URL |
|---|---|---|---|---|
| IBM DOORS / DOORS Next | canonical requirements linker | suspect-on-upstream-change, closest to 🔴 | watches attribute dates, not a hash; propagates transitively; no agent role | ibm.com/docs/en/engineering-lifecycle-management-suite/doors |
| Jama Connect | same suspect pattern, plus a version diff | diff-to-judge-a-suspect-link | one flag only, no severity tiers, no agent role | jamasoftware.com/blog/the-importance-of-suspect-tracking-in-requirements-management |
| Siemens Polarion | typed link roles (verifies/derives), baselines | frozen snapshot, closest to fingerprint-at-approval | whole-document granularity, no computed multi-state light | blogs.sw.siemens.com/polarion/how-to-incorporate-the-correct-traceability-model-into-your-processes |
| Helix ALM | traceability matrix, impact analysis | "suspect dependency" a user clears | no severity tiers, no role separation | perforce.com/blog/alm/performing-accurate-impact-analysis-helix-alm |
| Visure Solutions | regulated ALM, upstream flags downstream risk | closest to `entails`/gravity | severity hardcoded to one artifact type | visuresolutions.com/features/impact-analysis-software |
| Bohner & Arnold (1996) | foundational impact-analysis text | ancestor of the funnel; no single technique suffices | analysis literature, not a lock | en.wikipedia.org/wiki/Change_impact_analysis |

## Living documentation

| Tool | What it is | Shares | Lacks | URL |
|---|---|---|---|---|
| Living Documentation (Martraire) | pattern catalog: docs generated from code/tests | the goal of trustworthy docs | freshness from generation, not drift detection; no kinds | oreilly.com/library/view/living-documentation-continuous/9780134689418 |
| Concordion | instrumented prose executes as a test | closest analogue to `data-proof` | code-to-test, not test-to-fingerprint | concordion.org |
| doctest (Python) | runs `>>>` examples in docstrings | smallest-grain analogue of `data-proof` | verifies output only, never the surrounding narrative | docs.python.org/3/library/doctest.html |
| Swimm | doc "Smart Tokens" pointing at code, diffed by a GitHub App | closest single precedent: staleness from what the doc depends on | code-reference equality only, never a prose fingerprint | swimm.io |
| Mintlify / ReadMe freshness bots | diff a PR against doc pages, flag stale pages | "something changed underneath" detection | page-level, heuristic — a guess, not a hash | mintlify.com/blog/docs-on-autopilot |
| Design by Contract (Meyer) | pre/post-conditions as versioned, executable claims | a claim bound to an exact version | checked at runtime, not by a human ✓ | — |

## Knowledge graphs & review workflows

| Tool | What it is | Shares | Lacks | URL |
|---|---|---|---|---|
| Obsidian | Markdown vault, wikilinks, backlinks, graph view | subject-by-name links that survive reordering | no approval state, no hash, no "link broke because the target changed" | obsidian.md |
| Semantic MediaWiki | typed `Property::` links on wiki pages | closest precedent for the undone "respect" | fingerprints, staleness, human approval all absent — a query layer | semantic-mediawiki.org |
| Comala Document Management | page-level state machine (Draft→Review→Approved) | traffic light and roles, closest on the workflow axis | hand-set state, not derived from a hash; whole-page | (Confluence, Appfire) |
| Document360 / Notion | Draft/In-Review/Published, role-gated | role-gated states, like the cycle | "Approved" survives a later edit — the exact bug the lock prevents | — |
| C4 model / Structurizr | diagrams-as-code, typed directional relationships | typed links with a direction of impact | no tie to approval state or content hash | structurizr.com |
| Backstage TechDocs | renders repo docs into a catalog via `catalog-info.yaml` | git as source, roughly-typed entity links | no block-level anything — a doc is one opaque page | backstage.io |

## Regulated document control

| Tool | What it is | Shares | Lacks | URL |
|---|---|---|---|---|
| FDA 21 CFR Part 11 | tamper-evident audit trail, who/what/when/why | matches the append-only, trigger-enforced events table | no captured *reason* per event | ecfr.gov/current/title-21/chapter-I/subchapter-A/part-11 |
| GAMP 5 / CSV | URS→FS→DS→tests; a change revokes the "validated state" | overlaps `entails` | no system-wide validated state; one-hop propagation lacks a "stayed green" proof | sgsystemsglobal.com/glossary/gamp-5 |
| DO-178C | bidirectional req↔code↔test; code with no requirement is a finding | overlaps the designed-not-built "subject" and "respect" | misses the reverse hole: system does X with no doc, undetected | parasoft.com/learning-center/do-178c/requirements-traceability |
| Ketryx | AI-maintained RTM from requirements to tests, human confirms | nearly the same computation, "closes, never approves" | closed-source; built around named regulatory artifacts | ketryx.com/capabilities/traceability |
| IEC 62304 | requirement→design→code→test, by safety class | overlaps `data-proof` and gravity/sensitivity | no safety class forcing mandatory re-verification | en.wikipedia.org/wiki/IEC_62304 |
| Change Control Board | a human board reviews an impact package | severity routing to a person | no quorum or recorded rationale; Holdrim routes to any one admin/owner | visuresolutions.com/plm-guide/configuration-control-board-ccb-in-plm |

## What Holdrim should borrow

1. **Diff-aware suspicion**, from Jama's version diff — the git-diff layer `docs/IMPACT.md` admits
   is the unbuilt half of the edit-level signals.
2. **A reason field on every approval and closure**, from 21 CFR Part 11 — the event log has
   author, timestamp and fingerprint, never *why*.
3. **Baselines as frozen snapshots by git tag**, from Polarion — "what did this look like at the
   last release," independent of any one block's own approval.
4. **Typed relations for "respect"**, with a light syntax like `dependsOn::value` — from Semantic
   MediaWiki's `Property::`, Polarion's `verifies`/`derives`, and C4's labelled relationships.
5. **Subject-by-name links, with a backlink index and aliases for renames** — from Obsidian,
   Dendron and Foam. Luhmann's Folgezettel precedes a positional id (`data-code`) kept distinct
   from a link.
6. **Auto-repair of provably trivial moves**, from Swimm — a rename should not cost the same red
   mark as a real change.
7. **`data-proof` verifying the test runs and passes**, not that the file exists — from doctest,
   Doc Detective and Concordion, which execute the claim rather than check a path.
8. **The reverse hole** — behaviour with no document — from DO-178C's extraneous-code finding.
   Today the engine only catches the opposite: a document with no behaviour.
9. **A closure-chain report**, from GAMP 5's validated state — answers "prove nothing downstream
   of this red block quietly stayed green," without giving up one-hop propagation.
10. **A reverse-index page before any force graph**, from Backstage — a static list of what
    depends on what; a dense graph becomes unreadable at scale.

## Not borrowed, and why

- **Competency gates on approvers** (Qualio) — the owner/admin split is about power, not
  qualification; a training check needs a training system Holdrim has no reason to own.
- **CAPA loops** (Greenlight Guru, GAMP 5) — root-cause and effectiveness records belong to a
  quality-management system; a bug here ends at triage, not a corrective-action.

## Positioning

Not "nobody does documentation-centred systems" — plenty do, some older than this repository's
authors. The honest claim is narrower: traceability with suspect links, for prose, content-
addressed, with an agent that may close but never approve. The nearest neighbours are Ketryx,
which runs close to the same computation for regulated software but is closed-source and built
around named regulatory artifacts (URS, FS, DS) Holdrim lacks; and Swimm, which computes the
same shape of staleness but only for a doc's pointer into code, never one document's prose against
another's. Holdrim sits between them: open, prose-first, stricter about what an agent may decide.
