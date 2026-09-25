/**
 * The project's configuration, read without touching the disk.
 *
 * What is proved here is the ORDER of precedence — environment over file over default — and the
 * shape of what comes out. The engine never reads `holdrim.json` directly anywhere else, so a
 * key read under the wrong name here is a setting that silently never applies.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readConfig } from '../core/config.js';
import { HOME_SCREEN } from '../core/screens.js';

const file = (o) => ({ readFile: () => JSON.stringify(o) });
const noFile = { readFile: () => { throw new Error('no file'); } };

test('with no file at all, the engine still has every default it needs', () => {
  // The engine running outside a project: nothing to read, and nothing may throw.
  const c = readConfig('/p', noFile);
  assert.equal(c.name, 'Documentation');
  assert.equal(c.owner, null);
  assert.equal(c.admins, '');
  assert.equal(c.port, 8095);
  assert.equal(c.language, 'en');
  assert.equal(c.pageExamples, '');
  assert.deepEqual(c.theme, { brand: null, logo: null, name: 'Documentation' });
  assert.equal(c.home, HOME_SCREEN, 'the root opens on the project home, not on a page nobody wrote');
  assert.deepEqual(c.roles, {}, 'no project role without a file to define one');
  assert.deepEqual(c.grants, {}, 'no grant without a file to make one');
});

test('roles and grants are read from holdrim.json (#29) — the opposite of owner and admins', () => {
  const c = readConfig('/p', file({
    roles: { 'clinical-lead': ['triage', 'approve'] },
    grants: { 'bea@example.org': [{ role: 'clinical-lead', scope: 'P0*' }] },
  }));
  assert.deepEqual(c.roles, { 'clinical-lead': ['triage', 'approve'] });
  assert.deepEqual(c.grants, { 'bea@example.org': [{ role: 'clinical-lead', scope: 'P0*' }] });
});

test('the file is read under the keys the adopting project writes', () => {
  const c = readConfig('/p', file({
    name: 'Handbook',
    language: 'es',
    content: { folders: ['sheets'], registry: 'locks.json', home: '/sheets/A01.html',
               trimPrefix: 'sheets/', pageExamples: 'A01 or A02' },
    development: { port: 9000, actAs: 'ana@example.org' },
    cloud: { project: 'proj', account: 'acct', region: 'europe-west1', service: 'svc', projectNumber: '42' },
  }));
  assert.equal(c.name, 'Handbook');
  assert.equal(c.language, 'es');
  assert.deepEqual(c.sheetFolders, ['sheets']);
  assert.equal(c.registry, 'locks.json');
  assert.equal(c.home, '/sheets/A01.html');
  assert.equal(c.trimPrefix, 'sheets/');
  assert.equal(c.pageExamples, 'A01 or A02');
  assert.equal(c.port, 9000);
  assert.equal(c.actAs, 'ana@example.org');
  assert.equal(c.project, 'proj');
  assert.equal(c.account, 'acct');
  assert.equal(c.region, 'europe-west1');
  assert.equal(c.service, 'svc');
  assert.equal(c.projectNumber, '42');
});

test('the environment beats the file: one repository, more than one deployment', () => {
  const c = readConfig('/p', file({ name: 'Handbook',
    development: { port: 9000 }, theme: { brand: '#111111' } }), {
    HOLDRIM_NAME: 'Staging', HOLDRIM_OWNER: 'env@example.org', HOLDRIM_ADMINS: 'x@example.org',
    PORT: '8080', HOLDRIM_THEME_BRAND: '#0B5FA5', HOLDRIM_DEV_EMAIL: 'dev@example.org',
    HOLDRIM_PROJECT: 'p-env', HOLDRIM_ACCOUNT: 'c-env',
  });
  assert.equal(c.name, 'Staging');
  assert.equal(c.owner, 'env@example.org');
  assert.equal(c.admins, 'x@example.org');
  assert.equal(c.port, 8080, 'PORT is a number, whatever the shell handed over');
  assert.equal(c.theme.brand, '#0B5FA5');
  assert.equal(c.actAs, 'dev@example.org');
  assert.equal(c.project, 'p-env');
  assert.equal(c.account, 'c-env');
});

test('the language is the file first, then the environment, then English', () => {
  // The one setting where the file beats the environment: which language a project reviews in is
  // the project's statement, and a deployment variable is not where anyone would look for it.
  assert.equal(readConfig('/p', file({ language: 'pt-BR' }), { HOLDRIM_LANGUAGE: 'es' }).language, 'pt-BR');
  assert.equal(readConfig('/p', file({}), { HOLDRIM_LANGUAGE: 'es' }).language, 'es');
  assert.equal(readConfig('/p', file({})).language, 'en');
});

test('readConfig reads the theme, and falls back to the project name', () => {
  const withTheme = readConfig('/p', file({
    name: 'Handbook', theme: { brand: '#0B5FA5', logo: 'theme/l.svg', name: 'Product' },
  }));
  assert.deepEqual(withTheme.theme, { brand: '#0B5FA5', logo: 'theme/l.svg', name: 'Product' });

  // No `tema` at all is the normal case: the project still has a name, and the screen still has
  // something to show. Asking for the same name twice would be asking a project to repeat itself.
  const plain = readConfig('/p', file({ name: 'Handbook' }));
  assert.deepEqual(plain.theme, { brand: null, logo: null, name: 'Handbook' });
});

test('a file that is not JSON counts as no file, not as a crash', () => {
  // A broken `holdrim.json` is a developer's mistake, and the service saying "Documentation" on a
  // screen is a better clue than a stack trace on a port nobody is listening to.
  const c = readConfig('/p', { readFile: () => '{ not json' });
  assert.equal(c.name, 'Documentation');
  // ...but the reason is kept, for whoever has to say why the owner went missing.
  assert.match(c.unreadable ?? '', /JSON/);
  const none = readConfig('/p', { readFile: () => { throw new Error('ENOENT'); } });
  assert.equal(none.unreadable, null, 'no file at all is not a broken file');
  assert.equal(readConfig('/p', { readFile: () => '{}' }).unreadable, null);
});

test('the owner and the admins come from the environment, and only from it', () => {
  const c = readConfig('/p', file({ name: 'Handbook' }),
    { HOLDRIM_OWNER: 'env@example.org', HOLDRIM_ADMINS: 'a@example.org,b@example.org' });
  assert.equal(c.owner, 'env@example.org');
  assert.equal(c.admins, 'a@example.org,b@example.org');
  const none = readConfig('/p', file({ name: 'Handbook' }));
  assert.equal(none.owner, null, 'no variable, no owner: the service then refuses to start');
  assert.equal(none.admins, '');
});

test('a holdrim.json that names an owner, admins or lock-holders refuses to load', () => {
  // Whoever commits to the file is not whoever deploys: read, the key would hand authority to
  // anyone with a branch. The variable being set does not excuse it — the key would still say
  // something false about who owns the project.
  for (const [key, value] of [['owner', 'file@example.org'], ['admins', ['a@example.org']],
    ['locks', 'a@example.org:A01'], ['owner', null]]) {
    for (const env of [{}, { HOLDRIM_OWNER: 'env@example.org', HOLDRIM_ADMINS: 'x@example.org' }]) {
      assert.throws(() => readConfig('/p', file({ name: 'Handbook', [key]: value }), env),
        (e) => e instanceof Error && e.message.includes(`/p/holdrim.json names "${key}"`)
          && /authority is set by the deployment/.test(e.message)
          && e.message.includes('HOLDRIM_OWNER') && e.message.includes('HOLDRIM_ADMINS'),
        `"${key}" in the file, with ${Object.keys(env).length ? 'the variables set' : 'no variables'}`);
    }
  }
  assert.throws(() => readConfig('/p', file({ owner: 'o@example.org', admins: [], locks: '' })),
    /names "owner", "admins", "locks"/, 'every key it names, not only the first');
  // Keys that merely look alike are the project's own notes, not authority.
  assert.doesNotThrow(() => readConfig('/p', file({ _owner: 'who approves is set by HOLDRIM_OWNER' })));
});

test('"roles" and "grants" are not authority keys — unlike "admins", the file is where they belong', () => {
  // The opposite risk from the test above: refusing these too would make #29 impossible to use at
  // all, since roles and grants are exactly what the file is FOR (docs/ROLES.md, "Where everything
  // lives" — "Grants of the project's roles" is the one row this file, not the environment, answers
  // for a project role, as opposed to `admin`, which stays environment-only).
  assert.doesNotThrow(() => readConfig('/p', file({
    roles: { 'clinical-lead': ['triage'] }, grants: { 'x@example.org': [{ role: 'clinical-lead' }] },
  })));
});
