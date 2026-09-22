/**
 * A block's state, derived from the events. No cycle rule lives here: the server sends `status`
 * ready on every request, and the panel obeys.
 *
 * On purpose: a front end that computes state ends up disagreeing with the server — the same
 * request shows as "Approved" in one place and "Awaiting" in the other.
 *
 * Pure functions, no DOM and no React, so the rules that paint the traffic light run under
 * `node --test` without a browser.
 */

/**
 * A block's traffic light, from the browser's point of view.
 *
 * 🔴 does not come from the events: it comes from comparing what the block declares it depends on
 * against how those dependencies look RIGHT NOW. For the blocks on this page that is the text the
 * browser rendered; for a dependency on another page it is what the server reads from disk (see
 * `foreignDependencies`) — the page does not hold that text, and guessing it would paint every
 * cross-page dependency red.
 *
 * @param {{validated: string|null, fingerprint: string, validatedFingerprint?: string|null,
 *          dependedOn?: Record<string,string>}} block
 * @param {ReturnType<typeof blockState>} situation
 * @param {Map<string,string>} fingerprintsNow  id → current fingerprint of every block the page
 *   depends on: its own, computed here, and those on other pages, as the server read them
 */
export function trafficLightOf(block, situation, fingerprintsNow) {
  if (!situation.approved && !block.validated) return { color: 'none', culprits: [] };

  // 🟡 from the repository: the fingerprint recorded at the ✓ does not match the text on screen.
  // Without this attribute a rewritten block would stay green in the browser — `data-validated`
  // alone only says THAT it was validated, not WHICH text was.
  if (block.validatedFingerprint && block.validatedFingerprint !== block.fingerprint) {
    return { color: 'stale', culprits: [] };
  }
  if (situation.expired.length && !situation.approved) return { color: 'stale', culprits: [] };

  const dependedOn = block.dependedOn ?? {};
  const moved = Object.entries(dependedOn)
    .filter(([id, then]) => fingerprintsNow.get(id) !== then)
    .map(([id]) => id);
  if (moved.length) return { color: 'broken', culprits: moved };

  return { color: 'valid', culprits: [] };
}

/**
 * The blocks this page depends on that are not on this page: the ones whose current fingerprint
 * has to come from the server. Sorted, so the request for them is the same on every load.
 *
 * @param {{id: string, dependedOn?: Record<string,string>}[]} blocks
 */
export function foreignDependencies(blocks) {
  const here = new Set(blocks.map((b) => b.id));
  const wanted = new Set(blocks.flatMap((b) => Object.keys(b.dependedOn ?? {})));
  return [...wanted].filter((id) => !here.has(id)).sort();
}

/** Requests still in someone's hands: neither applied nor rejected. */
const isOpen = (r) => {
  const s = r.status?.state;
  return Boolean(s) && s !== 'applied' && s !== 'rejected';
};

export function blockState(events, id, fingerprintNow) {
  const mine = events.filter((e) => e.block === id);
  const approvals = mine.filter((e) => e.type === 'approval');
  const requests = mine.filter((e) => e.type === 'request');

  // An approval only holds for the text it approved. Change the text, the fingerprint changes,
  // and the approval becomes history — it does not disappear, it just stops counting.
  //
  // And only the owner's is the lock: the server says which, as `locks`, because it is the one that
  // knows who the owner is. Anyone else's ✓ on this text is `seconded` — recorded, shown for what
  // it is, and never green. Painted green, it would tell a reader the text is locked while
  // `holdrim sync` and the home, counting the owner's alone, say it is not.
  const current = approvals.filter((e) => e.fingerprint === fingerprintNow);
  const holding = current.filter((e) => e.locks);
  const seconded = current.filter((e) => !e.locks);
  const expired = approvals.filter((e) => e.locks && e.fingerprint !== fingerprintNow);

  return {
    approved: holding.length > 0, holding, seconded, expired, requests,
    open: requests.filter(isOpen),
    // The block's own story. Triage moves and supplements are part of a REQUEST's thread, not
    // entries of their own: listed here too, every triage would show up in the history as one
    // more "requested a change".
    history: mine.filter((e) => e.type !== 'request_state' && e.type !== 'supplement'),
  };
}

export const byWhen = (a, b) => String(a.when || '').localeCompare(String(b.when || ''));

/**
 * A day, for a human, in the reader's own locale.
 *
 * A bare `YYYY-MM-DD` — which is what `data-validated` carries — is read by `Date` as midnight UTC,
 * which is the day BEFORE everywhere west of Greenwich. So that shape is built as a local day.
 */
export function day(iso) {
  if (!iso) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  const d = m ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString();
}

/**
 * The line that names a block at the top of its panel: its first words, cut at a word, and saying
 * it was cut. Cut mid-word, "the return period decides" would read "the return period decide" —
 * which, on a page of rules, reads as a typo in the rule.
 */
export function summaryOf(text, max = 110) {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max + 1).replace(/\s+\S*$/, '')}…`;
}
