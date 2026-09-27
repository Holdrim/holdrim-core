/**
 * The configuration of the project using the method, read from `holdrim.json` at the root.
 *
 * It exists so the ENGINE does not know the product. Without it, the owner's e-mail and the cloud
 * project would be scattered through the code — anyone who cloned it would start a service pointing
 * at somebody else's infrastructure. With it there is exactly one file to edit.
 *
 * Environment variables beat the file: the same repository serves more than one environment. The
 * one exception is `language`, below, where HOLDRIM_LANGUAGE counts only when the file names none.
 *
 * ⚠️ AUTHORITY IS NOT IN THE FILE AT ALL. Who the owner and the admins are comes from HOLDRIM_OWNER
 * and HOLDRIM_ADMINS, who else holds `lock` comes from HOLDRIM_LOCKS, who is an agent comes from
 * HOLDRIM_AGENTS, and a project's own roles and who holds them come from the owner, as events from
 * the settings screen (docs/ROLES.md, section 5) — none of the five is ever read from this
 * file (docs/ROLES.md, "Authority comes from the deployment only"). The file travels with the
 * repository, and whoever can commit to it — a contributor, or the agent applying an approved
 * request — is not whoever deploys it: with a fallback to the file, editing one line would name a
 * new owner, a new lock-holder or a new role at the next deploy, or at the next `holdrim sync` on
 * somebody's machine.
 * @module
 */

import { join, isAbsolute } from 'node:path';
import { HOME_SCREEN } from './screens.js';
import { readFeatures } from './features.js';
import { readPeopleShow } from './people-show.js';
import { insideRoot } from './paths.js';

/** `content.glossary`'s own limits — generous enough for a real vocabulary, small enough that a
 *  request text built from it (`holdrim propose-deps`, engine/cli/propose.ts) cannot itself become
 *  the oversized payload `engine/core/limits.js` exists to catch. */
const GLOSSARY_TERM_MAX_LENGTH = 64;
const GLOSSARY_MAX_TERMS = 1000;

/**
 * `content.glossary`: the PROJECT's own vocabulary, never the engine's — `holdrim propose-deps`
 * proposes a dependency between two blocks that use the same one of these terms and declare no
 * `data-depends` on each other. It is the project's content that names its terms, in whatever
 * language the project reviews in; nothing here assumes English, or assumes a term is a single
 * word (docs/GLOSSARY.md is a different list entirely — the METHOD's own vocabulary, not a project's).
 *
 * Untrusted input, like every other value in this file: a term's text reaches a `request`'s own
 * `text` field verbatim (`textOf`, engine/cli/propose.ts), so it is checked the same way a theme
 * colour or a feature toggle is — refused loudly at load, never sanitised and let through as
 * something else. A control character would not corrupt anything downstream (the request is stored
 * as an ordinary string, not interpreted), but a term that carries one could not be read back
 * correctly by a person triaging the request either, so it is refused for the same reason a 3000
 * character "term" is: this is a short, human word or phrase, not a place to smuggle anything larger.
 *
 * @param {unknown} configured  `file.content.glossary`, or undefined
 * @param {string} root         only for the error message, as this file's other checks do
 * @returns {string[]}
 */
function readGlossary(configured, root) {
  if (configured === undefined) return [];
  if (!Array.isArray(configured)) {
    throw new Error(`${root}/holdrim.json's "content.glossary" must be an array of strings.`);
  }
  if (configured.length > GLOSSARY_MAX_TERMS) {
    throw new Error(
      `${root}/holdrim.json's "content.glossary" names ${configured.length} terms, more than the ` +
      `${GLOSSARY_MAX_TERMS} this version accepts.`);
  }
  configured.forEach((term, i) => {
    if (typeof term !== 'string' || term.length < 1 || term.length > GLOSSARY_TERM_MAX_LENGTH) {
      throw new Error(
        `${root}/holdrim.json's "content.glossary[${i}]" must be a string of 1–` +
        `${GLOSSARY_TERM_MAX_LENGTH} characters; got ${JSON.stringify(term)}.`);
    }
    // eslint-disable-next-line no-control-regex -- exactly what this line exists to catch.
    if (/[\x00-\x1f\x7f]/.test(term)) {
      throw new Error(
        `${root}/holdrim.json's "content.glossary[${i}]" carries a control character, which is ` +
        'refused rather than silently kept: a term is short, plain text.');
    }
  });
  return configured;
}

/**
 * `content.registry`'s own limit: `registryPath` (engine/cli/validation.ts) joins this value onto
 * the project root and, until now, nothing checked the result stayed there — `"../other/approvals.json"`
 * or an absolute path would be read, and later WRITTEN (`saveRegistry`), wherever that landed, never
 * necessarily inside the project whoever committed `holdrim.json` can see. Refused here, at load, the
 * same way `readGlossary` above refuses a bad `content.glossary`: one place every reader of the file
 * already goes through, so `registryPath` itself stays a plain join, trusting a value this function
 * has already cleared.
 *
 * The containment check itself is `insideRoot` (engine/core/paths.js), shared with the theme's own
 * logo path (`loadLogo`, engine/api/theme.ts) rather than a second hand-rolled comparison here —
 * see that module for why it resolves by `path.relative` and never a raw `startsWith`.
 *
 * An absolute value is refused outright, before `insideRoot` ever runs: `join(root,
 * ...value.split('/'))` happens to fold a leading `/` away and land back inside `root` on this
 * platform, but a value written as an absolute path says something different from what it does, and
 * a project that wrote one meant an absolute path — silently reinterpreting it as relative is its
 * own kind of surprise.
 *
 * ⚠️ Lexical only, on the STRING as written — nothing here touches the filesystem, so a symlinked
 * ANCESTOR that resolves outside the root (`content.registry: "mnt/approvals.json"`, `mnt` a
 * committed, working symlink to somewhere else) reads as contained right here, string-wise, and is
 * not this function's to catch: `refuseEscapedFolder` (engine/cli/fs.ts, holdrim#161 round 2) does,
 * with `fs.realpathSync`, at the moment the registry is actually loaded or saved — the one place a
 * link's real target is knowable, which a string never is. What this function alone rules out is a
 * value that could never stay inside no matter what the filesystem holds: `".."`, an absolute path,
 * the root itself.
 *
 * @param {unknown} configured  `file.content.registry`, or undefined
 * @param {string} root
 * @returns {string}
 */
function readRegistry(configured, root) {
  const value = configured ?? 'approvals.json';
  if (typeof value !== 'string' || value.length < 1) {
    throw new Error(`${root}/holdrim.json's "content.registry" must be a non-empty string.`);
  }
  if (isAbsolute(value)) {
    throw new Error(
      `${root}/holdrim.json's "content.registry" ("${value}") is an absolute path — it must name a ` +
      'file inside the project, relative to its root.');
  }
  if (!insideRoot(root, join(root, ...value.split('/')))) {
    throw new Error(
      `${root}/holdrim.json's "content.registry" ("${value}") resolves outside the project root — ` +
      'it must name a file inside the project.');
  }
  return value;
}

/**
 * `content.folders`'s own limit, the same shape as `readRegistry` just above and for the same
 * reason: `sheetFolders` (engine/cli/pages.ts) joins each entry onto the project root with a plain
 * `join`, and `sheetFiles` then `readdirSync`s the result — until now, nothing checked any of that
 * stayed inside the project. `"../other-project/pages"`, or an absolute path, made the engine scan,
 * fingerprint and SERVE pages that belong to a different project entirely: whoever can commit to
 * `holdrim.json` decides what a reader sees, not only what a reader reads back to the registry.
 *
 * Checked here, at load, the same one place `readRegistry` already goes through, with the same
 * `insideRoot` (engine/core/paths.js) — never a second hand-rolled comparison, and never a value
 * this function has not already cleared reaching `sheetFolders`' own plain `join`.
 *
 * An absolute entry is refused outright, before `insideRoot` ever runs, for the reason `readRegistry`
 * gives for its own `content.registry`: a value written as an absolute path says something different
 * from what it does, and reinterpreting it as relative because the join happens to fold it back
 * inside the root is a surprise of its own.
 *
 * ⚠️ Lexical only, on each STRING as written — see `readRegistry`'s own warning for why a symlinked
 * ANCESTOR is not this function's to catch. `sheetFiles` (engine/cli/pages.ts, holdrim#164) runs
 * `refuseEscapedFolder` (engine/cli/fs.ts) on each folder's REAL location before it ever opens one,
 * the same guard `loadRegistry`/`saveRegistry` run on the registry's (holdrim#161, round 2).
 *
 * `content.folders` is an array, unlike `content.registry`'s single string, so a value that is not
 * an array at all is refused before any entry is even looked at — a project that wrote an object or
 * a string here meant something this function cannot read as folders.
 *
 * @param {unknown} configured  `file.content.folders`, or undefined
 * @param {string} root
 * @returns {string[]}
 */
function readFolders(configured, root) {
  const value = configured ?? ['pages'];
  if (!Array.isArray(value)) {
    throw new Error(`${root}/holdrim.json's "content.folders" must be an array of strings.`);
  }
  value.forEach((entry, i) => {
    if (typeof entry !== 'string' || entry.length < 1) {
      throw new Error(
        `${root}/holdrim.json's "content.folders[${i}]" must be a non-empty string; got ` +
        `${JSON.stringify(entry)}.`);
    }
    if (isAbsolute(entry)) {
      throw new Error(
        `${root}/holdrim.json's "content.folders[${i}]" ("${entry}") is an absolute path — it must ` +
        'name a folder inside the project, relative to its root.');
    }
    if (!insideRoot(root, join(root, ...entry.split('/')))) {
      throw new Error(
        `${root}/holdrim.json's "content.folders[${i}]" ("${entry}") resolves outside the project ` +
        'root — it must name a folder inside the project.');
    }
  });
  return value;
}

/**
 * The keys that would grant authority, refused in `holdrim.json`. `roles` and `grants` joined this
 * list in the rework of #29: reading a project's own roles and who holds them from the file would
 * let a committer, or the agent applying an approved request, widen anyone's power at the next
 * deploy or the next `holdrim sync` — the exact hole this list already exists to close for `owner`
 * and `admins`. docs/ROLES.md, "Authority comes from the deployment only": role definitions and
 * grants are events from the settings screen, by the owner alone — a later piece, not this file.
 *
 * Refused, not ignored: an adopter who wrote `owner` there believes it counts. Ignored, the key
 * would sit in the file looking authoritative while the variable decided — and the day someone
 * read the file to find out who the owner is, it would answer wrong.
 */
const AUTHORITY_KEYS = ['owner', 'admins', 'locks', 'agents', 'roles', 'grants'];

/**
 * Where each authority key actually lives — docs/ROLES.md, "Where everything lives" (section 5) —
 * named in the refusal so removing the key is not the only thing an adopter learns from it. `roles`
 * and `grants` name no variable: they are not set where Holdrim runs at all, but by the owner, as
 * events from the settings screen. Saying so, rather than pointing at a variable that does not exist,
 * is the whole reason this is a lookup instead of one string reused for every key.
 */
const AUTHORITY_HOMES = {
  owner: 'HOLDRIM_OWNER (one e-mail), set where Holdrim runs',
  admins: 'HOLDRIM_ADMINS (comma separated), set where Holdrim runs',
  locks: 'HOLDRIM_LOCKS, set where Holdrim runs',
  agents: 'HOLDRIM_AGENTS, set where Holdrim runs',
  roles: 'the owner, from the settings screen (/engine/settings), and never this file',
  grants: 'the owner, from the settings screen (/engine/settings), and never this file',
};

/**
 * @param {unknown} file  the parsed `holdrim.json`
 * @param {string} root
 */
function refuseAuthority(file, root) {
  if (!file || typeof file !== 'object') return;
  const named = AUTHORITY_KEYS.filter((key) => Object.hasOwn(file, key));
  if (named.length === 0) return;
  throw new Error(
    `${root}/holdrim.json names ${named.map((k) => `"${k}"`).join(', ')}, and it may not: ` +
    'authority is set by the deployment, never by the repository. Remove ' +
    (named.length === 1 ? 'the key' : 'the keys') + ' from the file. ' +
    named.map((key) => `"${key}" comes from ${AUTHORITY_HOMES[key]}.`).join(' '));
}

/**
 * The keys of `holdrim.json` are English, like everything else. They are a contract with every
 * adopter: once a key is in a file on somebody's disk, renaming it means migrating that file.
 *
 * @param {string} root
 * @param {{ readFile: (path: string) => string }} io  injected so this can be tested without disk
 */
export function readConfig(root, io, env = {}) {
  let text = null;
  try {
    text = io.readFile(`${root}/holdrim.json`);
  } catch {
    // With no file, only the environment matters. That is the case of running the engine outside
    // a project at all.
  }
  let file = {};
  // A file that is there and does not parse is read as no file too, so the service still comes up
  // — but the reason is kept, not swallowed. Swallowed, a trailing comma would surface as "missing
  // the owner" in run-local.sh, which would then need a second reader of this file to find out why.
  let unreadable = null;
  if (text !== null) {
    try {
      file = JSON.parse(text);
    } catch (error) {
      unreadable = error instanceof Error ? error.message : String(error);
    }
  }
  // Here, where the file is read, and not in each caller: every path to the configuration — the
  // server's boot, every CLI command, the local runner — comes through this function, so none of
  // them can forget to ask.
  refuseAuthority(file, root);
  const cloud = file.cloud ?? {};
  const dev = file.development ?? {};
  const content = file.content ?? {};
  const theme = file.theme ?? {};

  const name = env.HOLDRIM_NAME ?? file.name ?? 'Documentation';

  return {
    name,
    // The environment only: see the top of this file. `rolesOf` (engine/core/roles.js) turns these
    // two into roles, for the server and the CLI alike.
    owner: env.HOLDRIM_OWNER ?? null,
    admins: env.HOLDRIM_ADMINS ?? '',
    // Who holds `lock` besides the owner (docs/ROLES.md, section 3) — the environment only, exactly
    // like the two above and for the same reason. `rolesOf` (engine/core/roles.js) parses and
    // validates it; `can('lock', …)` does not consult it yet (see `roles.js`'s own comment on why).
    locks: env.HOLDRIM_LOCKS ?? '',
    // Who is an agent (docs/ROLES.md, section 4) — the environment only, like the three above: the
    // file is exactly what the agent applying an approved request can edit, and removing itself
    // from this list is the one edit it must never be able to make count.
    agents: env.HOLDRIM_AGENTS ?? '',
    project: env.HOLDRIM_PROJECT ?? cloud.project ?? null,
    account: env.HOLDRIM_ACCOUNT ?? cloud.account ?? null,
    region: cloud.region ?? null,
    service: cloud.service ?? null,
    projectNumber: cloud.projectNumber ?? null,
    port: Number(env.PORT ?? dev.port ?? 8095),
    actAs: env.HOLDRIM_DEV_EMAIL ?? dev.actAs ?? null,

    // WHERE THE CONTENT LIVES. Written inside the engine — a folder in pages.ts, the approvals file
    // in validation.ts — it would tie the engine to a single project: anyone adopting the method
    // would have to name their folders the way that project named its own.
    // The defaults below are an example of shape, not a rule: one folder of pages next to the file
    // that records their approvals.
    sheetFolders: readFolders(content.folders, root),
    registry: readRegistry(content.registry, root),
    // Where `/` leads. The engine's own home by default: every page with its light and every open
    // request, which is the first thing a person needs after signing in. A project that would rather
    // open on one of its pages names it here.
    home: content.home ?? HOME_SCREEN,
    /** For the short file name in the record: the part of the path not worth showing. */
    trimPrefix: content.trimPrefix ?? 'pages/',
    /** Only for the invalid-page error message. Empty means: give no example. */
    pageExamples: content.pageExamples ?? '',
    /** The project's own vocabulary for `holdrim propose-deps` — see `readGlossary`, above.
     *  Empty when the project names none, which `propose-deps` reads as "nothing configured yet". */
    glossary: readGlossary(content.glossary, root),
    /**
     * The project's default language, when the reader states no preference.
     *
     * ⚠️ The default is English, because the README says the engine ships in English. Any other
     * default would contradict it, and hand a login screen in that language to anyone who cloned it
     * and dropped a second dictionary in. A project that reviews in another language says so in its
     * own `holdrim.json` — one line, and it is the project's statement, not the engine's assumption.
     */
    language: file.language ?? env.HOLDRIM_LANGUAGE ?? 'en',

    /**
     * THE AGENT'S COMMAND, when the project wants to name one:
     *
     *     "agent": { "command": ["claude", "-p"] }
     *
     * Optional, and deliberately with no default: the engine calls no model, and which CLI applies
     * a request is the person's choice, not the engine's. `holdrim apply` reads this, falls back
     * to whatever known CLI is on the PATH, and refuses with the three ways out if there is none.
     */
    agentCommand: Array.isArray(file.agent?.command) ? file.agent.command.map(String) : undefined,

    /**
     * HOW THE PROJECT DRESSES THE ENGINE. The Keycloak arrangement: the engine ships a complete,
     * neutral look and the deployment overrides the parts it cares about.
     *
     *     "theme": { "brand": "#0B5FA5", "logo": "theme/logo.svg", "name": "Product · Handbook" }
     *
     * All three are optional, and this function does NOT check them — it only reads. Validation
     * lives in engine/api/theme.ts, next to the code that writes the values into CSS and HTML,
     * because a check that is far from the use is a check the next caller forgets to run.
     *
     * `name` falls back to the project's own `name`, which every project already has: the screen
     * should never have nothing to show, and asking for the same name twice would be asking a
     * project to repeat itself.
     */
    theme: {
      brand: env.HOLDRIM_THEME_BRAND ?? theme.brand ?? null,
      logo: theme.logo ?? null,
      name: theme.name ?? name,
    },
    /** Why `holdrim.json` was there and ignored, or null: see where it is set, above. */
    unreadable,

    /**
     * FEATURE TOGGLES (docs/ROLES.md, section 7; the closed list and its defaults live in
     * `engine/core/features.js`, next to `roles.js`'s own closed list). Checked here, at the one
     * place every reader of `holdrim.json` already goes through, so a misspelled toggle refuses to
     * start the service — louder than an unrecognised top-level key, which this function simply
     * never reads, and louder than an invalid theme colour, which only warns and falls back.
     */
    features: readFeatures(file.features, root),

    /**
     * HOW A PERSON APPEARS (docs/ROLES.md, section 6; the closed list and the default live in
     * `engine/core/people-show.js`, next to `features.js`'s own closed list). NOT authority — see
     * that module's own warning — so it sits beside `theme`/`content`/`cloud` above, read from the
     * file the same way, and `AUTHORITY_KEYS` above does not, and must not, ever name `people`.
     */
    peopleShow: readPeopleShow(file.people?.show, root),

    /**
     * Which of the two settings just above the FILE named, as opposed to a default — read by the
     * settings screen alone (engine/api/settings-page.ts), which says where each value comes from.
     * Without it the screen could only compare a value with its default, and a toggle a project
     * wrote down at its default value would read as "not set", sending the owner to look for a line
     * that is there. After `features` and `peopleShow` on purpose: both have refused a bad value by
     * the time this runs, so every key listed here is a known one.
     */
    namedInFile: {
      features: file.features === undefined ? [] : Object.keys(file.features),
      peopleShow: file.people?.show !== undefined,
    },
  };
}
