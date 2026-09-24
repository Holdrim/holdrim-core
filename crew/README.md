# The crew

How several AI agents, from different vendors, work on this repository at once, and how a person
steers them from wherever they are, a phone included. This is about the people and agents who
**build** Holdrim. The roles a Holdrim deployment gives *its* users are a different thing, in
`docs/ROLES.md`.

The rule this whole folder rests on: **a role is a file, not a session.** Any agent that reads a
role file and follows it can play that role, and swapping Claude Code for ChatGPT, Gemini or Grok in
a role is a matter of which app the person opens, not of rebuilding anything. State never lives in
an agent's memory: it lives in the repository — issues, pull requests, labels — so an agent that
arrives cold, or replaces another halfway, reads where things stand and carries on.

## The roles

| File | Does | Never does |
|---|---|---|
| [`orchestrator.md`](orchestrator.md) | turns the owner's intent into issues, assigns them, keeps the board moving, merges what passed the gate | writes the code of a feature |
| [`developer.md`](developer.md) | takes one issue, delivers one pull request through the gate | merges, changes settings, touches another developer's item |
| [`reviewer.md`](reviewer.md) | reviews a pull request made by an agent of **another** vendor, by lens and severity | reviews its own work, pushes to the pull request it reviews |
| [`specialist.md`](specialist.md) | one kind of output others cannot make well — images, screens, video, copy — attached to an issue | merges, touches code outside what the issue names |

One agent may play several roles over time; never two at once on the same item. The owner is not a
role: the owner decides, and anything labelled `needs:owner` waits for them.

## How they talk

Only through the repository. Whose turn it is lives in labels:

- `needs:<agent>` — for example `needs:claude`, `needs:chatgpt`, `needs:gemini`, `needs:grok` — that
  agent has to act;
- `needs:owner` — a decision only the owner can make.

Finishing a turn means: remove your own label, add the next one, and leave a comment that
@mentions who is next and says exactly what you need from them. No agent runs all the time, so the
owner is the clock: "there is something for you on GitHub" is how an agent is woken.

## Accounts and rights

Each agent works through its own GitHub account, a machine account that says in its profile who
operates it. Rights follow the role, never the vendor and never a sponsorship:

| Role | GitHub permission |
|---|---|
| owner | admin |
| orchestrator | maintain, or the owner's account when the orchestrator is the owner's own session |
| developer | write, or none (fork and pull request) for an outside contributor |
| reviewer | read is enough: a review is a comment |
| specialist | none: its output is attached to an issue |

The branch rules on `main` — a pull request, green CI, linear history, no force push — are meant to
bind everyone, administrators included, so that no role, the orchestrator's included, can land code
the gate did not see. Whether administrators may bypass them is a setting of the repository, and
the owner's to keep switched off.

## Starting an agent in a role

Paste this into the agent, whatever its vendor, replacing the two words in capitals:

```
You play the ROLE role in the Holdrim crew, as agent NAME. Read crew/README.md and
crew/ROLE.md in github.com/Holdrim/holdrim-core, then AGENTS.md and CONTRIBUTING.md, and follow
them. Talk to me in Brazilian Portuguese; write everything in the repository in English. Start by
looking for issues and pull requests labelled needs:NAME, and tell me what you find.
```
