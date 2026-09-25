/**
 * The people screen: which buttons each row offers, and what it does with names and addresses
 * somebody else typed.
 *
 * The rules themselves — nobody but the owner creates or resets the owner's account, the owner is
 * never disabled — are enforced by the routes and proved by the HTTP contract. This file proves the
 * screen does not offer what the routes would refuse, and never lets a typed name become markup.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { actionsFor, engineNav, renderPeoplePage, PEOPLE_KEYS } from '../api/people-page.ts';
import { createI18n } from '../core/i18n.js';
import { ENGINE_THEME } from '../api/theme.ts';

const ROOT = new URL('../../', import.meta.url).pathname;
const dictionaries = Object.fromEntries(['en', 'pt-BR', 'es'].map((l) =>
  [l, JSON.parse(readFileSync(`${ROOT}engine/locales/${l}.json`, 'utf8'))]));
const i18n = createI18n(dictionaries, 'en');

const person = (email, extra = {}) => ({
  email, name: email.split('@')[0], mustChangePassword: false, createdAt: '2026-09-23', enabled: true, ...extra,
});

test('the owner\'s row offers nothing: their password is theirs, and they are never disabled', () => {
  assert.deepEqual(actionsFor(person('owner@x.org'), true), []);
});

test('everyone else can get a new password, and lose or regain access, never both at once', () => {
  assert.deepEqual(actionsFor(person('a@x.org'), false), ['reset', 'disable']);
  assert.deepEqual(actionsFor(person('r@x.org', { enabled: false }), false), ['reset', 'enable']);
});

test('the owner\'s rendered row carries no action; a member\'s still offers reset and disable', () => {
  const html = renderPeoplePage(i18n, 'en', {
    projectName: 'P',
    people: [person('owner@x.org'), person('mem@x.org')],
    roleOf: (e) => (e === 'owner@x.org' ? 'owner' : 'member'),
    isOwner: (e) => e === 'owner@x.org',
  }, ENGINE_THEME, 'n1');
  const rowFor = (email) => html.split('\n').find((line) => line.includes(`<td>${email}</td>`));
  assert.doesNotMatch(rowFor('owner@x.org'), /data-action=/, 'the owner\'s row must offer no action at all');
  assert.match(rowFor('mem@x.org'), /data-action="reset"/);
  assert.match(rowFor('mem@x.org'), /data-action="disable"/, 'enabled by default, so disable is on offer');
});

test('the People link appears only for whoever may manage people', () => {
  assert.match(engineNav(i18n, 'en', 'home', true), /href="\/engine\/people"/);
  assert.doesNotMatch(engineNav(i18n, 'en', 'home', false), /\/engine\/people/);
  assert.match(engineNav(i18n, 'en', 'people', true), /href="\/engine\/people" aria-current="page"/);
});

test('every dictionary has every sentence the people screen reads', () => {
  for (const [lang, dictionary] of Object.entries(dictionaries)) {
    const missing = PEOPLE_KEYS.filter((k) => typeof dictionary[k] !== 'string');
    assert.deepEqual(missing, [], `${lang} is missing ${missing.join(', ')}`);
  }
});

test('a name or an address somebody typed is shown, never run', () => {
  const html = renderPeoplePage(i18n, 'en', {
    projectName: 'P',
    people: [person('owner@x.org'), person('x@x.org', { name: '<img src=x onerror=alert(1)>' }),
      person('"><script>alert(1)</script>@x.org')],
    roleOf: (e) => (e === 'owner@x.org' ? 'owner' : 'member'),
    isOwner: (e) => e === 'owner@x.org',
  }, ENGINE_THEME, 'n0nce');
  // One script, the page's own, carrying the nonce; nothing a person typed opens another.
  assert.equal(html.match(/<script/g).length, 1);
  assert.match(html, /<script nonce="n0nce">/);
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /data-email="&quot;&gt;&lt;script&gt;/, 'the address is escaped inside the attribute too');
});

test('a translation cannot close the script it is handed to', () => {
  const hostile = createI18n({ ...dictionaries, en: { ...dictionaries.en, 'people.noAnswer': '</script><b>x' } }, 'en');
  const html = renderPeoplePage(hostile, 'en',
    { projectName: 'P', people: [], roleOf: () => 'member', isOwner: () => false },
    ENGINE_THEME, 'n');
  assert.equal(html.match(/<\/script>/g).length, 1, 'only the page\'s own script closes');
  assert.match(html, /\\u003c\/script>/);
});

test('the owner comes first, then admins, then everyone else, whatever their names', () => {
  const roles = { 'zed@x.org': 'owner', 'yan@x.org': 'admin', 'abe@x.org': 'member' };
  const html = renderPeoplePage(i18n, 'en', {
    projectName: 'P', people: Object.keys(roles).map((e) => person(e)).reverse(), roleOf: (e) => roles[e],
    isOwner: (e) => roles[e] === 'owner',
  }, ENGINE_THEME, 'n');
  const at = (email) => html.indexOf(`<td>${email}</td>`);
  assert.ok(at('zed@x.org') < at('yan@x.org') && at('yan@x.org') < at('abe@x.org'),
    'by role, not by name: the alphabet would put abe first');
});
