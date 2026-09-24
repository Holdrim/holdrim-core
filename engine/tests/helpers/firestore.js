/**
 * A Firestore project id nobody has used, for the tests that run against the emulator.
 *
 * The emulator keeps everything every earlier test and run wrote, and two runs can share one
 * emulator at the same time; a project of its own is what keeps a leftover event or person from
 * making a count or an order pass or fail for the wrong reason. One helper, so every suite means
 * the same by "fresh".
 */
import { randomBytes } from 'node:crypto';

/** `prefix-` and 12 random hex characters. */
export function freshFirestoreProject(prefix) {
  return `${prefix}-${randomBytes(6).toString('hex')}`;
}
