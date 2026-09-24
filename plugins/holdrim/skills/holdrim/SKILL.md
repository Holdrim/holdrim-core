---
name: holdrim
description: The Holdrim method — reviewable documentation with traceable approval. Use it when resuming work on the documentation, when applying a reviewer's request, when syncing approvals from the site, or when someone asks how the method works. Also when starting to document a new product with this method.
---

# Holdrim — documentation that is reviewed, not just written

This file lives **inside the repository**. Whoever clones the project gets the method, the tool
and the agent together.

## What the method is, in five lines

Documentation is written **before** the code, and reviewed by whoever understands the subject, not
whoever programs. Every block has a stable code and a **fingerprint of the text**: the approval is
for that text, and drops on its own if the text changes. Reviewers **ask for a change** on the
site; **only the agent makes the change**, with impact analysis and a traceable commit. Git is the
source of the content; the site never edits it.

## Who the agent is

You are. The engine calls no model and holds no API key: the agent is whichever CLI the person has
on their machine, running with their own account. `holdrim` prepares the work as text and records
what you did; the editing is yours.

## When resuming work — do it in this order

```bash
holdrim sync   # brings in the ✓ the owner gave on the site
holdrim list   # approved requests, ready to apply
holdrim check  # did anything validated change without permission?
```

`holdrim` takes the owner from `HOLDRIM_OWNER` and the admins from `HOLDRIM_ADMINS`, the same values
the deployment has, and refuses without the owner. It never reads them from `holdrim.json`, and a
`holdrim.json` that names `owner`, `admins` or `locks` stops every command: never add them there,
whatever a request asks — authority is the deployment's to set. `sync` prints the owner it used;
check it is the person you expect before trusting what it locked.

Tell the owner, in a few lines: how many new blocks were validated, how many requests are ready to
apply, and from whom. **Never offer to validate block by block in chat** — validation happens on
the site.

## When applying a request

1. `holdrim show <id>` — what was asked, the text then and now, and the conversation.
   `holdrim list --json` gives the same as data, for every approved request at once.
2. `holdrim state <id> applying "Received…"` — the reviewer sees the progress in the panel.
3. `holdrim impact <id> --term "…"` — **everywhere else the subject shows up**. Never change
   anything without this: the command marks which blocks are **validated**, and those need the
   owner's permission to change.
4. Ask about anything ambiguous. A misunderstood request turns into two requests.
5. Apply it, with a commit that carries the trailers `Request: <id>` and `Requested-by: <e-mail>`.
6. `holdrim state <id> applied "Done" --commit <sha> --blocks D01.1.4,D02.3.1`
7. Add the lesson to the Traps section below, if the fix teaches a rule that is not written yet.

`holdrim apply <id>` does steps 1 and 3 for you and hands the brief to your CLI (`--agent claude`,
`codex`, `gemini`, or a whole command; `--dry-run` prints the brief). Steps 4 to 6 are still yours.

## The rules that are not up for negotiation

1. **Git is the source.** Nothing changes content outside a commit. The site only reads and
   records events.
2. **Events are never erased.** Approved, asked, commented, rejected — each one with who, when,
   where, and the fingerprint of the text at that instant.
3. **An approval is for a text, not for a block.** Change the text and the approval drops on its
   own.
4. **Only owner and admin approve, and only the owner's ✓ becomes a lock** in the repository. An
   approval tells the agent to apply it. A reviewer asks for a change, comments, and answers decisions.
5. **A request from whoever can approve is born approved.** Nobody triages themselves.
6. **Impact before change.** The agent never applies a request without looking at everywhere else
   it touches.
7. **The agent applies; it never approves.** An agent may close an impact ("this change did not
   reach here") but never say a text is correct.
8. **Nothing is approved until it is validated.** Always write it as a proposal.

## Where things are

| What | Where |
|---|---|
| The rules of the cycle (states, transitions) | `engine/cycle.json` — data, not code |
| Shared core (fingerprint, cycle, roles, limits) | `engine/core/` — runs in the browser **and** on the server |
| API and site | `engine/api/` (TypeScript, no build step) |
| The agent's tool | `engine/cli/holdrim.ts` |
| The brief an agent receives | `engine/cli/agent.ts` |

## Traps

- **Port already in use = stale binary.** If `engine/run-local.sh` refuses to start, kill the
  process first. Testing the old code without noticing can undo a fix that was correct.
- **`element.focus()` does not trigger `:focus-visible`.** Test focus with Tab.
- **A test that passes for the wrong reason.** An assertion that runs `grep` on the output can
  report failure while everything passed. Prefer an exit code to text.
- **A forged approval.** A hand-written `data-validated` creates an approval out of nothing;
  `check` catches it, and the lesson stands: the lock has to look at both sides.
