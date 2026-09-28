#!/usr/bin/env node
/**
 * The two halves of a pass that hold the GitHub token, so that the model in between holds none.
 *
 *   node board.js snapshot <dir>          read the board into <dir>/board.json; exit 3 when paused
 *   node board.js publish <result> <dir>  apply the model's answer, but only what this file allows
 *
 * The model reads files and writes one JSON answer, as a user of its own with no shell, no network
 * and no token (run-orchestrator.sh). Whatever it was talked into by a comment it read, the most it
 * can do is ask for a comment or a label on an item already open, and this file is what says no to
 * the rest. The rules below are the orchestrator's (`crew/orchestrator.md`, `crew/autonomy.md`)
 * written as code, because a rule the model is only asked to keep is a rule a prompt injection can
 * talk away.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const OWNER_ID = 7923867;
export const ORCHESTRATOR_ID = 333497607;
export const MAX_ACTIONS = 20;
export const MAX_BODY = 20000;
export const STALL_MS = 24 * 60 * 60 * 1000;
// needs:owner comes off only by the owner's own hand (crew/README.md, "Who may give an
// instruction"); every other queue label is the orchestrator's to move.
const LABEL = /^(needs|working):[a-z0-9-]+$/;
const KEY = /^[\w.:@#/-]{1,100}$/;
const TYPES = ['comment', 'add_label', 'remove_label'];
// Asking for what is already so is not a refusal worth the owner's attention: a retry after a
// partial publish asks for exactly these. They are logged, and left out of the note.
const POSTED = 'already posted under this key';
const HAS = 'the item already carries that label';
const LACKS = 'the item does not carry that label';
const ALREADY = [POSTED, HAS, LACKS];

/** The marker a published comment carries, so that no later pass posts it twice. */
export const markerFor = (key) => `<!-- holdrim-key: ${key} -->`;

const pausedEvents = (timeline) => timeline.filter((e) => (e.event === 'labeled' || e.event === 'unlabeled') && e.label?.name === 'paused');

/**
 * Whether the owner paused the crew. Only the owner's own `paused` events count, both ways: a label
 * the owner put there stays in force when someone else removes it, and one someone else put there
 * is reported and not obeyed, or any account that can label could stop or restart the crew. With
 * no handoff issue, or a `paused` whose author the timeline does not show, the flag cannot be read,
 * and a flag that cannot be read keeps the crew idle (`crew/autonomy.md`).
 */
export function pauseState(handoff) {
  if (!handoff) return { paused: true, why: 'no open handoff issue' };
  const events = pausedEvents(handoff.timeline ?? []);
  const owners = events.filter((e) => e.actor?.id === OWNER_ID);
  const own = owners.at(-1);
  const after = own ? events.slice(events.lastIndexOf(own) + 1) : events;
  const other = after.filter((e) => e.actor?.id !== OWNER_ID).at(-1);
  if (own) return other ? { paused: own.event === 'labeled', ignored: other.actor?.login ?? 'unknown' } : { paused: own.event === 'labeled' };
  if (!handoff.labels.includes('paused')) return { paused: false };
  if (!other?.actor) return { paused: true, why: 'a paused label with no readable author' };
  return { paused: false, ignored: other.actor.login };
}

const time = (at) => (at ? Date.parse(at) : 0);

/**
 * The latest push that counts for an item: its own head, or that of an open PR that closes it and
 * that an account in crew/accounts.md opened. Anyone can write "Closes #7" in a pull request of
 * their own and push to it, and would otherwise keep someone else's stalled claim from ever being
 * reported.
 */
function lastPush(item, items, listed) {
  // GitHub's closing keywords, with or without a colon, naming the item by its bare number; a
  // reference into another repository is not this item.
  const closes = new RegExp(`\\b(close[sd]?|fix(e[sd])?|resolve[sd]?):?\\s+#${item.number}\\b`, 'i');
  const linked = items.filter((p) => p.head_date && (p === item || (closes.test(p.body ?? '') && listed.includes(p.author?.id))));
  return Math.max(0, ...linked.map((p) => time(p.head_date)));
}

/**
 * Claims older than the stall limit with no push since, as `<item>:<label>`. A claim sits on an
 * issue and its pushes land on the pull request that closes it, so those count too. A claim whose
 * start the timeline does not show counts from the beginning of time: reported, never trusted
 * forever. The limit is crossed by time passing, not by anything written, so the digest carries
 * this list: otherwise the pass that should report a stalled claim would be the one skipped.
 */
export function staleClaims(items, now, listed = []) {
  const out = [];
  for (const i of items) {
    for (const label of i.labels.filter((l) => l.startsWith('working:'))) {
      const at = (i.timeline ?? []).filter((e) => e.event === 'labeled' && e.label?.name === label).at(-1)?.created_at;
      if (now - Math.max(time(at), lastPush(i, items, listed)) > STALL_MS) out.push(`${i.number}:${label}`);
    }
  }
  return out.sort();
}

/**
 * A fingerprint of everything a pass acts on: equal to the last one means nothing to do. It leaves
 * out what the orchestrator itself wrote, or its own handoff comment would change the board, wake
 * the next pass, and be answered by another one every two hours for as long as work is in flight.
 */
export function boardDigest(items, now = Date.now(), listed = []) {
  const lines = items.map((i) => {
    const theirs = (i.comments ?? []).filter((c) => c.author?.id !== ORCHESTRATOR_ID).map((c) => c.id);
    const events = (i.timeline ?? []).filter((e) => e.actor?.id !== ORCHESTRATOR_ID).map((e) => `${e.event}:${e.label?.name ?? ''}:${e.created_at}`);
    const reviews = (i.reviews ?? []).map((r) => `${r.state}:${r.commit_id}`);
    return [i.number, [...i.labels].sort(), i.head ?? '', i.checks ?? '', theirs.at(-1) ?? '', events.at(-1) ?? '', reviews.join(',')].join(' ');
  }).sort();
  return createHash('sha256').update([...lines, ...staleClaims(items, now, listed)].join('\n')).digest('hex');
}

/**
 * Sorts the model's answer into what may be applied and what is refused, with the reason.
 * `secrets` are the values the answer must never carry, whatever the model was told, and `known`
 * the labels the repository has, so a typo does not become a new label.
 */
export function vetActions(answer, items, { secrets = [], known = null } = {}) {
  const actions = Array.isArray(answer?.actions) ? answer.actions : null;
  if (!actions) return { accepted: [], refused: [{ action: answer, reason: 'the answer has no actions list' }] };
  if (actions.length > MAX_ACTIONS) return { accepted: [], refused: [{ action: null, reason: `more than ${MAX_ACTIONS} actions in one pass` }] };
  const open = new Map(items.map((i) => [i.number, i]));
  const commented = new Set();
  const accepted = [];
  const refused = [];
  for (const a of actions) {
    const reason = refusal(a, open, commented, secrets, known);
    if (reason) { refused.push({ action: a, reason }); continue; }
    if (a.type === 'comment') commented.add(a.number);
    accepted.push(a);
  }
  return { accepted, refused };
}

function refusal(a, open, commented, secrets, known) {
  const item = open.get(a?.number);
  if (!item) return 'not an open item on the board';
  if (a.type === 'comment') {
    if (typeof a.body !== 'string' || a.body.trim() === '' || a.body.length > MAX_BODY) return `a comment needs a body of at most ${MAX_BODY} characters`;
    if (typeof a.key !== 'string' || !KEY.test(a.key)) return 'a comment needs a key naming the item and what it answers';
    if (commented.has(a.number)) return 'one comment per item per pass';
    // Only the orchestrator's own markers count: anyone can write the marker into a comment, and
    // one written by a stranger would otherwise silence the orchestrator on that item.
    if ((item.comments ?? []).some((c) => c.author?.id === ORCHESTRATOR_ID && c.body?.includes(markerFor(a.key)))) return POSTED;
    if (secrets.some((s) => s && a.body.includes(s))) return 'the body carries a credential';
    // The marker is this file's to write: one in a body would dedupe a key the orchestrator has
    // not answered yet, and silence its real answer when it comes.
    if (a.body.includes('holdrim-key')) return 'the body carries a dedupe marker';
    return null;
  }
  if (a.type === 'add_label' || a.type === 'remove_label') {
    if (typeof a.label !== 'string' || !LABEL.test(a.label)) return 'only needs: and working: labels';
    if (a.type === 'remove_label' && a.label === 'needs:owner') return 'only the owner removes needs:owner';
    if (a.type === 'remove_label' && !item.labels.includes(a.label)) return LACKS;
    if (a.type === 'add_label' && item.labels.includes(a.label)) return HAS;
    // Without the repository's labels read, no label is known: the check fails closed, never open.
    if (a.type === 'add_label' && !(known ?? []).includes(a.label)) return 'no such label in the repository';
    return null;
  }
  // The type is not repeated: it is the model's text, and a reason is published.
  return 'unknown action type';
}

/**
 * The model is asked for bare JSON, so that is read first: a fence is looked for only when the
 * whole text is not JSON, since a comment body in a valid answer may itself hold a fenced block.
 */
export function parseAnswer(text) {
  try { return JSON.parse(text.trim()); } catch { /* not bare JSON: look for a fence */ }
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  try { return fenced ? JSON.parse(fenced[1].trim()) : null; } catch { return null; }
}

/**
 * The last word before anything is written: whatever path built a comment, it carries no credential
 * and no marker but the one publish appends. Should one ever do, it throws and nothing is posted.
 * vetActions already refuses both; this is here for the path nobody has thought of yet.
 */
export function lastCheck(actions, secrets) {
  for (const a of actions.filter((x) => x.type === 'comment')) {
    if (secrets.some((x) => x && a.body.includes(x)) || a.body.includes('holdrim-key')) throw new Error(`a comment on #${a.number} failed the last check: nothing published`);
  }
}

/** The one place a GitHub request is made; `fetch` is a parameter so the tests can stand in for it. */
function client(repo, fetchImpl, token) {
  async function gh(path, init = {}) {
    const res = await fetchImpl(`https://api.github.com/${path.replace('{repo}', `repos/${repo}`)}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', ...init.headers },
    });
    if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path}: ${res.status}`);
    return res;
  }
  async function all(path) {
    const out = [];
    for (let page = 1; ; page++) {
      const batch = await (await gh(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`)).json();
      out.push(...batch);
      if (batch.length < 100) return out;
    }
  }
  return { gh, all };
}

const who = (u) => u && { login: u.login, id: u.id };

/** Reads every open issue and pull request into `<dir>/board.json`; true when the crew is paused. */
export async function snapshot(dir, { repo, listed = [], fetch: fetchImpl = fetch, token = process.env.GH_TOKEN, now = Date.now() }) {
  const { gh, all } = client(repo, fetchImpl, token);
  const items = [];
  for (const i of await all('{repo}/issues?state=open')) {
    const item = {
      number: i.number, title: i.title, body: i.body, pull_request: Boolean(i.pull_request),
      author: who(i.user), labels: i.labels.map((l) => l.name), assignees: i.assignees.map((a) => a.login),
      comments: (await all(`{repo}/issues/${i.number}/comments`))
        .map((c) => ({ id: c.id, author: who(c.user), created_at: c.created_at, body: c.body })),
      timeline: (await all(`{repo}/issues/${i.number}/timeline`))
        .filter((e) => ['labeled', 'unlabeled', 'assigned', 'unassigned', 'closed', 'reopened'].includes(e.event))
        .map((e) => ({ event: e.event, label: e.label && { name: e.label.name }, actor: who(e.actor), created_at: e.created_at })),
    };
    if (i.pull_request) {
      const pr = await (await gh(`{repo}/pulls/${i.number}`)).json();
      const runs = (await (await gh(`{repo}/commits/${pr.head.sha}/check-runs?per_page=100`)).json()).check_runs;
      const commit = await (await gh(`{repo}/commits/${pr.head.sha}`)).json();
      item.head = pr.head.sha;
      item.head_date = commit.commit.committer.date;
      item.draft = pr.draft;
      // Often `unknown` on a first read while GitHub computes it; kept out of the digest for that reason.
      item.mergeable_state = pr.mergeable_state;
      item.checks = runs.map((r) => `${r.name}=${r.conclusion ?? r.status}`).sort().join(',');
      item.reviews = (await all(`{repo}/pulls/${i.number}/reviews`))
        .map((r) => ({ author: who(r.user), state: r.state, commit_id: r.commit_id, body: r.body }));
    }
    items.push(item);
  }
  const known = (await all('{repo}/labels')).map((l) => l.name);
  const digest = boardDigest(items, now, listed);
  const stale = staleClaims(items, now, listed);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'board.json'), JSON.stringify({ repo, read_at: new Date(now).toISOString(), listed, digest, stale_claims: stale, labels: known, items }, null, 1));
  writeFileSync(join(dir, 'digest'), digest);
  const pause = pauseState(items.find((i) => i.labels.includes('handoff')));
  if (pause.ignored) console.log(`paused label changed by ${pause.ignored}, not the owner: ignored`);
  if (pause.why) console.log(`${pause.why}: staying idle`);
  return pause.paused;
}

/**
 * Applies the model's answer, and returns how many actions went through. What it did and refused
 * goes to stderr, the container's log; stdout carries only the count, which the script reads. An answer that is missing,
 * failed or unreadable throws instead: a pass that never answered must not be recorded as one that
 * found nothing to do. Refused actions are said on the handoff issue, where the owner sees them,
 * not only in the container's log.
 */
export async function publish(resultFile, dir, { repo, fetch: fetchImpl = fetch, token = process.env.GH_TOKEN, secrets = [] }) {
  const { items, labels, digest, read_at: readAt, listed = [] } = JSON.parse(readFileSync(join(dir, 'board.json'), 'utf8'));
  const result = JSON.parse(readFileSync(resultFile, 'utf8'));
  if (result.is_error || typeof result.result !== 'string') throw new Error(`the model gave no answer (${result.subtype ?? 'no result'})`);
  const answer = parseAnswer(result.result);
  if (!Array.isArray(answer?.actions)) throw new Error('the model\'s answer is not a JSON object with an actions list');
  const now = Date.parse(readAt);
  if (Number.isNaN(now)) throw new Error('board.json has no read_at: the stall limit cannot be judged');
  const secretList = [token, ...secrets];
  const { accepted, refused } = vetActions(answer, items, { secrets: secretList, known: labels });
  // What is said about a refused action, in the log and on GitHub alike, is only what this file
  // wrote or checked: the reason, and the type and item when they are ones it knows. The action's
  // own text never goes in: it may carry the very credential it was refused for, or a mention, a
  // marker or markdown that would then appear in a comment signed by the orchestrator.
  const shown = (a) => [TYPES.includes(a?.type) ? a.type : 'an action', Number.isInteger(a?.number) ? `on #${a.number}` : ''].join(' ').trim();
  for (const r of refused) console.error(`refused: ${shown(r.action)}: ${r.reason}`);
  const worth = refused.filter((r) => !ALREADY.includes(r.reason));
  const handoff = items.find((i) => i.labels.includes('handoff'));
  // Its own comment, under its own key, so that a retry after a partial publish finds it posted.
  if (worth.length && handoff) {
    const note = `The runner refused ${worth.length} action(s) the orchestrator asked for:\n`
      + worth.map((r) => `- ${shown(r.action)}: ${r.reason}`).join('\n');
    const own = { type: 'comment', number: handoff.number, key: `refused@${digest.slice(0, 16)}`, body: note };
    const posted = (handoff.comments ?? []).some((c) => c.author?.id === ORCHESTRATOR_ID && c.body?.includes(markerFor(own.key)));
    if (!posted) accepted.push(own);
  }
  lastCheck(accepted, secretList);
  const { gh } = client(repo, fetchImpl, token);
  for (const a of accepted) {
    const base = `{repo}/issues/${a.number}`;
    if (a.type === 'comment') await gh(`${base}/comments`, { method: 'POST', body: JSON.stringify({ body: `${a.body}\n\n${markerFor(a.key)}` }) });
    if (a.type === 'add_label') await gh(`${base}/labels`, { method: 'POST', body: JSON.stringify({ labels: [a.label] }) });
    if (a.type === 'remove_label') await gh(`${base}/labels/${encodeURIComponent(a.label)}`, { method: 'DELETE' });
    console.error(`applied: ${a.type} on #${a.number}${a.label ? ` ${a.label}` : ''}`);
  }
  // The labels just moved are the orchestrator's own writes, and the digest leaves those out: the
  // one the script records is taken from the board as this pass left it, or the next pass would
  // wake to its own label and answer it.
  // A label added is also a claim's start, as the next snapshot will read it from the timeline.
  for (const a of accepted) {
    const item = items.find((i) => i.number === a.number);
    const event = { label: { name: a.label }, actor: { id: ORCHESTRATOR_ID }, created_at: readAt };
    if (a.type === 'add_label') { item.labels.push(a.label); item.timeline = [...(item.timeline ?? []), { event: 'labeled', ...event }]; }
    if (a.type === 'remove_label') { item.labels = item.labels.filter((l) => l !== a.label); item.timeline = [...(item.timeline ?? []), { event: 'unlabeled', ...event }]; }
  }
  writeFileSync(join(dir, 'digest'), boardDigest(items, now, listed));
  return accepted.length;
}

// Compared by real path: a path with a space, or one reached through a symlink, is spelled
// differently in import.meta.url, and a mismatch here would make every command a silent no-op.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const [cmd, a, b] = process.argv.slice(2);
  const repo = process.env.REPO;
  if (!repo) { console.error('REPO is not set'); process.exit(2); }
  // The ids crew/accounts.md lists, read by the script from the fresh clone.
  const listed = (process.env.LISTED ?? '').split(',').filter(Boolean).map(Number);
  if (cmd === 'snapshot') process.exit((await snapshot(a, { repo, listed })) ? 3 : 0);
  else if (cmd === 'publish') console.log(`${await publish(a, b, { repo, secrets: [process.env.CLAUDE_CODE_OAUTH_TOKEN] })} applied`);
  else { console.error('usage: REPO=<owner/name> board.js snapshot <dir> | publish <result.json> <dir>'); process.exit(2); }
}
