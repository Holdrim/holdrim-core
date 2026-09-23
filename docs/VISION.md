# Holdrim — living documentation

> Proposal · `2026-09-20` · nothing here is finished, and much of it has not been started.

## Mission

**A method, and a platform for it, with which anyone can build a complex system that lasts, scales
and stays easy to maintain — because its business rules are understood through its documentation,
and the documentation is the centre of the work, not a by-product of it.**

## Vision

**Building software is for everyone.** If you know what you want, you explain it to the computer,
and that explanation is the program. What changes is the language: not the symbols few people could
read, but plain text, written until no second reading is possible — every term defined, every rule
proved, every dependency declared. Holdrim is where that text is kept honest.

Systems built this way are not islands. A cash register built on Holdrim and the sales system of its
supplier, built on Holdrim too, describe their contracts in the same shape, so connecting them is
reading two documents that already agree — a plugin, not a project. That protocol does not exist
yet; its design is written down to be argued with (`docs/PROTOCOL.md`), and it is on the roadmap
(`ROADMAP.md`).

## The problem

Product documentation dies in a well-known way: somebody writes it, somebody approves it, and six
months later nobody knows what is still true. Not because people are careless — because **nothing
warns them**. The document does not know the code changed. The use case does not know the rule
changed. The diagram does not know the screen changed.

The result is always the same: documentation turns into archaeology, and the decision goes back to
living only in the head of whoever was there.

## The idea in one sentence

**Documentation is generated from the business and validated by a human — and every piece of it can
say whether it can still be trusted.**

This is not "generate documentation automatically". That already exists, and it produces text
nobody reads. This is generating it **and keeping it honest**: when something changes, everything
that depended on it raises its hand.

## The traffic light

The heart of the method. Every block of documentation has a state, and the state is computed —
never declared by anyone.

| | State | Meaning | What to do |
|---|---|---|---|
| ⚪ | not validated | nobody has looked yet | read and approve, or ask for a change |
| 🟢 | validated | approved, and nothing has changed since | nothing |
| 🟡 | stale | **this** block's text changed after the ✓ | re-approve the new text |
| 🔴 | suspect | the text is unchanged, but something it **depends on** moved | check whether it still holds |

Red is what separates this method from version control with a badge. It catches the case nobody
notices while reading the page, because **on the page, nothing changed**.

### Why red is a question, not an error

The engine does not know the block became wrong. It knows it became **suspect**, and that a human
needs to look. Treating it as an error would make the first wave of false positives push somebody
into switching the check off — and then the whole lock is pointless.

*Status:* ⚪ ⟶ 🟢 ⟶ 🟡 implemented from the start; 🔴 implemented on `2026-09-20`.

## What the agent writes, and what the human does

```
  the business changes
        │
        ▼
  ┌─────────────────────┐
  │ the agent writes    │   text, flowchart, C4, use case, model
  │ or updates          │
  └─────────┬───────────┘
            │
            ▼
  ┌─────────────────────┐
  │ everything that     │   🟡 and 🔴 show up on their own
  │ depended on it      │
  │ raises its hand     │
  └─────────┬───────────┘
            │
            ▼
  ┌─────────────────────┐
  │ the human checks    │   ✓ or "this one is wrong, because…"
  │ and approves        │
  └─────────────────────┘
```

The machine never approves. **Approval is human, always** — it is the one part of the method that
does not get automated, and it is where all the value of the rest comes from.

### Whose agent it is

**Decision of `2026-09-22`:** the engine calls no model and holds no API key. The agent is
whichever CLI the person already has on their machine — Claude Code, Codex, Gemini — running with
their own account, on their own subscription.

The engine's side of the bridge is small. `holdrim list --json` is the queue of approved requests as
data; `holdrim apply <id>` writes the brief for one request and hands it to that CLI
(`engine/cli/agent.ts`); `holdrim state <id> applied --commit <sha>` closes the loop with the commit
that carried it. The plugin in `plugins/holdrim/` teaches Claude Code the method, and
`examples/hello-world/AGENTS.md` teaches any other agent.

The agent **applies** a request the owner or an admin approved, and it may **close** an impact —
"this change did not reach here". It never **approves**: only the owner's ✓ becomes a lock. And
nothing runs unattended on somebody's subscription: it is always a person, at their own computer,
starting their own tool. A service calling a model around the clock would be a different product,
with a key to guard and a bill nobody chose.

## The documentation categories

The template (`examples/template/`) is the skeleton a project copies. It grows as the method
matures; today it has eleven sections, and every one of them has a page to copy.

| Section | What it holds | Status |
|---|---|---|
| **Kinds** | eight of the fifteen kinds of content, each demonstrating itself; the catalogue is `engine/core/kinds.js` | ✅ |
| **Discovery** | why it exists, who for, what changes if it works | ✅ |
| **Roles** | who can do what, the capability table, who approves | ✅ |
| **Design system** | the values, the components, and what is not done here | ✅ |
| **Screens** | what the person came to do, what they see, what they can do, the prototype | ✅ |
| **Decisions** | what is still undecided, with an owner and a deadline | ✅ |
| **Stack** | what the system is made of, and why | ✅ |
| **Data model** | the entities, the relationships, the data dictionary | ✅ |
| **Use cases** | the flow end to end, with what travels at each step | ✅ |
| **Architecture (C4)** | context, containers, components, code | ✅ |
| **Contracts** | the APIs, the events, what goes in and what comes out | ✅ |

## The diagrams

**Decision:** a diagram is **text**, not an image. Mermaid, PlantUML or equivalent — something that
gets versioned, gets compared in a diff, and has a fingerprint computed from it.

This is not an aesthetic preference. A PNG has no useful fingerprint: any recompression changes the
bytes without changing the meaning, and no change of meaning is legible in a diff. A diagram in
text enters the traffic light like any other block — and it is the only way a flowchart turns 🟡
when the flow it draws has changed.

*Status:* 🟨 half. `diagram` is one of the fifteen kinds, it demands to be text, and a diagram in
text enters the lock like any other block. What does not exist is **generating** one — today a human
draws it, and the engine only keeps it honest.

## What the prototype is, and what it is not

**The owner's decision, `2026-09-20`:** the screen prototypes live in **HTML and CSS**, not in the
product's framework.

The reason is the same as for the diagram in text: whoever adopts the method may use React, Vue,
Svelte or none of them. Holdrim cannot impose a framework on anybody's documentation. The review
panel — which belongs to **the engine** — is React; the documented screen belongs to whoever writes
it.

## Who does what

| | Holdrim | The project adopting it |
|---|---|---|
| The rule | cycle, traffic light, lock by fingerprint, roles | — |
| The tool | panel, CLI, Docker image | — |
| The template | the empty skeleton | the filled-in content |
| The brand | — | colour, logo, name |
| The people | — | who approves, who reviews |
| The agent | the brief, and `holdrim apply` to hand it over | the CLI, and the account it runs on |

**Method improvements come up here. Content stays down there.** That is the rule that keeps the
engine from turning into somebody's product.

## What does not exist yet

In order of how much is missing:

1. **Generation.** Today a human writes, or asks for a change and the agent applies it once it is
   approved; the tool keeps it. The vision is the agent writing the first draft from the business,
   and the human correcting it — still the person's own agent, never a model the engine calls.
2. **Generating diagrams.** A diagram in text is versioned and under the traffic light today;
   nothing draws one.
3. **Automatic dependencies.** Today `data-depends` is written by hand. The tool ought to propose
   them: two blocks talking about the same term probably depend on each other.

## The name

"Holdrim" is the name: to *hold* the *rim* — the edge a text is not allowed to move past without
somebody noticing. That is what an approval does here: it holds one exact text, and the moment the
text crosses that edge, the light says so.

What matters is not the name but the part of the method it sits on: not the order in which
documentation and code are written, but the documentation **staying true** afterwards.
