/**
 * Who can do what. The invariant the product's security rests on is the first test: exactly one
 * owner, and the service refuses to start otherwise. Everything else here is the shape of the
 * answer — capabilities, never product role names.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CAPABILITIES, capabilitiesOf, createRoles, parseLocks, isValidScope,
  parseAgents, AGENT_NEVER, rolesOf, refuseGrantsToAgents, agentByToken, byToken, addressOf,
  EVERYWHERE, scopeCovers, pageOfBlock, whereOf, lockCoverage,
} from '../core/roles.js';

test('exactly one owner: zero or two refuse to start', () => {
  assert.throws(() => createRoles('', ''), /HOLDRIM_OWNER needs exactly one e-mail \(got 0\)/);
  assert.throws(() => createRoles(undefined, 'a@example.org'), /exactly one e-mail \(got 0\)/);
  assert.throws(() => createRoles('a@example.org,b@example.org', ''), /exactly one e-mail \(got 2\)/);
  // The same address twice is one owner, not two: a copy-paste in a compose file must not take
  // the service down.
  assert.equal(createRoles('a@example.org, A@example.org', '').owner, 'a@example.org');
});

test('the owner is an admin by consequence, not by configuration', () => {
  const roles = createRoles('Owner@Example.org', '');
  assert.equal(roles.isOwner('owner@example.org'), true, 'case does not count in an e-mail');
  assert.equal(roles.roleOf('owner@example.org'), 'owner');
  for (const capability of CAPABILITIES) assert.equal(roles.can(capability, 'owner@example.org', EVERYWHERE), true, capability);
  assert.deepEqual(roles.admins, ['owner@example.org']);
});

test('an admin can do everything the owner does, except be the owner and lock', () => {
  const roles = createRoles('owner@example.org', ' ana@example.org ,bob@example.org,, ');
  assert.equal(roles.isOwner('ana@example.org'), false);
  assert.equal(roles.roleOf('ana@example.org'), 'admin');
  assert.equal(roles.can('approve', 'bob@example.org', EVERYWHERE), true);
  assert.equal(roles.can('triage', 'bob@example.org', EVERYWHERE), true);
  assert.equal(roles.can('people', 'bob@example.org', EVERYWHERE), true);
  // Only the owner's ✓ becomes a lock (AGENTS.md). An admin who could also lock would make every
  // admin an owner in every way that matters, which is exactly the invariant this file guards.
  assert.equal(roles.can('lock', 'bob@example.org', EVERYWHERE), false);
  assert.deepEqual([...roles.admins].sort(), ['ana@example.org', 'bob@example.org', 'owner@example.org']);
});

test('anybody else — a member — can only read, comment and request', () => {
  const roles = createRoles('owner@example.org', 'ana@example.org');
  for (const who of ['carl@example.org', '', null, undefined]) {
    assert.equal(roles.isOwner(who), false);
    assert.equal(roles.roleOf(who), 'member');
    assert.equal(roles.can('read', who, EVERYWHERE), true);
    assert.equal(roles.can('comment', who, EVERYWHERE), true);
    assert.equal(roles.can('request', who, EVERYWHERE), true);
    for (const capability of ['triage', 'approve', 'lock', 'people']) {
      assert.equal(roles.can(capability, who, EVERYWHERE), false, capability);
    }
  }
});

test('roleOf answers with the three names the engine ships, and no product role', () => {
  const roles = createRoles('owner@example.org', 'ana@example.org');
  assert.equal(roles.roleOf('OWNER@example.org'), 'owner');
  assert.equal(roles.roleOf('ana@example.org'), 'admin');
  assert.equal(roles.roleOf('carl@example.org'), 'member');
});

test('can throws on a capability outside the closed list, rather than silently answering false', () => {
  const roles = createRoles('owner@example.org', '');
  assert.throws(() => roles.can('superadmin', 'owner@example.org', EVERYWHERE), /"superadmin" is not a capability/);
  // A typo must not read as "no": a mistyped capability that quietly refused everyone would look
  // exactly like a correct refusal, and nobody would notice which one it was.
  assert.throws(() => roles.can('Approve', 'owner@example.org', EVERYWHERE), /"Approve" is not a capability/);
});

// ------------------------------------------------------------------ the mapping the whole issue is
/**
 * The three shipped roles hold EXACTLY the capabilities docs/ROLES.md gives them, no more and no
 * less. This is the test the issue's mutations are aimed at: widen or narrow one shipped role's set
 * in `engine/core/roles.js` and this is the named test that fails.
 *
 * `lock` is checked separately, through `can`, not through `capabilitiesOf`: it is never part of a
 * role's GRANTABLE set, owner included — see `docs/ROLES.md`, "Capabilities are the engine's", and
 * the test right after this one.
 */
test('the three shipped roles hold exactly the capabilities docs/ROLES.md gives them', () => {
  const grantable = CAPABILITIES.filter((c) => c !== 'lock');
  assert.deepEqual([...capabilitiesOf('owner')].sort(), grantable.sort(),
    'the owner\'s table entry is everything but lock — lock comes from identity, never from here');
  assert.deepEqual([...capabilitiesOf('admin')].sort(), grantable.sort(), 'admin is every capability but lock');
  assert.deepEqual([...capabilitiesOf('member')].sort(), ['comment', 'read', 'request'],
    'member is read, comment and request — and nothing that decides anything');
  // Asked the other way too: naming exactly what admin (and the table itself) must NOT hold, so a
  // mutation that adds a capability to admin's set, or puts lock back in the table for anyone, fails
  // here even if the sorted-array comparison above did not catch a reordering bug in some other
  // change.
  assert.equal(capabilitiesOf('admin').has('lock'), false);
  assert.equal(capabilitiesOf('owner').has('lock'), false);
});

test('capabilitiesOf refuses a role this version does not ship', () => {
  assert.throws(() => capabilitiesOf('superadmin'), /"superadmin" is not one of the roles this version ships/);
});

// ------------------------------------------------------------------ the lock cannot come from a table edit
/**
 * `Object.freeze` on a `Set` freezes the BINDING, not the Set's contents — `.add()` still works,
 * frozen or not. `capabilitiesOf` must therefore hand out a Set nobody else can reach again, and
 * `can('lock', …)` must never consult the table at all: this is the test that proves both, and the
 * one the issue's `capabilitiesOf('admin').add('lock')` mutation is aimed at.
 */
test('mutating what capabilitiesOf returns changes nothing the next caller reads', () => {
  const roles = createRoles('owner@example.org', 'ana@example.org');
  const mutated = capabilitiesOf('admin');
  mutated.add('lock');
  mutated.add('anything-else-nobody-granted');
  // The mutated Set is a copy: a fresh call reads the frozen source again, not what somebody did to
  // an earlier call's answer.
  assert.equal(capabilitiesOf('admin').has('lock'), false);
  assert.equal(roles.can('lock', 'ana@example.org', EVERYWHERE), false, 'an admin\'s ✓ must not have just become a lock');
});

// ------------------------------------------------------------------ #29: the validation core, kept
// ready for the settings screen. `isValidScope`'s tests prove the grammar directly because
// `HOLDRIM_LOCKS` (below) is a real caller of it today; a project role's own name format has no
// caller until the settings screen exists, so it is not built ahead of one any more — round 2 of
// #29's review (finding 11): a format nothing calls is untested by construction, whatever a test
// that calls it directly says.

test('isValidScope accepts exactly the three shapes docs/ROLES.md describes', () => {
  assert.equal(isValidScope('P03'), true, 'an exact page');
  assert.equal(isValidScope('P0*'), true, 'a page family, with its explicit star');
  assert.equal(isValidScope('P03.2.1'), true, 'a single block id');
  assert.equal(isValidScope('supplier:C02.1.4'), true,
    'a block id may carry a namespace ahead of it — docs/PROTOCOL.md\'s own data-depends example');
  assert.equal(isValidScope('P'), true, 'a one-letter page code is still an exact page, not a family');
  assert.equal(isValidScope(''), false, 'empty names nothing');
  assert.equal(isValidScope('P0**'), false, 'two stars is not a family');
  assert.equal(isValidScope('*P0'), false, 'a star that is not trailing is not a family either');
  assert.equal(isValidScope(42), false, 'not even a string');
});

/**
 * A namespace names ANOTHER project's BLOCK, never one of its bare pages — `supplier:C02.1.4` is a
 * scope, `supplier:C02` is not one of the three shapes docs/ROLES.md describes at all. Without the
 * `{1,8}` on `SCOPE_BLOCK_FORMAT`'s dot group demanding at least one segment, a namespaced page with
 * no block would slip through here — `PAGE_FORMAT` and `SCOPE_FAMILY_FORMAT` never accept the colon,
 * so this is the one case only `SCOPE_BLOCK_FORMAT`'s own cardinality decides.
 */
test('isValidScope rejects a namespace with no block id after it', () => {
  assert.equal(isValidScope('supplier:C02'), false);
});

/**
 * Round 2 of #29's review, finding 4: before this, the third branch was the bare `ID_FORMAT`
 * alphabet — any non-empty run of its allowed characters — so a handful of separators with nothing
 * real between them slipped through as a "block id". Each of these pins one such form as REJECTED,
 * against the tightened `SCOPE_BLOCK_FORMAT` and `SCOPE_FAMILY_FORMAT`.
 */
test('isValidScope rejects a separator, or a few of them, with nothing real between', () => {
  for (const bad of ['::', '.', '...', '-', ':', '1']) {
    assert.equal(isValidScope(bad), false, JSON.stringify(bad));
  }
});

test('isValidScope rejects a bare "*" — a wildcard naming every page has no written form', () => {
  assert.equal(isValidScope('*'), false);
});

/**
 * A single-letter family ("P*") is not a family at all in a scheme where a whole section shares its
 * first letter — it reaches every page in it, the same "all pages" `isValidScope` refuses outright
 * for a bare "*". `SCOPE_FAMILY_FORMAT` now demands at least two characters before the star, the same
 * length every real page code in this codebase's own examples already has ("D01", "T03a", "UC-01").
 */
test('isValidScope rejects a single-letter family — "P0*" is a family, "P*" is not', () => {
  assert.equal(isValidScope('P*'), false);
  assert.equal(isValidScope('P0*'), true, 'two characters before the star is still accepted');
});

/**
 * Round 3 of #29's review, finding 1: most of `SCOPE_BLOCK_FORMAT` had no test that could fail —
 * the tests above exercise its overall shape, but the anchors, the segment cardinality and the
 * namespace's own grammar were never individually pinned. Each string below is one thing that shape
 * must NOT be — a script tag hiding in a segment, an anchor missing so a suffix or prefix of the
 * string is enough, a namespace with no real name in front of its colon, a segment that is empty,
 * missing or one too many — and together they kill every mutant the finding names:
 *   - `P03.1<script>`            segment char class widened to `[^.]`
 *   - `<script>P03.1`            `^` removed (a valid SUFFIX would then be enough)
 *   - `<script>:P03.1`           namespace body widened to `[^.]*`
 *   - `.:P03.1`                  `^` removed (a valid SUFFIX would then be enough)
 *   - `P03.1 x`, `P03.1\n<x>`,
 *     `P03.<b>`                  segment char class widened to `[^.]`
 *   - `P03.`, `P03..1`           segment `{1,8}` loosened to `{0,8}` (an empty segment)
 *   - `.1`, `-.1`                root's first-char letter requirement made optional
 *   - `1ab:P03.1`                namespace first char widened to allow digits, or body → `[^.]*`
 *   - `P03.1.2.3.4.5.6.7.8.9`    `$` removed, or the segment count `{1,8}` loosened to `{1,}`
 * (ten segments, one past the eight `SCOPE_BLOCK_FORMAT` allows).
 */
test('isValidScope rejects every one of these — each pins one piece of SCOPE_BLOCK_FORMAT\'s grammar', () => {
  const bad = [
    'P03.1<script>', '<script>P03.1', '<script>:P03.1', '.:P03.1',
    'P03.1 x', 'P03.1\n<x>', 'P03.<b>',
    'P03.', 'P03..1', '.1', '-.1',
    '1ab:P03.1', 'P03.1.2.3.4.5.6.7.8.9',
  ];
  for (const scope of bad) assert.equal(isValidScope(scope), false, JSON.stringify(scope));
});

// ------------------------------------------------------------------ HOLDRIM_LOCKS
/**
 * `parseLocks` is the one place `HOLDRIM_LOCKS` becomes data, and `createRoles` calls it once, at
 * construction — a malformed entry refuses to start, the same as a malformed `HOLDRIM_OWNER`.
 */
test('parseLocks reads "email:scope" entries, separated by ";", trimmed', () => {
  assert.deepEqual(parseLocks(' ana@example.org : P0* ; bea@example.org:F12 '),
    [{ email: 'ana@example.org', scope: 'P0*' }, { email: 'bea@example.org', scope: 'F12' }]);
  assert.deepEqual(parseLocks(''), [], 'empty names nobody, not an error');
  assert.deepEqual(parseLocks(undefined), []);
  assert.deepEqual(parseLocks(null), []);
});

test('parseLocks lower-cases the address, exactly as the store does', () => {
  assert.deepEqual(parseLocks('Ana@Example.ORG:P03'), [{ email: 'ana@example.org', scope: 'P03' }]);
});

test('parseLocks refuses an entry with no colon, no scope', () => {
  assert.throws(() => parseLocks('ana@example.org'), /missing its scope/);
});

test('parseLocks refuses an entry with no address before the colon', () => {
  assert.throws(() => parseLocks(':P03'), /names no e-mail before the colon/);
});

/**
 * Round 2 of #29's review, finding 2: before this, ANY non-empty text before the colon was accepted
 * as "the e-mail" — a plain typo like "notanemail" would silently, and permanently, name a lock-holder
 * that can never sign in to use it. `isEmailAddress` is the SAME check `engine/api/users.ts` applies
 * when a real account is created (`engine/core/email.js`, finding 6) — not a stricter one invented
 * here, so the two doors agree on what an address is.
 */
test('parseLocks refuses an entry whose address is not one, by the same check account creation uses', () => {
  for (const bad of ['notanemail', 'a name with spaces', 'a@b@c', '@example.org', 'ana@']) {
    assert.throws(() => parseLocks(`${bad}:P03`), /is not an e-mail address/, JSON.stringify(bad));
  }
});

/**
 * Round 3 of #29's review, finding 3: before this, `isEmailAddress` alone decided the question, and
 * it is deliberately lenient (its own comment) because account creation shares it — `<ana@x>`,
 * `"ana"@x` and `ana@x.` all passed it, though none is a bare address a mail server would ever
 * deliver to. `parseLocks` asks a second, stricter question of its own now; `isEmailAddress` and
 * account creation are untouched — `engine/tests/email.test.js` still proves the lenient side.
 */
test('parseLocks refuses what isEmailAddress alone would let through: display forms, quoting, a trailing dot', () => {
  for (const bad of ['<ana@x>', '"ana"@x', 'ana@x.']) {
    assert.throws(() => parseLocks(`${bad}:P03`), /is not an e-mail address/, JSON.stringify(bad));
  }
});

/**
 * Each of these also has exactly one `@` with something on both sides, so `isEmailAddress` alone
 * accepts every one of them — only `RESERVED_EMAIL_CHARS` refuses them, one character of the class
 * at a time: `>`, `<`, `(` and `)`, `[` and `]`, and a bare `,` as if a second address had been
 * pasted in. `(c)ana@x` and `[ana]@x` are the realistic shapes (a comment wrapping the address, a
 * bracketed display form), but each carries BOTH characters of its pair, so removing either alone
 * from the class still leaves the other to catch it — neither pins its own character on its own.
 * `(ana@x`, `[ana@x` and `ana]@x` do: an unclosed comment, an unclosed bracket, and a bracket with
 * no opening partner, where the missing half never appears at all. `;` is not exercised here:
 * `parseLocks` already split `raw` on `;` before an entry reaches this check, so a `;` inside one is
 * never possible to construct as a test input (`RESERVED_EMAIL_CHARS`'s own comment, above, says why
 * the character stays in the class regardless).
 */
test('parseLocks refuses every other reserved character, one at a time', () => {
  for (const bad of [
    'ana@x>', '<ana@x', '(c)ana@x', '(ana@x', 'ana)@x',
    '[ana]@x', '[ana@x', 'ana]@x', 'ana,bo@x',
  ]) {
    assert.throws(() => parseLocks(`${bad}:P03`), /is not an e-mail address/, JSON.stringify(bad));
  }
});

test('parseLocks refuses a scope outside the known shapes', () => {
  for (const bad of ['', '**', 'P0**', '<script>', 'P0 3']) {
    assert.throws(() => parseLocks(`ana@example.org:${bad}`), /is none of a page, a page family/,
      JSON.stringify(bad));
  }
});

test('createRoles refuses to start on a malformed HOLDRIM_LOCKS, the same way as a bad owner', () => {
  assert.throws(() => createRoles('owner@example.org', '', 'ana@example.org'), /missing its scope/);
});

test('createRoles exposes isLockHolder from HOLDRIM_LOCKS, case-insensitively', () => {
  const roles = createRoles('owner@example.org', '', 'ANA@example.org:P0*; bea@example.org:F12');
  assert.equal(roles.isLockHolder('ana@example.org'), true);
  assert.equal(roles.isLockHolder('bea@example.org'), true);
  assert.equal(roles.isLockHolder('carl@example.org'), false);
});

/**
 * Round 2 of #29's review, finding 7: the test above stores `HOLDRIM_LOCKS` mixed-case but always
 * ASKS `isLockHolder` with an already-normalized address, so `lockHolders.has(normalized(e))` →
 * `lockHolders.has(e)` changed nothing it checked. This asks with a differently-cased, padded
 * address, which only the QUERY side's own normalization can still answer true for.
 */
test('isLockHolder normalizes the address it is ASKED with, not only the one it stored', () => {
  const roles = createRoles('owner@example.org', '', 'ana@example.org:P0*');
  assert.equal(roles.isLockHolder('  ANA@Example.ORG  '), true);
});

test('naming the owner in HOLDRIM_LOCKS is harmless', () => {
  assert.doesNotThrow(() => createRoles('owner@example.org', '', 'owner@example.org:P0*'));
  const roles = createRoles('owner@example.org', '', 'owner@example.org:P0*');
  assert.equal(roles.isLockHolder('owner@example.org'), true);
  assert.equal(roles.isOwner('owner@example.org'), true);
});

/**
 * `can('lock', …)` stays owner-only in this change, whatever `HOLDRIM_LOCKS` says: making a LOCKS
 * entry actually lock needs docs/ROLES.md section 3's session-and-credential-history rule, which is
 * not built. This is the test the "can('lock', e) stays owner-only" mutation is aimed at.
 */
test('a lock holder does not yet lock — can(\'lock\', …) still asks isOwner alone', () => {
  const roles = createRoles('owner@example.org', '', 'ana@example.org:P0*');
  assert.equal(roles.isLockHolder('ana@example.org'), true, 'the guard sees them');
  assert.equal(roles.can('lock', 'ana@example.org', EVERYWHERE), false, 'but can() does not, yet');
  assert.equal(roles.can('lock', 'owner@example.org', EVERYWHERE), true);
});

test('the owner locks and admin and member do not, whatever a caller does to what capabilitiesOf returned', () => {
  const roles = createRoles('owner@example.org', 'ana@example.org');
  // `capabilitiesOf` hands out a FRESH Set on every call (proved above), so this loop mutates three
  // throwaway copies, never the table itself — it is here to show that `can('lock', …)` does not care
  // either way: it never reads `capabilitiesOf` for `'lock'` at all (see `can`, in roles.js), so even
  // a caller that DID manage to poison the table would still get isOwner's answer, not the table's.
  // The table's own shape — that no role's entry carries `lock` in the first place — is the mapping
  // test above ("the three shipped roles hold exactly the capabilities docs/ROLES.md gives them").
  for (const role of ['owner', 'admin', 'member']) capabilitiesOf(role).add('lock');
  assert.equal(roles.can('lock', 'owner@example.org', EVERYWHERE), true);
  assert.equal(roles.can('lock', 'ana@example.org', EVERYWHERE), false, 'admin must not lock, whatever the table says');
  assert.equal(roles.can('lock', 'carl@example.org', EVERYWHERE), false, 'member must not lock, whatever the table says');
});

// ---------------------------------------------------------------- agents (docs/ROLES.md, section 4)
const AGENT = 'agent@example.org';

test('HOLDRIM_AGENTS: ";" separated, normalized, and checked as strictly as HOLDRIM_LOCKS', () => {
  assert.deepEqual(parseAgents(' Agent@Example.org ; ci@example.org;; '), [AGENT, 'ci@example.org']);
  assert.deepEqual(parseAgents(undefined), []);
  assert.throws(() => parseAgents(`${AGENT},ci@example.org`), /separated by ";", not ","/);
  for (const bad of ['not-an-address', '<agent@example.org>', 'agent@example.org.']) {
    assert.throws(() => parseAgents(bad), /HOLDRIM_AGENTS names .* not an e-mail address/, bad);
  }
  assert.throws(() => createRoles('owner@example.org', '', '', 'nobody'), /HOLDRIM_AGENTS names "nobody"/,
    'and createRoles refuses to start on it, like a bad owner');
});

test('isAgent is asked by identity, case-insensitively, and marks nobody else', () => {
  const roles = createRoles('owner@example.org', '', '', AGENT);
  assert.equal(roles.isAgent('  AGENT@example.ORG '), true);
  assert.equal(roles.isAgent('owner@example.org'), false);
  assert.equal(roles.isAgent('someone@example.org'), false);
});

test('the capabilities an agent never holds are exactly triage, approve, lock and people', () => {
  assert.deepEqual([...AGENT_NEVER].sort(), ['approve', 'lock', 'people', 'triage']);
  for (const c of AGENT_NEVER) assert.ok(CAPABILITIES.includes(c), c);
});

/**
 * The layer `can` holds on its own. `createRoles` is built directly, bypassing `rolesOf`'s start-up
 * refusal on purpose: the grant naming the agent HERE is exactly the one that refusal exists to stop,
 * and this proves `can` refuses it anyway, before the grant is read. As the owner, the agent is
 * granted every capability, `lock` included, by `isOwner` — the strongest grant there is — so each
 * refusal below can only come from the agent check, and one named test per capability says which
 * one a mutation dropped.
 */
for (const capability of ['triage', 'approve', 'lock', 'people']) {
  test(`can refuses an agent ${capability}, even when a grant names it the owner`, () => {
    const roles = createRoles(AGENT, '', `${AGENT}:A01`, AGENT);
    assert.equal(roles.isOwner(AGENT), true, 'the grant is really there');
    assert.equal(roles.can(capability, AGENT, EVERYWHERE), false);
  });
}

test('can refuses an agent that HOLDRIM_ADMINS names, and the admin beside it keeps everything', () => {
  const roles = createRoles('owner@example.org', `${AGENT},ana@example.org`, '', AGENT);
  for (const c of ['triage', 'approve', 'people']) {
    assert.equal(roles.can(c, AGENT, EVERYWHERE), false, `the agent, ${c}`);
    assert.equal(roles.can(c, 'ana@example.org', EVERYWHERE), true, `the admin, ${c}`);
  }
});

test('an agent keeps read, comment and request: it is refused deciding, not taking part', () => {
  const roles = createRoles(AGENT, '', '', AGENT);
  for (const c of ['read', 'comment', 'request']) assert.equal(roles.can(c, AGENT, EVERYWHERE), true, c);
  // The owner-not-an-agent case still holds every capability: the check keys on the identity alone.
  const plain = createRoles('owner@example.org', '', '', AGENT);
  for (const c of CAPABILITIES) assert.equal(plain.can(c, 'owner@example.org', EVERYWHERE), true, c);
});

/**
 * The other layer, on its own: `rolesOf`, the one way from configuration to roles for the server's
 * boot and every CLI command, refuses a grant that names an agent. One case per variable, since each
 * is its own branch.
 */
const grantsToAgents = [
  { variable: 'HOLDRIM_OWNER', config: { owner: AGENT, admins: '', locks: '', agents: AGENT } },
  { variable: 'HOLDRIM_ADMINS', config: { owner: 'owner@example.org', admins: AGENT, locks: '', agents: AGENT } },
  { variable: 'HOLDRIM_LOCKS', config: { owner: 'owner@example.org', admins: '', locks: `${AGENT}:A01`, agents: AGENT } },
];
for (const { variable, config } of grantsToAgents) {
  test(`rolesOf refuses to start when ${variable} names an agent`, () => {
    assert.throws(() => rolesOf(config),
      new RegExp(`${variable} names ${AGENT}, which HOLDRIM_AGENTS marks as an agent`));
  });
}

test('rolesOf starts when no grant names an agent, and names every grant that does', () => {
  const roles = rolesOf({ owner: 'owner@example.org', admins: 'ana@example.org', locks: 'bea@example.org:A01', agents: AGENT });
  assert.equal(roles.isAgent(AGENT), true);
  assert.throws(() => refuseGrantsToAgents(createRoles('owner@example.org', AGENT, `${AGENT}:A01`, AGENT), `${AGENT}:A01`),
    /HOLDRIM_ADMINS names agent@example.org, HOLDRIM_LOCKS names agent@example.org, which/);
  // The owner is in `admins` by consequence; naming them once, as the owner, is the honest message.
  assert.throws(() => rolesOf({ owner: AGENT, admins: '', locks: '', agents: AGENT }),
    (e) => !/HOLDRIM_ADMINS/.test(e.message));
});

// ---------------------------------------------------------------- agent tokens (issue #122)
//
// The second source of the agent flag: an identity the server built after checking an agent token.
// None of these addresses is in HOLDRIM_AGENTS, so every refusal below can only come from the token.

test('a token identity is an agent, whatever HOLDRIM_AGENTS says, and its bare address is not', () => {
  const roles = createRoles('owner@example.org', 'ana@example.org', '', '');
  assert.equal(roles.isAgent(agentByToken('bot@example.org')), true, 'the token alone makes it an agent');
  assert.equal(roles.isAgent('bot@example.org'), false, 'the same address, signed in as a person, is not');
});

test('can refuses a token of an admin\'s address triage, approve, lock and people, and keeps read, comment and request', () => {
  // The admin's address, through a token: `ROLE_CAPABILITIES` grants it everything but `lock`, so a
  // refusal here comes from the agent check, before any grant is read — which is the layer a
  // `roles.isAgent` blind to tokens would take away.
  const roles = createRoles('owner@example.org', 'ana@example.org', '', '');
  const token = agentByToken('ana@example.org');
  for (const c of AGENT_NEVER) assert.equal(roles.can(c, token, EVERYWHERE), false, c);
  for (const c of ['read', 'comment', 'request']) assert.equal(roles.can(c, token, EVERYWHERE), true, c);
  assert.equal(roles.can('approve', 'ana@example.org', EVERYWHERE), true, 'the admin signed in as a person keeps approving');
});

test('a token issued for the owner\'s address is never the owner, and holds none of what the owner alone holds', () => {
  // A handover can make the owner's address one a token was issued for. `isOwner` is what every
  // owner-only guard asks — who issues a token, who resets the owner's account — so it has to say no.
  const roles = createRoles('owner@example.org', '', '', '');
  const token = agentByToken('Owner@Example.org');
  assert.equal(roles.isOwner(token), false);
  for (const c of AGENT_NEVER) assert.equal(roles.can(c, token, EVERYWHERE), false, c);
  assert.equal(roles.isOwner('owner@example.org'), true, 'the owner signed in is still the owner');
});

test('only an identity built by agentByToken reads as one: an address never does, whatever it holds', () => {
  assert.equal(byToken(agentByToken('bot@example.org')), true);
  assert.equal(byToken('bot@example.org'), false);
  assert.equal(byToken({ email: 'bot@example.org', byToken: 'true' }), false, 'a string "true" is not the flag');
  assert.equal(byToken(null), false);
  assert.ok(Object.isFrozen(agentByToken('bot@example.org')), 'a checked identity cannot be edited into another');
  assert.equal(agentByToken(' Bot@Example.org ').email, 'bot@example.org', 'normalized like every other address');
  assert.equal(addressOf(agentByToken('bot@example.org')), 'bot@example.org');
  assert.equal(addressOf('ana@example.org'), 'ana@example.org');
  assert.equal(addressOf(null), null, 'a missing viewer stays missing, never a throw');
});

test('a token identity holds a member\'s role, even on an address HOLDRIM_ADMINS grants', () => {
  // A restart can grant the address of a token already issued. The role is what `/api/me` shows and
  // what `can` looks capabilities up in, so the token reads as what it is: an agent, a member's grants.
  const roles = createRoles('owner@example.org', 'ana@example.org', '', '');
  assert.equal(roles.roleOf(agentByToken('ana@example.org')), 'member');
  assert.equal(roles.roleOf('ana@example.org'), 'admin', 'the admin signed in as a person is still an admin');
});

// ------------------------------------------------------------------ scopes, asked with the place in hand (#33)

test('can throws when it is not told where — a forgotten place is not an answer about everywhere', () => {
  const roles = createRoles('owner@example.org', 'ana@example.org');
  assert.throws(() => roles.can('approve', 'owner@example.org'), /needs to know where it is asked/);
  assert.throws(() => roles.can('read', 'carl@example.org', {}), /needs to know where it is asked/);
  assert.throws(() => roles.can('triage', 'ana@example.org', { page: '' }), /needs to know where it is asked/);
  assert.throws(() => roles.can('lock', 'owner@example.org', null), /needs to know where it is asked/);
  assert.equal(roles.can('approve', 'owner@example.org', { page: 'P03' }), true);
  assert.equal(roles.can('approve', 'ana@example.org', { block: 'P03.1.1' }), true);
  assert.equal(roles.can('people', 'ana@example.org', EVERYWHERE), true);
});

test('a family scope covers P01 to P09 and nothing that merely begins with P', () => {
  for (const page of ['P01', 'P05', 'P09', 'P0a', 'P0-']) assert.equal(scopeCovers('P0*', { page }), true, page);
  for (const page of ['P', 'P0', 'Q01', 'P010', 'P01a', 'p01']) assert.equal(scopeCovers('P0*', { page }), false, page);
  assert.equal(scopeCovers('P0*', { block: 'P07.2.1' }), true, 'a block of a covered page');
  assert.equal(scopeCovers('P0*', { block: 'P010.2.1' }), false, 'a block of a page the family does not reach');
});

test('a block scope covers its own block, and neither a page question nor the blocks under it', () => {
  assert.equal(scopeCovers('P03.2', { block: 'P03.2' }), true);
  assert.equal(scopeCovers('P03.2', { page: 'P03' }), false, 'a page-level question');
  assert.equal(scopeCovers('P03.2', { block: 'P03.2.1' }), false, 'a descendant');
  assert.equal(scopeCovers('P03.2', { block: 'P03.3' }), false, 'a neighbour');
  assert.equal(scopeCovers('P03.2', { page: 'P03', block: 'P03.2.1' }), false, 'a descendant, named with its page');
});

test('a page scope covers a block by the block\'s own page, whatever page the client named beside it', () => {
  assert.equal(pageOfBlock('P03.2.1'), 'P03');
  assert.equal(scopeCovers('P03', { block: 'P03.2.1' }), true);
  assert.equal(scopeCovers('P03', { page: 'P09', block: 'P03.2.1' }), true, 'the named page is not trusted to widen');
  assert.equal(scopeCovers('P09', { page: 'P09', block: 'P03.2.1' }), false, 'nor to narrow onto another page');
  assert.equal(scopeCovers('P03', { page: 'P03' }), true);
  assert.equal(scopeCovers('P03', { page: 'P030' }), false);
  assert.deepEqual(whereOf({ page: 'P09', block: 'P03.2.1' }), { block: 'P03.2.1' });
  assert.deepEqual(whereOf({ page: 'P09', block: null }), { page: 'P09' });
});

test('a scoped grant never answers a question asked about everywhere; an unscoped one does', () => {
  for (const scope of ['P03', 'P0*', 'P03.2.1']) assert.equal(scopeCovers(scope, EVERYWHERE), false, scope);
  assert.equal(scopeCovers(null, EVERYWHERE), true);
  assert.equal(scopeCovers(null, { block: 'Z99.1' }), true);
  assert.equal(scopeCovers('not a scope!', { page: 'P03' }), false, 'a shape none of the three: nothing');
  // No caller ever hands scopeCovers a non-string scope (parseLocks and isValidScope see to that),
  // but the fallback below still fails closed rather than throwing if one ever did.
  assert.equal(scopeCovers({ not: 'a string' }, { page: 'P03' }), false, 'a non-string scope: nothing, not a throw');
});

test('can refuses an agent triage and approve on the very page and block a grant would cover', () => {
  // HOLDRIM_ADMINS names the agent: `rolesOf` refuses that at start; `can` still denies on its own.
  const roles = createRoles('owner@example.org', 'agent@example.org', '', 'agent@example.org');
  for (const where of [{ page: 'P03' }, { block: 'P03.2.1' }, EVERYWHERE]) {
    assert.equal(roles.can('triage', 'agent@example.org', where), false, JSON.stringify(where));
    assert.equal(roles.can('approve', 'agent@example.org', where), false, JSON.stringify(where));
    assert.equal(roles.can('request', 'agent@example.org', where), true, JSON.stringify(where));
  }
});

test('lockCoverage says what each HOLDRIM_LOCKS scope reaches on the site, and an empty list when nothing', () => {
  const ids = ['A01.1.1', 'A01.2', 'A02.1.1', 'A10.1'];
  assert.deepEqual(lockCoverage(parseLocks('a@example.org:A0*; b@example.org:A02; c@example.org:A01.2; d@example.org:P0*; e@example.org:A01.2.9'), ids), [
    { scope: 'A0*', reaches: ['A01', 'A02'] },
    { scope: 'A02', reaches: ['A02'] },
    { scope: 'A01.2', reaches: ['A01.2'] },
    { scope: 'P0*', reaches: [] },
    { scope: 'A01.2.9', reaches: [] },
  ]);
});
