# Impact

> Design, `2026-09-20`. Partly built — what exists and what does not is at the end.

## The question

Git merges most branches without asking anyone. Not because it understands the code, but because it
has a **cheap, sound test** for "these two changes cannot touch each other": different hunks, no
overlap. It only asks a human when that test fails, and that is why nobody resents being asked.

Documentation has no such test. Meaning is not lines, and two paragraphs on opposite ends of a
project can contradict each other without sharing a word. So the goal is not one test — it is a
**funnel**, where each stage is cheaper and more certain than the next, and the human sees only what
survived all of them.

The measure of success is not how much impact the engine finds. It is **how little of it reaches a
person**, while nothing real gets through.

## The funnel

```
a change lands
     │
  1  did any visible text actually change? ───── no ──► silent
     │ yes
  2  does anything depend on it? ──────────────── no ──► silent
     │ yes
  3  how much does a change of THIS kind matter
     to a dependent of THAT kind? ──────── nothing ──► recorded, not raised
     │ enough
  4  does the dependent still hold? ────── holds ──► closed by the agent, with its reasoning
     │ unsure, or no
  5  a person looks
```

Stages 1 to 3 are deterministic and tested. Stage 4 is the only one that guesses, and the rule that
keeps it honest is in "What the agent may not do".

## Stage 3 — the weight

Not every change weighs the same. Rewording the label a doctor reads does not touch the business
rule. Changing the business rule touches everything that reasoned from it. The engine already knows
the **kind** of every block, so the weight belongs there — in `engine/core/kinds.js`, next to
`demands`, where a kind already declares what it expects of itself.

Two properties, and they are not the same property:

| | Question it answers |
|---|---|
| **gravity** | how much a change **here** disturbs whatever stands on it |
| **sensitivity** | how easily a block of this kind is disturbed by a change **underneath** it |

A `colors` block has low gravity and is robust: change the hex, little moves, and little moves it. A
`contract` is the opposite on both — it promised something to somebody else's system, and it breaks
when the ground shifts.

**Words, not numbers.** A scale of 1 to 5 invites averaging, and the average of invented numbers is
an invented number with a decimal point. Words you can argue about in a pull request.

| gravity × sensitivity | robust | normal | brittle |
|---|---|---|---|
| **cosmetic** | silent | silent | agent |
| **substantive** | silent | agent | person |
| **binding** | agent | person | person |

*Silent is still recorded.* It is stored with its dependency pair in the index, counted by
`holdrim index`, and — once it exists — shown in the ledger; it just does not raise a flag. The
difference is between being written down and being put in your way.

## Stage 3b — what the edit itself says

Kind against kind is not the whole story: the same block can be edited cosmetically or
substantively. Three signals are cheap, deterministic, and worth more than they cost
(`signalsOf`, in `engine/core/impact.js`):

| Signal | Reading |
|---|---|
| only whitespace moved — the text is the same under the fingerprint's own `normalize` | silent, whatever the kinds say: it is a fact about the bytes, not an opinion about the meaning |
| a **number** changed | never cosmetic — "24 hours" → "48 hours" is a rule change in any kind of block |
| a **negation** appeared or vanished (*not*, *never*, *no longer*) | never cosmetic |

⚠️ **These may only raise, never lower.** A deterministic rule that can lower a flag is a rule that
silently loosens the lock, and the day it is wrong nobody finds out. Lowering is the agent's job,
and the agent has to show its work. The whitespace row is the one apparent exception, and
`severityOf` says why it is not one: it does not judge the change small, it finds there was no
change to the visible text at all. Punctuation is not in it: `normalize` collapses whitespace and
nothing else, so a moved comma is a change the fingerprint sees, and it goes through the matrix
like any other.

## What a link carries

Obsidian's link is untyped: *these two are related*. That is enough to draw a graph and not enough
to decide anything. This one carries three things, and the third is the one that matters.

| | What it is | Why |
|---|---|---|
| **the subject** | a name, not a block number | block numbers are positional — reorder a section and every link points somewhere else |
| **the ground at ✓ time** | the fingerprint the subject had when this block was approved | this is what makes 🔴 possible at all (`data-depended-on`) |
| **the respect** | *in what way* it depends: the value, the existence, the wording | this is what makes stage 4 possible |

"B depends on A" tells a model nothing. "B depends on the **value** of A's deadline" lets it answer
correctly — and, just as important, lets it be **wrong in a way a human can see**.

The respect is proposed by the agent and confirmed by a person. Same loop as everything else here.

### Why linking does not cost a single ✓

The fingerprint is over the **visible text**. An `<a>` is markup, not text. So an existing
documentation can be linked up end to end — every subject, every reference — **without invalidating
one approval**.

That is not a detail, it is the difference between a feature people adopt and one they postpone
forever. If the link were `[[subject]]` written into the prose, inserting it would change the text,
drop the approval, and turn every act of linking into an act of re-approving.

⚠️ The other side of the same coin: there is only one fingerprint, over the text, and it is the one
`check` compares against the registry. A change of formatting inside an approved block — a link
added, a word put in bold — sets off nothing. That is what makes linking free, and it is also a
blind spot. Catching markup changes would need a second fingerprint over the HTML, and the day one
exists it needs a stated exception for links, or the first day of linking a project buries the
signal it was built to protect.

## What the agent may and may not do

| May | May not |
|---|---|
| close an impact as *still holds*, with its reasoning | approve a block |
| propose a link, and the respect of it | turn ⚪ into 🟢 |
| raise something the weight table left silent | lower what a deterministic rule raised |

**Closing is not approving, and the difference is not a formality.** Closing says *this change did
not reach here* — a claim about a **relation between two texts**, checkable by anyone who reads them
side by side. Approving says *this text is correct* — a claim about the **world**, and nothing in a
repository can check that. The engine lets the machine make the first claim and never the second.

Every closure is an event: the model, its version, the reasoning, the two fingerprints it compared.
Reopening it costs one click and nothing else, because nothing was erased. The ledger shows *"14
impacts, 11 closed by the agent"*, and a person can spot-check the 11 without asking anyone.

This is the honest version of the auto-merge analogy: Git merges without you, and you can still
`git diff` what it did.

## One hop, not the transitive closure

A changes. What cites A turns 🔴. What cites **those** does not.

The transitive closure of a documentation graph paints half the project red on the first commit, and
then people switch the check off — which is the exact failure `engine/core/validity.js` already
warns about in its own comments.

Propagation happens **by human confirmation instead**. Look at the 🔴 and say *still holds* → the
wave stops there. Change the text → that is a real change, and it propagates one more hop on its
own. The wave advances at the speed of checking, which is the only speed that means anything.

*This is about painting the traffic light, not about looking before you edit.* `radiusOf`
(`engine/core/validity.js`) DOES compute the full transitive closure, and the panel draws it when a
block is selected — the "impact radius" is a preview a person asks for, costs nothing, and locks
nothing. What it must never become is a second way to turn a block red: that would repaint the whole
project on day one, which is exactly the failure this section is about.

## Why this is not a scan

Three layers, each answering a question the layer below would have to scan for:

| Layer | Question | Cost |
|---|---|---|
| **git** | which **files** changed since the index was built (`git diff --name-only <sha>..HEAD`) | reparse only those |
| **fingerprint** | which **blocks** inside them really changed — reindenting does not count | already built |
| **reverse index** | who has to be repainted: `SELECT block FROM dependencies WHERE depends_on IN (…)` | one query |

The third already exists — `engine/api/index-store.ts` creates `dependencies_reverse ON
dependencies (depends_on)` for exactly this. The first now has somewhere to start from:
`index_meta` stores the **commit** the index was built at, and `Index.builtFrom()` gives it back.
What is still missing is the comparison itself — nothing yet runs `git diff --name-only
<sha>..HEAD` and reparses only what it names.

⚠️ `commit_sha` is nullable, and the layer has to cope: content kept in a plain folder produces an
index with no commit, and then there is no starting point and a reindex costs a full parse. Less
useful, not broken.

Repainting after a commit costs *blocks changed + their direct dependents*. Never the documentation.

## Built, and not built

| | |
|---|---|
| ✅ | the fingerprint, the traffic light, the fifteen kinds |
| ✅ | dependency declared by block id (`data-depends`), and the reverse index |
| ⬜ | **subject** — linking by name instead of by number |
| ✅ | **weight** — `gravity`, `sensitivity` and `entails` on the kind, the matrix and the three signals of stage 3b, in `engine/core/impact.js` |
| 🟡 | **the wiring** — `holdrim index` stores a severity on every dependency pair and counts them by level, and `needsAPerson()` asks for the ones that reached a person. The **matrix only**: an index built from the files on disk has no earlier text, so the three signals of stage 3b wait for the git layer |
| ⬜ | **the respect** of a dependency |
| ⬜ | **stage 4** — the agent closing what did not reach |
| ⬜ | **the queue** — every open impact in the project, in one place |

The queue is what this funnel empties into.
