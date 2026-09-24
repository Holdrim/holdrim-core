/**
 * The CI workflows hold the line they are supposed to hold.
 *
 * A workflow is code that runs with this repository checked out and a token in hand, and nothing
 * else in the suite reads it. So the three rules that keep it from becoming the way in are checked
 * here, where a pull request that quietly loosens one of them turns a test red instead of turning
 * nothing at all:
 *   - every action is pinned to a commit, because a tag can be moved under us;
 *   - every checkout drops the token, because nothing here pushes;
 *   - every workflow says what it may touch, because the default is more than it needs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('../../', import.meta.url).pathname;
const DIR = join(ROOT, '.github', 'workflows');
const WORKFLOWS = readdirSync(DIR).filter((f) => /\.ya?ml$/.test(f))
  .map((f) => ({ name: f, text: readFileSync(join(DIR, f), 'utf8') }));

test('there are workflows to check', () => {
  assert.ok(WORKFLOWS.some((w) => w.name === 'tests.yml'), 'tests.yml was read');
  assert.ok(WORKFLOWS.some((w) => w.name === 'codeql.yml'), 'codeql.yml was read');
});

test('every action is pinned to a full commit, with the version it was written next to it', () => {
  const loose = [];
  for (const w of WORKFLOWS) {
    for (const [line] of w.text.matchAll(/^\s*-?\s*uses:.*$/gm)) {
      // `./local-action` would be ours and needs no pin; nothing here uses one yet.
      if (/uses:\s*\.\//.test(line)) continue;
      if (!/uses:\s*[\w.-]+\/[\w./-]+@[0-9a-f]{40}\s+#\s*v\d+(\.\d+)*\s*$/.test(line)) loose.push(`${w.name}: ${line.trim()}`);
    }
  }
  assert.deepEqual(loose, []);
});

test('every checkout leaves the token behind', () => {
  const keeping = [];
  for (const w of WORKFLOWS) {
    for (const m of w.text.matchAll(/uses:\s*actions\/checkout@[^\n]*\n((?:[ \t]+[^\n]*\n){0,4})/g)) {
      if (!/persist-credentials:\s*false/.test(m[1])) keeping.push(w.name);
    }
  }
  assert.deepEqual(keeping, []);
});

test('every workflow declares its permissions at the top, and none asks to write the code', () => {
  for (const w of WORKFLOWS) {
    assert.match(w.text, /^permissions:\s*\n\s+contents:\s*read\s*$/m, `${w.name} has no top-level read-only permissions`);
    assert.doesNotMatch(w.text, /contents:\s*write|write-all/, `${w.name} asks to write`);
    // `pull_request_target` runs a fork's pull request with this repository's secrets. Nothing here
    // needs it, and it is the one trigger that turns a drive-by pull request into a key.
    assert.doesNotMatch(w.text, /pull_request_target/, `${w.name} uses pull_request_target`);
  }
});

test('Dependabot moves every kind of pin: actions, npm and the base image', () => {
  const config = readFileSync(join(ROOT, '.github', 'dependabot.yml'), 'utf8');
  for (const ecosystem of ['github-actions', 'npm', 'docker']) {
    assert.match(config, new RegExp(`package-ecosystem:\\s*${ecosystem}\\b`), ecosystem);
  }
  // Every entry aims at main. Without it Dependabot aims at the default branch, whatever that is.
  const entries = config.split(/\n\s*- package-ecosystem:/).slice(1);
  assert.equal(entries.length, 3);
  for (const e of entries) assert.match(e, /target-branch:\s*main\b/, `an entry without target-branch: ${e.split('\n')[0]}`);
});

test('CI refuses to ship what has a known high-severity advisory, and CodeQL reads the code', () => {
  const tests = WORKFLOWS.find((w) => w.name === 'tests.yml').text;
  assert.match(tests, /run:\s*npm audit --omit=dev --audit-level=high/);
  const codeql = WORKFLOWS.find((w) => w.name === 'codeql.yml').text;
  assert.match(codeql, /codeql-action\/analyze@/);
  assert.match(codeql, /languages:\s*javascript-typescript/);
});

test('a release publishes only after the tag guard and the full proofs, and never as `latest`', () => {
  const release = WORKFLOWS.find((w) => w.name === 'release.yml')?.text;
  assert.ok(release, 'release.yml was read');
  const job = (name) => release.split(/\n {2}(?=[a-z]+:\n)/).find((j) => j.startsWith(`${name}:`)) ?? '';
  assert.match(job('guard'), /run:\s*bash scripts\/check-release-tag\.sh "\$GITHUB_REF_NAME"/);
  assert.match(job('proofs'), /needs:\s*guard/);
  assert.match(job('proofs'), /uses:\s*\.\/\.github\/workflows\/tests\.yml/);
  assert.match(job('publish'), /needs:\s*proofs/);
  assert.match(job('publish'), /packages:\s*write/);
  // Only the publishing job may write anywhere, and only to packages.
  assert.doesNotMatch(job('guard') + job('proofs'), /:\s*write/);
  assert.match(release, /flavor:\s*latest=false/);
  assert.doesNotMatch(release, /value=latest|latest=true/);
  const tests = WORKFLOWS.find((w) => w.name === 'tests.yml').text;
  assert.match(tests, /^\s*workflow_call:/m, 'tests.yml can be called by the release');
});

test('the oldest Node package.json promises is a Node CI actually runs', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const floor = /^>=(\d+\.\d+)$/.exec(pkg.engines.node)?.[1];
  assert.ok(floor, `engines.node is "${pkg.engines.node}", not a plain ">=MAJOR.MINOR"`);
  const tests = WORKFLOWS.find((w) => w.name === 'tests.yml').text;
  const floorJob = /^ {2}floor:\n([\s\S]*?)(?=^ {2}\S|(?![\s\S]))/m.exec(tests)?.[1] ?? '';
  assert.match(floorJob, new RegExp(`node-version:\\s*'${floor.replace('.', '\\.')}\\.0'`),
    `the floor job does not run Node ${floor}.0, the version package.json promises`);
  assert.match(floorJob, /run:\s*npm test/, 'the floor job does not run the unit tests');
  assert.match(floorJob, /run:\s*bash engine\/test-contract\.sh/, 'the floor job does not boot the server');
});

test('contributors, CI and the image run the same Node major', () => {
  const nvmrc = readFileSync(join(ROOT, '.nvmrc'), 'utf8').trim();
  const image = /^FROM node:(\d+)-/m.exec(readFileSync(join(ROOT, 'Dockerfile'), 'utf8'))?.[1];
  assert.equal(image, nvmrc, 'the Dockerfile and .nvmrc name different Node majors');
  const tests = WORKFLOWS.find((w) => w.name === 'tests.yml').text;
  const testJob = /^ {2}test:\n([\s\S]*?)(?=^ {2}\S)/m.exec(tests)?.[1] ?? '';
  assert.match(testJob, /node-version-file:\s*\.nvmrc/, 'the test job does not read .nvmrc');
});

test('CI runs the store suites against real Postgres and Firestore, and a skip there fails', () => {
  const tests = WORKFLOWS.find((w) => w.name === 'tests.yml').text;
  const job = /^ {2}stores:\n([\s\S]*?)(?=^ {2}\S|(?![\s\S]))/m.exec(tests)?.[1] ?? '';
  assert.match(job, /image:\s*postgres:[\w.-]+@sha256:[0-9a-f]{64}\s*$/m, 'no Postgres service pinned by digest');
  assert.match(job, /google-cloud-cli:emulators@sha256:[0-9a-f]{64}/, 'no Firestore emulator pinned by digest');
  assert.match(job, /HOLDRIM_TEST_REQUIRE:\s*postgres,firestore\s*$/m, 'a store that fails to start would only skip');
  assert.match(job, /run:\s*node --test engine\/tests\/users-conformance\.test\.js/, 'the user stores\' suite does not run');
  assert.match(job, /run:\s*node --test engine\/tests\/events-conformance\.test\.js/, 'the event stores\' suite does not run');
});

test('every test file that runs against the Firestore emulator is run by the job that starts it', () => {
  // The other jobs have no emulator, so a file's [firestore] tests skip there; a file this job does
  // not name is one whose Firestore half runs nowhere, and CI stays green over it.
  const tests = WORKFLOWS.find((w) => w.name === 'tests.yml').text;
  const job = /^ {2}stores:\n([\s\S]*?)(?=^ {2}\S|(?![\s\S]))/m.exec(tests)?.[1] ?? '';
  const dir = join(ROOT, 'engine', 'tests');
  const needing = readdirSync(dir).filter((f) => f.endsWith('.test.js'))
    .filter((f) => /process\.env\.FIRESTORE_EMULATOR_HOST/.test(readFileSync(join(dir, f), 'utf8')));
  assert.ok(needing.includes('authors.test.js'), `the search found too little: ${needing.join(', ')}`);
  // Escapes every regex metacharacter, not just the dot: a file name is data, and CodeQL flags a
  // partial escape here because a name carrying a backslash or another special character would
  // build a pattern that means something other than the literal name.
  const literally = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const missing = needing.filter((f) => !new RegExp(`run:\\s*node --test engine/tests/${literally(f)}`).test(job));
  assert.deepEqual(missing, [], `run against the emulator by nobody: ${missing.join(', ')}`);
});
