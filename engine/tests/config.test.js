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
});

test('the file is read under the keys the adopting project writes', () => {
  const c = readConfig('/p', file({
    name: 'Handbook', owner: 'ana@example.org', admins: ['bob@example.org', 'cid@example.org'],
    language: 'es',
    content: { folders: ['sheets'], registry: 'locks.json', home: '/sheets/A01.html',
               trimPrefix: 'sheets/', pageExamples: 'A01 or A02' },
    development: { port: 9000, actAs: 'ana@example.org' },
    cloud: { project: 'proj', account: 'acct', region: 'europe-west1', service: 'svc', projectNumber: '42' },
  }));
  assert.equal(c.name, 'Handbook');
  assert.equal(c.owner, 'ana@example.org');
  assert.equal(c.admins, 'bob@example.org,cid@example.org', 'a list in the file, a comma list out');
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
  const c = readConfig('/p', file({ name: 'Handbook', owner: 'file@example.org', admins: ['a@example.org'],
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
