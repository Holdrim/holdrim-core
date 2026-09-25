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
 * and HOLDRIM_ADMINS, and from nowhere else (docs/ROLES.md, "Authority comes from the deployment
 * only"). The file travels with the repository, and whoever can commit to it — a contributor, or
 * the agent applying an approved request — is not whoever deploys it: with a fallback to the file,
 * editing one line would name a new owner at the next deploy, or at the next `holdrim sync` on
 * somebody's machine.
 * @module
 */

import { HOME_SCREEN } from './screens.js';
import { readFeatures } from './features.js';

/**
 * The keys that would grant authority, refused in `holdrim.json`. `locks` is here before the
 * lock-holders exist (docs/ROLES.md, section 3) so that no file ever learns to carry them.
 *
 * Refused, not ignored: an adopter who wrote `owner` there believes it counts. Ignored, the key
 * would sit in the file looking authoritative while the variable decided — and the day someone
 * read the file to find out who the owner is, it would answer wrong.
 */
const AUTHORITY_KEYS = ['owner', 'admins', 'locks'];

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
    (named.length === 1 ? 'the key' : 'the keys') + ' from the file and set HOLDRIM_OWNER (one e-mail) ' +
    'and HOLDRIM_ADMINS (comma separated) where Holdrim runs.');
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
    sheetFolders: content.folders ?? ['pages'],
    registry: content.registry ?? 'approvals.json',
    // Where `/` leads. The engine's own home by default: every page with its light and every open
    // request, which is the first thing a person needs after signing in. A project that would rather
    // open on one of its pages names it here.
    home: content.home ?? HOME_SCREEN,
    /** For the short file name in the record: the part of the path not worth showing. */
    trimPrefix: content.trimPrefix ?? 'pages/',
    /** Only for the invalid-page error message. Empty means: give no example. */
    pageExamples: content.pageExamples ?? '',
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
     * start the same way an unknown top-level key or an invalid theme colour does.
     */
    features: readFeatures(file.features, root),
  };
}
