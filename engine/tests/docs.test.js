/**
 * The documentation names real things.
 *
 * Docs rot differently from code: nothing imports them, so nothing breaks when the file they point
 * at is renamed, and a sentence goes on pointing at a file long after it was deleted. The reader
 * follows the path, finds nothing, and stops trusting the rest of the page.
 *
 * So the names a reader is most likely to act on are checked against the tree: relative links,
 * repository paths in backticks, `HOLDRIM_*` variables and `holdrim <command>`. The prose is still a
 * person's job; this only makes sure it points somewhere.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { normalize } from '../core/fingerprint.js';
import { CLI_COMMANDS as COMMANDS } from './helpers/cli-source.js';

const ROOT = new URL('../../', import.meta.url).pathname;
const read = (path) => readFileSync(join(ROOT, path), 'utf8');

/** Every Markdown file a reader of the repository meets, and none of node_modules. */
const DOCS = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '*.md'],
  { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean).filter((f) => existsSync(join(ROOT, f)));

/** Code blocks are examples of other people's projects (`my-docs/`, a sample path); prose is ours. */
const prose = (md) => md.replace(/^```[\s\S]*?^```/gm, '');

/** The source text of the engine, where a variable or a command either appears or does not. */
const CODE = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard',
  '*.ts', '*.js', '*.sh', '*.yml', '*.yaml', 'Dockerfile', '.env.example'],
{ cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean).filter((f) => existsSync(join(ROOT, f)))
  .map((f) => read(f)).join('\n');

test('every core document the repository promises exists', () => {
  for (const f of ['README.md', 'CONTRIBUTING.md', 'SECURITY.md', ...['BUGS', 'GLOSSARY', 'IMPACT',
    'LAYERS', 'METHOD', 'PRIOR-ART', 'VISION'].map((d) => `docs/${d}.md`)]) {
    assert.ok(DOCS.includes(f), `${f} is missing`);
  }
});

test('every relative link in the docs lands on a file that exists', () => {
  const broken = [];
  for (const file of DOCS) {
    for (const [, target] of prose(read(file)).matchAll(/\]\(([^)\s]+)\)/g)) {
      if (/^(https?:|mailto:|#)/.test(target)) continue;
      const path = target.split('#')[0];
      if (!existsSync(join(ROOT, dirname(file), path))) broken.push(`${file} → ${target}`);
    }
  }
  assert.deepEqual(broken, []);
});

test('every repository path the docs quote exists', () => {
  const missing = [];
  const roots = /^(engine|examples|docs|scripts|plugins|\.github|\.githooks|\.claude)\//;
  for (const file of DOCS) {
    for (const [, quoted] of prose(read(file)).matchAll(/`([^`\s]+)`/g)) {
      const path = quoted.replace(/[:#].*$/, '').replace(/\/$/, '');
      if (!roots.test(path) || /[*<{]/.test(path)) continue;       // a glob or a placeholder
      if (!existsSync(join(ROOT, path))) missing.push(`${file}: ${quoted}`);
    }
  }
  assert.deepEqual(missing, []);
});

test('every HOLDRIM_ variable the docs name is one the engine reads', () => {
  const unknown = [];
  for (const file of DOCS) {
    for (const [name] of read(file).matchAll(/\bHOLDRIM_[A-Z_]+[A-Z]\b/g)) {
      if (!CODE.includes(name)) unknown.push(`${file}: ${name}`);
    }
  }
  assert.deepEqual(unknown, []);
});

test('every `holdrim <command>` in the docs is a command the CLI has', () => {
  assert.ok(COMMANDS.has('check') && COMMANDS.has('apply'), 'the command list was read');
  const unknown = [];
  for (const file of DOCS) {
    for (const [, command] of read(file).matchAll(/\bholdrim ([a-z][a-z-]*)\b/g)) {
      if (!COMMANDS.has(command)) unknown.push(`${file}: holdrim ${command}`);
    }
  }
  assert.deepEqual(unknown, []);
});

test('the glossary names every request category the cycle has, and no other', () => {
  // The glossary exists so one concept does not get two names. A category added to cycle.json and
  // not to its table is the first step of exactly that, and nothing that imports code would notice.
  const cycle = JSON.parse(read('engine/cycle.json'));
  const table = read('docs/GLOSSARY.md').split('## Request categories')[1].split('\n## ')[0];
  const listed = [...table.matchAll(/^\| `([a-z]+)` \|/gm)].map(([, c]) => c).sort();
  assert.deepEqual(listed, Object.keys(cycle.request_categories).sort());
});

/** Text a reader sees, whatever wrote it: no tags, no bold marks, and the fingerprint's own spacing. */
const words = (s) => normalize(s.replace(/<[^>]+>/g, ' ').replace(/\*\*/g, ''));

/** The paragraph that starts right after `start`, up to the next blank line; empty when absent. */
const paragraphAfter = (text, start) => (text.split(start)[1] ?? '').trim().split(/\n\s*\n/)[0];

/**
 * The mission and the vision are written in three places a visitor meets them — the README, the
 * vision document and the site's first page — and a sentence kept in three places is three
 * sentences the day one of them is edited. docs/VISION.md is the one they are read from.
 */
test('the mission and the vision say the same thing wherever they are written', () => {
  const vision = read('docs/VISION.md');
  const section = (title) => words(paragraphAfter(vision, `## ${title}\n`));
  const mission = section('Mission');
  // The vision section goes on after its first paragraph; the statement is that paragraph.
  const statement = section('Vision');
  assert.ok(mission.length > 40 && statement.length > 40, 'the mission or the vision was not found in docs/VISION.md');

  // The paragraph a reader meets, not the words anywhere in the file: a copy further down would
  // otherwise vouch for a first paragraph that says something else.
  const readme = read('README.md');
  assert.equal(words(paragraphAfter(readme, '**Mission.**')), mission, 'README.md\'s mission is not the one in docs/VISION.md');
  assert.equal(words(paragraphAfter(readme, '**Vision.**')), statement, 'README.md\'s vision is not the one in docs/VISION.md');

  const site = read('site/pages/S01.html');
  const block = (id) => words(site.split(`data-id="${id}"`)[1].split('</div>')[0].replace(/^[^>]*>/, ''));
  assert.equal(block('S01.2.1'), mission, 'the site\'s mission (S01.2.1) is not the one in docs/VISION.md');
  assert.equal(block('S01.3.1'), statement, 'the site\'s vision (S01.3.1) is not the one in docs/VISION.md');
});

/**
 * A translation is a second copy, and a second copy drifts without anyone noticing: the English
 * gains a step, and the Portuguese goes on promising the old ones. So the part of README.md that is
 * translated ends at a marker, and each translation carries the fingerprint of that part as it was
 * when it was translated — the method's own lock, on its own front page.
 */
test('every translation of the README carries the fingerprint of the English it translates', async () => {
  const { createHash } = await import('node:crypto');
  const MARKER = '<!-- translated: everything above this line is also in README.pt-BR.md and README.es.md -->';
  const english = read('README.md');
  assert.ok(english.includes(MARKER), 'README.md has lost the marker that ends its translated part');
  // Line endings are the checkout's, not the text's: Git on Windows hands out CRLF, and a translation
  // would read as stale on a fresh clone with nothing changed.
  const now = createHash('sha256').update(english.split(MARKER)[0].replace(/\r\n/g, '\n')).digest('hex');
  for (const file of ['README.pt-BR.md', 'README.es.md']) {
    const recorded = read(file).match(/<!-- source: README\.md up to the translated marker, sha256 ([0-9a-f]{64}) -->/)?.[1];
    assert.equal(recorded, now, `${file} translates an older README.md: bring it up to date and record sha256 ${now}`);
  }
});
