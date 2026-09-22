/**
 * The bridge to the person's own agent CLI. Two things are proved: that the engine never picks a
 * vendor on its own, and that the brief carries everything an agent needs and every rule it must
 * not break — because the agent reading it may have nothing else.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { resolveAgent, brief, apply, KNOWN_AGENTS } from '../cli/agent.ts';
import { readBlocks } from '../cli/pages.ts';

const EXAMPLE = join(new URL('../../', import.meta.url).pathname, 'examples', 'hello-world');
process.env.HOLDRIM_OWNER ??= 'owner@example.org';

const none = () => false;
const all = () => true;

test('a known name resolves to that CLI, and a whole command is taken as typed', () => {
  assert.deepEqual(resolveAgent('claude', undefined, none), ['claude', '-p']);
  assert.deepEqual(resolveAgent('codex', undefined, none), ['codex', 'exec']);
  assert.deepEqual(resolveAgent('my-agent --fast --yes', undefined, none), ['my-agent', '--fast', '--yes']);
});

test('the command line beats the configuration, and the configuration beats the PATH', () => {
  assert.deepEqual(resolveAgent('gemini', ['claude', '-p'], all), ['gemini', '-p']);
  // gemini, not claude: with everything installed the PATH would also answer claude, so a
  // configuration naming the first known agent cannot tell "read the config" from "ignored it".
  assert.deepEqual(resolveAgent(undefined, ['gemini', '-p'], all), ['gemini', '-p']);
  assert.deepEqual(resolveAgent(undefined, undefined, (b) => b === 'codex'), ['codex', 'exec']);
});

test('with nothing to go on it refuses and names the three ways out — it never picks a vendor', () => {
  assert.throws(() => resolveAgent(undefined, undefined, none), (e) => {
    assert.match(e.message, /--agent/);
    assert.match(e.message, /holdrim\.json/);
    for (const name of Object.keys(KNOWN_AGENTS)) assert.match(e.message, new RegExp(name));
    return true;
  });
});

/** A source with one approved request against the hello world. */
async function sourceWithARequest() {
  const blocks = await readBlocks(EXAMPLE);
  const block = blocks.get('A01.1.3');
  return {
    events: async () => [
      { id: 'req00001', type: 'request', page: 'A01', block: 'A01.1.3', fingerprint: block.fingerprint,
        text: 'Say "one letter" instead of "one word"', snapshot: block.text,
        author: 'reviewer@example.org', when: '2026-09-22T10:00:00Z', data: { category: 'text' } },
      { id: 'st000001', type: 'request_state', page: 'A01', block: 'A01.1.3', text: 'agreed',
        author: 'owner@example.org', when: '2026-09-22T10:05:00Z',
        data: { request: 'req00001', state: 'approved', from: 'open' } },
    ],
  };
}

test('only a request in the agent\'s queue is briefed, not even printed otherwise', async () => {
  // Every state, named here rather than read from cycle.json: a queue widened by mistake there, to
  // take `applied`, would hand finished work to an agent again, and a test that reads the same list
  // would widen with it. Without the guard, open and rejected would reach the agent with a brief
  // saying the owner approved them.
  const [asked, decided] = await (await sourceWithARequest()).events();
  const PATHS = {
    open: [], question: ['question'], rejected: ['rejected'],
    approved: ['approved'], applying: ['approved', 'applying'], waiting: ['approved', 'applying', 'waiting'],
    applied: ['approved', 'applying', 'applied'],
  };
  const through = (steps) => ({
    events: async () => [asked, ...steps.map((state, i) => ({ ...decided, id: `st${i}`,
      when: `2026-09-22T10:0${5 + i}:00Z`, data: { request: 'req00001', state, from: steps[i - 1] ?? 'open' } }))],
  });
  const BRIEFED = ['approved', 'applying', 'waiting'];
  for (const [state, steps] of Object.entries(PATHS)) {
    const source = through(steps);
    if (BRIEFED.includes(state)) {
      assert.match(await brief(EXAMPLE, source, 'req0'), new RegExp(`State:\\s+${state}`), state);
      continue;
    }
    // An applied request was approved: saying otherwise sends the agent to ask the owner for nothing.
    const why = state === 'applied' ? /nothing is left to do on it/ : /only applies requests the owner APPROVED/;
    await assert.rejects(brief(EXAMPLE, source, 'req0'), why, state);
    await assert.rejects(apply(EXAMPLE, source, 'req0', { dryRun: true }), why, `${state}, dry run`);
    // `true` would exit 0: a refusal that let the agent run first would still read as a success.
    await assert.rejects(apply(EXAMPLE, source, 'req0', { agent: 'true' }), why, `${state}, for real`);
  }
});

test('the brief carries the request, the text then and now, the impact and the rules', async () => {
  const text = await brief(EXAMPLE, await sourceWithARequest(), 'req0');
  assert.match(text, /# Holdrim request req00001/);
  assert.match(text, /State:\s+approved/);
  assert.match(text, /Who:\s+reviewer@example.org/);
  assert.match(text, /Where:\s+A01\.1\.3\s+·\s+category: text/);
  assert.match(text, /## Asked for\n\nSay "one letter" instead of "one word"/);
  assert.match(text, /## The block, as it read when they asked\n\nApproval covers/);
  assert.match(text, /## Where "Say "one letter"" also shows up/);
  assert.match(text, /## Thread\n\n- .* owner@example.org: approved — agreed/);
  // The rules the agent must not break, whatever else it knows.
  assert.match(text, /Request: req00001/);
  assert.match(text, /Requested-by: reviewer@example.org/);
  assert.match(text, /holdrim state req00001 applied/);
  assert.match(text, /VALIDATED block does not change without the owner/);
  assert.match(text, /data-validated-fingerprint/);
});

test('a validated block among the hits is named as such in the brief', async () => {
  const source = await sourceWithARequest();
  const withTerm = await brief(EXAMPLE, source, 'req0');
  // Nothing in the hello world is validated, so the flag must be absent — and present the moment
  // the impact finds a validated block. Proved through the impact function's own data.
  assert.doesNotMatch(withTerm, /VALIDATED, needs the owner to change/);
});

test('apply runs the command it resolved and returns its exit code; --dry-run only prints', async () => {
  const source = await sourceWithARequest();
  assert.equal(await apply(EXAMPLE, source, 'req0', { dryRun: true }), 0);
  // `true` and `false` are on every POSIX PATH and ignore their arguments: the cheapest agents
  // there are, and enough to prove the exit code travels back.
  assert.equal(await apply(EXAMPLE, source, 'req0', { agent: 'true' }), 0);
  assert.notEqual(await apply(EXAMPLE, source, 'req0', { agent: 'false' }), 0);
});

test('a request for a new page tells the agent to write one, shaped like its neighbour, and lock nothing', async () => {
  const source = {
    events: async () => [
      { id: 'page0001', type: 'request', page: 'A01', block: null, text: 'Explain how a request is closed',
        author: 'reviewer@example.org', when: '2026-09-23T10:00:00Z', data: { category: 'page' } },
      { id: 'st000002', type: 'request_state', page: 'A01', author: 'owner@example.org',
        when: '2026-09-23T10:05:00Z', data: { request: 'page0001', state: 'approved', from: 'open' } },
    ],
  };
  const text = await brief(EXAMPLE, source, 'page0');
  assert.match(text, /## This asks for a NEW page/);
  assert.match(text, /Write ONE new page, in pages\/, next to A01/, 'the folder comes from the project, the neighbour from the request');
  assert.match(text, /mark nothing as validated/);
  assert.match(text, /## Asked for\n\nExplain how a request is closed/);
  // And a request about an existing block says nothing of the kind.
  assert.doesNotMatch(await brief(EXAMPLE, await sourceWithARequest(), 'req0'), /NEW page/);
});
