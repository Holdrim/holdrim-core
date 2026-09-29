/**
 * The orchestrator's runner keeps the model away from every credential, and board.js is what
 * holds the line between what the model asks for and what reaches GitHub.
 *
 * Nothing else runs this code before a real pass does, and a real pass that gets it wrong writes
 * to the repository under the orchestrator's name, or stops the crew with nothing on the board to
 * say so. So board.js is driven here against a stand-in for GitHub's API, and run-orchestrator.sh
 * is run with `setpriv`, `gh`, `git`, `claude` and board.js replaced by stubs on the PATH, the way
 * session-start.test.js runs its hook.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stub } from './helpers/stub.js';
import {
  boardDigest, lastCheck, markerFor, parseAnswer, pauseOf, pauseState, publish, snapshot, staleClaims, vetActions,
  MAX_ACTIONS, MAX_BODY, ORCHESTRATOR_ID, OWNER_ID, STALL_MS,
} from '../../crew/runner/board.js';

const ROOT = new URL('../../', import.meta.url).pathname;
const SCRIPT = join(ROOT, 'crew', 'runner', 'run-orchestrator.sh');
const NOW = Date.parse('2026-09-28T12:00:00Z');
const orch = { login: 'orchestrator', id: ORCHESTRATOR_ID };
const owner = { login: 'owner', id: OWNER_ID };
const reviewer = { login: 'reviewer', id: 333201923 };

const ITEMS = [
  { number: 80, labels: ['handoff'], comments: [], timeline: [] },
  { number: 185, labels: ['needs:owner', 'working:claude'], head: 'abc', checks: 'test=success', timeline: [],
    comments: [{ id: 1, author: orch, body: `done\n\n${markerFor('185@abc')}` }] },
];
const KNOWN = ['needs:owner', 'needs:chatgpt', 'working:claude', 'working:chatgpt'];
const comment = (number, key, body = 'the state') => ({ type: 'comment', number, key, body });
const vet = (actions, opts = {}) => vetActions({ actions }, ITEMS, { known: KNOWN, ...opts });
const reasons = (actions, opts) => vet(actions, opts).refused.map((r) => r.reason);

test('a comment and a queue label on an open item go through', () => {
  const { accepted, refused } = vet([
    comment(80, '80@c1'),
    { type: 'add_label', number: 185, label: 'needs:chatgpt' },
    { type: 'remove_label', number: 185, label: 'working:claude' },
  ]);
  assert.equal(accepted.length, 3);
  assert.deepEqual(refused, []);
});

test('only open items on the board can be written to', () => {
  assert.deepEqual(reasons([comment(999, '999@x')]), ['not an open item on the board']);
});

test('only the owner removes needs:owner', () => {
  assert.deepEqual(reasons([{ type: 'remove_label', number: 185, label: 'needs:owner' }]), ['only the owner removes needs:owner']);
});

test('only needs: and working: labels: never paused, never an arbitrary one', () => {
  for (const label of ['paused', 'handoff', 'kind:security', 'needs:Owner', 'needs: owner']) {
    assert.deepEqual(reasons([{ type: 'add_label', number: 80, label }]), ['only needs: and working: labels'], label);
  }
});

test('a label is removed only where it is, added only where it is not, and never invented', () => {
  assert.deepEqual(reasons([{ type: 'remove_label', number: 80, label: 'working:claude' }]), ['the item does not carry that label']);
  assert.deepEqual(reasons([{ type: 'add_label', number: 185, label: 'working:claude' }]), ['the item already carries that label']);
  assert.deepEqual(reasons([{ type: 'add_label', number: 80, label: 'needs:chatgtp' }]), ['no such label in the repository']);
  assert.deepEqual(reasons([{ type: 'add_label', number: 80, label: 'needs:chatgpt' }], { known: undefined }), ['no such label in the repository'],
    'with the repository\'s labels unread, no label is known');
});

test('a key the orchestrator already posted on the item is not posted again', () => {
  assert.deepEqual(reasons([comment(185, '185@abc')]), ['already posted under this key']);
  assert.equal(vet([comment(185, '185@def')]).accepted.length, 1, 'a new head is a new key');
});

test('a marker written by anyone else does not silence the orchestrator', () => {
  const items = [{ number: 185, labels: [], comments: [{ id: 2, author: { login: 'x', id: 1 }, body: markerFor('185@def') }] }];
  assert.equal(vetActions({ actions: [comment(185, '185@def')] }, items).accepted.length, 1);
});

test('one comment per item per pass', () => {
  const { accepted, refused } = vet([comment(80, '80@a'), comment(80, '80@b')]);
  assert.equal(accepted.length, 1);
  assert.deepEqual(refused.map((r) => r.reason), ['one comment per item per pass']);
});

test('a comment carrying a credential is refused, in its body or its key, and spelled out too', () => {
  const secrets = ['ghp_SECRETVALUE0123456789'];
  for (const [key, body] of [
    ['80@a', 'here: ghp_SECRETVALUE0123456789'],
    ['80@ghp_SECRETVALUE0123456789', 'an innocent body'],
    ['80@a', 'g h p _ S E C R E T V A L U E - 0123-4567-89'],
  ]) {
    assert.deepEqual(reasons([comment(80, key, body)], { secrets }), ['the comment carries a credential'], `${key} / ${body}`);
  }
  assert.deepEqual(reasons([comment(80, '80@a', 'SECRETVALUE alone is only a word')], { secrets }), []);
  assert.deepEqual(reasons([comment(80, '80@a', 'the cat sat, then t-0-k')], { secrets: ['t0k'] }), [],
    'a secret too short to be told from ordinary text is matched only as written');
});

test('the refusal note\'s key is the publisher\'s: a model comment may not take it', () => {
  assert.deepEqual(reasons([comment(80, `refused@${'d'.repeat(16)}`)]), ['a comment key may not start with refused@']);
});

test('a comment body may not carry a dedupe marker, which only the publisher writes', () => {
  assert.deepEqual(reasons([comment(80, '80@a', `ok ${markerFor('185@next')}`)]), ['the body carries a dedupe marker']);
});

test('a comment needs a key and a bounded body', () => {
  const body = `a comment needs a body of at most ${MAX_BODY} characters`;
  assert.deepEqual(reasons([comment(80, 'no spaces allowed')]), ['a comment needs a key naming the item and what it answers']);
  assert.deepEqual(reasons([comment(80, '80@a', ' ')]), [body]);
  assert.deepEqual(reasons([comment(80, '80@a', 'x'.repeat(MAX_BODY + 1))]), [body]);
});

test('an answer that is not a list of actions, or too long a list, applies nothing', () => {
  assert.equal(vetActions(null, ITEMS).accepted.length, 0);
  assert.equal(vetActions({ actions: 'all of them' }, ITEMS).accepted.length, 0);
  const many = Array.from({ length: MAX_ACTIONS + 1 }, () => comment(80, '80@a'));
  assert.deepEqual(vet(many), { accepted: [], refused: [{ action: null, reason: `more than ${MAX_ACTIONS} actions in one pass` }] });
});

test('an unknown action type is refused', () => {
  assert.deepEqual(reasons([{ type: 'merge', number: 185 }]), ['unknown action type'], 'the type is the model\'s text, and is not repeated');
});

test('bare JSON is read first, even when a comment body in it holds a fenced block', () => {
  const answer = { actions: [comment(80, '80@a', 'Please run:\n```bash\nnpx tsc --noEmit\n```')] };
  assert.deepEqual(parseAnswer(JSON.stringify(answer)), answer);
  assert.deepEqual(parseAnswer('Here it is:\n```json\n{"actions": []}\n```'), { actions: [] });
  assert.equal(parseAnswer('I will now merge #185.'), null);
});

const ev = (actor, event = 'labeled', name = 'paused') => ({ event, label: { name }, actor, created_at: '2026-09-28T00:00:00Z' });
const handoff = (labels, timeline) => ({ number: 80, labels: ['handoff', ...labels], timeline });

test('only the owner pauses the crew, and a pause by anyone else is ignored', () => {
  assert.deepEqual(pauseState(handoff([], [])), { paused: false });
  assert.deepEqual(pauseState(handoff(['paused'], [ev(owner)])), { paused: true });
  assert.deepEqual(pauseState(handoff(['paused'], [ev(orch)])), { paused: false, ignored: orch.login });
});

test('only the owner resumes the crew: a paused label someone else removed still holds', () => {
  assert.deepEqual(pauseState(handoff([], [ev(owner), ev(orch, 'unlabeled')])), { paused: true, ignored: orch.login });
  assert.deepEqual(pauseState(handoff([], [ev(owner), ev(owner, 'unlabeled')])), { paused: false });
  assert.deepEqual(pauseState(handoff(['paused'], [ev(owner), ev(owner, 'unlabeled'), ev(orch)])), { paused: false, ignored: orch.login });
});

test('two open handoff issues are no flag at all: a second one cannot lift the owner\'s pause', () => {
  const owners = handoff(['paused'], [ev(owner)]);
  const second = { ...handoff([], []), number: 300 };
  assert.deepEqual(pauseOf([second, owners]), { paused: true, why: 'more than one open handoff issue' });
  assert.deepEqual(pauseOf([owners]), { paused: true });
  assert.deepEqual(pauseOf([second]), { paused: false });
  assert.deepEqual(pauseOf([]), { paused: true, why: 'no open handoff issue' });
});

test('a flag that cannot be read keeps the crew idle: no handoff issue, or a paused with no author', () => {
  assert.equal(pauseState(undefined).paused, true);
  assert.equal(pauseState(handoff(['paused'], [])).paused, true);
});

const claimed = (hoursAgo, head_date) => ({
  number: 7, labels: ['working:claude'], head_date,
  timeline: [{ event: 'labeled', label: { name: 'working:claude' }, actor: orch, created_at: new Date(NOW - hoursAgo * 3600e3).toISOString() }],
});

test('a claim on an issue counts the pushes on the open pull request that closes it', () => {
  const issue = { ...claimed(25), number: 7, head_date: undefined };
  const listed = [ORCHESTRATOR_ID, reviewer.id];
  const pr = (body, hoursAgo, author = reviewer) => ({ number: 9, labels: [], body, author, head_date: new Date(NOW - hoursAgo * 3600e3).toISOString(), timeline: [] });
  const stale = (items) => staleClaims(items, NOW, listed);
  assert.deepEqual(stale([issue, pr('Closes #7', 1)]), []);
  assert.deepEqual(stale([issue, pr('Closes #7', 1, { login: 'stranger', id: 42 })]), ['7:working:claude'], 'a stranger\'s pull request does not keep a claim alive');
  assert.deepEqual(stale([issue, pr('Closes #7', 30)]), ['7:working:claude'], 'an old push does not restart it');
  assert.deepEqual(stale([issue, pr('Closes #70', 1)]), ['7:working:claude'], 'another issue\'s pull request does not count');
  for (const body of ['Closes: #7', 'fixes  #7', 'Resolved #7.']) assert.deepEqual(stale([issue, pr(body, 1)]), [], body);
  assert.deepEqual(stale([issue, pr('Closes other/repo#7', 1)]), ['7:working:claude'], 'another repository\'s #7 is not this item');
  assert.deepEqual(stale([issue, pr('This encloses #7', 1)]), ['7:working:claude'], 'a keyword inside another word is not one');
});

test('a claim is stale after the limit with no push, and a push restarts the clock', () => {
  assert.equal(STALL_MS, 24 * 3600e3);
  assert.deepEqual(staleClaims([claimed(23)], NOW), []);
  assert.deepEqual(staleClaims([claimed(25)], NOW), ['7:working:claude']);
  assert.deepEqual(staleClaims([claimed(25, new Date(NOW - 3600e3).toISOString())], NOW), []);
  assert.deepEqual(staleClaims([{ number: 7, labels: ['working:claude'], timeline: [] }], NOW), ['7:working:claude'],
    'a claim whose start the timeline does not show is reported, not trusted forever');
});

test('the digest leaves out the orchestrator\'s own writes and takes in everyone else\'s', () => {
  const base = boardDigest(ITEMS, NOW);
  assert.equal(boardDigest([...ITEMS].reverse(), NOW), base, 'the order it was read in');
  const withOwn = [ITEMS[0], { ...ITEMS[1], comments: [...ITEMS[1].comments, { id: 9, author: orch, body: 'state' }] }];
  assert.equal(boardDigest(withOwn, NOW), base, 'its own comment');
  const withOwnEvent = [{ ...ITEMS[0], timeline: [ev(orch, 'labeled', 'needs:chatgpt')] }, ITEMS[1]];
  assert.equal(boardDigest(withOwnEvent, NOW), base, 'its own label event');
  const withTheirs = [ITEMS[0], { ...ITEMS[1], comments: [...ITEMS[1].comments, { id: 9, author: owner, body: 'go' }] }];
  assert.notEqual(boardDigest(withTheirs, NOW), base, 'someone else\'s comment');
  assert.notEqual(boardDigest([{ ...ITEMS[0], timeline: [ev(owner, 'labeled', 'needs:chatgpt')] }, ITEMS[1]], NOW), base, 'someone else\'s label event');
  for (const change of [{ head: 'def' }, { checks: 'test=failure' }, { labels: ['needs:owner'] }, { reviews: [{ state: 'APPROVED', commit_id: 'abc' }] }]) {
    assert.notEqual(boardDigest([ITEMS[0], { ...ITEMS[1], ...change }], NOW), base, JSON.stringify(change));
  }
});

test('the digest takes in every change a pass decides on: draft, scope, an edited instruction, a finding on a line', () => {
  const pr = { number: 187, title: 'Runner', body: 'scope', draft: true, labels: [], head: 'abc', comments: [{ id: 5, author: owner, body: 'do X' }],
    review_comments: [], reviews: [{ id: 70, state: 'COMMENTED', commit_id: 'abc', body: '' }], timeline: [] };
  const base = boardDigest([{ ...pr, timeline: [ev(owner)] }], NOW);
  for (const [what, change] of [
    ['ready for review', { draft: false }],
    ['a new scope', { body: 'a wider scope' }],
    ['a new title', { title: 'Runner, and more' }],
    ['an edited instruction', { comments: [{ id: 5, author: owner, body: 'do Y instead' }] }],
    ['an earlier comment edited under a later one', { comments: [{ id: 5, author: owner, body: 'do Y' }, { id: 6, author: reviewer, body: 'ok' }] }],
    ['an inline finding', { review_comments: [{ id: 71, author: reviewer, body: 'MAJOR: wrong' }] }],
    ['a review summary edited', { reviews: [{ id: 70, state: 'COMMENTED', commit_id: 'abc', body: 'MAJOR' }] }],
    ['a review dismissed', { reviews: [{ id: 70, state: 'DISMISSED', commit_id: 'abc', body: '' }] }],
    ['a comment deleted and another with the same words added', { comments: [{ id: 8, author: owner, body: 'do X' }] }],
    ['a label event for another label', { timeline: [ev(owner, 'labeled', 'needs:owner')] }],
    ['a label event that is a removal', { timeline: [ev(owner, 'unlabeled', 'paused')] }],
    ['a label event at another time', { timeline: [{ ...ev(owner), created_at: '2026-09-28T01:00:00Z' }] }],
  ]) {
    assert.notEqual(boardDigest([{ ...pr, timeline: [ev(owner)], ...change }], NOW), base, what);
  }
  assert.notEqual(boardDigest([{ ...pr, number: 188 }], NOW), boardDigest([pr], NOW), 'the same state on another item');
  assert.equal(boardDigest([{ ...pr, labels: ['b', 'a'] }], NOW), boardDigest([{ ...pr, labels: ['a', 'b'] }], NOW), 'the order GitHub lists labels in');
  const withLater = { ...pr, comments: [...pr.comments, { id: 6, author: reviewer, body: 'ok' }] };
  assert.notEqual(boardDigest([{ ...withLater, comments: [{ ...withLater.comments[0], body: 'do Y' }, withLater.comments[1]] }], NOW), boardDigest([withLater], NOW),
    'an edit to a comment that is not the last one');
  assert.equal(boardDigest([{ ...pr, review_comments: [{ id: 72, author: orch, body: 'noted' }] }], NOW), boardDigest([pr], NOW), 'the orchestrator\'s own line comment');
  assert.equal(boardDigest([{ ...pr, mergeable_state: 'clean' }], NOW), boardDigest([pr], NOW), 'mergeable_state, often unknown on a first read');
});

test('the digest changes when a claim crosses the stall limit, with nothing written', () => {
  const items = [claimed(23.5)];
  assert.notEqual(boardDigest(items, NOW + 3600e3), boardDigest(items, NOW));
});

/**
 * Answers what publish reads just before its first write: the open handoff issue, #80, and its
 * timeline, which is `timeline`. Every `fakeGitHub()` answers this way unless told otherwise, so a
 * publish test sees a crew that is not paused; other paths get an empty object.
 */
const handoffResolver = (timeline = []) => (path, u) => {
  if (path === '/repos/o/r/issues') return u.searchParams.get('state') === 'open' && u.searchParams.get('labels') === 'handoff' && u.searchParams.get('page') === '1' ? [{ number: 80, labels: [{ name: 'handoff' }] }] : [];
  if (path === '/repos/o/r/issues/80/timeline') return u.searchParams.get('page') === '1' ? timeline : [];
  return {};
};

/**
 * A stand-in for GitHub's API. `resolve(pathname, url)` answers a request, and a path it does not
 * know gets a 404, the way GitHub answers one: matched exactly, so a request built with a wrong
 * number or a stray suffix fails here as it would there. Every request is recorded.
 */
function fakeGitHub(resolve = handoffResolver()) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    calls.push({ method: init.method ?? 'GET', path: u.pathname + u.search, body: init.body && JSON.parse(init.body), auth: init.headers?.authorization });
    const value = resolve(u.pathname, u);
    return value === undefined ? { ok: false, status: 404, json: async () => ({}) } : { ok: true, status: 200, json: async () => value };
  };
  return { fetch, calls, get writes() { return calls.filter((c) => c.method !== 'GET'); } };
}

function board(t, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'holdrim-board-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'board.json'), JSON.stringify({ items: ITEMS, labels: KNOWN, digest: 'd'.repeat(64), read_at: new Date(NOW).toISOString(), ...extra }));
  const answer = (result) => { writeFileSync(join(dir, 'result.json'), JSON.stringify(result)); return join(dir, 'result.json'); };
  return { dir, answer };
}

test('publish sends each allowed action to its endpoint, and marks every comment with its key', async (t) => {
  const { dir, answer } = board(t);
  const gh = fakeGitHub();
  const file = answer({ result: JSON.stringify({ actions: [
    comment(80, 'handoff@abc', 'the state'),
    { type: 'add_label', number: 185, label: 'needs:chatgpt' },
    { type: 'remove_label', number: 185, label: 'working:claude' },
  ] }) });
  assert.equal(await publish(file, dir, { repo: 'o/r', fetch: gh.fetch, token: 't0k' }), 3);
  assert.deepEqual(gh.writes.map((c) => [c.method, c.path, c.body]), [
    ['POST', '/repos/o/r/issues/80/comments', { body: `the state\n\n${markerFor('handoff@abc')}` }],
    ['POST', '/repos/o/r/issues/185/labels', { labels: ['needs:chatgpt'] }],
    ['DELETE', '/repos/o/r/issues/185/labels/working%3Aclaude', undefined],
  ]);
  assert.ok(gh.calls.every((c) => c.auth === 'Bearer t0k'));
});

test('publish refuses the token it holds, and says on the handoff issue what it refused', async (t) => {
  const { dir, answer } = board(t);
  const gh = fakeGitHub();
  const file = answer({ result: JSON.stringify({ actions: [comment(185, '185@x', 'leak t0k'), { type: 'remove_label', number: 185, label: 'needs:owner' }] }) });
  const logged = [];
  const log = console.error;
  console.error = (...args) => logged.push(args.join(' '));
  try {
    assert.equal(await publish(file, dir, { repo: 'o/r', fetch: gh.fetch, token: 't0k' }), 1);
  } finally {
    console.error = log;
  }
  assert.ok(logged.some((l) => l.startsWith('refused: comment on #185')), 'the refusal is logged');
  assert.ok(!logged.join('\n').includes('t0k'), 'the container log does not carry the credential either');
  assert.equal(gh.writes.length, 1);
  assert.equal(gh.writes[0].path, '/repos/o/r/issues/80/comments');
  assert.match(gh.writes[0].body.body, /refused 2 action\(s\)[\s\S]*comment on #185: the comment carries a credential[\s\S]*remove_label on #185: only the owner removes needs:owner/);
  assert.match(gh.writes[0].body.body, new RegExp(markerFor(`refused@${'d'.repeat(16)}`)));
  assert.ok(!gh.writes[0].body.body.includes('t0k'), 'the credential a comment was refused for is not posted in the note');
});

test('the refusal note repeats nothing the refused action wrote: no mention, marker or markdown gets out', async (t) => {
  const { dir, answer } = board(t);
  const gh = fakeGitHub();
  const evil = `needs:x\` @someone ${markerFor('handoff@next')}`;
  const file = answer({ result: JSON.stringify({ actions: [
    { type: 'add_label', number: 185, label: evil },
    { type: `x\` @someone t0k ${markerFor('185@next')}`, number: 185 },
    { type: 'merge', number: '185 @a' },
    { type: 'comment', number: 4172839405612380, key: 'x@y', body: 'b' },
  ] }) });
  await publish(file, dir, { repo: 'o/r', fetch: gh.fetch, token: 't0k' });
  const body = gh.writes[0].body.body.replace(markerFor(`refused@${'d'.repeat(16)}`), '');
  assert.doesNotMatch(body, /@someone|holdrim-key|`|t0k|4172839405612380/);
  assert.match(body, /- add_label on #185: only needs: and working: labels\n- an action on #185: unknown action type\n- an action: not an open item on the board\n- comment: not an open item on the board/);
});

test('asking for what is already so is left out of the note, and the same note is not posted twice', async (t) => {
  const { dir, answer } = board(t);
  const gh = fakeGitHub();
  const already = answer({ result: JSON.stringify({ actions: [comment(185, '185@abc'), { type: 'add_label', number: 185, label: 'working:claude' }] }) });
  assert.equal(await publish(already, dir, { repo: 'o/r', fetch: gh.fetch, token: 'tok-SECRET' }), 0);
  assert.equal(gh.writes.length, 0);
  const { dir: posted, answer: again } = board(t, { items: [{ ...ITEMS[0], comments: [{ id: 3, author: orch, body: markerFor(`refused@${'d'.repeat(16)}`) }] }, ITEMS[1]] });
  assert.equal(await publish(again({ result: JSON.stringify({ actions: [{ type: 'merge', number: 185 }] }) }), posted, { repo: 'o/r', fetch: gh.fetch, token: 'tok-SECRET' }), 0);
  assert.equal(gh.writes.length, 0);
});

test('the digest publish leaves is the board as the pass left it, so its own label moves wake no one', async (t) => {
  const { dir, answer } = board(t);
  const gh = fakeGitHub();
  await publish(answer({ result: JSON.stringify({ actions: [
    { type: 'remove_label', number: 185, label: 'working:claude' }, { type: 'add_label', number: 185, label: 'needs:chatgpt' },
  ] }) }), dir, { repo: 'o/r', fetch: gh.fetch, token: 'tok-SECRET' });
  const next = [ITEMS[0], { ...ITEMS[1], labels: ['needs:owner', 'needs:chatgpt'], timeline: [ev(orch, 'unlabeled', 'working:claude'), ev(orch, 'labeled', 'needs:chatgpt')] }];
  assert.equal(readFileSync(join(dir, 'digest'), 'utf8'), boardDigest(next, NOW), 'what the next snapshot will read');
});

test('the digest publish leaves judges the stall limit at the time the board was read, not later', async (t) => {
  const readAt = '2030-01-01T00:00:00.000Z';
  const claim = { number: 7, labels: ['working:claude'], comments: [], timeline: [ev(orch, 'labeled', 'working:claude')].map((e) => ({ ...e, created_at: '2029-12-30T20:00:00.000Z' })) };
  const { dir, answer } = board(t, { read_at: readAt, items: [ITEMS[0], claim] });
  await publish(answer({ result: '{"actions": []}' }), dir, { repo: 'o/r', fetch: fakeGitHub().fetch, token: 'tok-SECRET' });
  const written = readFileSync(join(dir, 'digest'), 'utf8');
  assert.deepEqual(staleClaims([claim], Date.parse(readAt)), ['7:working:claude']);
  assert.equal(written, boardDigest([ITEMS[0], claim], Date.parse(readAt)));
  assert.notEqual(written, boardDigest([ITEMS[0], claim], Date.now()), 'the clock of the run, not of the board, would miss it');
});

test('a claim the orchestrator adds starts now, as the next snapshot will read it, and is not stale', async (t) => {
  const { dir, answer } = board(t, { items: [ITEMS[0], { number: 7, labels: [], comments: [], timeline: [] }] });
  await publish(answer({ result: JSON.stringify({ actions: [{ type: 'add_label', number: 7, label: 'working:claude' }] }) }), dir, { repo: 'o/r', fetch: fakeGitHub().fetch, token: 'tok-SECRET' });
  const at = new Date(NOW).toISOString();
  const next = [ITEMS[0], { number: 7, labels: ['working:claude'], comments: [], timeline: [{ event: 'labeled', label: { name: 'working:claude' }, actor: orch, created_at: at }] }];
  assert.deepEqual(staleClaims(next, NOW), []);
  assert.equal(readFileSync(join(dir, 'digest'), 'utf8'), boardDigest(next, NOW));
});

test('the refusal note is a comment of its own, beside the orchestrator\'s handoff comment, under its own key', async (t) => {
  const { dir, answer } = board(t);
  const gh = fakeGitHub();
  const file = answer({ result: JSON.stringify({ actions: [comment(80, 'handoff@x', 'the state'), { type: 'merge', number: 185 }] }) });
  assert.equal(await publish(file, dir, { repo: 'o/r', fetch: gh.fetch, token: 't0k' }), 2);
  assert.deepEqual(gh.writes.map((c) => c.body.body.split('\n')[0]), ['the state', 'The runner refused 1 action(s) the orchestrator asked for:']);
  assert.match(gh.writes[1].body.body, new RegExp(markerFor(`refused@${'d'.repeat(16)}`)));
});

test('the last check stops a comment carrying a credential or a marker, whatever path built it', () => {
  assert.throws(() => lastCheck([comment(80, '80@a', 'x t0k')], ['t0k']), /failed the last check/);
  assert.throws(() => lastCheck([comment(80, '80@t0k', 'fine')], ['t0k']), /failed the last check/, 'the key goes out in the marker');
  assert.throws(() => lastCheck([{ type: 'add_label', number: 80, label: 'needs:t0k' }], ['t0k']), /failed the last check/, 'a label goes out too');
  assert.throws(() => lastCheck([comment(80, '80@a', markerFor('185@b'))], []), /failed the last check/);
  assert.doesNotThrow(() => lastCheck([comment(80, '80@a', 'fine'), { type: 'add_label', number: 80, label: 'needs:x' }], ['t0k']));
});

test('a credential in a comment\'s key is refused through the publisher, and is not posted in the marker', async (t) => {
  const { dir, answer } = board(t);
  const gh = fakeGitHub();
  const token = 'ghp_SECRETVALUE0123456789';
  const file = answer({ result: JSON.stringify({ actions: [comment(185, `185@${token}`, 'fine'), comment(80, 'handoff@x', `g-h-p-_-${[...'SECRETVALUE0123456789'].join(' ')}`)] }) });
  assert.equal(await publish(file, dir, { repo: 'o/r', fetch: gh.fetch, token }), 1);
  assert.equal(gh.writes.length, 1);
  assert.match(gh.writes[0].body.body, /^The runner refused 2 action\(s\)/);
  const sent = JSON.stringify(gh.writes.map((w) => [w.path, w.body]));
  assert.ok(!sent.includes(token) && !sent.includes('SECRETVALUE'), 'nothing of the credential reaches GitHub');
});

test('a pause the owner set while the model ran stops every write; one that cannot be read stops them too', async (t) => {
  const actions = { result: JSON.stringify({ actions: [comment(80, 'handoff@x'), { type: 'add_label', number: 185, label: 'needs:chatgpt' }] }) };
  const run = async (resolve) => {
    const { dir, answer } = board(t);
    const gh = fakeGitHub(resolve);
    const before = readFileSync(join(dir, 'board.json'), 'utf8');
    const out = await publish(answer(actions), dir, { repo: 'o/r', fetch: gh.fetch, token: 'tok-SECRET' }).catch((e) => e);
    return { out, gh, dir, before };
  };
  const paused = await run(handoffResolver([ev(owner)]));
  assert.equal(paused.out, null);
  assert.equal(paused.gh.writes.length, 0);
  assert.ok(!existsSync(join(paused.dir, 'digest')), 'a paused publish records no digest');
  const gone = await run((path, u) => (path === '/repos/o/r/issues' ? [] : handoffResolver()(path, u)));
  assert.equal(gone.out, null, 'no open handoff issue reads as paused');
  assert.equal(gone.gh.writes.length, 0);
  const unreadable = await run((path, u) => (path === '/repos/o/r/issues/80/timeline' ? undefined : handoffResolver()(path, u)));
  assert.match(String(unreadable.out), /timeline\S*: 404/);
  assert.equal(unreadable.gh.writes.length, 0);
  const twice = await run((path, u) => (path === '/repos/o/r/issues'
    ? (u.searchParams.get('page') === '1' ? [{ number: 300, labels: [{ name: 'handoff' }] }, { number: 80, labels: [{ name: 'handoff' }] }] : [])
    : path === '/repos/o/r/issues/300/timeline' ? [] : handoffResolver([ev(owner)])(path, u)));
  assert.equal(twice.out, null, 'a second handoff issue someone opened does not lift the owner\'s pause');
  assert.equal(twice.gh.writes.length, 0);
  const stranger = await run(handoffResolver([ev({ login: 'stranger', id: 42 })]));
  assert.equal(stranger.out, 2, 'a paused label nobody but a stranger set does not stop the crew');
  const resumed = await run(handoffResolver([ev(owner), ev(owner, 'unlabeled')]));
  assert.equal(resumed.out, 2, 'the owner\'s resume holds');
  const { dir, answer } = board(t);
  const idle = fakeGitHub(handoffResolver([ev(owner)]));
  assert.equal(await publish(answer({ result: '{"actions": []}' }), dir, { repo: 'o/r', fetch: idle.fetch, token: 'tok-SECRET' }), 0,
    'with nothing to write there is nothing to stop: the pass is recorded as any other');
  assert.equal(idle.calls.length, 0);
  assert.ok(existsSync(join(dir, 'digest')));
});

test('a pause that lands between two writes stops the rest, and the digest is not recorded', async (t) => {
  const { dir, answer } = board(t);
  let posted = 0;
  const gh = fakeGitHub((path, u) => handoffResolver(posted ? [ev(owner)] : [])(path, u));
  const fetch = async (url, init) => { const r = await gh.fetch(url, init); if (init?.method === 'POST') posted++; return r; };
  const file = answer({ result: JSON.stringify({ actions: [comment(80, 'handoff@x'), { type: 'add_label', number: 185, label: 'needs:chatgpt' }] }) });
  assert.equal(await publish(file, dir, { repo: 'o/r', fetch, token: 'tok-SECRET' }), null);
  assert.deepEqual(gh.writes.map((w) => w.path), ['/repos/o/r/issues/80/comments']);
  assert.ok(!existsSync(join(dir, 'digest')));
});

test('a label someone removed while the model ran counts as removed', async (t) => {
  const { dir, answer } = board(t);
  const gh = fakeGitHub((path, u) => (path.endsWith('/labels/working%3Aclaude') ? undefined : handoffResolver()(path, u)));
  const file = answer({ result: JSON.stringify({ actions: [{ type: 'remove_label', number: 185, label: 'working:claude' }, comment(80, 'handoff@x')] }) });
  assert.equal(await publish(file, dir, { repo: 'o/r', fetch: gh.fetch, token: 'tok-SECRET' }), 2);
  assert.deepEqual(gh.writes.map((w) => w.method), ['DELETE', 'POST']);
  const failing = fakeGitHub((path, u) => (path === '/repos/o/r/issues/80/comments' ? undefined : handoffResolver()(path, u)));
  const { dir: d2, answer: a2 } = board(t);
  await assert.rejects(publish(a2({ result: JSON.stringify({ actions: [comment(80, 'handoff@x')] }) }), d2, { repo: 'o/r', fetch: failing.fetch, token: 'tok-SECRET' }), /POST .*comments: 404/,
    'a 404 anywhere else still fails the pass');
});

test('a board with no reading time is refused, since the stall limit could not be judged', async (t) => {
  const { dir, answer } = board(t, { read_at: undefined });
  await assert.rejects(publish(answer({ result: '{"actions": []}' }), dir, { repo: 'o/r', fetch: fakeGitHub().fetch, token: 'tok-SECRET' }), /read_at/);
});

test('a missing, failed or unreadable answer throws, so the pass is not recorded as done', async (t) => {
  const { dir, answer } = board(t);
  const gh = fakeGitHub();
  for (const result of [
    { type: 'result', subtype: 'error_max_turns', is_error: true },
    { type: 'result', subtype: 'error_during_execution', is_error: true, result: '{"actions": []}' },
    {},
    { result: 'Here is my answer: {"actions": []} and more' },
    { result: '{"not_actions": []}' },
  ]) {
    await assert.rejects(publish(answer(result), dir, { repo: 'o/r', fetch: gh.fetch, token: 'tok-SECRET' }), /no answer|not a JSON object/, JSON.stringify(result));
  }
  assert.equal(gh.writes.length, 0);
});

test('snapshot follows every page and maps what the rules read: authors, timeline actors, head, checks, reviews', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'holdrim-snap-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const issue = (number, extra = {}) => ({ number, title: `#${number}`, body: '', user: owner, labels: [], assignees: [], ...extra });
  const page = (items) => (u) => (u.searchParams.get('page') === '1' ? items : []);
  const numbers = new Set([80, 187, ...Array.from({ length: 99 }, (_, n) => 1000 + n)]);
  const routes = {
    '/repos/o/r/issues': (u) => (u.searchParams.get('state') !== 'open' ? undefined : u.searchParams.get('page') === '1'
      ? [issue(80, { labels: [{ name: 'handoff' }] }), ...Array.from({ length: 99 }, (_, n) => issue(1000 + n))]
      : [issue(187, { pull_request: {}, user: orch })]),
    '/repos/o/r/issues/80/timeline': page([
      { event: 'labeled', label: { name: 'paused' }, actor: owner, created_at: 't' }, { event: 'commented' },
      { event: 'assigned', actor: owner, created_at: 't' }, { event: 'unassigned', actor: owner, created_at: 't' },
      { event: 'closed', actor: owner, created_at: 't' }, { event: 'reopened', actor: owner, created_at: 't' }, { event: 'cross-referenced' },
    ]),
    '/repos/o/r/issues/187/comments': page([{ id: 5, user: owner, created_at: 't', body: 'go' }]),
    '/repos/o/r/pulls/187/reviews': page([{ id: 70, user: reviewer, state: 'CHANGES_REQUESTED', commit_id: 'sha1', body: '' }]),
    '/repos/o/r/pulls/187/comments': page([
      { id: 71, user: reviewer, pull_request_review_id: 70, commit_id: 'sha1', path: 'a.js', line: 3, created_at: 't', body: 'MAJOR: wrong' },
      { id: 72, user: orch, pull_request_review_id: 70, in_reply_to_id: 71, commit_id: 'sha0', path: 'a.js', line: null, original_line: 7, created_at: 't', body: 'fixed' },
    ]),
    '/repos/o/r/pulls/187': () => ({ head: { sha: 'sha1' }, draft: true }),
    '/repos/o/r/commits/sha1/check-runs': () => ({ check_runs: [{ name: 'test', conclusion: 'failure', status: 'completed' }, { name: 'floor', conclusion: null, status: 'in_progress' }] }),
    '/repos/o/r/commits/sha1': () => ({ commit: { committer: { date: '2026-09-28T10:00:00Z' } } }),
    '/repos/o/r/labels': page([{ name: 'needs:owner' }]),
  };
  const gh = fakeGitHub((path, u) => {
    if (routes[path]) return routes[path](u);
    const m = /^\/repos\/o\/r\/issues\/(\d+)\/(comments|timeline)$/.exec(path);
    return m && numbers.has(Number(m[1])) ? page([])(u) : undefined;
  });
  assert.equal(await snapshot(dir, { repo: 'o/r', fetch: gh.fetch, token: 'tok-SECRET', now: NOW }), true, 'the owner paused it');
  const snap = JSON.parse(readFileSync(join(dir, 'board.json'), 'utf8'));
  assert.equal(snap.items.length, 101, 'the second page was read');
  const pr = snap.items.find((i) => i.number === 187);
  assert.deepEqual(pr.author, orch);
  assert.deepEqual(pr.comments, [{ id: 5, author: owner, created_at: 't', body: 'go' }]);
  assert.equal(pr.head, 'sha1');
  assert.equal(pr.head_date, '2026-09-28T10:00:00Z');
  assert.equal(pr.checks, 'floor=in_progress,test=failure');
  assert.deepEqual(pr.reviews, [{ id: 70, author: reviewer, state: 'CHANGES_REQUESTED', commit_id: 'sha1', body: '' }]);
  assert.deepEqual(pr.review_comments, [
    { id: 71, author: reviewer, review_id: 70, commit_id: 'sha1', path: 'a.js', line: 3, created_at: 't', body: 'MAJOR: wrong' },
    { id: 72, author: orch, review_id: 70, in_reply_to_id: 71, commit_id: 'sha0', path: 'a.js', line: 7, created_at: 't', body: 'fixed' },
  ], 'a finding left on a line reaches the model, with its author, review, commit and thread, even once the line is outdated');
  assert.equal(pr.draft, true);
  assert.deepEqual(snap.items.find((i) => i.number === 80).timeline.map((e) => e.event), ['labeled', 'assigned', 'unassigned', 'closed', 'reopened']);
  assert.deepEqual(snap.items.find((i) => i.number === 80).timeline[0], { event: 'labeled', label: { name: 'paused' }, actor: owner, created_at: 't' });
  assert.deepEqual(snap.labels, ['needs:owner']);
  assert.equal(readFileSync(join(dir, 'digest'), 'utf8'), snap.digest);
  assert.equal(snap.digest, boardDigest(snap.items, NOW));
  assert.ok(gh.calls.every((c) => c.method === 'GET' && c.auth === 'Bearer tok-SECRET'), 'a snapshot only reads, with the token it was given');
});

test('snapshot reads two open handoff issues as a pause, whichever GitHub lists first', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'holdrim-snap-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const first = (list) => (u) => (u.searchParams.get('page') === '1' ? list : []);
  const routes = {
    '/repos/o/r/issues': first([300, 80].map((number) => ({ number, title: '', body: '', user: owner, labels: [{ name: 'handoff' }], assignees: [] }))),
    '/repos/o/r/issues/300/comments': first([]), '/repos/o/r/issues/300/timeline': first([]),
    '/repos/o/r/issues/80/comments': first([]), '/repos/o/r/issues/80/timeline': first([]),
    '/repos/o/r/labels': first([]),
  };
  const gh = fakeGitHub((path, u) => routes[path]?.(u));
  assert.equal(await snapshot(dir, { repo: 'o/r', fetch: gh.fetch, token: 'tok-SECRET', now: NOW }), true);
});

test('run as a command, board.js reads REPO and the listed ids from its environment', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'holdrim-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // GitHub answers with nothing at all: no open item, so no handoff issue, and the pass stays idle.
  writeFileSync(join(dir, 'empty-github.mjs'), 'globalThis.fetch = async () => ({ ok: true, json: async () => [] });\n');
  const cli = (env) => spawnSync(process.execPath, ['--import', join(dir, 'empty-github.mjs'), join(ROOT, 'crew', 'runner', 'board.js'), 'snapshot', join(dir, 'board')],
    { encoding: 'utf8', env: { PATH: process.env.PATH, GH_TOKEN: 'tok-SECRET', ...env } });
  const listed = cli({ REPO: 'o/r', LISTED: `${ORCHESTRATOR_ID},333201923` });
  assert.equal(listed.status, 3, listed.stderr);
  assert.match(listed.stdout, /no open handoff issue: staying idle/);
  const snap = JSON.parse(readFileSync(join(dir, 'board', 'board.json'), 'utf8'));
  assert.deepEqual([snap.repo, snap.listed], ['o/r', [ORCHESTRATOR_ID, 333201923]]);
  assert.equal(cli({ REPO: 'o/r', LISTED: '' }).status, 3);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'board', 'board.json'), 'utf8')).listed, [], 'none listed reads as none, not as a stray 0');
  const norepo = cli({});
  assert.equal(norepo.status, 2);
  assert.match(norepo.stderr, /REPO is not set/);
  // With no open handoff issue, publish reads the crew as paused, and says so to the script by its
  // exit code alone.
  writeFileSync(join(dir, 'board', 'board.json'), JSON.stringify({ items: ITEMS, labels: KNOWN, digest: 'd'.repeat(64), read_at: new Date(NOW).toISOString() }));
  writeFileSync(join(dir, 'result.json'), JSON.stringify({ result: JSON.stringify({ actions: [comment(80, 'handoff@x')] }) }));
  const pub = spawnSync(process.execPath, ['--import', join(dir, 'empty-github.mjs'), join(ROOT, 'crew', 'runner', 'board.js'), 'publish', join(dir, 'result.json'), join(dir, 'board')],
    { encoding: 'utf8', env: { PATH: process.env.PATH, GH_TOKEN: 'tok-SECRET', REPO: 'o/r' } });
  assert.equal(pub.status, 3, pub.stderr);
  assert.equal(pub.stdout, '', 'no count, so the script cannot mistake it for a pass that published');
});

test('a board that lists no one counts no one\'s pull request toward a claim', async (t) => {
  const claim = { ...claimed(25), number: 7, comments: [] };
  const closer = { number: 9, labels: [], body: 'Closes #7', author: reviewer, head_date: new Date(NOW - 3600e3).toISOString(), comments: [], timeline: [] };
  const { dir, answer } = board(t, { items: [ITEMS[0], claim, closer] });
  await publish(answer({ result: '{"actions": []}' }), dir, { repo: 'o/r', fetch: fakeGitHub().fetch, token: 'tok-SECRET' });
  const written = readFileSync(join(dir, 'digest'), 'utf8');
  assert.equal(written, boardDigest([ITEMS[0], claim, closer], NOW, []));
  assert.notEqual(written, boardDigest([ITEMS[0], claim, closer], NOW, [reviewer.id]), 'with the author listed, the claim would not be stale');
});

test('a refusal-note marker a stranger wrote does not stop the note', async (t) => {
  const forged = { ...ITEMS[0], comments: [{ id: 4, author: { login: 'stranger', id: 42 }, body: markerFor(`refused@${'d'.repeat(16)}`) }] };
  const { dir, answer } = board(t, { items: [forged, ITEMS[1]] });
  const gh = fakeGitHub();
  assert.equal(await publish(answer({ result: JSON.stringify({ actions: [{ type: 'merge', number: 185 }] }) }), dir, { repo: 'o/r', fetch: gh.fetch, token: 'tok-SECRET' }), 1);
  assert.match(gh.writes[0].body.body, /The runner refused 1 action/);
});

/**
 * Runs run-orchestrator.sh in a throwaway folder, next to a stub board.js whose snapshot exits
 * with `snap` and writes `digest`, and whose publish prints `published` or fails. `setpriv` logs
 * the user it was asked for and runs the command; `claude` logs its environment and answers.
 */
const ACCOUNTS = `| Account | Numeric id | Who | Role |\n|---|---|---|---|\n| @orchestrator | ${ORCHESTRATOR_ID} | machine | orchestrator |\n| @reviewer2 | 333201923 | machine | reviewer |\n`;

function pass(t, { snap = 0, digest = 'new', cached = null, published = '0 applied', publishExit = 0, accounts = ACCOUNTS, id = String(ORCHESTRATOR_ID), env = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'holdrim-runner-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, 'bin');
  const work = join(dir, 'work');
  const state = join(dir, 'state');
  mkdirSync(bin); mkdirSync(state);
  copyFileSync(SCRIPT, join(dir, 'run-orchestrator.sh'));
  const log = join(dir, 'calls.log');
  writeFileSync(log, '');
  if (cached !== null) writeFileSync(join(state, 'board-digest'), cached);
  stub(bin, 'setpriv', `echo "setpriv $1" >> '${log}'; echo "argv $*" >> '${log}'; while [ "\${1#--}" != "$1" ]; do shift; done; exec "$@"`);
  stub(bin, 'gh', `echo "gh $*" >> '${log}'; [ "$1 $2" = "api user" ] && echo ${id}`);
  writeFileSync(join(dir, 'accounts.md'), accounts);
  stub(bin, 'git', `echo "git $*" >> '${log}'; mkdir -p "$4/crew"; cp '${join(dir, 'accounts.md')}' "$4/crew/accounts.md"`);
  stub(bin, 'claude', `echo "claude GH_TOKEN=\${GH_TOKEN:-none} CLAUDE=\${CLAUDE_CODE_OAUTH_TOKEN:-none} HOME=$HOME" >> '${log}'; echo '{"result":"{\\"actions\\":[]}"}'`);
  writeFileSync(join(dir, 'board.js'), [
    `const [cmd, , out] = process.argv.slice(2);`,
    `require('fs').appendFileSync('${log}', 'board ' + cmd + '\\n');`,
    `if (cmd === 'snapshot') { require('fs').mkdirSync(process.argv[3], { recursive: true }); require('fs').writeFileSync(process.argv[3] + '/digest', '${digest}'); process.exit(${snap}); }`,
    published === null ? `process.exit(1);` : `console.log('${published}'); process.exit(${publishExit});`,
  ].join('\n'));
  writeFileSync(join(dir, 'package.json'), '{"type":"commonjs"}');
  const r = spawnSync('bash', [join(dir, 'run-orchestrator.sh')], {
    encoding: 'utf8',
    env: { PATH: `${bin}:${process.env.PATH}`, WORK_DIR: work, STATE_DIR: state, GH_TOKEN: 'gh-secret', CLAUDE_CODE_OAUTH_TOKEN: 'cl-secret', ...env },
  });
  const calls = readFileSync(log, 'utf8');
  const recorded = existsSync(join(state, 'board-digest')) ? readFileSync(join(state, 'board-digest'), 'utf8') : null;
  return { status: r.status, out: r.stdout + r.stderr, calls, recorded };
}

test('a changed board runs the model as its own user, with the Claude token and not the GitHub one', (t) => {
  const r = pass(t, { cached: 'old' });
  assert.equal(r.status, 0, r.out);
  assert.match(r.calls, /setpriv --reuid=model\nargv --reuid=model --regid=model --init-groups --no-new-privs env -i [\s\S]*?\nclaude GH_TOKEN=none CLAUDE=cl-secret HOME=\/home\/model/);
  assert.doesNotMatch(r.calls.replace(/^claude GH_TOKEN=.*$/m, ''), /cl-secret|gh-secret/, 'no token is ever an argument, where any process could read it');
  const start = r.calls.indexOf('setpriv --reuid=model');
  const modelStep = r.calls.slice(start, r.calls.indexOf('setpriv --reuid=crew', start));
  assert.doesNotMatch(modelStep, /^(gh|git|board) /m, 'nothing but the model runs as model');
  assert.match(r.calls, /setpriv --reuid=crew\nargv [^\n]*board\.js snapshot[^\n]*\nboard snapshot/);
  assert.match(r.calls, /setpriv --reuid=crew\nargv [^\n]*board\.js publish[^\n]*\nboard publish/);
  assert.equal(r.recorded, 'new', 'a pass that answered records the digest');
});

test('the proxy the host needs reaches the model, and nothing reaches it when there is none', (t) => {
  const withProxy = pass(t, { env: { HTTPS_PROXY: 'http://proxy:3128', NO_PROXY: 'localhost', NODE_EXTRA_CA_CERTS: '/etc/ca.pem' } });
  assert.equal(withProxy.status, 0, withProxy.out);
  assert.match(withProxy.calls, /argv --reuid=model [^\n]* HTTPS_PROXY=http:\/\/proxy:3128 NO_PROXY=localhost NODE_EXTRA_CA_CERTS=\/etc\/ca\.pem bash -c/);
  const without = pass(t);
  assert.match(without.calls, /argv --reuid=model [^\n]*PATH=[^ ]* bash -c/, 'no empty argument where no proxy was set');
});

test('the crew steps are told which accounts crew/accounts.md lists: the id column of every row', (t) => {
  const r = pass(t);
  assert.match(r.calls, new RegExp(`argv --reuid=crew [^\\n]*LISTED=${ORCHESTRATOR_ID},333201923 node [^\\n]*board\\.js snapshot`),
    'both rows, and not the digit in a login');
  const bare = pass(t, { accounts: ACCOUNTS.replace('| @orchestrator |', '| orchestrator |') });
  assert.equal(bare.status, 1);
  assert.match(bare.out, /not listed in crew\/accounts.md: not starting/, 'a row the list does not read is not listed, and says so');
});

test('a proxy URL carrying credentials, with a scheme or without, stops the pass before anything runs', (t) => {
  for (const [v, url] of [['HTTPS_PROXY', 'http://user:pw@proxy:3128'], ['HTTPS_PROXY', 'user:pw@proxy:3128'], ['HTTP_PROXY', 'http://TOKEN@proxy']]) {
    const r = pass(t, { env: { [v]: url } });
    assert.equal(r.status, 1, url);
    assert.match(r.out, new RegExp(`${v} carries credentials`), url);
    assert.equal(r.calls, '', `${url}: nothing ran`);
  }
  const ok = pass(t, { env: { HTTPS_PROXY: 'http://proxy:3128', NODE_EXTRA_CA_CERTS: '/certs/ops@corp/ca.pem', NO_PROXY: 'svc@x' } });
  assert.equal(ok.status, 0, 'an @ in a certificate path or NO_PROXY is not a credential');
});

test('an unchanged board calls no model and publishes nothing', (t) => {
  const r = pass(t, { cached: 'same', digest: 'same' });
  assert.equal(r.status, 0);
  assert.match(r.out, /no change since the last pass/);
  assert.doesNotMatch(r.calls, /claude|board publish/);
});

test('a pass the owner paused, or one that cannot read the board, calls no model', (t) => {
  const paused = pass(t, { snap: 3 });
  assert.equal(paused.status, 0);
  assert.match(paused.out, /paused by the owner/);
  assert.doesNotMatch(paused.calls, /claude/);
  const unread = pass(t, { snap: 1 });
  assert.equal(unread.status, 1);
  assert.match(unread.out, /could not read the board/);
  assert.doesNotMatch(unread.calls, /claude/);
});

test('a pass the owner paused while the model ran publishes nothing and records no digest, and says so', (t) => {
  const r = pass(t, { cached: 'old', publishExit: 3 });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /paused while the model ran, or the pause could not be read: nothing more published/);
  assert.equal(r.recorded, 'old', 'the digest of a pass that published nothing is not recorded');
});

test('a pass whose answer could not be published does not record the digest', (t) => {
  const r = pass(t, { published: null });
  assert.notEqual(r.status, 0);
  assert.equal(r.recorded, null);
});

test('the pass refuses any account but the orchestrator, and one crew/accounts.md no longer lists', (t) => {
  const other = pass(t, { id: String(OWNER_ID) });
  assert.equal(other.status, 1);
  assert.match(other.out, /not the orchestrator's: not starting/);
  assert.doesNotMatch(other.calls, /git clone|claude/);
  const unlisted = pass(t, { accounts: ACCOUNTS.replace(`| @orchestrator | ${ORCHESTRATOR_ID} |`, '| @orchestrator | 1 |') });
  assert.equal(unlisted.status, 1);
  assert.match(unlisted.out, /not listed in crew\/accounts.md: not starting/);
  assert.doesNotMatch(unlisted.calls, /board snapshot|claude/);
});

test('the model runs with file tools only, confined, and with no MCP server', () => {
  const text = readFileSync(SCRIPT, 'utf8');
  const model = text.slice(text.indexOf('--reuid=model'));
  assert.match(model, /--tools "Read,Grep,Glob" --restricted --strict-mcp-config/);
  assert.doesNotMatch(model, /--allowedTools|Bash\(/);
});
