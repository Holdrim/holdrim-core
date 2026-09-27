import { existsSync, realpathSync } from 'node:fs';
import { mkdir, open, unlink } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { insideRoot } from '../core/paths.js';
import {
  DEFAULT_SQLITE_PATH, generatePassword, isFileBackedUserStore, looksEphemeral, sqlitePathOf,
} from './users.ts';
import { log } from './log.ts';

/**
 * The first-access password: generated at the first start, written to a FILE, never to the log.
 *
 * Why a file and not the log: a log is read by whoever can read the log collector, kept for weeks,
 * and copied into every tool that ingests it — and the line that carried this password was the
 * owner's credential, in all of those places, for as long as nobody changed it. Why a file and not a
 * screen shown once: a screen goes to whoever reaches the server first, who may not be the owner. A
 * file on the deployment's own data directory is read by whoever operates the deployment — the same
 * person who set `HOLDRIM_OWNER`, so it reaches exactly the one who was already trusted to name the
 * owner.
 *
 * The file holds the password and nothing else, so `cat` is the whole procedure and no parser can
 * misread a trailing line as part of it.
 * @module
 */

/** The file's name, in the data directory when `HOLDRIM_FIRST_ACCESS_PATH` does not say otherwise. */
export const FIRST_ACCESS_FILE = 'first-access-password';

type Env = Record<string, string | undefined>;

/**
 * Where the file goes.
 *
 * `HOLDRIM_FIRST_ACCESS_PATH` when set. Otherwise beside the people's SQLite file — the directory the
 * deployment already keeps its store in, which the image declares as the `/data` volume and chowns
 * to the user the service runs as. For `sqlite:<path>` that is beside `<path>`; for Firestore and
 * Postgres, which keep no local file, it is beside `HOLDRIM_USERS_PATH` all the same — `./data`, or
 * `/data` in the image — because that is the one directory every deployment of this engine already
 * has, and a second default somewhere else would be a second place to look.
 */
export function firstAccessPath(env: Env = process.env): string {
  const chosen = env.HOLDRIM_FIRST_ACCESS_PATH?.trim();
  if (chosen) return chosen;
  const users = (env.HOLDRIM_USERS ?? '').trim();
  const store = users.startsWith('sqlite:') && isFileBackedUserStore(users)
    ? sqlitePathOf(users)
    : env.HOLDRIM_USERS_PATH ?? DEFAULT_SQLITE_PATH;
  return join(dirname(store), FIRST_ACCESS_FILE);
}

/**
 * Why the first access must NOT be created here, or `null` when it may.
 *
 * On a runtime whose disk does not outlive the instance (`looksEphemeral`, users.ts) and cannot be
 * opened from outside it — Cloud Run has no shell — the default directory is a file nobody will ever
 * read: the owner's account would exist with a password no person holds, and the way out is removing
 * that account by hand in the database. Not creating it is the cheaper failure: the store stays
 * empty, and the next start with `HOLDRIM_FIRST_ACCESS_PATH` on a mounted volume creates it then.
 * An explicit path is taken at its word — whoever set it has said where they will read it.
 */
export function firstAccessRefusal(env: Env = process.env): string | null {
  if (env.HOLDRIM_FIRST_ACCESS_PATH?.trim() || !looksEphemeral(env)) return null;
  return `the first-access password would go to ${resolve(firstAccessPath(env))}, on a disk that looks `
    + 'ephemeral (K_SERVICE is set) and that nobody can read from outside the instance, so the '
    + "owner's account was NOT created and nobody can sign in yet. Set HOLDRIM_FIRST_ACCESS_PATH to a "
    + 'file on a volume mounted into the service that only its operators can read, and start again.';
}

/** The file is already there: an earlier first access left it, and it is never overwritten. */
export class FirstAccessFileExists extends Error {}

/** The file would land in the folder this server serves, where a URL reads it. */
export class FirstAccessFileServed extends Error {}

/**
 * The real path of `path`, resolved through its deepest ancestor that exists: the folders not
 * created yet cannot be links, and the ones that exist can — a `data` inside the site that is a link
 * to somewhere else, or a path outside it that is a link back in, are exactly what a string
 * comparison would get wrong in each direction.
 */
function realThroughExisting(path: string): string {
  let existing = resolve(path);
  const rest: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    rest.unshift(basename(existing));
    existing = parent;
  }
  return join(realpathSync(existing), ...rest);
}

/**
 * Whether the file's folder is the served site's root or anywhere under it, compared by REAL path.
 *
 * `serveStatic` (server.ts) hands out any file under `HOLDRIM_SITE` to whoever is signed in, so a
 * password written there is the owner's credential one URL away from every member — the leak this
 * file exists to close, moved from the log to the site. The folder, not the file: the file does not
 * exist yet, and whatever folder holds it is served whole. `insideRoot` (engine/core/paths.js) is
 * strict, so the root itself is checked on its own.
 */
export function servedBySite(file: string, site: string): boolean {
  const folder = realThroughExisting(dirname(resolve(file)));
  const root = realpathSync(resolve(site));
  return folder === root || insideRoot(root, folder);
}

/** What the first access needs of the identity, and no more — so a test can race it. */
export interface FirstAccessIdentity {
  users: { isEmpty(): Promise<boolean> };
  firstAccess(email: string, name: string, password: string): Promise<string | null>;
}

/**
 * Creates the owner's account on an empty store, with its password in the file. Says where the file
 * is, never what it holds.
 *
 * - `created`: the account and the file both exist, and the log says where the file is.
 * - `none`: somebody already exists, or another instance created the owner first; nothing touched.
 * - `refused`: `firstAccessRefusal` answered; nothing created, the reason logged at ERROR.
 *
 * ⚠️ The file first, the account second. The other order leaves a window — a full disk, a directory
 * the service cannot write — where the account exists and its password is in no file and no log:
 * nobody can sign in, and the next start sees a store that is no longer empty and creates nothing.
 * In this order a failure leaves no account, so fixing the cause and starting again is the whole
 * recovery. That is why the password is generated here (`generatePassword`) instead of by `create`.
 *
 * ⚠️ `wx`: created, never opened if it exists. An existing file is refused, never replaced: it is
 * a password an earlier first access left behind (its account removed since, or its store swapped),
 * or something planted — and `wx` fails on a symbolic link too, so a link laid at this path cannot
 * steer the write into a file somebody else reads. Refusing to start over it asks the operator to
 * look and remove it by hand; replacing it would decide for them. A second instance racing the
 * first onto a shared volume is refused the same way, and its restart finds the store no longer
 * empty and starts normally.
 *
 * ⚠️ Mode 0600, set on the open descriptor and not left to the mode argument alone: the umask can
 * only remove bits, so the argument can come out as 0400 or less, and a `chmod` after a close would
 * leave a moment with the umask's mode instead. Only the user the service runs as reads it.
 */
export async function provisionFirstAccess(
  identity: FirstAccessIdentity,
  owner: string,
  name: string,
  options: { site: string; env?: Env; say?: (line: string) => void },
): Promise<'created' | 'none' | 'refused'> {
  const env = options.env ?? process.env;
  // ⚠️ console.log, and deliberately not through `log`: this is a banner for whoever is watching the
  // first start, English and hard-coded for the reason the top of engine/core/i18n.js gives.
  const say = options.say ?? ((line: string) => console.log(line));
  // Asked before anything else is touched, so an ordinary restart never so much as looks at the file.
  if (!(await identity.users.isEmpty())) return 'none';

  // ⚠️ Before anything is generated or written, and for the default location as much as for
  // HOLDRIM_FIRST_ACCESS_PATH: a users store configured inside the site puts the default file there
  // too. Checked only when a file is about to be written, not on every start: this is the only code
  // that ever writes one, so a store that already has people has no such file to protect.
  if (servedBySite(firstAccessPath(env), options.site)) {
    throw new FirstAccessFileServed(
      `the first-access password would go to ${resolve(firstAccessPath(env))}, inside the folder this `
      + `server serves (HOLDRIM_SITE, ${resolve(options.site)}), where anyone signed in could read it `
      + 'at its URL. Set HOLDRIM_FIRST_ACCESS_PATH to a file outside it, and start again.');
  }

  const refusal = firstAccessRefusal(env);
  if (refusal) {
    log('ERROR', 'first_access_not_created', { reason: refusal });
    return 'refused';
  }

  const path = resolve(firstAccessPath(env));
  const password = generatePassword();
  await mkdir(dirname(path), { recursive: true });
  const handle = await open(path, 'wx', 0o600).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'EEXIST') throw error;
    throw new FirstAccessFileExists(
      `${path} already exists, and the store has nobody in it. It is left by an earlier first access `
      + '(or put there by someone else) and is never overwritten. Look at it, remove it, and start again.');
  });
  try {
    await handle.chmod(0o600);
    await handle.writeFile(password);
    await handle.sync();
  } catch (error) {
    await handle.close();
    await unlink(path).catch(() => {});
    throw error;
  }
  await handle.close();

  let created: string | null;
  try {
    created = await identity.firstAccess(owner, name, password);
  } catch (error) {
    // The account was not created, so its password names nothing — and left behind, the file would
    // turn the next start into a refusal over a password that never worked.
    await unlink(path).catch(() => {});
    throw error;
  }
  if (created === null) {
    // Another instance won the race between `isEmpty` and here; its password is the one that works.
    await unlink(path).catch(() => {});
    return 'none';
  }

  say('\n' + '='.repeat(72));
  say('  FIRST ACCESS — the password is in a file, never in this log:');
  say(`     sign in with: ${owner}`);
  say(`     password in:  ${path}`);
  say('  Only the user the service runs as can read it. You will have to change the password when');
  say('  you sign in, and the file is removed when you do.');
  say('='.repeat(72) + '\n');
  return 'created';
}

/**
 * Removes the file once the owner has chosen a password of their own: what it holds no longer opens
 * anything, and a secret left on a disk is one more thing for a backup to carry. Called after a
 * successful change by the owner, the only person a first access is ever created for.
 *
 * ⚠️ This is not an exception to "nothing is erased" (AGENTS.md). That invariant is about the
 * record — events, the texts they carry, the people who gave them. This file is a bootstrap secret,
 * never part of the record, and deleting it erases no evidence of anything.
 *
 * It never fails the change: the password has already changed when this runs, and a file it cannot
 * remove holds a password that no longer works. It says so, at WARNING, so the operator can remove
 * it by hand.
 */
export async function retireFirstAccessFile(env: Env = process.env): Promise<'removed' | 'absent' | 'failed'> {
  const path = resolve(firstAccessPath(env));
  try {
    await unlink(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return 'absent';
    log('WARNING', 'first_access_file_not_removed', { path, reason: code ?? String(error) });
    return 'failed';
  }
  log('INFO', 'first_access_file_removed', { path });
  return 'removed';
}
