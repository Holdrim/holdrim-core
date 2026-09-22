/**
 * The traffic light of living documentation: what state each block's validation is in.
 *
 * The question this answers is not "did someone approve it?" but **"does the approval still
 * hold?"**. Those are different questions, and the second one is what matters in documentation
 * that keeps changing.
 *
 *   ⚪ none     nobody has validated it yet
 *   🟢 valid    validated, and nothing has changed since
 *   🟡 stale    this block's TEXT changed after the ✓ — nobody approved the new text
 *   🔴 broken   this block's text is unchanged, but something it DEPENDS ON changed
 *
 * The engine could always see yellow, through the fingerprint. Red is what makes documentation
 * living rather than merely traceable: it is what says *"this is still written exactly as
 * approved, but the rule it stood on moved — go check whether it is still true"*.
 *
 * ⚠️ Red is not an error. It is a **question**. The engine does not know the block became wrong —
 * it knows the block became SUSPECT, and that a human needs to look. Treating it as an error would
 * make people switch the check off at the first false positive, and then the whole lock is
 * pointless.
 * @module
 */

/** @typedef {'none'|'valid'|'stale'|'broken'} State */

/**
 * A block, as the traffic light sees it.
 * @typedef {{
 *   id: string,
 *   fingerprint: string,
 *   dependsOn?: string[],
 * }} Block
 */

/**
 * What was recorded when someone validated a block.
 * @typedef {{ fingerprint: string, date?: string, dependsOn?: Record<string,string> }} Record_
 */

export const COLOURS = /** @type {const} */ ({
  none: '⚪', valid: '🟢', stale: '🟡', broken: '🔴',
});

/**
 * The state of ONE block.
 *
 * @param {Block} block             how it looks right now, on disk
 * @param {Record_|undefined} record what was written down when someone validated it
 * @param {Map<string, string>} fingerprintsNow  id → current fingerprint of every block
 * @returns {{ state: State, why: string, blame: string[] }}
 */
export function stateOf(block, record, fingerprintsNow) {
  if (!record) return { state: 'none', why: 'nobody has validated it yet', blame: [] };

  if (record.fingerprint !== block.fingerprint) {
    return {
      state: 'stale',
      why: 'the text changed after validation — nobody approved the new text',
      blame: [],
    };
  }

  // The text is unchanged. What is left is whether the ground under it still is.
  // `record.dependsOn` holds the fingerprint EACH dependency had at the moment of the ✓. Comparing
  // with today's is what reveals the indirect change — the one no fingerprint of this block
  // denounces.
  const dependedOn = record.dependsOn ?? {};
  const moved = Object.entries(dependedOn)
    .filter(([id, fingerprintThen]) => {
      const now = fingerprintsNow.get(id);
      // A dependency that vanished is a break too: the block points at something that is gone.
      return now === undefined || now !== fingerprintThen;
    })
    .map(([id]) => id);

  if (moved.length) {
    return {
      state: 'broken',
      why: `the text is unchanged, but what it depends on moved: ${moved.join(', ')}`,
      blame: moved,
    };
  }

  return { state: 'valid', why: 'validated, and nothing has changed since', blame: [] };
}

/**
 * The traffic light for the whole documentation.
 *
 * @param {Map<string, Block>} blocks
 * @param {Record<string, Record_>} records
 * @returns {{ byBlock: Map<string, {state: State, why: string, blame: string[]}>,
 *             tally: Record<State, number> }}
 */
export function trafficLight(blocks, records) {
  const fingerprintsNow = new Map([...blocks].map(([id, b]) => [id, b.fingerprint]));
  const byBlock = new Map();
  const tally = /** @type {Record<State, number>} */ ({ none: 0, valid: 0, stale: 0, broken: 0 });

  for (const [id, b] of blocks) {
    const r = stateOf(b, records[id], fingerprintsNow);
    byBlock.set(id, r);
    tally[r.state]++;
  }
  return { byBlock, tally };
}

/**
 * What depends on a block — the question the other way round, and the one people actually ask:
 * *"if I touch this, what else do I have to look at?"*
 *
 * @param {string} id
 * @param {Map<string, Block>} blocks
 * @returns {string[]}
 */
export function dependentsOf(id, blocks) {
  return [...blocks.values()].filter((b) => (b.dependsOn ?? []).includes(id)).map((b) => b.id);
}
