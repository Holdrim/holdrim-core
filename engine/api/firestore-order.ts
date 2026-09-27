/**
 * The order Firestore's events are read in: by the server's own timestamp, to the nanosecond. `when`
 * is kept to the millisecond, and two events inside one would otherwise come back in document-id
 * order, which is random.
 *
 * Its own file, with no import of the Firestore client, so the rule is proved by a unit test that
 * runs everywhere (`engine/tests/firestore-order.test.js`), not only where the emulator is: appends
 * made by a test mostly land inside one second, so a store test cannot tell a comparator that dropped
 * the seconds from a right one, and an older `role_defined` would then read as the latest across a
 * second boundary. `list` and `listBare` (store-firestore.ts) both sort with it.
 */

/** A Firestore `Timestamp`, as far as ordering needs it. */
export interface ServerTime { seconds: number; nanoseconds: number }

/**
 * Oldest first: the seconds, then the nanoseconds within them. A document with no timestamp (one the
 * server has not stamped yet) sorts as the epoch, first, rather than throwing.
 */
export function byServerTime(a: ServerTime | undefined, b: ServerTime | undefined): number {
  return (a?.seconds ?? 0) - (b?.seconds ?? 0) || (a?.nanoseconds ?? 0) - (b?.nanoseconds ?? 0);
}
