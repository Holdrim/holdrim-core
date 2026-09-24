**Kind:** <!-- one of: feature, fix, security, docs, tests, tooling, refactor, lessons,
contributor-experience (CONTRIBUTING, "Kinds of pull request") -->
**Tier:** <!-- 1, 2 or 3 (CONTRIBUTING, "And the six lenses"); when in doubt, the higher -->
**Made with:** <!-- the agent and the model, as its vendor names them, or "by hand" -->
**Closes:** <!-- #issue, if there is one -->

## What changes, and why it was needed

<!-- The why matters more. If there was an accident behind this, describe it — that is what stops
     someone from undoing the fix later. -->

## Proof

The five proofs, as CONTRIBUTING lists them:

- [ ] `npx tsc --noEmit` clean
- [ ] `npx eslint engine examples` clean
- [ ] `npm test` green
- [ ] `bash engine/test-contract.sh` ends in "all good"
- [ ] `bash scripts/check-language.sh --comments=en $(git ls-files '*.ts' '*.js' '*.sh')` clean
- [ ] `npm run browser` green, if the panel or the API changed
- [ ] the six lenses came back with no blocker (CONTRIBUTING, "And the six lenses") — say below
      what they found and what you did with it

**If this touches a lock** — the fingerprint, the traffic light, approval validity, the triggers:

- [ ] I broke my own test on purpose and watched it fail

Say what you broke and what the failure looked like. A green test nobody has seen fail proves
nothing.

## What this does not cover

<!-- Every change has an edge it does not handle. Naming it here is worth more than pretending
     there is none. -->
