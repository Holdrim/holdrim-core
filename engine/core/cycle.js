/**
 * The request cycle: states, transitions, and the reduction of an event history to one state.
 *
 * THIS IS THE ONLY IMPLEMENTATION. Browser and server both import this file; the table comes from
 * `cycle.json` next to it, which stays being the data.
 *
 * Why one file: a state machine copied across languages and templates comes out similar, not
 * equal. The same request shows as "Approved" in one place and "Awaiting triage" in another, the
 * site's own counters disagree with each other, and a race-condition guard added to one copy never
 * reaches the others. A copied rule is a rule that drifts.
 *
 * The cycle knows NO language: it returns keys (`open`, `approved`), and translation happens at the
 * edge: a product meant for three languages cannot carry interface text inside its business rule.
 *
 * @module
 */

// `request` is optional because `data` is the grab-bag of ANY event — a comment carries
// `category`, an applied one carries `commit`, and only request_state carries `request`. Declaring
// it required would make the core's type fight the API's.
/** @typedef {{ request?: string, state?: string, from?: string, [k: string]: unknown }} EventData */
/** @typedef {{ id: string, type: string, author?: string, when?: string, data?: EventData|null }} Event */
/**
 * `label` and `short` are for the EDGE, not for the rule: the core never reads them, which is why
 * they are optional here. Whoever shows text to a person resolves the label in that person's
 * language.
 * @typedef {{ owned_by: string, label?: string, short?: string }} StateDef
 */
/** @typedef {{ initial: string, initial_for_admin: string, states: Record<string,StateDef>,
 *              transitions: Record<string,string[]>, accepts_supplement: string[],
 *              requires_reason: string[], requires_commit: string[], agent_queue: string[],
 *              request_categories?: Record<string,string> }} CycleTable */

/**
 * @param {CycleTable} table
 */
export function createCycle(table) {
  // Object.keys, not truthiness: `{}` is truthy, so an empty table would slip through — accepting
  // any state change at all. A slip a test catches and reading does not.
  if (!Object.keys(table?.states ?? {}).length || !Object.keys(table?.transitions ?? {}).length) {
    throw new Error('cycle.json has no states or no transitions: any state change would be accepted.');
  }
  if (!table.states[table.initial]) {
    throw new Error(`cycle.json: the initial state "${table.initial}" is not in "states".`);
  }
  const dangling = Object.entries(table.transitions)
    .flatMap(([from, targets]) => targets.filter((t) => !table.states[t]).map((t) => `${from} → ${t}`));
  if (dangling.length) {
    throw new Error('cycle.json: transition to a state that does not exist — ' + dangling.join(', '));
  }

  const ownedBy = (who) =>
    Object.entries(table.states).filter(([, v]) => v.owned_by === who).map(([k]) => k);

  return {
    table,
    exists: (state) => Boolean(table.states[state]),
    ownerStates: ownedBy('owner'),
    agentStates: ownedBy('agent'),
    canGo: (from, to) => (table.transitions[from] ?? []).includes(to),
    acceptsSupplement: (state) => table.accepts_supplement.includes(state),
    requiresReason: (state) => table.requires_reason.includes(state),
    requiresCommit: (state) => table.requires_commit.includes(state),

    /**
     * Every request's own events, gathered in one pass: `threadsOf(events).get(id)`.
     *
     * `currentState` filters whatever list it is handed, so handing it every event, once per
     * request, would make a list of requests cost the square of its length — seconds, then minutes,
     * as a project's history grows. Grouped first, each request reads only its own thread.
     * @template {{ data?: { request?: string } | null }} E
     * @param {E[]} events
     * @returns {Map<string, E[]>}
     */
    threadsOf(events) {
      const threads = new Map();
      for (const e of events) {
        const id = e.data?.request;
        if (typeof id !== 'string') continue;
        if (!threads.has(id)) threads.set(id, []);
        threads.get(id).push(e);
      }
      return threads;
    },

    /**
     * The current state of a request, derived from its history.
     * @param {string} requestId
     * @param {Event[]} events  the request's own thread, `threadsOf(all).get(requestId)`. A wider
     *                          list still answers right — this filters it — but costs its whole
     *                          length on every call, which over a list of requests is the square.
     * @param {boolean} authorIsAdmin  owner and admin do not triage themselves
     */
    currentState(requestId, events, authorIsAdmin = false) {
      let state = authorIsAdmin ? table.initial_for_admin : table.initial;
      const ofRequest = events
        .filter((e) => e.data?.request === requestId)
        .sort((a, b) => String(a.when ?? '').localeCompare(String(b.when ?? '')));

      for (const e of ofRequest) {
        if (e.type === 'request_state' && e.data?.state) {
          // Race guard: `from` says which state the change departed from. Two simultaneous requests
          // can read the same state and both write — leaving the request in a state the machine
          // itself declares impossible, and nothing can be erased. Whoever departed from a state
          // that was no longer current lost the race. An old event with no `from` still counts:
          // history is not rewritten.
          if (e.data.from && e.data.from !== state) continue;
          state = e.data.state;
        } else if (e.type === 'supplement' && table.accepts_supplement.includes(state)) {
          state = table.initial;
        }
      }
      return state;
    },

    /**
     * What the front end needs to know without reimplementing anything. Returns KEYS — the label a
     * person reads is resolved at the edge, in their language.
     * `triage` comes pre-filtered: on an approved request every possible transition belongs to the
     * agent, so the "Approve" button must not appear at all.
     */
    status(state) {
      const targets = table.transitions[state] ?? [];
      const owner = ownedBy('owner');
      return {
        state,
        ownedBy: table.states[state]?.owned_by ?? 'owner',
        canGoTo: targets,
        triage: targets.filter((t) => owner.includes(t)),
        requiresReason: targets.filter((t) => table.requires_reason.includes(t)),
        acceptsSupplement: table.accepts_supplement.includes(state),
      };
    },
  };
}
