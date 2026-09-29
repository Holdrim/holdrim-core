/**
 * The order Firestore's events are read in: by `when`, the time the process that signed each event
 * gave it from its own clock, in milliseconds (`#nextTime`, store-firestore.ts). One instance never
 * gives two events the same time, so its events sort in the order it wrote them; two instances
 * writing inside one millisecond tie, and a tie keeps the order the query returned, which is
 * document-id order. The sort is stable, so that fallback is the query's and nothing else's.
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
 * Oldest first: the seconds, then the nanoseconds within them. A document with no `when` — one
 * written from outside the product — sorts as the epoch, first, rather than throwing.
 */
export function byServerTime(a: ServerTime | undefined, b: ServerTime | undefined): number {
  return (a?.seconds ?? 0) - (b?.seconds ?? 0) || (a?.nanoseconds ?? 0) - (b?.nanoseconds ?? 0);
}
