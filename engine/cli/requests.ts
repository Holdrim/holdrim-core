import { readFileSync } from 'node:fs';
import { createCycle } from '../core/cycle.js';
import { readBlocks, ofProject, projectRoles } from './pages.ts';
import { Source } from './remote.ts';
import { authorCouldTriage, earliestLockBaseline, type Event } from '../api/types.ts';
import { suspectsOf } from '../api/texts.ts';
import { personAs } from '../core/people-show.js';

/**
 * The agent's tool: read the change requests reviewers made on the site, see the context, measure
 * the impact, and record progress. It NEVER edits content — the agent does that, with the owner,
 * in a commit carrying the request trailers.
 *
 * ⚠️ What this file prints is English, and deliberately not routed through `engine/core/i18n.js`:
 * whoever operates the tool reads logs, and a log is evidence. Evidence whose wording changes with
 * the machine's locale is evidence nobody can grep for. The state LABEL comes from the engine's
 * `cycle.json`, which is English too.
 */

export interface Request extends Event {
  state: string;
  history: Event[];
}

/**
 * The cycle is the ENGINE's, not the project's: it ships with the tool and lives next to it.
 * Reading it from the content project's root would only work if that project and the engine were
 * one repository.
 */
export function loadCycle() {
  return createCycle(JSON.parse(readFileSync(new URL('../cycle.json', import.meta.url), 'utf8')));
}

/**
 * The label a person reads. It lives here, not in the core: the rule carries no interface text —
 * it returns the key, and each edge resolves it in the reader's language.
 */
const labelOf = (cycle: ReturnType<typeof createCycle>, state: string) =>
  cycle.table.states[state]?.label ?? state;

/**
 * The refusal for a request the agent may not work on. One wording for both doors: `state`, which
 * moves a request, and `apply`, which hands its brief to a CLI that edits content.
 *
 * Two cases, because a single sentence would tell the agent the owner had not approved a request
 * the agent has itself already applied. A request still in the owner's hands waits for the owner;
 * one already in the agent's hands can only go where the cycle takes it next, or nowhere once
 * applied.
 */
function notTheAgents(cycle: ReturnType<typeof createCycle>, state: string) {
  const now = `no: the request is "${labelOf(cycle, state)}"`;
  if (!cycle.agentStates.includes(state)) return new Error(`${now}. The agent only applies requests the owner APPROVED.`);
  const next = cycle.status(state).canGoTo;
  return new Error(next.length
    ? `${now}; from there it goes to: ${next.map((s: string) => labelOf(cycle, s)).join(', ')}.`
    : `${now}: nothing is left to do on it.`);
}

/**
 * Refuses a request outside the agent's queue. Without it, `apply` would brief the agent on any
 * request, saying "the request was approved by the owner" about one still open, or rejected — and
 * the agent, told so, would edit content nobody agreed to change.
 */
export function mustBeQueued(r: { state: string }) {
  const cycle = loadCycle();
  if (!cycle.table.agent_queue.includes(r.state)) throw notTheAgents(cycle, r.state);
}

/**
 * Refuses to run against a project whose authority is not the deployment's alone — a holdrim.json
 * naming `owner`, `admins` or `locks`, or HOLDRIM_OWNER missing or malformed — exactly as `sync`
 * refuses it (docs/ROLES.md, "Authority comes from the deployment only").
 *
 * Every command below calls this and throws away the `roles` it gets back: since decision A, a
 * request's own state no longer depends on them (`authorCouldTriage`, types.ts, reads what was
 * WRITTEN, never a live `roles.can(...)`), so nothing here needs the VALUE any more — but the
 * VALIDATION is still owed. Dropping this call would leave `list`, `show`, `summary`, `impact` and
 * `state` silently running against a project with no owner at all, or one whose repository claims to
 * be it, while `sync` alone still refused — exactly the asymmetry `engine/tests/owner.test.js` was
 * written to catch.
 */
function checkAuthority(root: string): void {
  projectRoles(root);
}

/**
 * Reduces events to requests with a state — using the SAME core as the server and the browser.
 *
 * No roles are handed in any more: a request's starting state is read from what `recordEvent` wrote
 * on it when it was FILED (`authorCouldTriage`, types.ts — the one implementation this file and
 * server.ts both call, round 1's review, finding 2), and a request with nothing written fails closed
 * to "at triage" (decision A) rather than asking this process's own HOLDRIM_ADMINS — which is how the
 * CLI came to know a different answer than the server in the first place: this runs in the agent's
 * own process, and a request granted `triage` afterwards must not read as pre-approved here with no
 * triage event to show for it.
 *
 * `authorCouldTriage` trusts what was written only for a request dated after the events' OWN
 * `lock_baseline` (round 2's review, CRITICAL "fields written before this version are trusted"): the
 * same store this reads from can hold a pre-version request with a client-forged `authorCouldTriage`,
 * from back when `recordEvent` stored whatever `data` a client sent — and this file has no server
 * process's `LOCK_BASELINE` to ask, only whatever `events` itself carries, which is exactly why the
 * baseline is a written EVENT (`ensureLockBaseline`, types.ts) and not a value kept in memory.
 */
export function requests(events: Event[]): Request[] {
  const cycle = loadCycle();
  const threads = cycle.threadsOf(events);
  const baseline = earliestLockBaseline(events);
  return events.filter((e) => e.type === 'request').map((r) => {
    const thread = threads.get(r.id) ?? [];
    return {
      ...r,
      state: cycle.currentState(r.id, thread, authorCouldTriage(r, baseline)),
      history: thread.filter((e) => e.type !== 'request').sort((a, b) => a.when.localeCompare(b.when)),
    };
  });
}

export function find(all: Request[], prefix: string): Request {
  const hits = all.filter((r) => r.id.startsWith(prefix));
  if (hits.length !== 1) {
    throw new Error(`request "${prefix}": ${hits.length === 0 ? 'not found' : 'ambiguous, use more characters'}`);
  }
  return hits[0];
}

/**
 * When something happened, short enough to sit in a column.
 *
 * ⚠️ Built by hand instead of `toLocaleString`. Pinned to one locale it prints the same order for
 * everybody but reads backwards to half of them; left to the machine's own locale, the same run
 * would read `09/20` on one laptop and `20/09` on the next, so two people comparing the same output
 * would disagree about the day. Month-day, in that order, is the one shape that cannot be read
 * backwards. The CLOCK stays local, because the question being asked is "how long ago", and that
 * is only answerable in the reader's own day.
 */
export const formatWhen = (iso: string) => {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso.slice(0, 16);
  const two = (n: number) => String(n).padStart(2, '0');
  return `${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
};

/**
 * What the CLI prints for a person — docs/ROLES.md, "How a person appears" — applied at the two
 * places a human (or the coding agent reading `agent.ts`'s brief) actually reads one: the console
 * lines below, and `brief`'s own "Who:" line. `holdrim list --json` is untouched: `queue`'s own
 * comment already calls it "the contract other tools read", and a display setting is not the kind
 * of thing that contract should move under — it keeps naming the real address, exactly as before.
 *
 * The CLI never reaches the accounts store (docs/PRIVACY.md, section 1: "never the accounts") or a
 * signed-in reader of its own, so two things `personAs` can do for the panel and the home, this
 * cannot: "name" has nothing beyond the address to fall back to, and "id" the same — the row id
 * lives behind a lookup this tool has no connection open for — and no override applies, because
 * there is no viewer here to apply one TO. Both read as `personAs` already reads missing data: the
 * address, which is what a project set "email" to mean in the first place.
 */
export function personLabel(show: ReturnType<typeof ofProject>['peopleShow'], roles: Pick<ReturnType<typeof projectRoles>, 'roleOf'>, email: string): string {
  return personAs({
    show, email, id: null, name: null,
    role: roles.roleOf(email), alwaysNamed: false,
  });
}

/**
 * The agent's queue: what the owner approved and nobody applied yet, with everything an agent
 * needs to act — as data. `--json` is the contract other tools read; the table is for a person.
 */
export async function queue(root: string, source: Pick<Source, 'events'> & { guardsTampered?: boolean }, all: boolean) {
  checkAuthority(root);
  const cycle = loadCycle();
  const events = await source.events();
  const found = requests(events);
  const agentQueue = cycle.table.agent_queue ?? ['approved', 'applying', 'waiting'];
  const showing = all ? found : found.filter((r) => agentQueue.includes(r.state));
  const blocks = await readBlocks(root);
  return {
    toTriage: found.filter((r) => r.state === 'open').length,
    // Which of the three cases it was already went out through `reportTampered`, wherever `events`
    // was actually resolved (the server, or one of `Source`'s two direct readers) — this is only
    // the flag `list` warns from and exits non-zero on (issue #91's "same warning").
    tampered: suspectsOf(events).length > 0,
    // A SEPARATE finding, not folded into `tampered` above: a guard `GUARDS` (store-sqlite.ts)
    // names being missing or changed is not the same claim as a text failing its own hash, and
    // `list --json`'s own contract should let a reader (an agent parsing the queue, say) tell the
    // two apart. Only `Source#fromFile`, the `--db` reader, ever sets it — `guardsTampered` reads
    // `false` for the cloud and the local server, which have no equivalent trigger to compare
    // (issue #108). Read AFTER `source.events()`, which is what actually runs the comparison.
    guardsTampered: source.guardsTampered ?? false,
    requests: showing.map((r) => {
      const block = r.block ? blocks.get(r.block) : undefined;
      return {
        id: r.id, state: r.state, page: r.page, block: r.block ?? null, author: r.author, when: r.when,
        category: typeof r.data?.category === 'string' ? r.data.category : null,
        text: r.text ?? '', snapshot: r.snapshot ?? null,
        file: block?.file ?? null,
        textNow: block?.text ?? null,
        blockChanged: Boolean(block && r.fingerprint && block.fingerprint !== r.fingerprint),
        validated: block?.validated ?? null,
        history: r.history.map((e) => ({ when: e.when, author: e.author, type: e.type,
          state: typeof e.data?.state === 'string' ? e.data.state : null, text: e.text ?? null })),
      };
    }),
  };
}

/**
 * The one line `list` and `sync` (validation.ts) both print when a field they read comes back
 * tampered — issue #91's "the CLI prints the same warning". `reportTampered` (engine/api/texts.ts)
 * has already put the specifics — the event, the field, which of the three cases it was — through the
 * CRITICAL log, wherever the read actually happened; this is the terminal's own notice that a person
 * running the command is looking at data it does not trust, not a second copy of that alert.
 */
export function warnOfTampering() {
  console.error('⚠ CRITICAL: a text read back does not match its own hash. The store was written to '
    + 'outside the product — this almost always means a credential leaked. Rotate it, and see the '
    + 'server log (or run this again where the log is written) for which event and field.');
}

export async function list(root: string, source: Pick<Source, 'events'> & { guardsTampered?: boolean },
                           options: { all?: boolean; json?: boolean } = {}) {
  const cycle = loadCycle();
  const q = await queue(root, source, options.all ?? false);
  // `q.guardsTampered` needs no warning of its own here: `Source#fromFile` already printed one line
  // per guard the moment `source.events()` found it, the same way `reportTampered` already did for
  // `q.tampered` before `queue` ever runs — this only has to fold it into the exit code.
  const exitWorthy = q.tampered || q.guardsTampered;
  if (options.json) { console.log(JSON.stringify(q, null, 2)); if (q.tampered) warnOfTampering(); return exitWorthy; }
  if (q.tampered) warnOfTampering();

  if (!q.requests.length) {
    console.log(`no requests ${options.all ? 'recorded' : 'approved and waiting to be applied'}.` +
      (q.toTriage && !options.all ? ` (${q.toTriage} waiting for the owner's triage)` : ''));
    return exitWorthy;
  }
  const { peopleShow } = ofProject(root);
  const roles = projectRoles(root);
  for (const r of q.requests) {
    const changed = r.blockChanged ? ' · ⚠ the block changed since the request' : '';
    const label = cycle.table.states[r.state]?.short ?? r.state;
    console.log(`${r.id.slice(0, 8)}  ${label.padEnd(10)} ${(r.block ?? r.page).padEnd(10)} ` +
      `${formatWhen(r.when)}  ${personLabel(peopleShow, roles, r.author)}${changed}`);
    console.log(`          “${r.text.replace(/\n/g, ' ').slice(0, 140)}”`);
  }
  return exitWorthy;
}

export async function show(root: string, source: Pick<Source, 'events'>, prefix: string) {
  checkAuthority(root);
  const cycle = loadCycle();
  const events = await source.events();
  const roles = projectRoles(root);
  const r = find(requests(events), prefix);
  const blocks = await readBlocks(root);
  const block = r.block ? blocks.get(r.block) : undefined;
  const { peopleShow } = ofProject(root);

  console.log(`Request  ${r.id}`);
  console.log(`State    ${labelOf(cycle, r.state)}`);
  console.log(`Who      ${personLabel(peopleShow, roles, r.author)}  ·  ${formatWhen(r.when)}`);
  console.log(`Where    ${r.block ?? r.page}${block ? `  (${block.file})` : ''}`);
  console.log(`\nAsked for:\n  ${(r.text ?? '').replace(/\n/g, '\n  ')}`);
  if (r.snapshot) console.log(`\nThe block's text when they asked:\n  ${r.snapshot.slice(0, 500)}`);
  if (block) {
    console.log(`\nThe block's text NOW:\n  ${block.text.slice(0, 500)}`);
    if (r.fingerprint && block.fingerprint !== r.fingerprint) console.log('\n  ⚠ the block CHANGED since the request.');
    if (block.validated) {
      console.log(`  ⚠ this block is VALIDATED (${block.validated}): changing it needs the owner's permission.`);
    }
  }
  if (r.history.length) {
    console.log('\nThread:');
    for (const e of r.history) {
      const what = e.type === 'supplement' ? 'added more'
        : (labelOf(cycle, String(e.data?.state ?? '')) || e.type);
      console.log(`  ${formatWhen(e.when)}  ${personLabel(peopleShow, roles, e.author)}  ${what}`);
      if (e.text) console.log(`      ${e.text.replace(/\n/g, ' ')}`);
    }
  }
}

/** Where else the subject shows up — the impact analysis you run before editing. As data. */
export async function impactOf(root: string, source: Pick<Source, 'events'>, prefix: string, terms: string[]) {
  checkAuthority(root);
  const events = await source.events();
  const r = find(requests(events), prefix);
  const blocks = await readBlocks(root);
  const searching = terms.length ? terms : [(r.text ?? '').split(/\s+/).slice(0, 3).join(' ')];
  return {
    request: r,
    terms: searching.map((term) => {
      const rx = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      const hits = [...blocks.values()].filter((b) => rx.test(b.text));
      return { term, hits: hits.map((b) => ({ id: b.id, file: b.file, validated: b.validated, text: b.text })) };
    }),
  };
}

export async function impact(root: string, source: Pick<Source, 'events'>, prefix: string, terms: string[]) {
  const { request: r, terms: found } = await impactOf(root, source, prefix, terms);
  console.log(`Impact of request ${r.id.slice(0, 8)} — ${r.block ?? r.page}\n`);
  for (const { term, hits } of found) {
    console.log(`"${term}" shows up in ${hits.length} block(s):`);
    for (const b of hits.slice(0, 25)) {
      console.log(`  ${b.id.padEnd(12)} ${b.validated ? '✓ validated ' : '            '}${b.text.slice(0, 80)}`);
    }
    if (hits.length > 25) console.log(`  … and ${hits.length - 25} more`);
    const validated = hits.filter((b) => b.validated).length;
    if (validated) console.log(`  ⚠ ${validated} of them are VALIDATED: changing those needs the owner's permission.`);
    console.log('');
  }
}

export async function summary(root: string, source: Pick<Source, 'events'>) {
  checkAuthority(root);
  const events = await source.events();
  const all = requests(events);
  const perPage = new Map<string, { approvals: number; requests: number; open: number }>();
  for (const e of events) {
    const v = perPage.get(e.page) ?? { approvals: 0, requests: 0, open: 0 };
    if (e.type === 'approval') v.approvals++;
    if (e.type === 'request') v.requests++;
    perPage.set(e.page, v);
  }
  // ⚠️ `open` is the core's key. A comparison left spelling any other name would make the "open"
  // column count zero forever, on every page, and read like a clean queue.
  for (const r of all.filter((x) => x.state === 'open')) {
    const v = perPage.get(r.page)!; v.open++;
  }
  for (const [page, v] of [...perPage].sort()) {
    console.log(`${page.padEnd(8)} ${String(v.approvals).padStart(3)} approval(s) · ` +
      `${v.requests} request(s) · ${v.open} open`);
  }
  console.log(`total: ${events.length} event(s), ${all.length} request(s), ` +
    `${all.filter((r) => r.state === 'open').length} open`);
}

/**
 * Records progress on a request — what the reviewer sees in the block's panel.
 * The agent only uses ITS OWN states: approving, rejecting and asking is the owner's triage, on
 * the site.
 */
export async function setState(root: string, source: Pick<Source, 'events' | 'add'>, prefix: string, target: string,
                               message: string, extra: { commit?: string; blocks?: string } = {}) {
  checkAuthority(root);
  const cycle = loadCycle();
  const events = await source.events();
  const r = find(requests(events), prefix);

  if (!cycle.agentStates.includes(target)) {
    throw new Error(`the agent only uses: ${cycle.agentStates.join(', ')} ` +
      '(approving, rejecting and asking is the owner\'s triage, on the site)');
  }
  if (!cycle.canGo(r.state, target)) throw notTheAgents(cycle, r.state);
  if (cycle.requiresCommit(target) && !extra.commit) {
    throw new Error('applied needs --commit SHA (the trail ties request ↔ commit)');
  }

  const data: Record<string, string> = { request: r.id, state: target, from: r.state };
  if (extra.commit) data.commit = extra.commit;
  if (extra.blocks) data.blocks = extra.blocks;

  const text = message + (extra.commit ? ` · commit ${extra.commit.slice(0, 7)}` : '') +
    (extra.blocks ? ` · blocks: ${extra.blocks}` : '');
  await source.add({ type: 'request_state', page: r.page, block: r.block, text, data });
  console.log(`recorded: ${r.id.slice(0, 8)} → ${labelOf(cycle, target)}`);
}
