import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize, relative, sep } from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createCycle } from '../core/cycle.js';
import { radiusOf } from '../core/validity.js';
import { createRoles, rolesOf } from '../core/roles.js';
import { overLimit, validCommit, short } from '../core/limits.js';
import { createI18n } from '../core/i18n.js';
import { MemoryEventStore } from './store.ts';
import { SqliteEventStore } from './store-sqlite.ts';
import {
  openUserStore, ephemeralUserStoreWarning, DEFAULT_SQLITE_PATH, UserInputError,
  normalizeEmail, isEmailAddress, MAX_NAME_LENGTH, type UserStore,
} from './users.ts';
import { log } from './log.ts';
import { renderLoginPage, signInPolicy, screenPolicy } from './login-page.ts';
import { withPanelNonce, pagePolicy, FILE_POLICY } from './content-policy.ts';
import { renderHomePage, summarisePages, requestsInProgress, HOME_SECTION, type HomeOutcome } from './home-page.ts';
import { renderPeoplePage } from './people-page.ts';
import { HOME_SCREEN, PEOPLE_SCREEN } from '../core/screens.js';
import { readBlocks, ofProject } from '../cli/pages.ts';
import { loadRegistry } from '../cli/validation.ts';
import { graphOf } from '../cli/graph.ts';
import { loadTheme } from './theme.ts';
import { LANGUAGE_ROUTE, chosenLanguage, languageSwitch } from './language.ts';
import { PasswordIdentity } from './identity-password.ts';
import { IapIdentity } from './identity-iap.ts';
import {
  EVENT_TYPES, LOCKS_FIELD, AUTHOR_COULD_TRIAGE_FIELD, AS_AGENT_FIELD, ensureLockBaseline, isLocked, authorCouldTriage,
  type Event, type NewEvent, type EventStore,
} from './types.ts';
import { idForLog as peopleIdForLog, actedOn as peopleActedOn, recordAuthored } from './people.ts';
import { personAs } from '../core/people-show.js';
import { resolveRemovedBy, type Removed, type TamperReport } from './texts.ts';
import { openFindings, mayAcknowledge, acknowledgementRefusal, acknowledgementOf } from './tamper.ts';

/**
 * The Holdrim service: serves the site and records review events.
 *
 * When an identity proxy guards the edge, the API still validates who the caller is — defence in
 * depth. The business rules — cycle, roles, limits — come from `engine/core/`, the SAME code the
 * browser imports.
 */

// The PROJECT's configuration comes from holdrim.json; environment variables beat the file. The
// engine knows no product name, no e-mail and no cloud project — it asks. The owner and the admins
// come from the environment alone, and a holdrim.json that names them refuses to load.
const projectRoot = process.env.HOLDRIM_SITE ?? join(import.meta.dirname, '..', '..');
/** The same line, the same exit, for every configuration the service refuses before it listens. */
function refuseToStart(error: unknown): never {
  // ⚠️ English, hard-coded, and NOT through i18n. This prints before the server listens, so there
  // is no request, no session and nobody whose language we could have chosen — the same reason the
  // first-access banner below stays English. See the comment at the top of engine/core/i18n.js.
  console.error('invalid configuration: ' + (error instanceof Error ? error.message : String(error)));
  process.exit(1);
}
// Read through `ofProject`, the CLI's own reader, so the owner the service boots with and the one
// `holdrim sync` locks with come out of one call, not two that merely look alike. Guarded because it
// throws on a holdrim.json that names an owner: unguarded, that refusal would be a stack trace.
const project = (() => {
  try { return ofProject(projectRoot); } catch (error) { return refuseToStart(error); }
})();

// The sentences the reviewer reads. The core returns keys; here they become words, in the language
// of whoever is reading. Logs and boot errors do NOT come through here, on purpose — a log is
// evidence, and evidence that changes wording by locale cannot be grepped.
//
// ⚠️ Discovered, not listed. A hard-coded list would make the README lie — it promises that adding
// a language is copying one file into engine/locales/, and with a list it would be copying a file
// AND editing this line. It would also kill the server the day one dictionary moved out, and not
// one unit test would notice, because none of them boot the server. Reading the folder avoids both.
const localesFolder = new URL('../locales/', import.meta.url);
const dictionaries = Object.fromEntries(
  readdirSync(localesFolder).filter((f) => f.endsWith('.json')).map((f) =>
    [f.slice(0, -5), JSON.parse(readFileSync(new URL(f, localesFolder), 'utf8'))]));
const i18n = createI18n(dictionaries, 'en');
// `person` is what makes a deliberate choice beat the browser header — see engine/api/language.ts.
const languageOf = (req: IncomingMessage) =>
  i18n.choose({
    person: chosenLanguage(req.headers.cookie),
    acceptLanguage: req.headers['accept-language'] as string, project: project.language,
  });

/**
 * How the project dresses the engine. Read ONCE, at boot, for two reasons: the logo is a file on
 * disk and re-reading it on every sign-in would put an I/O call on the one request that is always
 * a cold start; and a theme that changes without a restart is a theme nobody can reason about when
 * two instances disagree.
 *
 * ⚠️ Whatever was refused is logged, and logged LOUDLY. A theme that quietly does not apply is an
 * afternoon of someone reloading the page wondering where their colour went — and if the reason it
 * was refused is that the value looked like an injection attempt, that is the line an operator
 * needs to find.
 */
const { theme: projectTheme, warnings: themeWarnings } = loadTheme(
  projectRoot, project.theme, { readBinary: (p: string) => readFileSync(p) },
);
for (const warning of themeWarnings) log('WARNING', 'theme_rejected', { reason: warning });

const cfg = {
  port: Number(process.env.PORT ?? 8080),
  site: projectRoot,
  project: project.project,
  owner: project.owner,
  mode: process.env.HOLDRIM_MODE,
  environment: process.env.NODE_ENV === 'development' ? 'Development' : (process.env.HOLDRIM_ENVIRONMENT ?? 'Production'),
};

// ---------------------------------------------------------------- configuration that fails at boot
/**
 * How people get in.
 *   password | user and password in the service itself. This is "start the image and use it".
 *   iap      | Google Cloud IAP. Needs HOLDRIM_AUDIENCE.
 *   dev      | the X-Dev-Email header, Development only. Open the browser and work, with no login.
 *
 * The default is never `dev` outside Development: a service that accepts "I am whoever I say I
 * am" in production is not a small oversight. Outside Development it is the identity proxy when
 * there is an audience, and password everywhere else — whoever starts the image configuring
 * nothing lands on a login screen, which is the worst acceptable case.
 */
const identityKind = process.env.HOLDRIM_IDENTITY
  ?? (cfg.environment === 'Development' ? 'dev' : process.env.HOLDRIM_AUDIENCE ? 'iap' : 'password');

let roles: ReturnType<typeof createRoles>;
let iap: IapIdentity | null = null;
const cycle = createCycle(JSON.parse(readFileSync(new URL('../cycle.json', import.meta.url), 'utf8')));

try {
  // No default, on purpose: in a distributed package, an e-mail of ours here would make anyone who
  // forgot to configure it start a service with OUR owner.
  roles = rolesOf(project);
  // The proxy identity is only built when it is the one in charge: demanding its audience from
  // someone logging in with a password would block the "start it and use it" case, which is the
  // whole point of password identity.
  if (identityKind === 'iap' || identityKind === 'dev') {
    iap = new IapIdentity({
      audience: process.env.HOLDRIM_AUDIENCE, mode: cfg.mode,
      environment: cfg.environment, // an empty string is a choice — 'identify nobody' — which the
                                    // contract test uses to exercise the 401
      devEmail: process.env.HOLDRIM_DEV_EMAIL !== undefined ? process.env.HOLDRIM_DEV_EMAIL || undefined : (project.actAs ?? undefined),
    });
  } else if (identityKind !== 'password') {
    throw new Error(`HOLDRIM_IDENTITY="${identityKind}" does not exist (use password, iap or dev)`);
  }
} catch (error) {
  refuseToStart(error);
}

/**
 * Where events live. `sqlite` is the default for running the tool without a cloud: one file, no
 * external dependency, and the database REFUSING update and delete — "nothing is erased" stops
 * being a promise and becomes a guarantee.
 *   memory    | gone when it stops. For developing and testing.
 *   sqlite    | a file on disk, at HOLDRIM_EVENTS_PATH. The "start it and use it" mode.
 *   firestore | Google Cloud. Needs HOLDRIM_PROJECT.
 */
const eventsKind = process.env.HOLDRIM_EVENTS ?? (cfg.mode === 'local' ? 'memory' : 'sqlite');
const events: EventStore = await (async () => {
  switch (eventsKind) {
    case 'memory': return new MemoryEventStore();
    case 'sqlite': return new SqliteEventStore(process.env.HOLDRIM_EVENTS_PATH ?? './data/events.db');
    case 'firestore': {
      if (!cfg.project) { console.error('invalid configuration: firestore needs HOLDRIM_PROJECT'); process.exit(1); }
      // Imported here and only here — see the note at the top of store.ts. If the optional package
      // was not installed, say which one, instead of a module-resolution stack at boot.
      const { FirestoreEventStore } = await import('./store-firestore.ts').catch((error) => {
        console.error('invalid configuration: HOLDRIM_EVENTS=firestore needs the optional package '
          + `@google-cloud/firestore, which is not installed (${error.message})`);
        process.exit(1);
      });
      return new FirestoreEventStore(cfg.project);
    }
    default:
      console.error(`invalid configuration: HOLDRIM_EVENTS="${eventsKind}" (use memory, sqlite or firestore)`);
      process.exit(1);
  }
})();

/**
 * The fact an unwritten ✓ is measured against (decision B, round 1's review): who HOLDRIM_OWNER was
 * the moment THIS server first read this store. Resolved once, at boot, before anything is served —
 * "on the first start of this version" means whatever the store already holds, checked here, never a
 * flag this process could lose track of. See `ensureLockBaseline`'s own comment (types.ts) for the
 * write it makes, and why it is never reachable from a client POST.
 *
 * It also decides which events' WRITTEN fields are trusted at all (round 2's review): `isLocked` and
 * `authorCouldTriage` (types.ts) read `data.locks`/`data.authorCouldTriage` only for an event dated
 * after this one — anything this server itself recorded, this boot or an earlier one of this
 * version — never for one that predates it, which is a store from before this mechanism existed and
 * could hold whatever a client's own POST body once put in `data`.
 */
const LOCK_BASELINE = await ensureLockBaseline(events, roles.owner);

/** Wraps `idForLog`/`actedOn` (engine/api/people.ts) around this server's own store. */
const idForLog = (email: string) => peopleIdForLog(events, email);
const actedOn = (subject: string, actor: string) => peopleActedOn(events, subject, actor);

/**
 * Where the people and their sessions live. Same idea as Keycloak: a file to run it on a laptop, a
 * real database for a deployment whose instances come and go.
 *   (absent)      | SQLite, at HOLDRIM_USERS_PATH or ./data/users.db
 *   sqlite:<path> | SQLite in that file
 *   firestore     | Google Cloud. Needs HOLDRIM_PROJECT
 *   postgres://…  | Postgres. `postgresql://…` works too
 *
 * ⚠️ SQLite on Cloud Run loses people. The disk there is ephemeral and per instance, so an access
 * created today is gone when the platform recycles the instance — with no error and no log. That
 * failure is the reason this variable exists; see engine/api/users.ts.
 */
/** The kind of store a URL names, with nothing secret left in it. Safe to log. */
const userStoreKind = (url: string | undefined): string => {
  const u = (url ?? '').trim();
  if (u === '' || u.startsWith('sqlite')) return 'sqlite';
  if (u === 'firestore') return 'firestore';
  if (u.startsWith('postgres')) return 'postgres';
  return 'unknown';
};

let byPassword: PasswordIdentity | null = null;
if (identityKind === 'password') {
  let users;
  try {
    users = await openUserStore(process.env.HOLDRIM_USERS, {
      projectId: cfg.project,
      sqlitePath: process.env.HOLDRIM_USERS_PATH ?? DEFAULT_SQLITE_PATH,
    });
  } catch (error) {
    console.error('invalid configuration: ' + (error instanceof Error ? error.message : String(error)));
    process.exit(1);
  }
  byPassword = new PasswordIdentity(users, { secure: cfg.environment !== 'Development' });
  await users.purgeExpiredSessions();

  // ⚠️ It WARNS, it does not refuse. This configuration works — it just forgets people — and a
  // service that refuses to start is a new way to be stuck at three in the morning over something
  // that was never an emergency. The choice stays with whoever deploys; what they were missing is
  // the information.
  //
  // One structured line at WARNING rather than a banner of '=': this fires only on a hosted
  // runtime, where nobody is watching a terminal and the log collector is the only reader. A
  // banner is loud on a screen; a severity is loud in a log.
  const ephemeralWarning = ephemeralUserStoreWarning(process.env.HOLDRIM_USERS);
  if (ephemeralWarning) log('WARNING', 'ephemeral_user_store', { warning: ephemeralWarning });

  // First boot: creates the owner's access and shows the password ONCE. A fixed password like
  // "admin" is an invitation, and an internal tool stays up for years with nobody looking.
  //
  // The display name comes from configuration because the alternative is everyone's first account
  // being called "Owner" — and a review history where every approval is signed by a job title
  // instead of a person is a history that answers "who said this?" with "the owner did".
  //
  // ⚠️ English, hard-coded, and NOT through i18n. This prints before anyone has a session, so
  // there is no person and no chosen language yet — the same reason boot errors stay English. The
  // comment at the top of engine/core/i18n.js is the long version.
  const password = await byPassword.firstAccess(cfg.owner!, process.env.HOLDRIM_OWNER_NAME || 'Owner');
  if (password) {
    console.log('\n' + '='.repeat(72));
    console.log('  FIRST ACCESS — write it down now, this password is not shown again:');
    console.log(`     sign in with: ${cfg.owner}`);
    console.log(`     password:     ${password}`);
    console.log('  You will have to change it when you sign in.');
    console.log('='.repeat(72) + '\n');
  }
}

// ---------------------------------------------------------------- helpers
const json = (res: ServerResponse, code: number, body: unknown) => {
  const text = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', ...API_HEADERS });
  res.end(text);
};

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.pdf': 'application/pdf', '.ico': 'image/x-icon',
};

async function rawBody(req: IncomingMessage): Promise<string> {
  const parts: Buffer[] = [];
  let size = 0;
  for await (const p of req) {
    size += p.length;
    // A ceiling BEFORE parsing, and the message goes to the log, not to the person: the reply is
    // the unhandled-error 500 below, which says only `api.internal` plus an id. Whoever operates
    // greps this line by that id, so it is English like every other piece of evidence.
    if (size > 1_000_000) throw new Error('request body larger than 1 MB');
    parts.push(p);
  }
  return Buffer.concat(parts).toString('utf8');
}

/** Whether the request says its body is JSON — the media type alone, whatever the parameters. */
function declaresJson(req: IncomingMessage): boolean {
  return (req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase() === 'application/json';
}

/**
 * The body as a JSON object, or a UserInputError the edge answers with a 400. A typo in a body is
 * the caller's mistake: uncaught, `JSON.parse` would make it the 500 that says the service is
 * broken, and `null` would get one step further and fail on `body.email`. Every route reads fields
 * off the result, so anything that is not an object — `null`, an array, a number — is refused
 * here, once.
 */
async function jsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const text = await rawBody(req);
  if (!text) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new UserInputError('request body is not a JSON object', 'api.body.notObject');
  }
  return parsed as Record<string, unknown>;
}

/**
 * Which toggle an event needs turned on, or null when nothing about it is gated at all.
 *
 * A plain lookup, never a question asked of `roles`: FEATURES decide what exists, capabilities
 * decide who may use it, and the two must never blend into one function — the moment a toggle could
 * also be read as "may", it could be read as a way to take a capability from someone, which is
 * exactly what docs/ROLES.md's "a toggle never turns off a guard" forbids. `approval`,
 * `request_state` and `supplement` are absent on purpose: they are how a request already filed
 * moves and how a text is locked, never a way to file a new kind of thing a toggle could gate.
 */
function gatingFeatureOf(incoming: NewEvent): keyof typeof project.features | null {
  if (incoming.type === 'comment') return 'comments';
  if (incoming.type === 'request' && incoming.data?.category === 'page') return 'pageRequests';
  if (incoming.type === 'request' && incoming.data?.category === 'bug') return 'bugCategory';
  return null;
}

/**
 * Why an event is refused before anything else about it is looked up, or null when it may go on.
 *
 * Called by `recordEvent` only, the one way into the event store for the API and both of the home's
 * forms, so a request is held to the same rules whichever door it came in through. A second copy of
 * these checks, written for a form, is how that form would one day accept the 500 KB text the API
 * refuses.
 */
function refusalOf(incoming: NewEvent, email: string, say: (key: string, params?: Record<string, string | number>) => string):
  { status: number; body: Record<string, unknown> } | null {
  if (!EVENT_TYPES.has(incoming.type)) {
    return { status: 400, body: { error: say('api.event.unknownType'), type: incoming.type } };
  }
  // Checked before the feature gate below: `gatingFeatureOf` matches `data.category` by EXACT
  // string — `"Bug"` or `"page "` would silently side-step whichever toggle the real spelling would
  // have gated, because nothing else validates it is one of `cycle.json`'s own categories.
  //
  // ⚠️ `typeof category !== 'string'` is checked FIRST, never folded into `String(category)` the way
  // this used to read. `gatingFeatureOf` compares the RAW value (`data.category === 'page'`), never a
  // stringified one — and `String([...])` joins a single-element array with nothing in between, so a
  // JSON body naming `"category":["page"]` used to pass THIS check (`String(['page']) === 'page'`)
  // while `gatingFeatureOf` read the very same value and saw neither `'page'` nor `'bug'`: the gate
  // stayed null, and a request shaped exactly like a page request reached the store with pageRequests
  // off, never having asked it. Requiring a real string closes the gap by construction: the two
  // checks now agree on the same value instead of two different ones that merely print the same.
  // `data.category` is `unknown` (the core's own typedef, `engine/core/cycle.js`), and a category is
  // never required — a request naming none still goes on to the checks below.
  //
  // `short`, not the raw value, in the message: `category` is caller-controlled and unbounded until
  // `overLimit` runs, further down — echoing it whole here is how a 200 KB category once became a
  // 200 KB error body.
  const category = incoming.data?.category;
  if (incoming.type === 'request' && category !== undefined
      && (typeof category !== 'string' || !Object.hasOwn(cycle.table.request_categories ?? {}, category))) {
    return { status: 400, body: { error: say('api.request.unknownCategory', { category: short(category) }) } };
  }
  // Checked before anything role-shaped: a feature that is off refuses everyone, owner included —
  // it is not a permission, and answering 403 either way keeps the two indistinguishable to whoever
  // is refused, exactly as intended.
  const gate = gatingFeatureOf(incoming);
  if (gate && !project.features[gate]) {
    return { status: 403, body: { error: say('api.feature.disabled', { feature: gate }) } };
  }
  if (incoming.type === 'approval' && (!incoming.block || !incoming.fingerprint)) {
    return { status: 400, body: { error: say('api.approval.needsBlockAndFingerprint') } };
  }
  // Approving belongs to owner and admin. Only the owner's ✓ becomes a lock in the repository —
  // `holdrim sync` takes theirs alone — and an admin's is recorded, and stays an opinion.
  if (incoming.type === 'approval' && !roles.can('approve', email)) {
    return { status: 403, body: { error: say('api.approval.ownerOnly') } };
  }
  if (['request', 'comment', 'supplement'].includes(incoming.type) && !incoming.text?.trim()) {
    return { status: 400, body: { error: say('api.text.required') } };
  }
  const limit = overLimit(incoming, project.pageExamples);
  if (limit) return { status: 400, body: { error: say(limit.key, limit.params) } };
  return null;
}

/**
 * A request plus the state the server computed. The front end does not reimplement the cycle.
 * `thread` is the request's own events (`cycle.threadsOf`), not the whole list: see there why.
 * `authorCouldTriage` (types.ts) is what reads what `recordEvent` wrote onto the request when it was
 * FILED — the one implementation this file and requests.ts (the agent's CLI) both call, so there is
 * no second copy of the fallback to drift from it (round 1's review, finding 2). It trusts that
 * written field only when the request itself is dated after `LOCK_BASELINE` (round 2's review): a
 * request from before this whole mechanism existed could hold a client-forged `authorCouldTriage`
 * `recordEvent` never wrote, back when it stored whatever `data` a client sent.
 */
const withStatus = (e: Event, thread: Event[]) => ({
  ...e,
  status: cycle.status(cycle.currentState(e.id, thread, authorCouldTriage(e, LOCK_BASELINE))),
});

/**
 * An event as a reader gets it: a request with its state, and an approval saying whether it is the
 * lock. Only the owner's ✓ is — `holdrim sync` and the home count theirs alone — and a panel that
 * painted any ✓ green, an admin's included, would show an opinion as if it were the lock. `isLocked`
 * (types.ts) reads what `recordEvent` wrote onto the ✓ when it was GIVEN — but only when the ✓ is
 * dated after `LOCK_BASELINE`, for the same reason `withStatus`, above, gates `authorCouldTriage` the
 * same way — falling back to `legacyLock` against `LOCK_BASELINE` for one that predates it, or holds
 * nothing at all. The one implementation this file and validation.ts (`holdrim sync`) both call.
 */
const asRead = (e: Event, threads: Map<string, Event[]>) => {
  if (e.type === 'request') return withStatus(e, threads.get(e.id) ?? []);
  if (e.type === 'approval') return { ...e, locks: isLocked(e, LOCK_BASELINE) };
  return e;
};

/**
 * What `viewer` is sent instead of `subject`'s own address — docs/ROLES.md, "How a person appears":
 * the project's `people.show`, with the two overrides the design names applied here, once, so the
 * panel, the home and the API's own two `/events` routes never re-decide them. `alwaysNamed` covers
 * both: the owner and a holder of `people` (`roles.can('people', …)` already answers true for the
 * owner — see `ROLE_CAPABILITIES` in engine/core/roles.js) see every name, and a person sees their
 * own on their own requests, whatever the project chose.
 *
 * `id` is `authorId` (`withAuthors`, engine/api/people.ts) — the value `author` held before it was
 * resolved to an address — so this never has to ask the store a second time for what the first read
 * already had in hand.
 */
async function personDisplay(subject: string, id: string | undefined, viewer: string | null, lang: string): Promise<string> {
  const alwaysNamed = viewer !== null && (subject === viewer || roles.can('people', viewer));
  // Only asked when the answer could actually change: `alwaysNamed` and `people.show: "name"` are
  // the only two paths `personAs` reads `name` on at all, and behind no password there is no account
  // to find in the first place — an identity proxy holds no name Holdrim could show instead.
  const needsName = alwaysNamed || project.peopleShow === 'name';
  const user = needsName && byPassword ? await byPassword.users.find(subject) : null;
  return personAs({
    show: project.peopleShow, email: subject, id: id ?? null, name: user?.name ?? null,
    role: i18n.t(lang, `people.role.${roles.roleOf(subject)}`), alwaysNamed,
  });
}

/**
 * `personDisplay` over a list of events, once per DISTINCT author rather than once per event: a
 * page's history repeats the same few people, and a busy home page many more.
 */
async function authorDisplaysFor(
  events: { author: string; authorId?: string }[], viewer: string | null, lang: string,
): Promise<Map<string, string>> {
  const distinct = new Map<string, string | undefined>();
  for (const e of events) if (!distinct.has(e.author)) distinct.set(e.author, e.authorId);
  const entries = await Promise.all(
    [...distinct].map(async ([email, id]) => [email, await personDisplay(email, id, viewer, lang)] as const),
  );
  return new Map(entries);
}

/**
 * The extra `{author, authorId}` pairs `authorDisplaysFor` needs so `resolveRemovedBy` (engine/api/
 * texts.ts) can also resolve `e`'s `textRemoved.by`/`snapshotRemoved.by` — round 1 of the issue #31
 * review, finding 1. `Removed.by` is already an address (`removalsOf`'s own comment says why), the
 * same shape `author` is before `authorDisplaysFor` resolves it, so it needs the same treatment.
 *
 * `authorId` comes from `all` rather than a second store read: `removeText` (store-sqlite.ts) always
 * writes the removal on the SAME page and block as the text it removes, so whichever event produced
 * `Removed.by` is already in whatever list the caller has in hand — `all` for `/events?page=`, the
 * whole-site `all` of `/events/:id` — under that exact `author` value. A remover with no match at
 * all (impossible today, since `removeText` never leaves an event unauthored) is passed through with
 * `authorId: undefined`, which `authorDisplaysFor` already reads as "no id to show instead of a
 * name" — the same fallback an event from before ids existed gets.
 */
function removalSubjectsOf(
  e: { textRemoved?: Removed | null; snapshotRemoved?: Removed | null },
  all: { author: string; authorId?: string }[],
): { author: string; authorId?: string }[] {
  const subjects: { author: string; authorId?: string }[] = [];
  for (const removed of [e.textRemoved, e.snapshotRemoved]) {
    if (!removed) continue;
    subjects.push({ author: removed.by, authorId: all.find((x) => x.author === removed.by)?.authorId });
  }
  return subjects;
}

// ---------------------------------------------------------------- the API routes
/**
 * Records one event for `email`, after every check the cycle demands — or says, as a status and a
 * body, why not. The one door into the event store: the API, the home's "ask for a page" form and
 * its triage form all come through here, so a rule added for one reaches the others.
 *
 * @param through  where it came from, for the log only
 */
async function recordEvent(
  incoming: NewEvent, email: string, say: (key: string, params?: Record<string, string | number>) => string,
  through = 'api',
): Promise<{ status: number; body: Record<string, unknown>; event?: Event }> {
  const canApprove = roles.can('approve', email);
  const refusal = refusalOf(incoming, email, say);
  if (refusal) return refusal;

  if (incoming.type === 'request_state' || incoming.type === 'supplement') {
    const requestId = incoming.data?.request;
    if (!requestId) return { status: 400, body: { error: say('api.request.needsRequestId') } };
    const ofPage = await events.list(incoming.page);
    const request = ofPage.find((e) => e.id === requestId && e.type === 'request');
    if (!request) return { status: 404, body: { error: say('api.request.notFound') } };
    const current = cycle.currentState(requestId, ofPage, authorCouldTriage(request, LOCK_BASELINE));

    if (incoming.type === 'supplement') {
      if (email !== request.author && !canApprove) {
        return { status: 403, body: { error: say('api.supplement.ownerOrAuthor') } };
      }
      if (!cycle.acceptsSupplement(current)) {
        // The state travels into the sentence as the contract value, untranslated, because it is
        // also the `state` field next to it — one name for one thing, in both places.
        return { status: 409, body: { error: say('api.supplement.tooLate', { state: current }), state: current } };
      }
    } else {
      const target = incoming.data?.state as string | undefined;
      if (!target) return { status: 400, body: { error: say('api.state.required') } };
      if (!cycle.exists(target)) return { status: 400, body: { error: say('api.state.unknown') } };
      const agentState = cycle.agentStates.includes(target);
      if (!canApprove && !(iap?.localMode && agentState)) {
        return { status: 403, body: { error: say('api.triage.ownerOnly') } };
      }
      if (cycle.requiresReason(target) && !incoming.text?.trim()) {
        return { status: 400, body: { error: say('api.reason.required') } };
      }
      if (cycle.requiresCommit(target) && !validCommit(incoming.data)) {
        return { status: 400, body: { error: say('api.commit.required') } };
      }
      if (!cycle.canGo(current, target)) {
        return { status: 409, body: { error: say('api.state.cannotGo', { from: current, to: target }), state: current } };
      }
      // Race guard: recording where the change departed from makes the history itself the
      // guard — see `currentState` in engine/core/cycle.js.
      incoming.data = { ...incoming.data, from: current };
    }
  }

  // Written NOW, from the grants `roles` holds at this exact instant — never left for a later read
  // to work out, which is the bug this closes (docs/ROLES.md §3, "written at the moment, read
  // forever after"): a ✓ recomputed on every read stops being a lock the moment its author no longer
  // holds `lock`, and a request recomputed the same way is silently decided the moment its author
  // gains `triage`, with no triage event ever written. Written as a STRING — see `writtenBoolean`'s
  // own comment for why a bare boolean here would silently break the CLI's cloud reader.
  if (incoming.type === 'approval') {
    incoming.data = { ...incoming.data, [LOCKS_FIELD]: String(roles.can('lock', email)) };
  } else if (incoming.type === 'request') {
    incoming.data = { ...incoming.data, [AUTHOR_COULD_TRIAGE_FIELD]: String(roles.can('triage', email)) };
  }
  // Every event, not only the ones an agent may not write: the trail has to say an agent closed an
  // impact or moved a request (docs/ROLES.md §4), and it has to say so from the identity the server
  // saw, never from a `data.asAgent` the client sent — spread LAST so that one is always replaced.
  incoming.data = { ...incoming.data, [AS_AGENT_FIELD]: String(roles.isAgent(email)) };

  // Resolved BEFORE the write, not after: an event's author is never null — the row has to exist
  // for the event to mean anything — so this is the one log id that must still find-OR-CREATE.
  // `recordAuthored` (engine/api/people.ts) is why the order can't drift back: it takes the store as
  // a parameter precisely so a stub can prove the resolve-then-append order without a running server.
  // `append` resolves the same address again to store the event, and finds the row this just made —
  // one person, one insert.
  const { author, event: e } = await recordAuthored(events, incoming, email);
  log('INFO', 'event_recorded', {
    id: e.id, type: e.type, page: e.page, block: e.block, author,
    from: e.data?.from, to: e.data?.state, through,
  });
  return { status: 201, body: e as unknown as Record<string, unknown>, event: e };
}

async function api(req: IncomingMessage, res: ServerResponse, url: URL, email: string) {
  const route = url.pathname.replace(/^\/api/, '');

  // ---------------------------------------------------------------- in and out (password identity)
  if (byPassword && req.method === 'POST' && route === '/sign-out') {
    await byPassword.users.closeSession(byPassword.sessionIdFrom(req.headers));
    res.setHeader('set-cookie', byPassword.signOutCookie());
    return json(res, 200, { ok: true });
  }

  if (byPassword && req.method === 'POST' && route === '/change-password') {
    const body = await jsonBody(req);
    // Strings or nothing, as at sign-in: a number would reach `.normalize()` and answer 500.
    const current = typeof body.current === 'string' ? body.current : '';
    const next = typeof body.next === 'string' ? body.next : '';
    const checked = await byPassword.checkCurrent(email, current);
    if (!checked) return json(res, 403, { error: i18n.t(languageOf(req), 'api.password.currentWrong') });
    // Issue #115: the caller's own session must survive a password THEY chose — dropping it too
    // would sign them out of the very tab that just proved it is them. Read before `changePassword`
    // runs, not after: the value never changes mid-request, and reading it after would only be a
    // second place for the same cookie header to be misparsed.
    const ownSession = byPassword.sessionIdFrom(req.headers);
    let sessionsDropped: boolean;
    try {
      ({ sessionsDropped } = await byPassword.users.changePassword(email, next, ownSession));
    } catch (error) {
      // Translated HERE, at the edge, and only here: the store throws a key, never a sentence.
      const failure = UserInputError.from(error, 'api.password.invalid');
      return json(res, 400, { error: i18n.t(languageOf(req), failure.key, failure.params) });
    }
    log('INFO', 'password_changed', { person: await idForLog(email) });
    // Same reasoning as the reset and the disable routes: the credential already changed either way,
    // but a failed drop means every OTHER session for this account may still be alive — reported the
    // same way theirs is, by id and at ERROR, never swallowed into a plain 200 nobody reads twice.
    if (!sessionsDropped) {
      log('ERROR', 'user_sessions_not_dropped', { person: await idForLog(email), reason: 'changing your own password' });
    }
    return json(res, 200, { ok: true, ...(sessionsDropped ? {} : { sessionsDropped }) });
  }

  if (req.method === 'GET' && route === '/me') {
    return json(res, 200, {
      email,
      role: roles.roleOf(email),
      canApprove: roles.can('approve', email),
      canTriage: roles.can('triage', email),
      owner: roles.isOwner(email),
      admins: roles.admins,
      // The language this person reads in, decided here by the one rule the server's screens use —
      // their own choice, then the browser, then the project — so the panel does not decide it a
      // second way and speak Spanish on a page whose sign-in spoke Portuguese.
      language: languageOf(req),
      // The toggles the PANEL draws a control for, and only those — never peopleScreen or graph,
      // which gate a server screen and a CLI command the panel never renders. Without this the
      // panel would keep offering "Comment", or the bug/page categories, after a project turned
      // them off, and the person would type into a form the server then 403s on: the front end has
      // to obey the same answer the server would give (docs/ROLES.md, "The front end obeys the
      // server"). `engine/web/src/Panel.jsx` is the one place that reads this.
      features: { comments: project.features.comments, pageRequests: project.features.pageRequests, bugCategory: project.features.bugCategory },
      // Only exists with password login. Without it, reloading the page would forget the password
      // is still the first-access one — and the change screen would only appear at login.
      ...(byPassword ? { mustChangePassword: (await byPassword.fromRequest(req.headers))?.mustChangePassword ?? false } : {}),
    });
  }

  // ---------------------------------------------------------------- people, and who may get in
  //
  // ⚠️ These routes exist ONLY with password identity, and the guard is `byPassword`. Behind an
  // identity proxy there is no user store at all — who exists is the proxy's directory — so
  // answering here would be inventing a second, empty source of truth for who works at the
  // company. Without a store they fall through to the 405 at the bottom.
  //
  // ⚠️ Who may do this comes from `roles`, which reads HOLDRIM_OWNER and HOLDRIM_ADMINS — NOT from
  // the user store. The two are different questions: the store answers "does this person have a
  // way in", the configuration answers "what may they do". Putting the role in the row would
  // create a second truth, and on the day they disagree nobody can say which one is the service.
  if (byPassword && (await userRoutes(req, res, route, email, byPassword.users, languageOf(req)))) return;

  if (req.method === 'GET' && route === '/events') {
    const page = url.searchParams.get('page');
    // ALL events of a request live on its own page (triage and the agent write with the request's
    // page), so the filtered query is enough — no need to scan the whole collection.
    const all = await events.list(page);
    const threads = cycle.threadsOf(all);
    const lang = languageOf(req);
    const displays = await authorDisplaysFor(all, email, lang);
    // `own`, never a raw address the panel could compare `me` against: `author` below is already
    // whatever `people.show` says this viewer may see, which for anyone but the viewer themselves is
    // not necessarily an e-mail at all — docs/ROLES.md, "The front end obeys the server" (the panel
    // computes nothing, `engine/web/src/Panel.jsx`'s own `.own` reads). `textRemoved`/`snapshotRemoved`
    // go through the very same map: the remover's own event is on this page too (`removeText` writes
    // it there), so `displays` already has their entry — no second resolve, and no raw address left
    // inside `Removed` for a viewer `author` itself already hides it from.
    return json(res, 200, all.map((e) => ({
      ...asRead(e, threads), author: displays.get(e.author) ?? e.author,
      textRemoved: resolveRemovedBy(e.textRemoved, displays), snapshotRemoved: resolveRemovedBy(e.snapshotRemoved, displays),
      own: e.author === email,
    })));
  }

  const oneEvent = route.match(/^\/events\/([A-Za-z0-9_-]+)$/);
  if (req.method === 'GET' && oneEvent) {
    const all = await events.list(null);
    const found = all.find((e) => e.id === oneEvent[1]);
    if (!found) return json(res, 404, { error: i18n.t(languageOf(req), 'api.event.notFound'), id: oneEvent[1] });
    const lang = languageOf(req);
    // Unlike the list route above, `all` here spans every page, so `[found]` alone would miss the
    // remover entirely: `removalSubjectsOf` adds them, by the same event `Removed.by` came from.
    const displays = await authorDisplaysFor([found, ...removalSubjectsOf(found, all)], email, lang);
    return json(res, 200, {
      ...asRead(found, cycle.threadsOf(all)), author: displays.get(found.author) ?? found.author,
      textRemoved: resolveRemovedBy(found.textRemoved, displays), snapshotRemoved: resolveRemovedBy(found.snapshotRemoved, displays),
      own: found.author === email,
    });
  }

  // The current fingerprint of blocks by id, read from the pages on disk. The panel computes the
  // fingerprints of its own page in the browser; a block it depends on that lives on ANOTHER page is
  // not in its DOM, and without this it would have to guess — and guessing "moved" paints every
  // cross-page dependency red. Unknown ids are left out: a dependency that is gone is the panel's
  // to judge, the same way the CLI does.
  //
  // No cap on how many ids: the answer holds only ids the site has, so it is never larger than the
  // site, and the query is already bounded by the server's header limit. A cap would drop real ids
  // silently, and the panel cannot tell a dropped id from a vanished one — it would paint red a
  // dependency that never moved.
  if (req.method === 'GET' && route === '/fingerprints') {
    const ids = new Set((url.searchParams.get('ids') ?? '').split(',').filter(Boolean));
    const blocks = await readBlocks(projectRoot);
    return json(res, 200, Object.fromEntries([...ids].filter((id) => blocks.has(id))
      .map((id) => [id, blocks.get(id)!.fingerprint])));
  }

  // What would need checking, transitively, before touching this block — the panel's "impact
  // radius" (docs/IMPACT.md). Computed here, from the SAME `radiusOf` the CLI's `if-i-touch` is
  // built on (engine/core/validity.js), because the panel only has the DOM of the page it is on:
  // a dependent three pages away is invisible to it unless the server names it.
  //
  // No `blocks.has(id)` guard: an id nobody declares any more still answers correctly, because
  // `radiusOf` looks at what OTHER blocks point at, not at whether `id` itself is there — the same
  // reasoning `stateOf` already relies on for "red when the dependency vanishes, too".
  //
  // ⚠️ Every dependent is named, with no visibility filter — the same gap `/fingerprints` already
  // has. Fine today, when a session only needs to be signed in at all; once grants can be scoped to
  // pages or blocks (#33), this has to filter by what the viewer may see, or the radius becomes a
  // way to learn the ids of blocks a scoped grant was meant to hide.
  if (req.method === 'GET' && route === '/impact-radius') {
    const id = url.searchParams.get('id') ?? '';
    const blocks = await readBlocks(projectRoot);
    return json(res, 200, { ids: radiusOf(id, blocks) });
  }

  // The documentation graph (#38): every block as a node, `data-depends` as edges, the traffic
  // light as colour — `graphOf`'s OWN answer (engine/cli/graph.ts), the same one `holdrim graph`
  // prints, never a second walk of the same pages. `href` is added HERE, not inside `graphOf`,
  // because it is a URL a BROWSER opens, not a fact about the graph — the same separation
  // `summarisePages` (home-page.ts) already keeps between a page's traffic light and where it is
  // served from. A `missing` node — a dangling `data-depends`, engine/cli/graph.ts's own doc
  // comment — has no block behind it and so no page to open: `href` comes back `null`.
  //
  // No `features.graph` check: hiding a SCREEN must never mean disabling what it fronts
  // (docs/ROLES.md, "no toggle may disable a guard" — `peopleScreenOn`, above, reads the same rule
  // for `/api/users*`). The home renders no script to call this route when the toggle is off, but
  // the route itself asks the one question every other block-reading route already asks — is
  // anybody signed in at all — and, same as `/impact-radius` and `/fingerprints`, asks nothing more
  // of WHO: any viewer sees the same graph the home's own tables already name every block in.
  if (req.method === 'GET' && route === '/graph') {
    const blocks = await readBlocks(projectRoot);
    const registry = loadRegistry(projectRoot);
    const graph = graphOf(blocks, registry);
    const nodes = graph.nodes.map((n) => {
      const block = blocks.get(n.id);
      const href = block
        ? `/${relative(cfg.site, block.path).split(sep).join('/')}#${encodeURIComponent(n.id)}` : null;
      return { id: n.id, page: n.page, kind: n.kind, state: n.state, href };
    });
    return json(res, 200, { nodes, edges: graph.edges });
  }

  if (req.method === 'GET' && route === '/requests/open') {
    const all = await events.list(null);
    const threads = cycle.threadsOf(all);
    const toTriage = all.filter((e) => e.type === 'request')
      .filter((r) => cycle.currentState(r.id, threads.get(r.id) ?? [], authorCouldTriage(r, LOCK_BASELINE)) === 'open').length;
    return json(res, 200, { toTriage });
  }

  // ---------------------------------------------------------------- tampered texts (issue #107)
  //
  // What the panel's banner shows: every finding a read of the whole store resolves to tampered, less
  // the ones the owner acknowledged — as ids and locale keys, never prose. Any signed-in reader gets
  // it: a text nobody can vouch for is everybody's to know about, not only the owner's. There is no
  // `holdrim.json` toggle for it and there must never be one (issue #107's decision): an alert the
  // repository can switch off is an alert whoever commits to it can hide.
  if (req.method === 'GET' && route === '/tampered') {
    const found: TamperReport[] = [];
    const all = await events.list(null, found);
    return json(res, 200, { findings: openFindings(found, all), canAcknowledge: mayAcknowledge(roles, email) });
  }

  // The owner's acknowledgement of ONE finding. Its own route, not `POST /events`: that path takes
  // `data` from the client, and this event's `data` has to be what the server itself found, on a
  // read made here — see `TAMPER_ACKNOWLEDGED` (tamper.ts). `POST /events` refuses the type as
  // unknown. Nothing here repairs the text: it appends one event, and the field goes on reading as
  // tampered, with its CRITICAL line on every read.
  if (req.method === 'POST' && route === '/tampered/acknowledge') {
    const say = (key: string, params?: Record<string, string | number>) => i18n.t(languageOf(req), key, params);
    // Identity before the body is read: a refusal must not depend on, or reveal, what was sent.
    if (!mayAcknowledge(roles, email)) return json(res, 403, { error: say('api.tamper.ownerOnly') });
    const body = await jsonBody(req);
    const found: TamperReport[] = [];
    const all = await events.list(null, found);
    const verdict = acknowledgementRefusal(roles, email, body, openFindings(found, all));
    if ('refused' in verdict) return json(res, verdict.refused.status, { error: say(verdict.refused.key) });
    const incoming = acknowledgementOf(verdict.found);
    // `asAgent` from the identity the server saw, as `recordEvent` writes it on every other event
    // (docs/ROLES.md, section 4) — never from the client, whose body this never spreads.
    incoming.data = { ...incoming.data, [AS_AGENT_FIELD]: String(roles.isAgent(email)) };
    const { author, event: e } = await recordAuthored(events, incoming, email);
    log('INFO', 'tamper_acknowledged', {
      id: e.id, eventId: verdict.found.event, field: verdict.found.field, kind: verdict.found.kind,
      finding: verdict.found.finding, author,
    });
    res.setHeader('location', `/api/events/${e.id}`);
    return json(res, 201, e);
  }

  if (req.method === 'POST' && route === '/events') {
    const incoming = (await jsonBody(req)) as NewEvent;
    // The sentences on this path are for the person looking at the panel, so they come out of the
    // dictionaries in the language they chose. `type` and the state values below do NOT: those are
    // contract, and a value that changes with the reader's locale is a value nobody can match on.
    const say = (key: string, params?: Record<string, string | number>) =>
      i18n.t(languageOf(req), key, params);
    const outcome = await recordEvent(incoming, email, say);
    if (outcome.event) res.setHeader('location', `/api/events/${outcome.event.id}`);
    return json(res, outcome.status, outcome.body);
  }

  return json(res, 405, { error: i18n.t(languageOf(req), 'api.route.notFound'), route });
}

/**
 * Managing the people who may sign in. Returns true when it answered the request.
 *
 * Split out of `api()` because it is a self-contained subject with five routes and one rule that
 * has to hold across all of them, and because a screen sits on top of it — the guards below are
 * the whole contract that screen may rely on.
 *
 * ## What never leaves this function
 *
 * A generated password is returned EXACTLY ONCE, in the body of the request that generated it. It
 * is never readable again, never in a `GET`, and never in a log line. That is not tidiness: this
 * service writes one structured JSON line per fact, and on a hosted runtime those lines go to a
 * collector that many more people can read than can ever sign in here. A password in a log is a
 * password with a much wider audience than the account it opens.
 */
async function userRoutes(
  req: IncomingMessage, res: ServerResponse, route: string, email: string,
  users: UserStore, lang: string,
): Promise<boolean> {
  const say = (key: string, params?: Record<string, string | number>) => i18n.t(lang, key, params);
  /** Owner and admin, and nobody else: the `people` capability, which member does not hold. */
  const manages = () => roles.can('people', email);
  const forbidden = () => (json(res, 403, { error: say('api.users.adminOnly') }), true);

  // ---------------------------------------------------------------- the list
  if (route === '/users' && req.method === 'GET') {
    if (!manages()) return forbidden();
    // `list()` hands back `User` objects: no salt, no hash, and no password — the plain one was
    // never stored anywhere, so there is nothing here that could give one back.
    json(res, 200, { users: await users.list() });
    return true;
  }

  // ---------------------------------------------------------------- creating an access
  if (route === '/users' && req.method === 'POST') {
    if (!manages()) return forbidden();
    const body = (await jsonBody(req)) as { email?: string; name?: string };
    const address = normalizeEmail(String(body.email ?? ''));
    if (!isEmailAddress(address)) {
      // The bad value goes back in the message. "Invalid e-mail" next to a form with three fields
      // is a message that makes the person guess which one, and guess what is wrong with it.
      json(res, 400, { error: say('api.users.emailInvalid', { email: String(body.email ?? '') }) });
      return true;
    }
    const name = String(body.name ?? '').trim();
    if (!name) { json(res, 400, { error: say('api.name.empty') }); return true; }
    if (name.length > MAX_NAME_LENGTH) {
      json(res, 400, { error: say('api.name.tooLong', { max: MAX_NAME_LENGTH }) });
      return true;
    }
    // ⚠️ Checked, AND caught below. The check is what produces a message worth reading; the catch
    // is what covers two admins creating the same address at the same moment, where the check
    // passes twice and the database is the only thing that can still say no.
    // ⚠️ Nobody but the owner creates the OWNER's account, and this guard is the twin of the one
    // on the reset route: guarding only that one would leave this door open, and a rule enforced
    // on one path is not enforced.
    //
    // Being the owner is decided by HOLDRIM_OWNER, not by a column, so the account can legitimately
    // not exist yet: `firstAccess` only runs while the store is EMPTY, so handing the role over —
    // new address in the variable, store already full — leaves the owner's row missing. In that
    // window any admin could create it, read the generated password from this very response, sign
    // in, and from then on be the owner for every purpose: their ✓ locks, and nobody can disable
    // them. They never needed the reset route at all.
    if (roles.isOwner(address) && !roles.isOwner(email)) {
      json(res, 409, { error: say('api.users.ownerIsProvisionedAtBoot', { email: address }) });
      return true;
    }
    // ⚠️ Their accounts are guarded like the owner's (docs/ROLES.md, section 3): a password handed
    // out for a HOLDRIM_LOCKS address is a lock handed out, whoever ends up holding it. Guarded on
    // all four routes with the SAME question, `roles.isLockHolder` — see the reset and enabled
    // routes below.
    //
    // The MESSAGE never says "holds a lock" or names `HOLDRIM_LOCKS`. That does NOT stop an admin
    // from telling this account apart from an ordinary one — the refusal necessarily shows the
    // address is reserved, and this check runs before "already taken" below, so even the STATUS
    // CODE differs; the lock markers already in the event history name the holders anyway. What the
    // message withholds is only the MECHANISM — that the reservation is `HOLDRIM_LOCKS` specifically
    // — never the fact of the reservation itself, which the 409 already gives away (round 3 of #29's
    // review, finding 5; round 2's finding 5 first wrote this check, overclaiming what it hides).
    if (roles.isLockHolder(address) && !roles.isOwner(email)) {
      json(res, 409, { error: say('api.users.lockHolderIsOwnerToCreate', { email: address }) });
      return true;
    }
    if (await users.find(address)) {
      json(res, 400, { error: say('api.users.emailTaken', { email: address }) });
      return true;
    }
    let password: string;
    try {
      password = await users.create(address, name);
    } catch {
      json(res, 400, { error: say('api.users.emailTaken', { email: address }) });
      return true;
    }
    // The password is NOT in this line, and this is the line where it would be easiest to put it.
    log('INFO', 'user_created', await actedOn(address, email));
    json(res, 201, { user: await users.find(address), password });
    return true;
  }

  // ⚠️ `/users/me/name` is matched before the patterns below and cannot collide with them: `me` is
  // not an address, and `isEmailAddress` is what every other route puts in that position.
  if (route === '/users/me/name' && req.method === 'POST') {
    // No role check, on purpose: this is the one route about the caller's OWN row. Anybody who got
    // this far has a session, and correcting the spelling of your own name is not a privilege.
    const body = (await jsonBody(req)) as { name?: string };
    try {
      await users.rename(email, String(body.name ?? ''));
    } catch (error) {
      const failure = UserInputError.from(error, 'api.name.invalid');
      json(res, 400, { error: say(failure.key, failure.params) });
      return true;
    }
    log('INFO', 'user_renamed', { person: await idForLog(email) });
    json(res, 200, { user: await users.find(email) });
    return true;
  }

  // ---------------------------------------------------------------- a new password for somebody
  const reset = route.match(/^\/users\/([^/]+)\/password$/);
  if (reset && req.method === 'POST') {
    if (!manages()) return forbidden();
    const target = await found(reset[1]);
    if (!target) return true;
    // ⚠️ Nobody resets the OWNER's password but the owner. Without this an admin resets it, reads
    // the new password from this very response, signs in as the owner — and from then on every ✓
    // is signed with the owner's e-mail. In a method whose whole claim is "who approved this, and
    // when", that is not privilege escalation in the abstract: it is the audit trail becoming a
    // lie, with nothing in the record to show it happened.
    //
    // An owner who loses the password recovers it the way the invariant implies: whoever operates
    // the service removes the account and restarts, and the first-access password is generated
    // again. That is an operations act, on purpose — being the owner is configuration, not a
    // button someone else can press.
    if (roles.isOwner(target) && target !== email) {
      return json(res, 409, { error: say('api.users.ownerPasswordIsOwnTo') }), true;
    }
    // Same guard, extended to HOLDRIM_LOCKS (docs/ROLES.md, section 3): "the owner's alone", with no
    // exception for the lock-holder resetting themselves — unlike the owner's own guard above, which
    // exists so the owner is never locked out of their own recovery. A lock-holder has no comparable
    // need served by this admin-only route; `/change-password` is theirs already.
    //
    // The message does not say "holds a lock" here either — see the create route's own comment,
    // above, for why (round 2 of #29's review, finding 5).
    if (roles.isLockHolder(target) && !roles.isOwner(email)) {
      return json(res, 409, { error: say('api.users.lockHolderPasswordIsOwnerToReset', { email: target }) }), true;
    }
    const { password, sessionsDropped } = await users.resetPassword(target);
    // Said once, here, and nowhere else. Not in the log line below, not in any later GET.
    log('INFO', 'user_password_reset', await actedOn(target, email));
    // ⚠️ The credential change is real either way — `password` is returned regardless — but a
    // failed drop means the OLD sessions may still be alive, which is exactly the gap a reset
    // exists to close. `idForLog`, never `target`: docs/PRIVACY.md says a log names a person by id,
    // and this is the one line that used to carry the e-mail instead, from inside the store that
    // had no id to reach for.
    if (!sessionsDropped) {
      log('ERROR', 'user_sessions_not_dropped', { person: await idForLog(target), reason: 'password reset' });
    }
    json(res, 200, { user: await users.find(target), password, ...(sessionsDropped ? {} : { sessionsDropped }) });
    return true;
  }

  // ---------------------------------------------------------------- taking the access away
  const enabled = route.match(/^\/users\/([^/]+)\/enabled$/);
  if (enabled && req.method === 'POST') {
    if (!manages()) return forbidden();
    const body = (await jsonBody(req)) as { enabled?: unknown };
    // A missing field is not "false". Read as falsy, a body with a typo in the key would silently
    // revoke somebody's access, which is the most expensive way to misread a request here.
    if (typeof body.enabled !== 'boolean') {
      json(res, 400, { error: say('api.users.enabledMissing') });
      return true;
    }
    const target = await found(enabled[1]);
    if (!target) return true;

    // ⚠️ The owner cannot be disabled, not by an admin and not by themselves. `createRoles`
    // refuses to start with anything other than exactly one owner, so a service whose owner cannot
    // sign in is a service where nobody can approve and nobody can hand the role to anyone else —
    // and the fix is a restart with a different environment variable, which is not something the
    // person locked out can do from the screen they are looking at.
    //
    // 409 and not 403: 403 above means "you may not do this", and this is "this may not be done".
    // Telling the two apart is the difference between asking an admin for help and understanding
    // that the answer is in the configuration.
    if (!body.enabled && roles.isOwner(target)) {
      json(res, 409, { error: say('api.users.ownerCannotBeDisabled', { email: target }) });
      return true;
    }
    // ⚠️ BOTH directions on a lock-holder's account are the owner's alone (docs/ROLES.md, "Capabilities
    // are the engine's": the `people` capability's own entry reads "disable and re-enable — never …
    // the account of anyone who holds `lock`"). Round 1 of this issue guarded only re-enabling, on the
    // reasoning that disabling hands out no password — true, but it misses the other half: an admin
    // who can disable a lock-holder at will can silence their ✓ at the exact moment it would matter,
    // with no password needed to do it. One check now, not two: `roles.isLockHolder` does not care
    // which direction `body.enabled` asks for, only who is asking (round 2 of #29's review, finding 1).
    if (roles.isLockHolder(target) && !roles.isOwner(email)) {
      const key = body.enabled ? 'api.users.lockHolderIsOwnerToEnable' : 'api.users.lockHolderIsOwnerToDisable';
      json(res, 409, { error: say(key, { email: target }) });
      return true;
    }
    const { sessionsDropped } = await users.setEnabled(target, body.enabled);
    log('INFO', 'user_enabled_changed', { ...await actedOn(target, email), enabled: body.enabled });
    // Same reasoning as the reset route just above: the disable itself already took, but a failed
    // drop leaves the old sessions possibly alive, and that has to reach both the log — by id, not
    // by the e-mail the store no longer has anywhere to put — and the person who asked.
    if (!sessionsDropped) {
      log('ERROR', 'user_sessions_not_dropped', { person: await idForLog(target), reason: 'disabling the account' });
    }
    json(res, 200, { user: await users.find(target), ...(sessionsDropped ? {} : { sessionsDropped }) });
    return true;
  }

  return false;

  /** The address in the path, if somebody is there. Answers 404 itself and returns null if not. */
  async function found(segment: string): Promise<string | null> {
    // ⚠️ `decodeURIComponent` THROWS on a half-written escape like `%zz`, and an uncaught throw
    // here becomes a 500 with an incident id — the shape of an answer that says "the service is
    // broken" about a request that was simply malformed. A path nobody can decode names nobody.
    let target: string;
    try {
      target = normalizeEmail(decodeURIComponent(segment));
    } catch {
      json(res, 404, { error: say('api.users.notFound', { email: segment }) });
      return null;
    }
    // ⚠️ `find` returns disabled people too, and it has to: giving an access back is a request
    // about somebody who is, by definition, already disabled.
    if (await users.find(target)) return target;
    json(res, 404, { error: say('api.users.notFound', { email: target }) });
    return null;
  }
}

/** The only page served without a session. Self-contained on purpose: see engine/api/login.html. */
const SIGN_IN_SCREEN = '/sign-in';



/**
 * Whoever is asking, or null. The one place identity is resolved: the API and the engine's screens
 * both ask here, so a change to how people are identified cannot reach one and miss the other.
 */
async function viewerOf(req: IncomingMessage): Promise<string | null> {
  return byPassword ? (await byPassword.fromRequest(req.headers))?.email ?? null : await iap!.email(req.headers);
}

/**
 * Whether this viewer may manage people. One rule for the two places that ask: the route that
 * serves the screen and the home that links to it — a link to a screen that then sends you away is
 * a door painted on a wall. Password sign-in only: behind a proxy, people live in the proxy.
 */
const managesPeople = (viewer: string | null) => Boolean(byPassword && viewer && roles.can('people', viewer));

/**
 * Whether the people SCREEN (and its link in the nav) is reachable at all — `features.peopleScreen`.
 *
 * ⚠️ This is the ONLY place that toggle is read. The `/api/users*` routes (`userRoutes`, above) ask
 * `manages()` — `roles.can('people', email)` — and never this: hiding the screen must never mean
 * disabling what it fronts (docs/ROLES.md, "no toggle may disable a guard"). An owner who knows the
 * routes, or a script that calls them directly, keeps every ability the screen merely gives a button
 * to; turning this off hides the button, nothing else. `engine/tests/features.test.js` proves the
 * guards themselves read as if this toggle did not exist.
 */
const peopleScreenOn = () => project.features.peopleScreen;

/** Headers for a screen the engine renders itself: never cached, framed by nobody, and its policy. */
function screenHeaders(nonce: string, script: boolean) {
  return {
    'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
    ...SECURITY_HEADERS, 'content-security-policy': screenPolicy(nonce, { script }),
  };
}

async function servePeople(req: IncomingMessage, res: ServerResponse) {
  const viewer = await viewerOf(req);
  // Somebody who may not manage people is sent home rather than shown a refusal: the navigation
  // never offered them this screen, so they got here by typing the address. A project that turned
  // the screen off sends EVERYONE home the same way, owner included — the routes behind it (above)
  // never asked this question and are not asked it here either.
  if (!peopleScreenOn() || !byPassword || !managesPeople(viewer)) {
    return (res.writeHead(302, { location: HOME_SCREEN }), res.end());
  }
  const nonce = randomBytes(16).toString('base64');
  res.writeHead(200, screenHeaders(nonce, true));
  res.end(renderPeoplePage(i18n, languageOf(req), {
    projectName: project.name, people: await byPassword.users.list(),
    roleOf: (e) => roles.roleOf(e), isOwner: (e) => roles.isOwner(e),
  }, projectTheme, nonce));
}

/**
 * Whether a form post came from a page this server served.
 *
 * With password sign-in the session cookie is `SameSite=Strict`, so a form on another site arrives
 * with no session and is refused at the guard anyway. Behind an identity proxy the cookie is the
 * proxy's, and its rules are not ours to rely on — so the one screen that writes from a plain form
 * checks where the post came from, and says no to anywhere else.
 *
 * A post that names no origin at all is refused too. Every current browser sends `Origin` on a
 * POST, so the home's own form always has one; what arrives without it is a client that is not a
 * browser, or something in between that stripped it — neither is the form this route exists for.
 */
function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return false;
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}

/**
 * The home's two forms, posted back to it: "ask for a page" — a request with the `page` category,
 * hanging on the page it was asked near — and, for whoever can approve, a triage decision on one
 * request in progress. Both go through `recordEvent`, the same door the API uses, and both answer
 * with a redirect back home, so a reload does not post twice. A refusal re-renders the home with
 * the reason and the same status the API would have answered.
 */
async function homeForm(req: IncomingMessage, res: ServerResponse) {
  const lang = languageOf(req);
  const say = (key: string, params?: Record<string, string | number>) => i18n.t(lang, key, params);
  const viewer = await viewerOf(req);
  if (!viewer) return json(res, 401, { error: say('api.notAuthenticated') });
  if (!sameOrigin(req)) return json(res, 403, { error: say('api.crossSite') });
  const form = new URLSearchParams(await rawBody(req));

  if (form.get('action') === 'triage') {
    const incoming: NewEvent = {
      type: 'request_state', page: form.get('page') ?? '', block: form.get('block') || null,
      text: form.get('reason')?.trim() || null,
      data: { request: form.get('request') ?? '', state: form.get('state') ?? '' },
    };
    const outcome = await recordEvent(incoming, viewer, say, 'home');
    if (!outcome.event) {
      return serveHome(req, res, { triage: { problem: String(outcome.body.error), request: form.get('request') ?? '',
        reason: form.get('reason') ?? '' } }, outcome.status);
    }
    // The fragment lands the person on the confirmation. Without it the browser opens the home at
    // the top, and on a phone the sentence saying it worked is a screen and a half below.
    res.writeHead(303, { location: `${HOME_SCREEN}?decided=1#${HOME_SECTION.requests}` });
    return res.end();
  }

  const incoming: NewEvent = {
    type: 'request', page: form.get('page') ?? '', block: null, text: form.get('text') ?? '',
    data: { category: 'page' },
  };
  const outcome = await recordEvent(incoming, viewer, say, 'home');
  if (!outcome.event) {
    return serveHome(req, res, { problem: String(outcome.body.error), draft: incoming.text ?? '', near: incoming.page },
      outcome.status);
  }
  res.writeHead(303, { location: `${HOME_SCREEN}?asked=1#${HOME_SECTION.ask}` });
  res.end();
}

async function serveHome(req: IncomingMessage, res: ServerResponse, ask: HomeOutcome = {}, status = 200) {
  const lang = languageOf(req);
  const all = await events.list(null);
  // Only a ✓ from someone who holds `lock` can become one, so only those are worth counting as
  // waiting for one.
  const ownerApprovals = all.filter((e) => e.type === 'approval' && isLocked(e, LOCK_BASELINE));
  const pages = summarisePages(await readBlocks(projectRoot), loadRegistry(projectRoot), cfg.site, ownerApprovals,
    (path) => readFileSync(path, 'utf8'));
  const threads = cycle.threadsOf(all);
  const viewer = await viewerOf(req);
  // Resolved once for every request on the home, not once per row: `requestsInProgress` only reads
  // this for `type: "request"` events, so those are all `authorDisplaysFor` ever needs to look at.
  const displays = await authorDisplaysFor(all.filter((e) => e.type === 'request'), viewer, lang);
  const requests = requestsInProgress(all,
    (r) => cycle.currentState(r.id, threads.get(r.id) ?? [], authorCouldTriage(r, LOCK_BASELINE)),
    new Map(pages.map((p) => [p.page, p.href])),
    (email) => displays.get(email) ?? email);
  // The decisions each request can take, for whoever may take them — the cycle's own list, the
  // same one the panel draws its buttons from. Nobody else is offered a form the server refuses.
  if (viewer && roles.can('approve', viewer)) {
    for (const r of requests) {
      const { triage, requiresReason } = cycle.status(r.state);
      Object.assign(r, { triage, requiresReason });
    }
  }
  const nonce = randomBytes(16).toString('base64');
  // Script-free unless `features.graph` is on (#38) — the SAME toggle `renderHomePage` reads to
  // decide whether it writes the graph's `<script>` tag at all. Read once, here, so the page's own
  // policy and the markup it allows can never disagree about which one this response is: a script
  // written under a policy that forbids it would simply not run; a policy that allows one the page
  // never wrote is a door left open for nothing this route intended.
  res.writeHead(status, screenHeaders(nonce, project.features.graph));
  res.end(renderHomePage(i18n, lang, {
    projectName: project.name, pages, requests,
    canManagePeople: peopleScreenOn() && managesPeople(viewer),
    pageRequestsEnabled: project.features.pageRequests, ask,
    graphEnabled: project.features.graph,
  }, projectTheme, nonce));
}

// ---------------------------------------------------------------- static site
// `lang` is carried in rather than read from the request because this function recurses on the
// index page and never sees the headers again. Both answers it can give are read by a person.
async function serveStatic(url: URL, res: ServerResponse, lang: string) {
  const path = decodeURIComponent(url.pathname);
  // Where the root leads comes from holdrim.json (`content.home`). Hard-coded here, it would be one
  // project's home page, which is that project's, not the method's.
  if (path === '/') return (res.writeHead(302, { location: project.home }), res.end());

  // The review panel belongs to the ENGINE and lives next to the server — not inside the content.
  // Without this route, pointing HOLDRIM_SITE at documentation mounted from outside would leave the
  // panel without its own files: the page would load, and no review button would appear.
  // `web` is the panel; `core` comes along because the panel imports `/engine/core/fingerprint.js`
  // at run time rather than bundling it — the server and the browser must compute a fingerprint
  // with the same file — so /engine/core/ has to answer or no fingerprint gets computed. `locales`
  // because the panel speaks the reader's language with the dictionaries this server discovered:
  // it fetches the one `/api/me` names, so a language added by copying one file reaches it too.
  for (const folder of ['web', 'core', 'locales']) {
    const prefix = `/engine/${folder}/`;
    if (!path.startsWith(prefix)) continue;
    const base = normalize(join(import.meta.dirname, '..', folder));
    const safe = normalize(join(base, path.slice(prefix.length)));
    if (!safe.startsWith(base + sep)) break;        // outside the engine folder
    try {
      await stat(safe);
      return serveFile(safe, res);
    } catch { break; /* not here: fall through to the site */ }
  }

  // normalize plus a prefix check: without it, `/../../etc/passwd` would escape the site folder.
  const target = normalize(join(cfg.site, path));
  if (!target.startsWith(normalize(cfg.site) + sep)) {
    return json(res, 403, { error: i18n.t(lang, 'site.pathOutside') });
  }
  try {
    const info = await stat(target);
    if (info.isDirectory()) return serveStatic(new URL(url.href.replace(/\/?$/, '/index.html')), res, lang);
    return serveFile(target, res, path);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS });
    res.end(i18n.t(lang, 'site.notFound'));
  }
}

/**
 * Headers that cost nothing and close two doors.
 *
 * They matter little while an identity proxy stands in front — nobody reaches a page without
 * being let in first. The moment the service answers on the open internet with only a password,
 * they stop being hygiene and start being the defence:
 *
 *   frame-ancestors 'none'   nobody can put the login screen, or the panel, inside an <iframe>.
 *                            Without it, a hostile page can overlay an invisible "Approve" button
 *                            on top of a real one — and an approval here is a lock in a repository.
 *   nosniff                  the browser respects the content-type instead of guessing it. A file
 *                            served as text does not get executed because it happened to look like
 *                            a script.
 *   referrer-policy          the address of an internal page does not leak to whatever is clicked.
 */
const SECURITY_HEADERS = {
  'content-security-policy': "frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'same-origin',
};

/**
 * What an API answer carries: the same, and a policy that runs nothing. JSON is data; a browser
 * that ever renders one — opened directly, or sniffed despite `nosniff` by something old — has no
 * reason to execute or load anything from it, so it is told so.
 */
const API_HEADERS = { ...SECURITY_HEADERS, 'content-security-policy': "default-src 'none'; frame-ancestors 'none'" };

/**
 * Serves a file from disk, the site's or the engine's own, with what it may run (content-policy.ts):
 * a page, only the panel; anything else, nothing. The engine's files are included so the rule has
 * no exception to remember the day an HTML file lands next to the panel.
 */
async function serveFile(target: string, res: ServerResponse, urlPath = '') {
  const type = MIME_TYPES[extname(target).toLowerCase()] ?? 'application/octet-stream';
  // The theme (fonts and icons) does not change: cache it for real. With no-cache the browser
  // would revalidate the menu icons on every navigation, and because they arrive through
  // mask-image, the menu would flicker.
  const cache = urlPath.includes('/theme/') ? 'public, max-age=31536000, immutable' : 'no-cache';
  const headers: Record<string, string> = {
    'content-type': type, 'cache-control': cache, 'x-robots-tag': 'noindex, nofollow', ...SECURITY_HEADERS,
  };
  let body: Buffer = await readFile(target);
  if (type.startsWith('text/html')) {
    const nonce = randomBytes(16).toString('base64');
    body = withPanelNonce(body, nonce);
    headers['content-security-policy'] = pagePolicy(nonce);
  } else {
    headers['content-security-policy'] = FILE_POLICY;
  }
  res.writeHead(200, headers);
  res.end(body);
}

// ---------------------------------------------------------------- the server
const server = createServer(async (req, res) => {
  // A fixed base, not the Host header, and inside a guard. `http://${host}` from a request saying
  // `Host: a b` would throw here, before the try below, and an async handler that throws is an
  // unhandled rejection: one line from anyone who can reach the port, and the process is gone.
  // Nothing reads the host back out of this URL — `sameOrigin` reads the header itself.
  let url: URL;
  try {
    url = new URL(req.url ?? '/', 'http://localhost');
  } catch {
    return json(res, 404, { error: i18n.t(languageOf(req), 'api.route.notFound') });
  }
  try {
    if (url.pathname === '/api/health') return json(res, 200, { ok: true });

    // Before the authentication guard on purpose: the login screen is where most people change
    // language, and it is the one page they can reach without a session.
    if (url.pathname === LANGUAGE_ROUTE) {
      const headers = languageSwitch(url, i18n.languages, cfg.environment !== 'Development');
      return (res.writeHead(302, headers), res.end());
    }

    // Every write to the API says it is JSON, or it is refused before anything reads it. A form on
    // another site can post `text/plain` without the browser asking first, and a body that happens
    // to parse as JSON, taken as the real call, would be — behind an identity proxy, where the
    // cookie is not ours to make `SameSite=Strict` — an approval cast in the owner's name by a page
    // they merely visited. `application/json` cannot be sent cross-site without a CORS
    // preflight, which this server never answers, so the browser stops the forgery itself.
    if (url.pathname.startsWith('/api/') && req.method === 'POST' && !declaresJson(req)) {
      return json(res, 415, { error: i18n.t(languageOf(req), 'api.jsonOnly') });
    }

    // /api/sign-in is the only API route without a session: it is the one that creates it.
    if (byPassword && url.pathname === '/api/sign-in' && req.method === 'POST') {
      const body = await jsonBody(req);
      // Strings or nothing: `{"email": 1}` would reach `.trim()` and come back as a 500 and an
      // ERROR line, from anyone, before any session exists. Refused the same way as a wrong
      // password.
      const email = typeof body.email === 'string' ? body.email : '';
      const password = typeof body.password === 'string' ? body.password : '';
      const r = await byPassword.signIn(email, password);
      if (!r) {
        // The same answer for an unknown e-mail and a wrong password: saying which of the two
        // failed hands over who has an account. The response time matches too (see users.ts).
        // The address as typed, but never more of it than an address can be: signIn refuses an
        // oversized one before the throttle sees it, so unsliced, each such refusal would write up
        // to a megabyte into the log, as often as anyone cared to ask.
        //
        // The raw address, never an id: a refusal never reaches `personFor`, so this line names
        // nobody's row in the people table — a wrong guess against the owner's e-mail must not
        // create a person, and an attacker trying a thousand addresses must not create a thousand
        // of them. This is the one log line an operator needs to see an attack, and there is no
        // person behind it yet to protect (`docs/PRIVACY.md`, section 6).
        log('WARNING', 'sign_in_refused', { email: email.slice(0, PasswordIdentity.MAX_EMAIL) });
        return json(res, 401, { error: i18n.t(languageOf(req), 'api.credentials.invalid') });
      }
      res.setHeader('set-cookie', byPassword.sessionCookie(r.session));
      // Read-only, like every other account action: signing in does not itself make this address a
      // person — filing a request, a comment or a ✓ does — so a brand-new account's first sign-in
      // logs `person: null`, honestly, rather than minting a row for an address that has not acted
      // on anything reviewable yet.
      log('INFO', 'signed_in', { person: await idForLog(r.user.email), mustChangePassword: r.user.mustChangePassword });
      return json(res, 200, { email: r.user.email, name: r.user.name, mustChangePassword: r.user.mustChangePassword });
    }

    if (url.pathname.startsWith('/api/')) {
      const email = await viewerOf(req);
      if (!email) return json(res, 401, { error: i18n.t(languageOf(req), 'api.notAuthenticated') });
      return await api(req, res, url, email);
    }

    // With an identity proxy, the edge blocks before anything reaches here. With password login
    // there is no edge at all: without this guard the entire documentation would be open to anyone
    // who can reach the port — and whoever started the image believing they had configured a login
    // would have no way to suspect otherwise.
    if (byPassword && !(await byPassword.fromRequest(req.headers))) {
      if (url.pathname === SIGN_IN_SCREEN) {
        // ⚠️ SECURITY_HEADERS here is not decoration: the login screen goes through neither json()
        // nor serveFile(), so without it this would be the ONE page without `frame-ancestors
        // 'none'` — the exact page the comment on those headers names as the clickjacking target.
        // A rule applied everywhere except where it matters.
        // A fresh nonce per response: it is what lets the page's own script and styles run under a
        // policy that runs nothing else. See `signInPolicy` in engine/api/login-page.ts.
        const nonce = randomBytes(16).toString('base64');
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
          ...SECURITY_HEADERS, 'content-security-policy': signInPolicy(nonce),
        });
        // The text goes in before the bytes leave: no untranslated flash, no second request, and
        // the labels are there with JavaScript off. See engine/api/login-page.ts.
        return res.end(renderLoginPage(i18n, languageOf(req), url.pathname + url.search, projectTheme, nonce));
      }
      const next = encodeURIComponent(url.pathname + url.search);
      return (res.writeHead(302, { location: `${SIGN_IN_SCREEN}?next=${next}` }), res.end());
    }
    // With a session already in hand, the login screen has nothing to do: send them to the site.
    if (byPassword && url.pathname === SIGN_IN_SCREEN) {
      return (res.writeHead(302, { location: '/' }), res.end());
    }

    if (url.pathname === HOME_SCREEN) {
      return req.method === 'POST' ? await homeForm(req, res)
        : await serveHome(req, res, { asked: url.searchParams.has('asked'), decided: url.searchParams.has('decided') });
    }
    if (url.pathname === PEOPLE_SCREEN) return await servePeople(req, res);

    return await serveStatic(url, res, languageOf(req));
  } catch (error) {
    // Thrown by a reader of the request, not by the service: the person's to fix, so a 400 that
    // says what, and nothing in the error log.
    if (error instanceof UserInputError) {
      return json(res, 400, { error: i18n.t(languageOf(req), error.key, error.params) });
    }
    const id = crypto.randomUUID().slice(0, 8);
    log('ERROR', 'unhandled_error', {
      id, path: url.pathname, reason: error instanceof Error ? error.message : String(error),
    });
    // The reason is in the log and NOT in the reply: a stack trace or a database message handed to
    // whoever asked is free reconnaissance. The id is what ties the screen to the log line — the
    // person quotes eight characters and whoever operates greps for them. So the id is inside the
    // sentence too: every screen shows `error` and none shows `id`, and a person who cannot see the
    // eight characters has nothing to quote.
    json(res, 500, { error: i18n.t(languageOf(req), 'api.internal', { id }), id });
  }
});

server.listen(cfg.port, () => {
  log('INFO', 'server_listening', {
    port: cfg.port, environment: cfg.environment, identity: identityKind, events: eventsKind,
    // Which user store is in play, said out loud at boot. Whoever is losing accounts on Cloud Run
    // needs one grep to find out they are on a disk that does not survive the instance.
    // ⚠️ The KIND, never the URL: `postgres://user:password@host/db` in a log line is the database
    // password in the log collector, readable by everyone who can read logs.
    users: byPassword ? userStoreKind(process.env.HOLDRIM_USERS) : null,
    localMode: iap?.localMode ?? false, site: cfg.site,
  });
});
