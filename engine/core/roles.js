/**
 * Capabilities, and roles as sets of them (docs/ROLES.md).
 *
 * The METHOD defines only `owner` and the `founder` tag; `admin`, `member`, `clinical lead` and
 * everything else beyond them are roles of the PROJECT adopting the method. What the method DOES fix
 * is the list of things any role can grant — `CAPABILITIES` below — because a role can be renamed by
 * every adopter, but "can this person triage?" has to mean the same thing everywhere the engine asks
 * it.
 *
 *   owner   exactly one, always the same: the founding architect. `can()` answers true for every
 *           capability, `lock` included, but the owner is not itself a role — nothing grants it and
 *           nothing takes it away (docs/ROLES.md, "The owner is not a role"), and `lock` specifically
 *           is never read from a role's capabilities at all (see `can`, below).
 *   admin   every capability but `lock`. A role of the PROJECT, named by `HOLDRIM_ADMINS`.
 *   member  `read`, `comment`, `request` — everyone else who can sign in.
 *
 * The engine asks `can(capability, who, where)`, never a role's name: a role name changes with every
 * product this ships inside, and a caller that compared one directly (`role === 'admin'`) would stop
 * working the day a project renamed it. `engine/tests/roles-boundary.test.js` proves no caller
 * outside this file does. `where` — a page, a block, or `EVERYWHERE` — is asked every time, because
 * a grant may be limited to some pages or blocks (docs/ROLES.md, section 2), and an answer given
 * without a place would be the unscoped one.
 *
 * A project's OWN roles, and who holds them, are NOT read here yet, and never from `holdrim.json`
 * (docs/ROLES.md, "Authority comes from the deployment only"; `engine/core/config.js`'s
 * `AUTHORITY_KEYS` refuses the file the moment it names `roles` or `grants`). They come from the
 * owner, through events at a settings screen — a later piece, which will need its own name grammar
 * for a project role then, not before: a format with no caller is untested by construction, whatever
 * a unit test that calls it directly says — the settings screen gets one when it exists, not sooner.
 * `isValidScope` below is different: `HOLDRIM_LOCKS` (`parseLocks`) is a real caller of it TODAY, so
 * its grammar is proved against the tier this change actually ships.
 *
 * `HOLDRIM_LOCKS` (below, `parseLocks`) is different: who holds `lock` besides the owner is read from
 * the environment, same as `owner` and `admins`, because a forged lock is the one thing signed events
 * (phase E) have not closed yet. `can('lock', …)` does not consult it in this change — see `can`'s own
 * comment for why.
 *
 * `HOLDRIM_AGENTS` (`parseAgents`) marks who is an agent, also from the environment. It grants
 * nothing: it takes `AGENT_NEVER` away from those addresses, in `can`, before any grant is read, and
 * `rolesOf` refuses to start when a grant names one of them.
 * @module
 */
import { PAGE_FORMAT } from './limits.js';
import { normalizeEmail, isEmailAddress } from './email.js';

/**
 * The closed list of capabilities the engine knows. A project combines these into roles; it can
 * never invent one, the same way an unknown `holdrim.json` key refuses to start (`config.js`).
 *
 * `lock` validates here like the other six (`can('lock', …)` throws on a typo exactly as it does for
 * `'triage'`), but it is never part of a role's GRANTABLE set — `ROLE_CAPABILITIES` below leaves it
 * out of every role, owner included — because who holds it is decided by IDENTITY, never by a table
 * a role's capabilities live in. Reconciled once, with why, in `docs/ROLES.md`, "Capabilities are the
 * engine's, roles are the project's" — this comment only points there so the two cannot drift apart.
 */
export const CAPABILITIES = Object.freeze([
  'read', 'comment', 'request', 'triage', 'approve', 'lock', 'people',
]);

/** `lock` is deliberately absent from every one of these — see the comment on `CAPABILITIES`. */
const GRANTABLE = Object.freeze(CAPABILITIES.filter((c) => c !== 'lock'));

/**
 * The capabilities each of the three shipped roles holds, as ARRAYS — never a `Set`: `Object.freeze`
 * on a `Set` freezes the BINDING, not its contents, so a frozen `Set` still accepts `.add()` and
 * `.delete()` without a complaint, in or out of strict mode. `capabilitiesOf` copies one of these
 * into a fresh `Set` on every call for exactly that reason: a caller that mutates what it gets back
 * — `capabilitiesOf('admin').add('lock')` — would otherwise reach into this table itself, and every
 * `can()` call for the rest of the process would read it too.
 *
 * A project-defined role, once the settings screen exists, will extend this shape rather than
 * replace it: the same kind of array, held in the store instead of written here.
 *
 * `owner` is included for `capabilitiesOf` and the mapping test to read from one table, not two,
 * even though the owner is not a role a project can hold or grant (see the module comment) — its
 * entry is `GRANTABLE` too, because the owner needs nothing from this table beyond what admin has:
 * `lock`, its one capability the table never carries for anyone, comes from `can` asking `isOwner`
 * directly, below, never from a lookup here.
 */
const ROLE_CAPABILITIES = Object.freeze({
  owner: GRANTABLE,
  admin: GRANTABLE,
  member: Object.freeze(['read', 'comment', 'request']),
});

/**
 * The capabilities a shipped role holds, as a FRESH `Set` — a new one on every call, copied from the
 * frozen array above, so nothing a caller does to what it gets back can reach the table itself (see
 * the comment on `ROLE_CAPABILITIES`). Exported so the mapping test can read the very table `can`
 * reads, instead of a copy of it that could drift from what `createRoles` actually checks.
 *
 * Never asked for `'lock'`: it holds no role's answer to that question, on purpose, and `can` never
 * calls it for `'lock'` either — see `CAPABILITIES`.
 * @param {'owner'|'admin'|'member'} role
 * @returns {Set<string>}
 */
export function capabilitiesOf(role) {
  const held = ROLE_CAPABILITIES[role];
  if (!held) throw new Error(`"${role}" is not one of the roles this version ships: owner, admin, member.`);
  return new Set(held);
}

/**
 * A page-FAMILY scope: `PAGE_FORMAT`'s own shape with an explicit trailing `*`, and a prefix of at
 * LEAST two characters before it (docs/ROLES.md, "A grant can be limited to pages or to blocks" —
 * "P0*" reaches P01..P09 and nothing that merely starts with "P"). The minimum is not decorative:
 * every real page code in this codebase's own examples (`engine/core/limits.js`'s comment — "D01,
 * T03a, C02, UC-01 and DNN") is two characters or more, and a single-letter family ("P*") would not
 * pick out a family at all — it would mean "everything whose code happens to start with the same
 * letter as this one page", which for a scheme where every page in a whole SECTION shares that first
 * letter is "every page", the exact bare wildcard the next paragraph refuses outright. Kept as its
 * own pattern, not derived from `PAGE_FORMAT`, so the two stay two plain regexes anyone can read side
 * by side rather than one built by string surgery on the other.
 */
const SCOPE_FAMILY_FORMAT = /^[A-Za-z][A-Za-z0-9-]{1,7}\*$/;

/**
 * A block id: a page-code-shaped root, then one or more `.`-separated segments (`P03.2.1`), and
 * optionally a namespace naming another project's block ahead of it (`supplier:C02.1.4`, the shape
 * `docs/PROTOCOL.md`'s own `data-depends` example uses). The dot segment is not optional — a scope
 * with none of them is a PAGE, the first branch of `isValidScope` below, or a FAMILY, the second; a
 * block id is the one shape of the three that is neither, and asking for at least one dot is what
 * tells it apart from a plain page code instead of overlapping it (see `isValidScope`'s own comment
 * on why that overlap used to hide a whole branch behind an "equivalent mutant").
 *
 * This replaces reusing `ID_FORMAT` (`engine/core/limits.js`) here: that format exists to bound an
 * EVENT's own `block` field — free text an author's fingerprint tool wrote, already scoped to one
 * page by the event it sits on — and accepts any non-empty run of its allowed characters, `.`, `-`,
 * `:` and a bare `1` among them. A grant's scope is different: it is untrusted input that itself
 * SELECTS pages and blocks before anything else runs (docs/ROLES.md, "Configuration is untrusted
 * input"), so it is checked against the actual shape a block id has, not merely the alphabet it is
 * allowed to be drawn from.
 */
const SCOPE_BLOCK_FORMAT = /^(?:[A-Za-z][A-Za-z0-9-]{0,15}:)?[A-Za-z][A-Za-z0-9-]{0,7}(?:\.[A-Za-z0-9-]{1,8}){1,8}$/;

/**
 * Whether `scope` is one of the three shapes docs/ROLES.md allows on a grant or a `HOLDRIM_LOCKS`
 * entry: an exact page code, a page family with its explicit `*`, or a block id. Nothing else,
 * because a scope that reached the panel unchecked would be exactly the kind of untrusted value
 * `engine/api/theme.ts` already refuses to trust raw — it would end up choosing which pages and
 * blocks a payload includes.
 *
 * Order matters for what each branch actually proves, not merely for what it accepts: before round 2
 * of #29's review, the third branch was the bare `ID_FORMAT` alphabet check, which is a SUPERSET of
 * `PAGE_FORMAT` — every exact page code `PAGE_FORMAT` accepts, `ID_FORMAT` accepts too. Deleting the
 * `PAGE_FORMAT` branch outright then changed nothing any test could see: an "equivalent mutant", the
 * one shape a mutation this codebase's own method (`AGENTS.md`, rule 2) exists to catch. `PAGE_FORMAT`
 * now proves something `SCOPE_BLOCK_FORMAT` cannot: a block id demands at least one `.` segment, so a
 * plain page code like `P03` fails it, and only `PAGE_FORMAT` still accepts it — deleting that branch
 * now fails `isValidScope('P03')` for real.
 * @param {unknown} scope
 */
export function isValidScope(scope) {
  if (typeof scope !== 'string' || scope === '') return false;
  return PAGE_FORMAT.test(scope) || SCOPE_FAMILY_FORMAT.test(scope) || SCOPE_BLOCK_FORMAT.test(scope);
}

/**
 * The answer to "where?" when a question is about no page at all — managing people, for one. Frozen,
 * and compared by identity: `can` has to tell a question about everywhere and a caller that forgot
 * to say where apart, and a plain `{}` a caller built would read as the second. A scoped grant never answers it
 * (`scopeCovers`), since a grant limited to some pages says nothing about the rest.
 */
export const EVERYWHERE = Object.freeze({ everywhere: true });

/**
 * The page a block id lives on: everything before its first `.`, the derivation `engine/cli/pages.ts`
 * uses when it reads a block off disk. The server asks this of the BLOCK an event names rather than
 * trusting the `page` the client sent beside it, so a ✓ on `P03.2.1` posted as if on `P09` is still
 * judged as `P03`'s.
 * @param {string} block
 */
export function pageOfBlock(block) {
  return String(block).split('.')[0];
}

/**
 * Whether a page family (`P0*`) reaches `page`: the family's prefix and exactly one character more,
 * and the result still a page code `PAGE_FORMAT` accepts. One character, because docs/ROLES.md's
 * example has `P0*` reach `P01` to `P09` and nothing that merely begins with `P`; `PAGE_FORMAT` is
 * loose enough to call `P010` a page code, and a family that read `*` as "anything after" would
 * reach it, and `P0-draft`, and every longer code a later commit invents. Case-sensitive, as every
 * other comparison of a page code in the engine is.
 * @param {string} family
 * @param {string} page
 */
function familyCovers(family, page) {
  const prefix = family.slice(0, -1);
  return page.length === prefix.length + 1 && page.startsWith(prefix) && PAGE_FORMAT.test(page);
}

/**
 * Whether a grant's `scope` reaches `where` (docs/ROLES.md, section 2). No scope — `null` — is
 * everywhere. Otherwise, by the shape `isValidScope` gave the scope:
 *   - a page (`P03`) reaches that page, and any block whose page is it (`pageOfBlock`);
 *   - a family (`P0*`) reaches the pages `familyCovers` names, and their blocks the same way;
 *   - a block id reaches that one block — not the blocks under it, and never a question asked of a
 *     whole page, since a person trusted with one block was not trusted with its neighbours.
 * A scoped grant never reaches `EVERYWHERE`, and a scope that fits none of the three reaches
 * nothing: failing closed is the only safe reading of a value that should never have got this far.
 * @param {string|null|undefined} scope
 * @param {{page?: string, block?: string}|typeof EVERYWHERE} where
 */
export function scopeCovers(scope, where) {
  if (scope === null || scope === undefined) return true;
  // No guard for `EVERYWHERE`, on purpose: it names no page and no block, so every branch below
  // compares a scope against nothing and answers false — a guard here would be one no test could
  // tell from its absence. `typeof onPage` below is the one check `EVERYWHERE` does lean on: without
  // it a family would read the length of a page that is not there, and throw. The dropped
  // `typeof scope !== 'string'` needs no replacement either: every caller hands `scopeCovers` either
  // `null` or a scope `isValidScope` already accepted — `parseLocks` throws on anything else before a
  // scope reaches here, and `grantsOf`'s scope is `null` today — so a scope of the wrong type never
  // arrives to be guarded against.
  const { page, block } = /** @type {{page?: string, block?: string}} */ (where);
  // The block's own page, never the `page` a caller put beside it: see `pageOfBlock`.
  const onPage = block ? pageOfBlock(block) : page;
  if (PAGE_FORMAT.test(scope)) return scope === onPage;
  if (SCOPE_FAMILY_FORMAT.test(scope)) return typeof onPage === 'string' && familyCovers(scope, onPage);
  // Compared with the block alone: a page question has none, so it can never equal a block scope.
  if (SCOPE_BLOCK_FORMAT.test(scope)) return scope === block;
  return false;
}

/**
 * The `where` a question about an event's place is asked with: its block when it names one, its page
 * otherwise. One function, so the server's checks and `/api/me`'s answer cannot phrase the same place
 * two ways.
 * @param {{page?: string|null, block?: string|null}} at
 * @returns {{block: string}|{page: string}}
 */
export function whereOf(at) {
  return at.block ? { block: at.block } : { page: String(at.page ?? '') };
}

/**
 * Refuses a `where` `can` cannot read: missing, or naming neither a page nor a block. Thrown, like
 * an unknown capability, because a check that forgot to say where would otherwise be answered — and
 * an answer about nowhere in particular is the unscoped answer this change exists to stop giving.
 * @param {unknown} where
 */
function checkWhere(where) {
  if (where === EVERYWHERE) return;
  const w = /** @type {{page?: unknown, block?: unknown}|null} */ (where);
  const named = (v) => typeof v === 'string' && v !== '';
  if (typeof w !== 'object' || w === null || !(named(w.page) || named(w.block))) {
    throw new Error(
      'roles.can needs to know where it is asked: a page ({ page }), a block ({ block }), or ' +
      'EVERYWHERE for a question about no page at all (docs/ROLES.md, section 2).');
  }
}

/**
 * How far each `HOLDRIM_LOCKS` entry's scope reaches on this site: the pages a page or family scope
 * covers, or the one block a block scope names. What start logs, and refuses on when a scope reaches
 * nothing — docs/ROLES.md's attack table, "a commit renumbers a page into a lock-holder's scope":
 * the renumbering is the repository's to decide, but a scope that matches no page at all is a typo
 * or a page that moved away, and a lock quietly granted over nothing is found out only the day it
 * starts matching something.
 * @param {{scope: string}[]} locks  as `parseLocks` returns them
 * @param {Iterable<string>} blockIds  every block id the site has
 * @returns {{scope: string, reaches: string[]}[]}
 */
export function lockCoverage(locks, blockIds) {
  const ids = [...blockIds];
  const pages = [...new Set(ids.map(pageOfBlock))].sort();
  return locks.map(({ scope }) => ({
    scope,
    reaches: SCOPE_BLOCK_FORMAT.test(scope)
      ? ids.filter((id) => id === scope)
      : pages.filter((page) => scopeCovers(scope, { page })),
  }));
}

/**
 * `HOLDRIM_LOCKS`, parsed once at start: `"ana@example.org:P0*; bea@example.org:F12"` — entries
 * separated by `;`, each an e-mail, a colon, and a scope validated by `isValidScope`. Read from the
 * environment only, next to `HOLDRIM_OWNER` and `HOLDRIM_ADMINS`, and never from `holdrim.json`
 * (`engine/core/config.js`'s `AUTHORITY_KEYS` refuses the file the key would otherwise sit in) —
 * docs/ROLES.md, section 3: "Set where the owner is set."
 *
 * The address is normalized, and checked, by `engine/core/email.js` — the ONE module both this file
 * and `engine/api/users.ts` import it from (round 2 of #29's review, findings 2 and 6: this used to
 * repeat `users.ts`'s `normalizeEmail` by hand, with no shape check at all).
 *
 * `isEmailAddress` alone is not enough here, though, and round 2 was wrong to claim it was: it stays
 * DELIBERATELY lenient (see its own comment) because `engine/api/users.ts`'s create route uses the
 * very same function for a brand new account, where refusing a real but unusual address is the worse
 * mistake. `<ana@x>`, `"ana"@x` and `ana@x.` all still pass it — a display form's angle brackets, a
 * quoted local part, and a domain with a trailing dot are each something a real mail system might
 * hand you, just not the bare address `HOLDRIM_LOCKS` needs. A `HOLDRIM_LOCKS` typo is a different
 * failure than a rejected sign-up, though: it does not fail loudly, it silently locks NOBODY, forever,
 * with nothing in the product to notice it by. So `parseLocks` asks a second, stricter question of
 * its own, below — `RESERVED_EMAIL_CHARS` and the trailing-dot check — on top of `isEmailAddress`,
 * never inside it: `isEmailAddress` keeps meaning what it means for account creation, unmoved.
 *
 * Anything that does not fit — no colon, an address `isEmailAddress` or this file's own check
 * refuses, a scope `isValidScope` refuses — throws: a malformed entry here is a lock silently never
 * granted, which is worse than a service that will not start, the same reasoning `HOLDRIM_OWNER`'s
 * own parsing already follows.
 *
 * Naming the owner in it is harmless: the owner already holds `lock` from `isOwner` alone (below),
 * so nothing here treats that address specially.
 */
/**
 * Characters `isEmailAddress` lets through on purpose (its own comment: it is not an RFC 5322
 * parse) but a bare address never legitimately carries: the angle brackets and parentheses of a
 * DISPLAY form (`Ana <ana@x>`, a comment inside `(not ana) ana@x`), a quoted local part (`"ana"@x`),
 * and the two separators this file's own grammar already gives a meaning to elsewhere (`,` and `;`,
 * round 3 of #29's review, finding 3). None of the four is something `parseLocks` should have to
 * guess the intent of — `HOLDRIM_LOCKS` is typed by whoever deploys, not pasted from a mail client.
 */
// `;` inside the class is untestable by mutation: `parseLocks` splits `raw` on `;` before any entry
// ever reaches this check, so an entry containing `;` was already cut into two entries upstream —
// removing `;` here changes nothing a test could observe. It stays for the reason its own doc
// comment above gives (a separator this grammar already means something else by), not because a
// test proves it.
const RESERVED_EMAIL_CHARS = /[<>"()[\],;]/;

/**
 * One address from a variable that names people by address alone — `HOLDRIM_LOCKS` and
 * `HOLDRIM_AGENTS` — normalized, and held to `parseLocks`'s stricter question (its own comment says
 * why `isEmailAddress` alone is not enough). One function for both, so the two variables can never
 * disagree about what an address is: an address one of them accepted and the other normalized
 * differently would name two people where the deployment meant one.
 * @param {string} variable  the variable's name, for the message
 * @param {string} rawEmail  as written, trimmed
 */
function strictAddress(variable, rawEmail) {
  const email = normalizeEmail(rawEmail);
  if (!isEmailAddress(email)) {
    throw new Error(
      `${variable} names "${rawEmail}", which is not an e-mail address — the same check ` +
      '`engine/api/users.ts` applies when an account is created.');
  }
  // Stricter than `isEmailAddress` on purpose — see `parseLocks`'s own comment for why account
  // creation cannot ask this same question.
  if (RESERVED_EMAIL_CHARS.test(email) || email.endsWith('.')) {
    throw new Error(
      `${variable} names "${rawEmail}", which is not an e-mail address a mail server would ever ` +
      `deliver to: account creation stays lenient about this, but a ${variable} typo does not ` +
      'fail loudly the way a rejected sign-up does — it silently matches nobody, forever.');
  }
  return email;
}

/**
 * @param {string|undefined|null} raw
 * @returns {{email: string, scope: string}[]}
 */
export function parseLocks(raw) {
  const entries = String(raw ?? '').split(';').map((s) => s.trim()).filter(Boolean);
  return entries.map((entry) => {
    // The FIRST colon, not the only one: a scope may itself contain one (`ID_FORMAT` allows it, for
    // a block id written with a namespace), so splitting on every colon would cut a valid scope in
    // half the day somebody's block ids use one.
    const colon = entry.indexOf(':');
    if (colon === -1) {
      throw new Error(
        `HOLDRIM_LOCKS has "${entry}", which is missing its scope: an entry is an e-mail, a colon, ` +
        'and a scope, like "ana@example.org:P0*". Entries are separated by ";".');
    }
    const rawEmail = entry.slice(0, colon).trim();
    const scope = entry.slice(colon + 1).trim();
    if (!rawEmail) {
      throw new Error(`HOLDRIM_LOCKS has "${entry}", which names no e-mail before the colon.`);
    }
    const email = strictAddress('HOLDRIM_LOCKS', rawEmail);
    if (!isValidScope(scope)) {
      throw new Error(
        `HOLDRIM_LOCKS grants ${email} the scope "${scope}", which is none of a page, a page family ` +
        '("P0*") or a block id — see docs/ROLES.md, "A grant can be limited to pages or to blocks".');
    }
    return { email, scope };
  });
}

/**
 * `HOLDRIM_AGENTS`, parsed once at start: `"agent@example.org; ci@example.org"` — the addresses the
 * deployment marks as agents (docs/ROLES.md, section 4). Separated by `;` and checked by the same
 * `strictAddress` as `HOLDRIM_LOCKS`, and read from the environment only, for the reason every other
 * authority variable is: a committer, or the agent itself applying an approved request, could
 * otherwise delete one line of `holdrim.json` and stop being an agent at the next deploy.
 *
 * A malformed entry throws rather than being skipped: an agent this list silently failed to name is
 * an agent the engine treats as a person, with whatever that person's grants hold.
 *
 * The comma gets its own message because `HOLDRIM_ADMINS` uses one: whoever copies that variable's
 * shape would otherwise be told only that `a@x,b@x` is "not an e-mail address", which is true and
 * says nothing about what to type instead.
 * @param {string|undefined|null} raw
 * @returns {string[]} normalized addresses
 */
export function parseAgents(raw) {
  const entries = String(raw ?? '').split(';').map((s) => s.trim()).filter(Boolean);
  return entries.map((entry) => {
    if (entry.includes(',')) {
      throw new Error(`HOLDRIM_AGENTS has "${entry}": entries are separated by ";", not ",".`);
    }
    return strictAddress('HOLDRIM_AGENTS', entry);
  });
}

/**
 * What an agent may never do, whatever it is granted (docs/ROLES.md, section 4): decide a request,
 * give a ✓, turn a ✓ into a lock, or manage people. `can` refuses these for an agent BEFORE it reads
 * the owner, `HOLDRIM_ADMINS` or a role's capabilities — so a grant that names an agent, which
 * `rolesOf` already refuses at start, still hands it none of them if that refusal is ever bypassed
 * or broken. An agent may close an impact ("this change did not reach here"); it never says a text
 * is correct (AGENTS.md).
 */
export const AGENT_NEVER = Object.freeze(['triage', 'approve', 'lock', 'people']);

/**
 * Who the server saw, when it came in with an agent token the owner issued (docs/ROLES.md, section
 * 4, "a credential of its own") rather than with a session. The second source of the agent flag,
 * next to `HOLDRIM_AGENTS`: the address alone cannot say it, since the same address may also have a
 * password and sign in as a person, so the flag rides on the identity itself.
 *
 * Frozen, and built only by the server after it checked the token: a JSON body is never turned into
 * one, so a client cannot claim to be a token identity, and nothing claiming to be one can be
 * mutated into something else after the check.
 * @param {string} email the address the token was issued for
 * @returns {Readonly<{email: string, byToken: true}>}
 */
export function agentByToken(email) {
  return Object.freeze({ email: normalizeEmail(email), byToken: true });
}

/**
 * Whether `who` came in with an agent token. `=== true`, never truthiness: an address is a string,
 * and a string's `byToken` is `undefined`, so an address can never read as a token identity.
 * @param {unknown} who
 */
export function byToken(who) {
  return typeof who === 'object' && who !== null && /** @type {{byToken?: unknown}} */ (who).byToken === true;
}

/**
 * The address behind `who`, which is either an address or `agentByToken`'s identity. Every question
 * `createRoles` answers takes either, so a caller holding a token identity cannot drop the flag by
 * handing over the bare address by mistake — it hands over what it holds.
 *
 * Anything that is not an identity object passes through untouched — `null` included: every
 * question here was asked of a missing viewer before identities existed, and answered "no" through
 * `normalizeEmail`, which a throw here would turn into a 500.
 * @param {string|{email: string}|null|undefined} who
 * @returns {string}
 */
export function addressOf(who) {
  return typeof who === 'object' && who !== null ? who.email : /** @type {string} */ (who);
}

/**
 * @param {string|undefined|null} owner  ONE e-mail. Zero or more than one is a config error.
 * @param {string|undefined|null} admins comma-separated e-mails; may be empty.
 * @param {string|undefined|null} [locksRaw] `HOLDRIM_LOCKS`, in `parseLocks`'s format
 * @param {string|undefined|null} [agentsRaw] `HOLDRIM_AGENTS`, in `parseAgents`'s format
 *
 * Builds roles even when a grant names an agent: refusing that is `rolesOf`'s job, at start
 * (`refuseGrantsToAgents`), and `can` denies it again here on its own. Two layers, each proved by a
 * test that fails when that layer alone is removed — a refusal inside this function would make the
 * second layer impossible to construct, and so impossible to prove.
 */
export function createRoles(owner, admins, locksRaw, agentsRaw) {
  const split = (s) => String(s ?? '').split(',').map(normalizeEmail).filter(Boolean);

  const list = [...new Set(split(owner))];
  if (list.length !== 1) {
    throw new Error(
      `HOLDRIM_OWNER needs exactly one e-mail (got ${list.length}). ` +
      'The owner is unique by definition: they are the founding architect of the project. ' +
      // Said outright because the file is where an adopter looks first, and holdrim.json refuses
      // the key (engine/core/config.js): without this, "set it in the file" is the natural guess.
      'It comes from HOLDRIM_OWNER, set where Holdrim runs, and never from holdrim.json.');
  }
  const ownerEmail = list[0];
  // The owner is an admin by consequence, not by configuration: there is no way to strip their
  // power by accident.
  const everyone = new Set([...split(admins), ownerEmail]);
  // `normalizeEmail` itself (`engine/core/email.js`) is the one function every normalization in this
  // file, and in `engine/api/users.ts`, now calls — see `parseLocks`'s own comment for why a second,
  // hand-written copy of "trim, then lower-case" was the bug findings 2 and 6 closed.
  const normalized = normalizeEmail;

  // Validated once, at construction, exactly like `list` above: a malformed HOLDRIM_LOCKS entry is
  // a config error, and a config error refuses to start rather than surfacing the first time
  // something asks about it.
  const lockHolders = new Set(parseLocks(locksRaw).map((l) => l.email));
  // Validated at construction for the same reason as `lockHolders`, just above.
  const agents = new Set(parseAgents(agentsRaw));
  /**
   * Whether `e` is an agent — an identity check, like `isOwner`. Two sources, either one enough: an
   * address `HOLDRIM_AGENTS` marks, and anyone who came in with an agent token (`agentByToken`),
   * whatever their address. Without the second, a token issued for an address the variable does not
   * list would reach the server as whoever that address is to a person's grants.
   */
  const isAgent = (e) => byToken(e) || agents.has(normalized(addressOf(e)));

  /**
   * Whether `e` is THE owner — an identity check, not a capability. Defined once, here, so `can`
   * and the returned `isOwner` are provably the same question asked the same way.
   *
   * Never true for a token identity, even one issued for the owner's address before a handover made
   * it the owner's: the owner is a person signed in, and every guard that reads `isOwner` — who
   * issues a token, who resets the owner's account — has to fail closed for a token, not trust that
   * the server refused it earlier.
   */
  const isOwner = (e) => !byToken(e) && normalized(addressOf(e)) === ownerEmail;
  /**
   * The shipped role `e` holds — never handed to a caller, only used to look up its capabilities.
   *
   * A token identity is a member whatever `HOLDRIM_ADMINS` says of its address, as an address in
   * `HOLDRIM_AGENTS` always is (a grant naming one refuses to start). A restart can grant the address
   * of a token already issued; without this, that token would read as an admin on `/api/me`, and would
   * hold every admin capability `AGENT_NEVER` does not name — including any added later.
   */
  const roleOf = (e) => (isOwner(e) ? 'owner'
    : !byToken(e) && everyone.has(normalized(addressOf(e))) ? 'admin' : 'member');
  /**
   * What `e` holds, as grants: capabilities, each set limited to a scope or to none (docs/ROLES.md,
   * section 2). Today every grant is one of the three shipped roles, unscoped — `HOLDRIM_OWNER` and
   * `HOLDRIM_ADMINS` name no pages — so this is one grant per person. It is the shape `can` reads so
   * that a project's own scoped grants, once the owner can make them, are one more entry here and
   * not a second way of answering.
   * @returns {{capabilities: Set<string>, scope: string|null}[]}
   */
  const grantsOf = (e) => [{ capabilities: capabilitiesOf(roleOf(e)), scope: null }];

  return {
    owner: ownerEmail,
    admins: [...everyone],
    /**
     * Whether `e` is THE owner — an identity check, not a capability: resetting or creating the
     * owner's account, and disabling nobody's, belong to the owner alone and to no capability any
     * role can hold (docs/ROLES.md, "The owner is not a role"). Every other decision asks `can`.
     */
    isOwner,
    /**
     * Whether `e` is named in `HOLDRIM_LOCKS` — an identity check, like `isOwner`, never a
     * capability. This is the ONE function `engine/api/server.ts`'s account guards (create, reset,
     * disable and re-enable) and any future lock check both ask, so a rule added for one reaches the
     * other (docs/ROLES.md, section 3, "One parser, one question").
     *
     * Not yet read by `can('lock', …)` — see the comment there for why.
     */
    isLockHolder: (e) => lockHolders.has(normalized(addressOf(e))),
    /**
     * Whether `e` is an agent — named in `HOLDRIM_AGENTS`, or come in with an agent token — who they
     * ARE, not what they may do. `can` asks it first, and `recordEvent` (engine/api/server.ts)
     * writes its answer onto every event, so the trail says an agent wrote it however the agent's
     * grants later change.
     */
    isAgent,
    /** The role `e` holds, for display only — the people screen's column, `/api/me`'s `role` field.
     *  Never compared against a string by a caller: that is exactly the check `can` replaces. */
    roleOf,
    /**
     * Whether `e` may `capability` — the one question every caller outside this file asks. Throws
     * on an unknown capability rather than silently answering false, for the same reason an unknown
     * `holdrim.json` key refuses to start: a typo that answered "no" would look exactly like a real
     * refusal.
     *
     * `'lock'` is answered straight from `isOwner`, never from `capabilitiesOf` and never from
     * `isLockHolder` — not merely because `ROLE_CAPABILITIES` happens to leave `lock` out today, but
     * because making a `HOLDRIM_LOCKS` entry actually lock needs docs/ROLES.md section 3's rule: a ✓
     * is a lock only when the session that gave it opened with a credential the PERSON set
     * themselves, after the latest issuance made by the OWNER. That test reads the account's whole
     * credential history, which nothing here does yet. Without it, an admin who reset a
     * soon-to-be-lock-holder's account before their address reached `HOLDRIM_LOCKS`, and kept the
     * session open across the restart that added it, could give a ✓ in that person's name at the
     * moment it starts reading as a lock — the exact forgery section 3 exists to close. `isOwner`
     * alone has no such gap, so `lock` stays exactly that, in this change.
     */
    can: (capability, e, where) => {
      if (!CAPABILITIES.includes(capability)) {
        throw new Error(`"${capability}" is not a capability engine/core/roles.js knows: ${CAPABILITIES.join(', ')}.`);
      }
      // `where` is required, and checked before anything is answered: a caller that forgot it would
      // otherwise get the unscoped answer, which is exactly what a scoped grant must never give.
      checkWhere(where);
      // FIRST, before `isOwner` and before any role's capabilities: an agent is refused these on
      // who it is, so no grant — the owner's, `HOLDRIM_ADMINS`, a future role — is ever consulted
      // for them. Asked after a grant, the grant would already have answered.
      if (AGENT_NEVER.includes(capability) && isAgent(e)) return false;
      if (capability === 'lock') return isOwner(e);
      return grantsOf(e).some((g) => g.capabilities.has(capability) && scopeCovers(g.scope, where));
    },
  };
}

/**
 * The roles a project's configuration grants — what `readConfig` returned, turned into roles.
 *
 * ⚠️ The one way from configuration to roles, for the server AND the CLI. Who the owner is decides
 * whose ✓ becomes a lock, so the two cannot be allowed to answer it differently: a CLI that read
 * the owner one way while the server read it another would lock nothing the owner approved, or
 * triage as the owner someone the server does not know as one. Where the three values come from —
 * HOLDRIM_OWNER, HOLDRIM_ADMINS, HOLDRIM_LOCKS and HOLDRIM_AGENTS, and never holdrim.json — is `readConfig`'s to
 * say, once; this adds no rule of its own, so there is no second copy of it to drift.
 *
 * @param {{ owner: string|null, admins: string, locks?: string, agents?: string }} config  as `readConfig` returns it
 */
export function rolesOf(config) {
  const roles = createRoles(config.owner, config.admins, config.locks, config.agents);
  refuseGrantsToAgents(roles, config.locks);
  return roles;
}

/**
 * Refuses to start when `HOLDRIM_OWNER`, `HOLDRIM_ADMINS` or `HOLDRIM_LOCKS` names an address that
 * `HOLDRIM_AGENTS` marks as an agent. `can` would deny the agent anyway (`AGENT_NEVER`); this is the
 * louder layer, so a deployment that contradicts itself is told at start instead of finding out the
 * day the owner's ✓ is quietly not a lock because the owner's address was also listed as an agent.
 *
 * Called by `rolesOf`, the one way from configuration to roles for the server's boot and every CLI
 * command, so both refuse alike.
 * @param {ReturnType<typeof createRoles>} roles
 * @param {string|undefined|null} locksRaw
 */
export function refuseGrantsToAgents(roles, locksRaw) {
  const named = [];
  if (roles.isAgent(roles.owner)) named.push(['HOLDRIM_OWNER', roles.owner]);
  for (const admin of roles.admins) {
    // `admins` carries the owner too (the owner is an admin by consequence); named once, above.
    if (admin !== roles.owner && roles.isAgent(admin)) named.push(['HOLDRIM_ADMINS', admin]);
  }
  for (const { email } of parseLocks(locksRaw)) if (roles.isAgent(email)) named.push(['HOLDRIM_LOCKS', email]);
  if (named.length === 0) return;
  throw new Error(
    named.map(([variable, email]) => `${variable} names ${email}`).join(', ') +
    ', which HOLDRIM_AGENTS marks as an agent. An agent is never granted a ✓, a lock, triage or ' +
    'people (docs/ROLES.md, section 4): remove the address from one of the two.');
}
