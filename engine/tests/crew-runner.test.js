/**
 * The orchestrator's runner keeps the model away from every credential, and board.js is what
 * holds the line between what the model asks for and what reaches GitHub.
 *
 * Nothing else runs this code before a real pass does, and a real pass that gets it wrong writes
 * to the repository under the orchestrator's name. So the rules board.js enforces, and the flags
 * run-orchestrator.sh starts the model with, are checked here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { boardDigest, markerFor, parseAnswer, pauseState, vetActions, OWNER_ID } from '../../crew/runner/board.js';

const ROOT = new URL('../../', import.meta.url).pathname;
const SCRIPT = readFileSync(`${ROOT}crew/runner/run-orchestrator.sh`, 'utf8');

const ITEMS = [
  { number: 80, labels: ['handoff'], updated_at: '2026-09-28T00:00:00Z', comments: [] },
  { number: 185, labels: ['needs:owner'], updated_at: '2026-09-28T01:00:00Z', head: 'abc', checks: 'test=success', comments: [{ body: `done\n\n${markerFor('185@abc')}` }] },
];
const comment = (number, key, body = 'the state') => ({ type: 'comment', number, key, body });
const reasons = (answer, secrets) => vetActions(answer, ITEMS, secrets).refused.map((r) => r.reason);

test('a comment and a queue label on an open item go through', () => {
  const { accepted, refused } = vetActions({ actions: [
    comment(80, '80@c1'),
    { type: 'add_label', number: 185, label: 'needs:chatgpt' },
    { type: 'remove_label', number: 185, label: 'working:claude' },
  ] }, ITEMS);
  assert.equal(accepted.length, 3);
  assert.deepEqual(refused, []);
});

test('only open items on the board can be written to', () => {
  assert.deepEqual(reasons({ actions: [comment(999, '999@x')] }), ['not an open item on the board']);
});

test('only the owner removes needs:owner', () => {
  assert.deepEqual(reasons({ actions: [{ type: 'remove_label', number: 185, label: 'needs:owner' }] }),
    ['only the owner removes needs:owner']);
});

test('only needs: and working: labels: never paused, never an arbitrary one', () => {
  for (const label of ['paused', 'handoff', 'kind:security', 'needs:Owner', 'needs: owner']) {
    assert.deepEqual(reasons({ actions: [{ type: 'add_label', number: 80, label }] }), ['only needs: and working: labels'], label);
  }
});

test('a key already posted on the item is not posted again', () => {
  assert.deepEqual(reasons({ actions: [comment(185, '185@abc')] }), ['already posted under this key']);
  assert.equal(vetActions({ actions: [comment(185, '185@def')] }, ITEMS).accepted.length, 1, 'a new head is a new key');
});

test('one comment per item per pass', () => {
  const { accepted, refused } = vetActions({ actions: [comment(80, '80@a'), comment(80, '80@b')] }, ITEMS);
  assert.equal(accepted.length, 1);
  assert.deepEqual(refused.map((r) => r.reason), ['one comment per item per pass']);
});

test('a comment carrying a credential is refused, whatever the model was told', () => {
  assert.deepEqual(reasons({ actions: [comment(80, '80@a', 'here: ghp_SECRETVALUE')] }, ['ghp_SECRETVALUE']),
    ['the body carries a credential']);
});

test('a comment needs a key and a bounded body', () => {
  assert.deepEqual(reasons({ actions: [comment(80, 'no spaces allowed')] }), ['a comment needs a key naming the item and what it answers']);
  assert.deepEqual(reasons({ actions: [comment(80, '80@a', ' ')] }), ['a comment needs a body of at most 20000 characters']);
  assert.deepEqual(reasons({ actions: [comment(80, '80@a', 'x'.repeat(20001))] }), ['a comment needs a body of at most 20000 characters']);
});

test('an answer that is not a list of actions, or too long a list, applies nothing', () => {
  assert.equal(vetActions(null, ITEMS).accepted.length, 0);
  assert.equal(vetActions({ actions: 'all of them' }, ITEMS).accepted.length, 0);
  const many = Array.from({ length: 21 }, (_, n) => ({ type: 'add_label', number: 80, label: `needs:a${n}` }));
  assert.deepEqual(vetActions({ actions: many }, ITEMS), { accepted: [], refused: [{ action: null, reason: 'more than 20 actions in one pass' }] });
});

test('an unknown action type is refused', () => {
  assert.deepEqual(reasons({ actions: [{ type: 'merge', number: 185 }] }), ['unknown action type "merge"']);
});

test('the answer is read from bare JSON or from a fenced block, and anything else reads as nothing', () => {
  assert.deepEqual(parseAnswer('{"actions": []}'), { actions: [] });
  assert.deepEqual(parseAnswer('Here it is:\n```json\n{"actions": []}\n```'), { actions: [] });
  assert.equal(parseAnswer('I will now merge #185.'), null);
});

const labeled = (id, event = 'labeled') => ({ event, label: { name: 'paused' }, actor: { id, login: `u${id}` } });

test('paused counts only when the owner applied it last', () => {
  assert.deepEqual(pauseState(['handoff'], []), { paused: false });
  assert.deepEqual(pauseState(['handoff', 'paused'], [labeled(OWNER_ID)]), { paused: true });
  assert.deepEqual(pauseState(['handoff', 'paused'], [labeled(OWNER_ID), labeled(333497607, 'unlabeled'), labeled(333497607)]),
    { paused: false, ignored: 'u333497607' });
});

test('a paused label whose author the timeline does not show keeps the crew idle', () => {
  assert.deepEqual(pauseState(['handoff', 'paused'], []), { paused: true });
});

test('the board digest changes with any update, head or check, and not with the order it was read in', () => {
  const base = boardDigest(ITEMS);
  assert.equal(boardDigest([...ITEMS].reverse()), base);
  assert.notEqual(boardDigest([ITEMS[0], { ...ITEMS[1], updated_at: '2026-09-28T02:00:00Z' }]), base);
  assert.notEqual(boardDigest([ITEMS[0], { ...ITEMS[1], head: 'def' }]), base);
  assert.notEqual(boardDigest([ITEMS[0], { ...ITEMS[1], checks: 'test=failure' }]), base);
});

test('the model runs with file tools only, no MCP, and no GitHub token in its environment', () => {
  const model = SCRIPT.slice(SCRIPT.indexOf('claude -p'));
  assert.match(SCRIPT, /env -u GH_TOKEN -u GITHUB_TOKEN claude -p/);
  assert.match(model, /--tools "Read,Grep,Glob"/);
  assert.match(model, /--restricted/);
  assert.match(model, /--strict-mcp-config/);
  assert.doesNotMatch(model, /--allowedTools|Bash\(/);
});

test('the pass stops when the owner paused it or the board cannot be read', () => {
  assert.match(SCRIPT, /if \[ "\$code" = 3 \]; then echo "paused by the owner: nothing done"; exit 0; fi/);
  assert.match(SCRIPT, /\[ "\$code" = 0 \] \|\| \{ echo "could not read the board: not starting"; exit 1; \}/);
});
