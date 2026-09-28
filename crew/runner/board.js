#!/usr/bin/env node
/**
 * The two halves of a pass that hold the GitHub token, so that the model in between holds none.
 *
 *   node board.js snapshot <dir>       read the board into <dir>/board.json; exit 3 when the owner paused
 *   node board.js publish <result> <dir>  apply the model's answer, but only what this file allows
 *
 * The model reads files and writes one JSON answer; it has no shell, no network and no token
 * (run-orchestrator.sh). Whatever it was talked into by a comment it read, the most it can do is
 * ask for a comment or a label on an item already open, and this file is what says no to the rest.
 * The rules below are the orchestrator's (`crew/orchestrator.md`, `crew/autonomy.md`) written as
 * code, because a rule the model is only asked to keep is a rule a prompt injection can talk away.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const OWNER_ID = 7923867;
export const MAX_ACTIONS = 20;
export const MAX_BODY = 20000;
// needs:owner comes off only by the owner's own hand (crew/README.md, "Who may give an
// instruction"); every other queue label is the orchestrator's to move.
const LABEL = /^(needs|working):[a-z0-9-]+$/;
const KEY = /^[\w.:@#/-]{1,100}$/;

/** The marker a published comment carries, so that no later pass posts it twice. */
export const markerFor = (key) => `<!-- holdrim-key: ${key} -->`;

/**
 * Whether the owner paused the crew: the handoff issue carries `paused` and the timeline shows the
 * owner's own id applied it last. A `paused` put there by anyone else is reported and not obeyed,
 * or any account that can label could stop the crew. A label whose author the timeline does not
 * show pauses all the same: a flag that cannot be read keeps the crew idle (`crew/autonomy.md`).
 */
export function pauseState(labels, timeline) {
  if (!labels.includes('paused')) return { paused: false };
  const last = timeline.filter((e) => (e.event === 'labeled' || e.event === 'unlabeled') && e.label?.name === 'paused').at(-1);
  if (last?.event !== 'labeled' || !last.actor) return { paused: true };
  if (last.actor.id === OWNER_ID) return { paused: true };
  return { paused: false, ignored: last.actor.login };
}

/** A fingerprint of everything a pass acts on: equal to the last one means nothing to do. */
export function boardDigest(items) {
  const lines = items.map((i) => [i.number, i.updated_at, i.head ?? '', i.checks ?? ''].join(' ')).sort();
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}

/**
 * Sorts the model's answer into what may be applied and what is refused, with the reason.
 * `secrets` are the values the answer must never carry, whatever the model was told.
 */
export function vetActions(answer, items, secrets = []) {
  const actions = Array.isArray(answer?.actions) ? answer.actions : null;
  if (!actions) return { accepted: [], refused: [{ action: answer, reason: 'the answer has no actions list' }] };
  if (actions.length > MAX_ACTIONS) return { accepted: [], refused: [{ action: null, reason: `more than ${MAX_ACTIONS} actions in one pass` }] };
  const open = new Map(items.map((i) => [i.number, i]));
  const commented = new Set();
  const accepted = [];
  const refused = [];
  for (const a of actions) {
    const reason = refusal(a, open, commented, secrets);
    if (reason) { refused.push({ action: a, reason }); continue; }
    if (a.type === 'comment') commented.add(a.number);
    accepted.push(a);
  }
  return { accepted, refused };
}

function refusal(a, open, commented, secrets) {
  const item = open.get(a?.number);
  if (!item) return 'not an open item on the board';
  if (a.type === 'comment') {
    if (typeof a.body !== 'string' || a.body.trim() === '' || a.body.length > MAX_BODY) return 'a comment needs a body of at most 20000 characters';
    if (typeof a.key !== 'string' || !KEY.test(a.key)) return 'a comment needs a key naming the item and what it answers';
    if (commented.has(a.number)) return 'one comment per item per pass';
    if ((item.comments ?? []).some((c) => c.body?.includes(markerFor(a.key)))) return 'already posted under this key';
    if (secrets.some((s) => s && a.body.includes(s))) return 'the body carries a credential';
    return null;
  }
  if (a.type === 'add_label' || a.type === 'remove_label') {
    if (typeof a.label !== 'string' || !LABEL.test(a.label)) return 'only needs: and working: labels';
    if (a.type === 'remove_label' && a.label === 'needs:owner') return 'only the owner removes needs:owner';
    return null;
  }
  return `unknown action type ${JSON.stringify(a?.type)}`;
}

/** The model is asked for bare JSON; this takes the object out of the first ``` block or the text. */
export function parseAnswer(text) {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  try { return JSON.parse((fenced ? fenced[1] : text).trim()); } catch { return null; }
}

const REPO = 'Holdrim/holdrim-core';

async function gh(path, init = {}) {
  const res = await fetch(`https://api.github.com/${path}`, {
    ...init,
    headers: { authorization: `Bearer ${process.env.GH_TOKEN}`, accept: 'application/vnd.github+json', ...init.headers },
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

async function snapshot(dir) {
  const issues = await all(`repos/${REPO}/issues?state=open`);
  const items = [];
  for (const i of issues) {
    const item = {
      number: i.number, title: i.title, body: i.body, pull_request: Boolean(i.pull_request),
      author: { login: i.user.login, id: i.user.id }, labels: i.labels.map((l) => l.name),
      assignees: i.assignees.map((a) => a.login), updated_at: i.updated_at,
      comments: (await all(`repos/${REPO}/issues/${i.number}/comments`))
        .map((c) => ({ id: c.id, author: { login: c.user.login, id: c.user.id }, created_at: c.created_at, body: c.body })),
      timeline: (await all(`repos/${REPO}/issues/${i.number}/timeline`))
        .filter((e) => ['labeled', 'unlabeled', 'assigned', 'unassigned', 'closed', 'reopened'].includes(e.event))
        .map((e) => ({ event: e.event, label: e.label && { name: e.label.name }, actor: e.actor && { login: e.actor.login, id: e.actor.id }, created_at: e.created_at })),
    };
    if (i.pull_request) {
      const pr = await (await gh(`repos/${REPO}/pulls/${i.number}`)).json();
      const runs = (await (await gh(`repos/${REPO}/commits/${pr.head.sha}/check-runs?per_page=100`)).json()).check_runs;
      item.head = pr.head.sha;
      item.draft = pr.draft;
      item.mergeable_state = pr.mergeable_state;
      item.checks = runs.map((r) => `${r.name}=${r.conclusion ?? r.status}`).sort().join(',');
      item.reviews = (await all(`repos/${REPO}/pulls/${i.number}/reviews`))
        .map((r) => ({ author: { login: r.user.login, id: r.user.id }, state: r.state, commit_id: r.commit_id, body: r.body }));
    }
    items.push(item);
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'board.json'), JSON.stringify({ repo: REPO, read_at: new Date().toISOString(), items }, null, 1));
  writeFileSync(join(dir, 'digest'), boardDigest(items));
  const handoff = items.find((i) => i.labels.includes('handoff'));
  const pause = handoff ? pauseState(handoff.labels, handoff.timeline) : { paused: false };
  if (pause.ignored) console.log(`paused label on the handoff issue from ${pause.ignored}, not the owner: ignored`);
  return pause.paused;
}

async function publish(resultFile, dir) {
  const { items } = JSON.parse(readFileSync(join(dir, 'board.json'), 'utf8'));
  const answer = parseAnswer(JSON.parse(readFileSync(resultFile, 'utf8')).result ?? '');
  const { accepted, refused } = vetActions(answer, items, [process.env.GH_TOKEN, process.env.CLAUDE_CODE_OAUTH_TOKEN]);
  for (const r of refused) console.log(`refused: ${r.reason}: ${JSON.stringify(r.action)?.slice(0, 200)}`);
  for (const a of accepted) {
    const base = `repos/${REPO}/issues/${a.number}`;
    if (a.type === 'comment') await gh(`${base}/comments`, { method: 'POST', body: JSON.stringify({ body: `${a.body}\n\n${markerFor(a.key)}` }) });
    if (a.type === 'add_label') await gh(`${base}/labels`, { method: 'POST', body: JSON.stringify({ labels: [a.label] }) });
    if (a.type === 'remove_label') await gh(`${base}/labels/${encodeURIComponent(a.label)}`, { method: 'DELETE' });
    console.log(`applied: ${a.type} on #${a.number}${a.label ? ` ${a.label}` : ''}`);
  }
  return accepted.length;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, a, b] = process.argv.slice(2);
  if (cmd === 'snapshot') process.exit((await snapshot(a)) ? 3 : 0);
  else if (cmd === 'publish') console.log(`${await publish(a, b)} applied`);
  else { console.error('usage: board.js snapshot <dir> | publish <result.json> <dir>'); process.exit(2); }
}
