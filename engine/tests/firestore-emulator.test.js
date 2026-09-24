/**
 * The Firestore emulator script, checked.
 *
 * `scripts/firestore-emulator.sh` downloads a jar and runs it, so its guards are the ones that keep
 * a wrong jar from running and a dead emulator from passing for a live one. Nothing else runs it
 * but the cloud session hook, whose test stubs it out. Here it runs with `curl` and `java` replaced
 * by stubs, against a copy whose pinned checksum is the fake jar's: the real jar is 130 MB, and
 * nothing but the constant differs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync }
  from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stub } from './helpers/stub.js';

const ROOT = new URL('../../', import.meta.url).pathname;
const SCRIPT = readFileSync(join(ROOT, 'scripts', 'firestore-emulator.sh'), 'utf8');
const VERSION = SCRIPT.match(/^VERSION=(\S+)$/m)[1];
const JAR_NAME = `cloud-firestore-emulator-v${VERSION}.jar`;
const JAR = 'a jar, as far as the stubs are concerned\n';
const literally = (text) => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const EXPORT = 'export FIRESTORE_EMULATOR_HOST=127.0.0.1:8433\n';

// What the script calls besides curl and java, then what the stubs below call. The PATH holds only
// these, so that "no Java" — or "no sha256sum", as on macOS — can be staged on a machine that has one.
const SCRIPT_TOOLS = ['bash', 'cut', 'sha256sum', 'shasum', 'mkdir', 'rm', 'mv', 'seq', 'sleep', 'tail', 'nohup', 'kill'];
const STUB_TOOLS = ['cat'];


/**
 * Runs the script with a download that serves `served` (null: the download cut halfway), a `java`
 * that starts an emulator that answers or not (null: no Java at all), something already listening
 * on the port (`running`: true for the emulator, or the body something else answers with), a jar
 * already `cached`, and `sha256sum` on the PATH or not. Hands back the exit code, both outputs,
 * every call the stubs saw, and the cache.
 */
function run(t, { served = JAR, java = 'answers', running = false, cached = null, sha256sum = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'holdrim-emulator-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, 'bin');
  const cache = join(dir, 'cache', 'holdrim');
  mkdirSync(bin);
  for (const tool of [...SCRIPT_TOOLS, ...STUB_TOOLS]) {
    if (tool === 'sha256sum' && !sha256sum) continue;
    const found = spawnSync('bash', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim();
    if (found) symlinkSync(found, join(bin, tool));
  }
  const log = join(dir, 'calls.log');
  const up = join(dir, 'up');
  writeFileSync(log, '');
  if (running) writeFileSync(up, running === true ? 'Ok' : running);
  if (served !== null) writeFileSync(join(dir, 'served'), served);
  if (cached !== null) {
    mkdirSync(cache, { recursive: true });
    writeFileSync(join(cache, JAR_NAME), cached);
  }
  stub(bin, 'curl', [
    `echo "curl $*" >> '${log}'`,
    'out=""; while [ $# -gt 0 ]; do [ "$1" = -o ] && out=$2; shift; done',
    served === null
      ? '[ -n "$out" ] && { printf "half a jar" > "$out"; exit 18; }'
      : `[ -n "$out" ] && { cat '${join(dir, 'served')}' > "$out"; exit 0; }`,
    `[ -e '${up}' ] && cat '${up}'`,
    'exit 0',
  ].join('\n'));
  if (java !== null) {
    const starts = {
      answers: `printf Ok > '${up}'`,
      dies: 'echo "port in use"; exit 1',
      hangs: `echo $$ > '${join(dir, 'java.pid')}'; exec sleep 30`,
    }[java];
    stub(bin, 'java', `echo "java $*" >> '${log}'\n${starts}`);
  }
  // The copy differs from the script in one constant: the checksum it pins.
  const pinned = createHash('sha256').update(JAR).digest('hex');
  const script = join(dir, 'firestore-emulator.sh');
  writeFileSync(script, SCRIPT.replace(/^SHA256=\w+$/m, `SHA256=${pinned}`));
  const r = spawnSync(join(bin, 'bash'), [script], {
    encoding: 'utf8',
    env: { PATH: bin, HOME: dir, XDG_CACHE_HOME: join(dir, 'cache'), HOLDRIM_EMULATOR_WAIT: '2' },
  });
  const pidFile = join(dir, 'java.pid');
  return {
    code: r.status, out: r.stdout, err: r.stderr, calls: readFileSync(log, 'utf8'),
    javaPid: existsSync(pidFile) ? Number(readFileSync(pidFile, 'utf8')) : null,
    jar: existsSync(join(cache, JAR_NAME)),
    part: existsSync(join(cache, `${JAR_NAME}.part`)),
  };
}

test('the script pins a checksum, and the copy under test replaces exactly that line', () => {
  assert.match(SCRIPT, /^SHA256=[0-9a-f]{64}$/m);
  assert.match(SCRIPT, /^URL=.*cloud-firestore-emulator-v\$VERSION\.jar"$/m);
});

test('it downloads the pinned jar, starts it, and prints only the line to export', (t) => {
  const { code, out, calls, jar } = run(t);
  assert.equal(code, 0);
  assert.equal(out, EXPORT);
  assert.match(calls, new RegExp(`^curl .*-o .*${literally(JAR_NAME)}\\.part https://storage\\.googleapis\\.com/`, 'm'));
  assert.match(calls, new RegExp(`^java -jar .*${literally(JAR_NAME)} --host 127\\.0\\.0\\.1 --port 8433$`, 'm'));
  // Asked past the proxy: the cloud session's proxy cannot reach this machine's loopback.
  // Bounded, or a port that takes the connection and never replies hangs the session start.
  assert.match(calls, /^curl -s --noproxy \* --max-time 2 http:\/\/127\.0\.0\.1:8433$/m);
  assert.ok(jar);
});

test('an emulator already answering is used as it is, with nothing downloaded or started', (t) => {
  const { code, out, calls } = run(t, { running: true, java: null });
  assert.equal(code, 0);
  assert.equal(out, EXPORT);
  assert.doesNotMatch(calls, / -o /);
  assert.doesNotMatch(calls, /^java/m);
});

test('a jar that does not match the pinned checksum is thrown away and never run', (t) => {
  const { code, out, err, calls, jar, part } = run(t, { served: 'something else entirely\n' });
  assert.equal(code, 1);
  assert.equal(out, '');
  assert.match(err, /does not match its pinned checksum; not running it/);
  assert.doesNotMatch(calls, /^java/m);
  assert.equal(jar, false);
  assert.equal(part, false);
});

test('a cached jar that no longer matches is fetched again, not run', (t) => {
  const { code, calls } = run(t, { cached: 'tampered with\n' });
  assert.equal(code, 0);
  assert.match(calls, / -o /);
});

test('a cached jar that matches is not downloaded again', (t) => {
  const { code, calls } = run(t, { cached: JAR });
  assert.equal(code, 0);
  assert.doesNotMatch(calls, / -o /);
});

test('a download cut halfway says so and leaves nothing half-written behind', (t) => {
  const { code, err, part, jar } = run(t, { served: null });
  assert.equal(code, 1);
  assert.match(err, /could not download https:\/\/storage\.googleapis\.com\//);
  assert.equal(part, false);
  assert.equal(jar, false);
});

test('no Java is said in those words, before anything is downloaded', (t) => {
  const { code, err, calls } = run(t, { java: null });
  assert.equal(code, 1);
  assert.match(err, /needs Java, and there is none on the PATH/);
  assert.doesNotMatch(calls, / -o /);
});

test('an emulator that never answers fails, with the end of its log', (t) => {
  const { code, out, err } = run(t, { java: 'dies' });
  assert.equal(code, 1);
  assert.equal(out, '');
  assert.match(err, /did not answer on 127\.0\.0\.1:8433 within 2s/);
  assert.match(err, /port in use/);
});

test('something else answering on the port is not taken for the emulator', (t) => {
  const { out, calls } = run(t, { running: 'Not Found' });
  assert.equal(out, EXPORT);
  assert.match(calls, /^java /m);
});

test('without sha256sum, as on macOS, shasum computes the same digest', (t) => {
  const { code, out } = run(t, { sha256sum: false });
  assert.equal(code, 0);
  assert.equal(out, EXPORT);
});

test('an emulator that never answers is stopped, so the failure it reports is true', (t) => {
  const { code, javaPid } = run(t, { java: 'hangs' });
  assert.equal(code, 1);
  assert.ok(javaPid);
  assert.throws(() => process.kill(javaPid, 0), /ESRCH/);
});
