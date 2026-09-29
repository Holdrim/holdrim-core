/**
 * The project's own roles (docs/ROLES.md, sections 1, 2 and 5; issue #36): what a project role may
 * hold and be called (`engine/core/roles.js`), what the `_roles` events add up to
 * (`engine/api/role-grants.ts`), and what `can` answers with those grants in force.
 *
 * That only the owner writes them, that `POST /events` refuses all three, that a grant is in force
 * from the next request and gone after its revocation, and that a stored grant naming an agent is
 * ignored and logged without the service refusing to start, are proved against a real server by
 * `engine/test-contract.sh`; in a browser, by `engine/test-browser.js`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  createRoles, agentByToken, EVERYWHERE, PROJECT_CAPABILITIES, CAPABILITIES, isValidRoleName,
  projectCapabilitiesOf, MAX_ROLE_NAME,
} from '../core/roles.js';
import {
  ROLES_PAGE, ROLE_DEFINED, ROLE_GRANTED, GRANT_REVOKED, definedEvent, grantedEvent, revokedGrantEvent,
  projectRolesOf, grantsOfPerson,
} from '../api/role-grants.ts';
import { EVENT_TYPES, stored } from '../api/types.ts';

const ROOT = new URL('../../', import.meta.url).pathname;
const OWNER = 'owner@example.org';
const ADMIN = 'admin@example.org';
const BEA = 'bea@example.org';
const CAL = 'cal@example.org';
const BOT = 'bot@example.org';
const BEA_ID = `p_${'b'.repeat(24)}`;
const CAL_ID = `p_${'c'.repeat(24)}`;
const deployment = createRoles(OWNER, ADMIN, '', BOT);

// ---------------------------------------------------------------- what a project role may hold
test('a project role holds any of the grantable capabilities but people, and never lock', () => {
  assert.deepEqual([...PROJECT_CAPABILITIES], ['read', 'comment', 'request', 'triage', 'approve']);
  assert.ok(!PROJECT_CAPABILITIES.includes('lock') && !PROJECT_CAPABILITIES.includes('people'));
  assert.ok(PROJECT_CAPABILITIES.every((c) => CAPABILITIES.includes(c)), 'cut from the closed list, never beside it');
  assert.throws(() => PROJECT_CAPABILITIES.push('people'), 'frozen: nobody adds people to it at run time');
});

test('projectCapabilitiesOf takes a list whole, in the list\'s own order, or refuses it', () => {
  assert.deepEqual(projectCapabilitiesOf(['approve', 'triage']), ['triage', 'approve']);
  assert.deepEqual(projectCapabilitiesOf(['read']), ['read']);
  for (const refused of [[], ['lock'], ['people'], ['triage', 'lock'], ['triage', 'people'], ['admin'],
    ['triage', 'triage'], [' triage'], [1], 'triage', null, undefined, { 0: 'triage', length: 1 }]) {
    assert.equal(projectCapabilitiesOf(refused), null, JSON.stringify(refused));
  }
});

test('a role\'s name is lower-case words, and never one the engine ships', () => {
  for (const name of ['clinical lead', 'legal-review', 'r2', 'a', 'x'.repeat(MAX_ROLE_NAME)]) {
    assert.ok(isValidRoleName(name), name);
  }
  for (const name of ['', 'Lead', ' lead', 'lead ', 'clinical  lead', '2nd', '-x', 'owner', 'admin', 'member',
    '<b>lead</b>', 'lead;x', 'x'.repeat(MAX_ROLE_NAME + 1), null, 3]) {
    assert.equal(isValidRoleName(name), false, JSON.stringify(name));
  }
});

// ---------------------------------------------------------------- `can`, with grants in force
const grant = (email, capabilities, scope = null) => ({ email, capabilities, scope });

test('a grant gives its capabilities to its person, where its scope reaches, and nowhere else', () => {
  const roles = deployment.withProjectGrants([grant(BEA, ['approve'], 'A01')]);
  assert.equal(deployment.can('approve', BEA, { block: 'A01.1.1' }), false, 'setup: a member cannot approve');
  assert.equal(roles.can('approve', BEA, { block: 'A01.1.1' }), true);
  assert.equal(roles.can('approve', 'Bea@Example.org ', { block: 'A01.1.1' }), true, 'the address as the store normalizes it');
  assert.equal(roles.can('approve', BEA, { page: 'A01' }), true);
  assert.equal(roles.can('approve', BEA, { block: 'A02.1.1' }), false, 'not outside its scope');
  assert.equal(roles.can('approve', BEA, EVERYWHERE), false, 'a scoped grant never answers everywhere');
  assert.equal(roles.can('triage', BEA, { block: 'A01.1.1' }), false, 'not a capability the role does not hold');
  assert.equal(roles.can('approve', CAL, { block: 'A01.1.1' }), false, 'nor for anybody else');
  assert.equal(roles.can('comment', CAL, { block: 'A01.1.1' }), true, 'while everybody keeps what member holds');
});

// ---------------------------------------------------------------- #153: read is not yet scopable
/**
 * `read` is grantable (`PROJECT_CAPABILITIES` includes it), so the owner can scope a grant of it to
 * one page — but that grant sits BESIDE the unscoped `read` every member already holds
 * (`ROLE_CAPABILITIES`, engine/core/roles.js), never in place of it: `can` answers `.some(...)` across
 * every grant a person holds, so the base member entry alone is enough to say yes anywhere. Read
 * cannot be narrowed this way today, which is why `/impact-radius`, `/fingerprints` and `/graph`
 * (engine/api/server.ts) may still answer about every block unfiltered (issue #153's premise).
 */
test('#153: a scoped read grant only adds — it cannot narrow the read every member already holds', () => {
  const roles = deployment.withProjectGrants([grant(BEA, ['read'], 'A01')]);
  assert.equal(roles.can('read', BEA, { block: 'Z99.1.1' }), true, 'outside the grant\'s scope, still read as a member');
  assert.equal(roles.can('read', BEA, EVERYWHERE), true, 'read stays unscoped for a signed-in member, grant or not');
});

test('the grants in force are replaced, never added to: a grant left out is gone', () => {
  const granted = deployment.withProjectGrants([grant(BEA, ['triage'])]);
  assert.equal(granted.can('triage', BEA, EVERYWHERE), true);
  assert.equal(granted.withProjectGrants([]).can('triage', BEA, EVERYWHERE), false);
  assert.equal(deployment.can('triage', BEA, EVERYWHERE), false, 'and the deployment\'s own roles never changed');
});

test('no grant reaches people or lock, whatever it was read from', () => {
  // `projectRolesOf` already refuses such a definition; this is the layer beneath it, for any
  // caller that hands `withProjectGrants` something it did not read from there.
  const roles = deployment.withProjectGrants([grant(BEA, ['people']), grant(CAL, ['triage', 'people']), grant(BEA, ['lock'])]);
  assert.equal(roles.can('people', BEA, EVERYWHERE), false);
  assert.equal(roles.can('lock', BEA, { block: 'A01.1.1' }), false);
  assert.equal(roles.can('triage', CAL, EVERYWHERE), false, 'a grant with people in it is dropped whole');
  assert.equal(roles.can('lock', OWNER, { block: 'A01.1.1' }), true, 'lock stays the owner\'s');
});

test('a grant\'s scope is everywhere only when it is null: an empty or unshaped one reaches nothing', () => {
  // `scopeCovers` answers this, not `withProjectGrants`: a scope that fits none of the three shapes
  // falls through all three branches, and only null reads as everywhere.
  const roles = deployment.withProjectGrants([grant(BEA, ['approve'], 'P*'), grant(CAL, ['approve'], '')]);
  assert.equal(roles.can('approve', BEA, { block: 'P01.1.1' }), false);
  assert.equal(roles.can('approve', CAL, { block: 'P01.1.1' }), false, 'an empty scope is not everywhere');
  assert.equal(deployment.withProjectGrants([grant(CAL, ['approve'], null)]).can('approve', CAL, { block: 'P01.1.1' }), true,
    'setup: null is');
});

test('an agent is refused what AGENT_NEVER names before any grant is read, token or address', () => {
  const roles = deployment.withProjectGrants([grant(BOT, ['triage', 'approve']), grant(BEA, ['triage', 'approve'])]);
  assert.equal(roles.can('triage', BOT, EVERYWHERE), false);
  assert.equal(roles.can('approve', BOT, { block: 'A01.1.1' }), false);
  // Bea's address, carried by a token: an agent, whatever a person's grant on that address says.
  assert.equal(roles.can('approve', agentByToken(BEA), { block: 'A01.1.1' }), false);
  assert.equal(roles.can('approve', BEA, { block: 'A01.1.1' }), true, 'setup: the grant itself does read');
});

test('who someone is does not move with a grant', () => {
  const roles = deployment.withProjectGrants([grant(BEA, ['triage', 'approve'])]);
  assert.equal(roles.roleOf(BEA), 'member');
  assert.equal(roles.isOwner(BEA), false);
  assert.equal(roles.isAgent(BEA), false);
  assert.deepEqual(roles.admins, deployment.admins);
  assert.equal(roles.owner, OWNER);
});

// ---------------------------------------------------------------- the `_roles` events
let clock = 0;
const at = () => new Date(Date.UTC(2026, 8, 27, 10, 0, clock++)).toISOString();
/** An event as a store answers one it signed: what the owner's routes write. */
const ev = (made, id, author = OWNER) => ({ ...stored(made, id, author, at()), signed: true });
/** The same event, as a reader finds one written into the store by someone without the key. */
const unsigned = (made, id, author = OWNER) => ({ ...ev(made, id, author), signed: false });

test('the three events live on _roles, carry strings only, and name a person by id', () => {
  const made = [definedEvent('clinical lead', ['triage', 'approve'], false), grantedEvent('clinical lead', BEA_ID, 'A0*', false),
    grantedEvent('clinical lead', BEA_ID, null, false), revokedGrantEvent('g1', false)];
  assert.deepEqual(made.map((e) => e.type), [ROLE_DEFINED, ROLE_GRANTED, ROLE_GRANTED, GRANT_REVOKED]);
  assert.ok(made.every((e) => e.page === ROLES_PAGE && e.block === null));
  assert.ok(made.every((e) => Object.values(e.data).every((v) => typeof v === 'string')), 'strings, one type every store and reader agrees on');
  assert.equal(made[0].data.capabilities, 'triage,approve');
  assert.equal(made[2].data.scope, '', 'everywhere, written as an empty scope');
  assert.ok(made.every((e) => !JSON.stringify(e).includes('@')), 'no address in any of them');
});

test('none of the three is a type POST /events accepts', () => {
  // The guard is `refusalOf` refusing a type outside EVENT_TYPES; the contract test posts each one.
  for (const type of [ROLE_DEFINED, ROLE_GRANTED, GRANT_REVOKED]) assert.equal(EVENT_TYPES.has(type), false, type);
});

test('the latest definition is the role, and a grant holds what it says now', () => {
  const state = projectRolesOf([
    ev(definedEvent('lead', ['approve'], false), 'd1'),
    ev(grantedEvent('lead', BEA_ID, 'A01', false), 'g1'),
    ev(definedEvent('lead', ['triage'], false), 'd2'),
  ]);
  assert.deepEqual(state.roles.get('lead'), { role: 'lead', capabilities: ['triage'], id: 'd2', when: state.roles.get('lead').when });
  assert.deepEqual(grantsOfPerson(state, BEA_ID, BEA), [{ email: BEA, capabilities: ['triage'], scope: 'A01' }]);
  const roles = deployment.withProjectGrants(grantsOfPerson(state, BEA_ID, BEA));
  assert.equal(roles.can('triage', BEA, { block: 'A01.1.1' }), true);
  assert.equal(roles.can('approve', BEA, { block: 'A01.1.1' }), false, 'what the first definition held is gone');
});

test('a latest definition that does not read leaves the role holding nothing, never the one before it', () => {
  for (const capabilities of ['triage,lock', 'people', '', 'triage,triage', 'governance']) {
    const forged = ev({ type: ROLE_DEFINED, page: ROLES_PAGE, block: null, data: { role: 'lead', capabilities } }, 'd2');
    const state = projectRolesOf([ev(definedEvent('lead', ['approve'], false), 'd1'), ev(grantedEvent('lead', BEA_ID, null, false), 'g1'), forged]);
    assert.deepEqual(state.roles.get('lead').capabilities, [], capabilities);
    assert.deepEqual(grantsOfPerson(state, BEA_ID, BEA), [], `${capabilities}: the grant holds nothing`);
  }
  const noList = ev({ type: ROLE_DEFINED, page: ROLES_PAGE, block: null, data: { role: 'lead' } }, 'd3');
  assert.deepEqual(projectRolesOf([ev(definedEvent('lead', ['approve'], false), 'd1'), noList]).roles.get('lead').capabilities, []);
});

test('a revoked grant is no longer in force, and stays on record as ended', () => {
  const events = [
    ev(definedEvent('lead', ['approve'], false), 'd1'),
    ev(grantedEvent('lead', BEA_ID, null, false), 'g1'),
    ev(grantedEvent('lead', CAL_ID, 'A01', false), 'g2'),
    ev(revokedGrantEvent('g1', false), 'r1'),
  ];
  const state = projectRolesOf(events);
  assert.deepEqual(state.grants.map((g) => g.id), ['g2']);
  assert.deepEqual(state.ended.map((g) => g.id), ['g1']);
  assert.deepEqual(grantsOfPerson(state, BEA_ID, BEA), []);
  assert.equal(projectRolesOf(events.slice(0, 3)).grants.length, 2, 'setup: before the revocation, both were in force');
});

test('a revocation takes its grant away wherever it sits, since taking away cannot hand anything out', () => {
  const state = projectRolesOf([
    ev(revokedGrantEvent('g1', false), 'r1'),
    ev(definedEvent('lead', ['approve'], false), 'd1'),
    ev(grantedEvent('lead', BEA_ID, null, false), 'g1'),
  ]);
  assert.deepEqual(state.grants, []);
});

test('a stored definition whose name does not read defines nothing', () => {
  const forged = (role, id) => ev({ type: ROLE_DEFINED, page: ROLES_PAGE, block: null, data: { role, capabilities: 'approve' } }, id);
  const state = projectRolesOf([forged('admin', 'd1'), forged('Lead', 'd2'), forged('owner', 'd3'), forged(undefined, 'd4')]);
  assert.equal(state.roles.size, 0);
  assert.equal(projectRolesOf([forged('lead', 'd5')]).roles.size, 1, 'setup: the same definition, well named, does');
});

test('a grant that does not read is left out: its role, its person or its scope', () => {
  const grantWith = (data, id) => ev({ type: ROLE_GRANTED, page: ROLES_PAGE, block: null, data }, id);
  const state = projectRolesOf([
    ev(definedEvent('lead', ['approve'], false), 'd1'),
    grantWith({ role: 'lead', person: BEA, scope: '' }, 'g1'),
    grantWith({ role: 'lead', person: BEA_ID, scope: 'P*' }, 'g2'),
    grantWith({ role: 'Lead', person: BEA_ID, scope: '' }, 'g3'),
    grantWith({ role: 'lead', person: BEA_ID }, 'g4'),
    grantWith({ role: 'lead', person: BEA_ID, scope: 'A0*' }, 'g5'),
  ]);
  assert.deepEqual(state.grants.map((g) => g.id), ['g5'], 'only the one that reads');
  assert.equal(state.grants[0].scope, 'A0*');
});

test('a grant is its own person\'s, and nobody else\'s', () => {
  const state = projectRolesOf([ev(definedEvent('lead', ['approve'], false), 'd1'), ev(grantedEvent('lead', BEA_ID, null, false), 'g1')]);
  assert.deepEqual(grantsOfPerson(state, CAL_ID, CAL), []);
  assert.equal(grantsOfPerson(state, BEA_ID, BEA).length, 1, 'setup: Bea\'s own grant does read');
});

test('a grant of a role nobody defined holds nothing', () => {
  const state = projectRolesOf([ev(grantedEvent('lead', BEA_ID, null, false), 'g1')]);
  assert.equal(state.grants.length, 1, 'in force as a record');
  assert.deepEqual(grantsOfPerson(state, BEA_ID, BEA), [], 'and in effect, nothing');
});

/**
 * #50: a definition, a grant and a revocation count only when this server signed them. Each alone,
 * beside a signed event that shows the same shape does count, so what refuses is the signature.
 */
test('a definition, a grant or a revocation not signed by the server counts for nothing', () => {
  const defined = ev(definedEvent('lead', ['approve'], false), 'd1');
  const granted = ev(grantedEvent('lead', BEA_ID, null, false), 'g1');
  assert.deepEqual(grantsOfPerson(projectRolesOf([defined, granted]), BEA_ID, BEA).length, 1, 'setup: signed, it holds');
  assert.equal(projectRolesOf([unsigned(definedEvent('lead', ['approve'], false), 'd1'), granted]).roles.size, 0,
    'a definition nobody signed defines nothing');
  assert.deepEqual(projectRolesOf([defined, unsigned(grantedEvent('lead', BEA_ID, null, false), 'g1')]).grants, [],
    'a grant nobody signed grants nothing');
  const revokedUnsigned = projectRolesOf([defined, granted, unsigned(revokedGrantEvent('g1', false), 'r1')]);
  assert.deepEqual(revokedUnsigned.grants.map((g) => g.id), ['g1'], 'a revocation nobody signed takes nothing away');
  assert.deepEqual(revokedUnsigned.ended, []);
  // `signed` exactly true: an event read by something that set no answer at all is not signed.
  const noAnswer = { ...granted };
  delete noAnswer.signed;
  assert.deepEqual(projectRolesOf([defined, noAnswer]).grants, []);
});

test('events of any other type on the page change nothing', () => {
  const state = projectRolesOf([ev({ type: 'comment', page: ROLES_PAGE, block: null, text: 'x', data: { role: 'lead', capabilities: 'approve' } }, 'c1')]);
  assert.equal(state.roles.size, 0);
  assert.equal(state.grants.length, 0);
});

// ---------------------------------------------------------------- the server asks the request's roles
test('the server asks what someone may do only of the roles built for the request', () => {
  // `deployment` answers who someone IS, and is typed without `can`, so the type checker refuses a
  // capability question asked of it or anything handed it that asks one. The one object with `can`
  // and no project grant, `rolesBeforeGrants`, is read by `rolesAt` alone: handed anywhere else, it
  // would answer as if no grant had ever been given or revoked. A text scan, as
  // `roles-boundary.test.js` is: there is no single call to intercept instead. The contract test is
  // the live proof, route by route.
  const text = readFileSync(`${ROOT}engine/api/server.ts`, 'utf8');
  const identity = /@typedef \{Pick<Roles, ([^>]+)>\} Identity/.exec(readFileSync(`${ROOT}engine/core/roles.js`, 'utf8'))?.[1];
  assert.ok(identity, 'setup: the identity-only type is where the scan expects it');
  assert.doesNotMatch(identity, /'can'|'withProjectGrants'/, 'deployment answers no capability question');
  assert.match(text, /^let deployment: Identity;$/m);
  const start = text.indexOf('async function rolesAt(');
  const end = text.indexOf('\n}\n', start);
  assert.ok(start > 0 && end > start, 'setup: rolesAt is where the scan expects it');
  const outside = (text.slice(0, start) + text.slice(end)).split('\n')
    .filter((line) => /\brolesBeforeGrants\b/.test(line) && !/^\s*(\/\/|\*)/.test(line)).map((line) => line.trim());
  assert.deepEqual(outside, ['let rolesBeforeGrants: Roles;', 'rolesBeforeGrants = rolesOf(project);', 'deployment = rolesBeforeGrants;'],
    'rolesBeforeGrants is declared, assigned, and read by rolesAt alone');
});
