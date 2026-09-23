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

const COMMANDS = new Set([...read('engine/cli/holdrim.ts').matchAll(/case '([a-z-]+)':/g)].map((m) => m[1]));

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
