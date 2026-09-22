/**
 * The language check, checked.
 *
 * `scripts/check-language.sh` is the only thing standing between this repository and rule 1, and
 * without this file nothing would assert it: CI calls it once, with a real file list, over a tree
 * that has no Portuguese in it. Every guard inside it could be deleted and all five proofs would
 * stay green — which is rule 2's "a test nobody has seen fail proves nothing", applied to the
 * script that enforces rule 1.
 *
 * Each test below is one of its guards, and each one was watched failing with that guard removed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = new URL('../../', import.meta.url).pathname;
const SCRIPT = join(ROOT, 'scripts', 'check-language.sh');

/** Runs the script the way CI does, and hands back what a person would see. */
function check(args, cwd = ROOT) {
  try {
    const out = execFileSync('bash', [SCRIPT, '--comments=en', ...args],
      { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status, out: String(e.stdout ?? '') + String(e.stderr ?? '') };
  }
}

/** A throwaway project, so a test that writes cannot dirty the repository. */
function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'holdrim-lang-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const PORTUGUESE = '// Este arquivo nao esta certo porque quando a pagina muda ele tambem falha.\n';

test('a comment in another language is caught, and the file and the line are named', (t) => {
  const dir = scratch(t);
  writeFileSync(join(dir, 'bad.js'), PORTUGUESE + 'export const a = 1;\n');
  const r = check(['bad.js'], dir);
  assert.equal(r.code, 1);
  assert.match(r.out, /bad\.js/);
  assert.match(r.out, /1:\/\/ Este arquivo/, 'the offending line, quoted');
});

test('English passes, and a Portuguese word inside a code span does not count', (t) => {
  const dir = scratch(t);
  // Backticks are stripped before the grammar words are counted: a comment that QUOTES an
  // identifier or a translated value is still an English comment.
  writeFileSync(join(dir, 'good.js'),
    '// The dictionary key `nao existe para que isso seja uma frase` is data, not prose.\n');
  assert.equal(check(['good.js'], dir).code, 0);
});

test('an empty file list is refused, not taken for a clean tree', () => {
  const r = check([]);
  assert.equal(r.code, 2, 'exit 2, not 0');
  assert.match(r.out, /no files to check/);
});

/**
 * The deeper half of the same trap. `$(git ls-files …)` prints paths from the repository root,
 * so running the check from a subdirectory hands it a full list in which nothing exists.
 */
test('paths that cannot be opened are refused, not skipped in silence', (t) => {
  const dir = scratch(t);
  const r = check(['nowhere/a.js', 'nowhere/b.ts'], dir);
  assert.equal(r.code, 2);
  assert.match(r.out, /could be opened/);
});

/**
 * An example's pages are demonstration content and are skipped. Its scripts are not: the template
 * ships code an adopter copies and runs, and a glob that skipped the whole folder would let it
 * through unread.
 */
test('a script inside examples/ is read; an example page is not', (t) => {
  const dir = scratch(t);
  mkdirSync(join(dir, 'examples', 'template', 'checks'), { recursive: true });
  const script = join('examples', 'template', 'checks', 'a.test.js');
  writeFileSync(join(dir, script), PORTUGUESE);
  assert.equal(check([script], dir).code, 1, 'an example script is checked');

  const page = join('examples', 'template', 'page.html');
  writeFileSync(join(dir, page), PORTUGUESE);
  assert.equal(check([page], dir).code, 0, 'an example page is not');
});

/** The dictionaries hold other languages by definition — that is what they are for. */
test('a translation is never read as a mistake', (t) => {
  const dir = scratch(t);
  mkdirSync(join(dir, 'engine', 'locales'), { recursive: true });
  const dict = join('engine', 'locales', 'pt-BR.js');
  writeFileSync(join(dir, dict), PORTUGUESE);
  assert.equal(check([dict], dir).code, 0);
});
