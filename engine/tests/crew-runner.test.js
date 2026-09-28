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
  boardDigest, markerFor, parseAnswer, pauseState, publish, snapshot, staleClaims, vetActions,
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

test('a comment carrying a credential is refused, whatever the model was told', () => {
  assert.deepEqual(reasons([comment(80, '80@a', 'here: ghp_SECRETVALUE')], { secrets: ['ghp_SECRETVALUE'] }), ['the body carries a credential']);
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
  assert.deepEqual(reasons([{ type: 'merge', number: 185 }]), ['unknown action type "merge"']);
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
  const pr = (body, hoursAgo) => ({ number: 9, labels: [], body, head_date: new Date(NOW - hoursAgo * 3600e3).toISOString(), timeline: [] });
  assert.deepEqual(staleClaims([issue, pr('Closes #7', 1)], NOW), []);
  assert.deepEqual(staleClaims([issue, pr('Closes #7', 30)], NOW), ['7:working:claude'], 'an old push does not restart it');
  assert.deepEqual(staleClaims([issue, pr('Closes #70', 1)], NOW), ['7:working:claude'], 'another issue\'s pull request does not count');
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

test('the digest changes when a claim crosses the stall limit, with nothing written', () => {
  const items = [claimed(23.5)];
  assert.notEqual(boardDigest(items, NOW + 3600e3), boardDigest(items, NOW));
});

/**
 * A stand-in for GitHub's API. `resolve(pathname, url)` answers a request, and a path it does not
 * know gets a 404, the way GitHub answers one: matched exactly, so a request built with a wrong
 * number or a stray suffix fails here as it would there. Every request is recorded.
 */
function fakeGitHub(resolve = () => ({})) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    calls.push({ method: init.method ?? 'GET', path: u.pathname + u.search, body: init.body && JSON.parse(init.body), auth: init.headers?.authorization });
    const value = resolve(u.pathname, u);
    return value === undefined ? { ok: false, status: 404, json: async () => ({}) } : { ok: true, status: 200, json: async () => value };
  };
  return { fetch, calls };
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
  assert.deepEqual(gh.calls.map((c) => [c.method, c.path, c.body]), [
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
  assert.equal(gh.calls.length, 1);
  assert.equal(gh.calls[0].path, '/repos/o/r/issues/80/comments');
  assert.match(gh.calls[0].body.body, /refused 2 action\(s\)[\s\S]*comment on #185: the body carries a credential[\s\S]*remove_label on #185: only the owner removes needs:owner/);
  assert.match(gh.calls[0].body.body, new RegExp(markerFor(`refused@${'d'.repeat(16)}`)));
  assert.ok(!gh.calls[0].body.body.includes('t0k'), 'the credential a comment was refused for is not posted in the note');
});

test('the refusal note repeats nothing the refused action wrote: no mention, marker or markdown gets out', async (t) => {
  const { dir, answer } = board(t);
  const gh = fakeGitHub();
  const evil = `needs:x\` @someone ${markerFor('handoff@next')}`;
  const file = answer({ result: JSON.stringify({ actions: [{ type: 'add_label', number: 185, label: evil }, { type: `x\` @someone`, number: '185 @a' }] }) });
  await publish(file, dir, { repo: 'o/r', fetch: gh.fetch, token: 't' });
  const body = gh.calls[0].body.body.replace(markerFor(`refused@${'d'.repeat(16)}`), '');
  assert.doesNotMatch(body, /@someone|holdrim-key|`/);
  assert.match(body, /- add_label on #185: only needs: and working: labels\n- an action: not an open item on the board/);
});

test('asking for what is already so is left out of the note, and the same note is not posted twice', async (t) => {
  const { dir, answer } = board(t);
  const gh = fakeGitHub();
  const already = answer({ result: JSON.stringify({ actions: [comment(185, '185@abc'), { type: 'add_label', number: 185, label: 'working:claude' }] }) });
  assert.equal(await publish(already, dir, { repo: 'o/r', fetch: gh.fetch, token: 't' }), 0);
  assert.equal(gh.calls.length, 0);
  const { dir: posted, answer: again } = board(t, { items: [{ ...ITEMS[0], comments: [{ id: 3, author: orch, body: markerFor(`refused@${'d'.repeat(16)}`) }] }, ITEMS[1]] });
  assert.equal(await publish(again({ result: JSON.stringify({ actions: [{ type: 'merge', number: 185 }] }) }), posted, { repo: 'o/r', fetch: gh.fetch, token: 't' }), 0);
  assert.equal(gh.calls.length, 0);
});

test('the digest publish leaves is the board as the pass left it, so its own label moves wake no one', async (t) => {
  const { dir, answer } = board(t);
  const gh = fakeGitHub();
  await publish(answer({ result: JSON.stringify({ actions: [
    { type: 'remove_label', number: 185, label: 'working:claude' }, { type: 'add_label', number: 185, label: 'needs:chatgpt' },
  ] }) }), dir, { repo: 'o/r', fetch: gh.fetch, token: 't' });
  const next = [ITEMS[0], { ...ITEMS[1], labels: ['needs:owner', 'needs:chatgpt'], timeline: [ev(orch, 'unlabeled', 'working:claude'), ev(orch, 'labeled', 'needs:chatgpt')] }];
  assert.equal(readFileSync(join(dir, 'digest'), 'utf8'), boardDigest(next, NOW), 'what the next snapshot will read');
});

test('publish folds the refusals into the orchestrator\'s own handoff comment when it wrote one', async (t) => {
  const { dir, answer } = board(t);
  const gh = fakeGitHub();
  const file = answer({ result: JSON.stringify({ actions: [comment(80, 'handoff@x', 'the state'), { type: 'merge', number: 185 }] }) });
  await publish(file, dir, { repo: 'o/r', fetch: gh.fetch, token: 't0k' });
  assert.equal(gh.calls.length, 1);
  assert.match(gh.calls[0].body.body, /^the state\n\nThe runner refused 1 action/);
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
    await assert.rejects(publish(answer(result), dir, { repo: 'o/r', fetch: gh.fetch, token: 't' }), JSON.stringify(result));
  }
  assert.equal(gh.calls.length, 0);
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
    '/repos/o/r/issues/80/timeline': page([{ event: 'labeled', label: { name: 'paused' }, actor: owner, created_at: 't' }, { event: 'commented' }]),
    '/repos/o/r/issues/187/comments': page([{ id: 5, user: owner, created_at: 't', body: 'go' }]),
    '/repos/o/r/pulls/187/reviews': page([{ user: reviewer, state: 'CHANGES_REQUESTED', commit_id: 'sha1', body: 'x' }]),
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
  assert.equal(await snapshot(dir, { repo: 'o/r', fetch: gh.fetch, token: 't', now: NOW }), true, 'the owner paused it');
  const snap = JSON.parse(readFileSync(join(dir, 'board.json'), 'utf8'));
  assert.equal(snap.items.length, 101, 'the second page was read');
  const pr = snap.items.find((i) => i.number === 187);
  assert.deepEqual(pr.author, orch);
  assert.deepEqual(pr.comments, [{ id: 5, author: owner, created_at: 't', body: 'go' }]);
  assert.equal(pr.head, 'sha1');
  assert.equal(pr.head_date, '2026-09-28T10:00:00Z');
  assert.equal(pr.checks, 'floor=in_progress,test=failure');
  assert.deepEqual(pr.reviews, [{ author: reviewer, state: 'CHANGES_REQUESTED', commit_id: 'sha1', body: 'x' }]);
  assert.deepEqual(snap.items.find((i) => i.number === 80).timeline, [{ event: 'labeled', label: { name: 'paused' }, actor: owner, created_at: 't' }]);
  assert.deepEqual(snap.labels, ['needs:owner']);
  assert.equal(readFileSync(join(dir, 'digest'), 'utf8'), snap.digest);
  assert.equal(snap.digest, boardDigest(snap.items, NOW));
  assert.ok(gh.calls.every((c) => c.method === 'GET' && c.auth === 'Bearer t'), 'a snapshot only reads, with the token it was given');
});

/**
 * Runs run-orchestrator.sh in a throwaway folder, next to a stub board.js whose snapshot exits
 * with `snap` and writes `digest`, and whose publish prints `published` or fails. `setpriv` logs
 * the user it was asked for and runs the command; `claude` logs its environment and answers.
 */
function pass(t, { snap = 0, digest = 'new', cached = null, published = '0 applied', listed = true, id = String(ORCHESTRATOR_ID) } = {}) {
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
  stub(bin, 'git', `echo "git $*" >> '${log}'; mkdir -p "$4/crew"; echo '${listed ? `| @orchestrator | ${ORCHESTRATOR_ID} |` : ''}' > "$4/crew/accounts.md"`);
  stub(bin, 'claude', `echo "claude GH_TOKEN=\${GH_TOKEN:-none} CLAUDE=\${CLAUDE_CODE_OAUTH_TOKEN:-none} HOME=$HOME" >> '${log}'; echo '{"result":"{\\"actions\\":[]}"}'`);
  writeFileSync(join(dir, 'board.js'), [
    `const [cmd, , out] = process.argv.slice(2);`,
    `require('fs').appendFileSync('${log}', 'board ' + cmd + '\\n');`,
    `if (cmd === 'snapshot') { require('fs').mkdirSync(process.argv[3], { recursive: true }); require('fs').writeFileSync(process.argv[3] + '/digest', '${digest}'); process.exit(${snap}); }`,
    published === null ? `process.exit(1);` : `console.log('${published}');`,
  ].join('\n'));
  writeFileSync(join(dir, 'package.json'), '{"type":"commonjs"}');
  const r = spawnSync('bash', [join(dir, 'run-orchestrator.sh')], {
    encoding: 'utf8',
    env: { PATH: `${bin}:${process.env.PATH}`, WORK_DIR: work, STATE_DIR: state, GH_TOKEN: 'gh-secret', CLAUDE_CODE_OAUTH_TOKEN: 'cl-secret' },
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
  const unlisted = pass(t, { listed: false });
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
