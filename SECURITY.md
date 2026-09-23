# Security

## Reporting

Report privately, through GitHub's **Report a vulnerability** button on the Security tab of this
repository. Please do not open a public issue for something exploitable.

Expect an acknowledgement within a week. This is a small project — that is the honest number, not
an SLA.

## What this software touches

Worth knowing before you run it:

- **It stores approvals, and approvals are evidence.** The database refuses `UPDATE` and `DELETE`
  through triggers, so nothing is erased even by someone opening the file with another program.
  People are disabled, never deleted, so every ✓ keeps the name of whoever gave it. What that
  means for personal data, and how a person is removed without breaking the trail:
  [`docs/PRIVACY.md`](docs/PRIVACY.md).
- **It serves your documentation over HTTP.** With password identity there is no edge protecting
  it: the guard is in the application. Without a session, every static page redirects to the login
  screen. That guard has a test in the HTTP contract suite, because its absence would be silent:
  every page would simply be served to anyone.
- **It stores passwords** with scrypt, per-user salt, and constant-time comparison. A test asserts
  the password does not appear in the raw database file.
- **The first-access password is random**, printed once, and must be changed at first login. There
  is no default account.
- **Exactly one owner**, and it comes from `HOLDRIM_OWNER`, never from a database column. Zero or
  two and the service refuses to start. Nobody but the owner resets or creates the owner's account.
- **The theme is untrusted input.** It lands inside CSS and HTML, so the brand colour is accepted
  only as hex and anything else is refused and logged.
- **The sign-in screen runs only what the server wrote into it.** Its Content-Security-Policy
  allows no script and no style without that response's nonce, new on every response, and no
  `unsafe-inline` anywhere. API answers carry a policy that runs nothing.
- **A documentation page runs the panel and nothing else.** The pages are served from the same
  origin as the API, so a script in one would run with the reader's session — for the owner, an
  approval in their name, and a lock after `holdrim sync`. Content is written by people and by
  agents, and an agent can be steered by text hidden in the documents it edits. So every page gets a
  nonce, new on every response, written into the panel's own tag and no other: an inline script, an
  `onerror=`, a script file added to the site, a `<base>` pointing elsewhere are all refused by the
  browser, and every other file of the site runs no script at all. The price: a page cannot bring
  scripts of its own.
- **The build is guarded against its own supply chain.** CI actions are pinned to commits, not
  tags; every checkout drops its token; no workflow can write to the repository or run on
  `pull_request_target`; `npm audit` blocks a known high-severity advisory in what ships; CodeQL
  reads the code weekly once the repository is public (GitHub offers it free only there);
  Dependabot proposes every update as a pull request that goes through the same proofs. `engine/tests/workflows.test.js` fails when a workflow loosens any of these.

## Running it safely

- **Put it behind TLS.** The session cookie is `Secure` outside development, which means it will not
  travel over plain HTTP anywhere but localhost.
- **Use a named volume for `/data`**, not a host folder. A host folder arrives with the host's
  ownership, and the process runs as an unprivileged user.
- **Never put a key in `holdrim.json`.** That file is versioned. Secrets go in the environment or
  in `.env`, which is git-ignored. The engine itself needs no model key: it calls no model.

## Known limits

- The agent's CLI can read the event store directly, bypassing the API — and therefore the cycle,
  the roles and the limits. It only reads, and it is marked in the code. The right fix is the agent
  having an identity of its own.
- Identity is password or an identity proxy. OIDC, Google and LDAP are not implemented.
- **Wrong passwords are counted per process, in memory.** Five free attempts per e-mail, then a
  wait that doubles up to fifteen minutes. With several instances each counts on its own, and a
  restart forgets the count, so the real ceiling is the one per instance times the instances. It is
  not in the user store on purpose: a write on every wrong password is a load anyone could cause
  without an account. If the service is reachable from the internet, rate-limit
  `POST /api/sign-in` at your edge as well.
