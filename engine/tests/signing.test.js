/**
 * Events signed by the server (engine/api/signing.ts): what a seal binds, what makes one fail, and
 * where the key comes from. The stores that seal and the readers that verify are proved in
 * events-conformance.test.js, cli.test.js and engine/test-contract.sh; this proves the rule itself.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  verifyRow, withSignatures, loadSigner, loadKeyring, kidOf, publicKeyText, signerOf, parsePrivateKey,
  namesPublicKeys, canonical, ENVELOPE_TAG,
} from '../api/signing.ts';
import { newKey } from '../cli/keys.ts';
import { signer, keyring, other, sealedRow } from './helpers/signing.js';

const ROOT = new URL('../../', import.meta.url).pathname;

/** A row with its seal taken off: what a direct writer who never had the key inserts. */
const unsealed = (row) => Object.fromEntries(Object.entries(row).filter(([k]) => !['envelope', 'sig', 'kid'].includes(k)));

const FIELDS = {
  id: 'e1', type: 'approval', page: 'A01', block: 'A01.1.1', fingerprint: 'f'.repeat(16),
  // Every field holds a value of its own: a field that is null in the fixture would read the same
  // whether or not the envelope carries it, and prove nothing about it.
  textHash: 'd'.repeat(64), snapshotHash: 'a'.repeat(64), author: 'p_' + '0'.repeat(24), when: '2026-09-28T10:00:00.000Z',
  data: { locks: 'true', asAgent: 'false' },
};

// ---------------------------------------------------------------- what a seal binds
test('a sealed row verifies, and its event comes from the envelope', () => {
  const v = verifyRow(sealedRow(FIELDS), keyring);
  assert.equal(v.signed, true);
  assert.equal(v.kid, signer.kid);
  assert.deepEqual(v.fields, FIELDS);
});

/**
 * Each field edited INSIDE the envelope, the signature kept: the bytes signed changed, so it no
 * longer verifies. Without a field in the envelope, editing it here would still verify — so each
 * line is the proof that its field is signed at all (a `data` left out, a `textHash` left out).
 */
test('every field is bound: editing any one inside the envelope breaks the signature', () => {
  const row = sealedRow(FIELDS);
  const edits = {
    id: 'e2', type: 'comment', page: 'A02', block: 'A01.1.2', fingerprint: 'e'.repeat(16), textHash: 'b'.repeat(64),
    snapshotHash: 'c'.repeat(64), author: 'p_' + '1'.repeat(24), when: '2026-09-28T10:00:00.001Z',
  };
  const index = { id: 2, type: 3, page: 4, block: 5, fingerprint: 6, textHash: 7, snapshotHash: 8, author: 9, when: 10 };
  for (const [field, value] of Object.entries(edits)) {
    const a = JSON.parse(row.envelope);
    a[index[field]] = value;
    const forged = { ...row, [field]: value, envelope: JSON.stringify(a) };
    const v = verifyRow(forged, keyring);
    assert.equal(v.signed, false, `${field} edited inside the envelope`);
    assert.equal(v.reason, 'a signature that does not verify', field);
  }
  const a = JSON.parse(row.envelope);
  a[11] = { ...a[11], locks: 'false' };
  assert.equal(verifyRow({ ...row, data: a[11], envelope: JSON.stringify(a) }, keyring).signed, false, 'data.locks edited');
});

/** A column changed beside a genuine envelope: the envelope still verifies, and the row is a forgery. */
test('a row column that disagrees with its envelope reads as forged, whichever column it is', () => {
  const row = sealedRow(FIELDS);
  const edits = {
    id: 'e2', type: 'comment', page: 'A02', block: null, fingerprint: null, textHash: 'b'.repeat(64),
    snapshotHash: null, author: 'p_' + '1'.repeat(24), when: '2026-09-28T09:00:00.000Z',
  };
  for (const [column, value] of Object.entries(edits)) {
    const v = verifyRow({ ...row, [column]: value }, keyring);
    assert.equal(v.signed, false, column);
    assert.equal(v.kind, 'forged', column);
    assert.equal(v.reason, `its ${column} disagrees with what was signed`, column);
  }
  const v = verifyRow({ ...row, data: { locks: 'true', asAgent: 'true' } }, keyring);
  assert.equal(v.reason, 'its data disagrees with what was signed');
  assert.equal(verifyRow({ ...row, data: null }, keyring).signed, false, 'data dropped from the row');
  // The same data in another key order is the same data: a store that hands keys back in its own
  // order (Firestore's map, a SQLite JSON column) must not read as a forgery.
  assert.equal(verifyRow({ ...row, data: { asAgent: 'false', locks: 'true' } }, keyring).signed, true);
});

test('a text written inside a signed event reads as forged: a signed event keeps its texts by hash', () => {
  for (const field of ['text', 'snapshot']) {
    const v = verifyRow({ ...sealedRow(FIELDS), [field]: 'written straight into the row' }, keyring);
    assert.equal(v.signed, false, field);
    assert.match(v.reason, /a text inside a signed event/);
  }
});

// ---------------------------------------------------------------- which key
test('a row with no seal at all is unsigned; one with part of a seal is forged', () => {
  const bare = unsealed(sealedRow(FIELDS));
  assert.deepEqual(verifyRow(bare, keyring), { signed: false, kind: 'unsigned', reason: 'no signature' });
  const row = sealedRow(FIELDS);
  for (const missing of ['envelope', 'sig', 'kid']) {
    const v = verifyRow({ ...row, [missing]: null }, keyring);
    assert.equal(v.kind, 'forged', missing);
  }
});

test('a key the reader does not trust signs nothing, and only the key the kid names is asked', () => {
  const byOther = sealedRow(FIELDS, other);
  assert.equal(verifyRow(byOther, keyring).signed, false, 'the other key is in no keyring here');
  assert.match(verifyRow(byOther, keyring).reason, /which this reader does not trust/);
  // Signed by the other key, labelled with the trusted key's kid: a reader that tried every key it
  // holds, or took the first, would accept it under the wrong name.
  const both = loadKeyring({ HOLDRIM_PUBLIC_KEYS: other.publicKey }, signer);
  assert.equal(verifyRow(byOther, both).signed, true, 'trusted once the reader names it');
  const relabelled = { ...byOther, kid: signer.kid };
  assert.equal(verifyRow(relabelled, both).signed, false, 'right kid, another key\'s signature');
  assert.equal(verifyRow(relabelled, both).reason, 'a signature that does not verify');
});

test('malformed seals are answers, never a crash of the read', () => {
  const row = sealedRow(FIELDS);
  for (const [what, forged] of [
    ['a signature that is not base64', { ...row, sig: '!!!' }],
    ['a signature cut short', { ...row, sig: row.sig.slice(0, 10) }],
    ['an envelope that is not JSON', { ...row, envelope: 'not json', sig: signer.sign('not json') }],
    ['numbers where the fields go', { ...row, sig: 42, kid: 42 }],
  ]) {
    assert.doesNotThrow(() => verifyRow(forged, keyring), what);
    assert.equal(verifyRow(forged, keyring).signed, false, what);
  }
  // Signed by the trusted key, but of a version this reader does not know: not guessed at.
  const a = JSON.parse(row.envelope);
  a[1] = 2;
  const v2 = JSON.stringify(a);
  const v = verifyRow({ ...row, envelope: v2, sig: signer.sign(v2) }, keyring);
  assert.equal(v.signed, false);
  assert.match(v.reason, /shape this version does not read/);
  assert.equal(JSON.parse(row.envelope)[0], ENVELOPE_TAG, 'the tag comes first');
});

// ---------------------------------------------------------------- over a list
test('withSignatures marks each row, reports each one not signed, and lets no seal through', () => {
  const good = sealedRow(FIELDS);
  const bare = unsealed(sealedRow({ ...FIELDS, id: 'e2' }));
  const edited = { ...sealedRow({ ...FIELDS, id: 'e3' }), page: 'A09' };
  const reports = [];
  const out = withSignatures([good, bare, edited], keyring, reports);
  assert.deepEqual(out.map((e) => e.signed), [true, false, false]);
  assert.ok(out.every((e) => !('envelope' in e) && !('sig' in e) && !('kid' in e)), 'no seal leaves the reader');
  assert.deepEqual(reports.map((r) => [r.event, r.field, r.kind]), [['e2', 'event', 'unsigned'], ['e3', 'event', 'forged']]);
  assert.equal(out[2].page, 'A09', 'an unsigned row is shown as found, not repaired from anything');
  // A row rewritten again is a new finding: what is hashed is the row as found.
  const again = [];
  withSignatures([{ ...edited, page: 'A10' }], keyring, again);
  assert.notEqual(again[0].finding, reports[1].finding);
});

test('a signed event takes its data from the envelope, whatever the row held beside it', () => {
  const [e] = withSignatures([{ ...sealedRow(FIELDS), afterExtraction: true }], keyring);
  assert.deepEqual(e.data, FIELDS.data);
  assert.equal(e.text, null);
  assert.equal(e.afterExtraction, true, 'what the store knows of the row itself is kept');
});

test('canonical sorts keys at every depth and drops nothing else', () => {
  assert.equal(canonical({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: null } }), '{"a":{"c":null,"d":[2,{"y":2,"z":1}]},"b":1}');
  assert.equal(canonical(null), 'null');
});

// ---------------------------------------------------------------- where the key comes from
const pem = () => generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' });
const noFile = () => { throw Object.assign(new Error('no'), { code: 'ENOENT' }); };

test('a lasting store refuses to start without a key, naming the variable and the command', () => {
  assert.throws(() => loadSigner({}, noFile, true),
    (e) => /HOLDRIM_SIGNING_KEY/.test(e.message) && /holdrim key new <file>/.test(e.message));
});

test('a store in memory gets a throwaway key when none is set, and a set one otherwise', () => {
  const a = loadSigner({}, noFile, false);
  const b = loadSigner({}, noFile, false);
  assert.equal(a.ephemeral, true);
  assert.notEqual(a.signer.kid, b.signer.kid, 'made up fresh, never a fixed key every checkout shares');
  const key = pem();
  const set = loadSigner({ HOLDRIM_SIGNING_KEY: key }, noFile, false);
  assert.equal(set.ephemeral, false);
  assert.equal(set.signer.kid, signerOf(parsePrivateKey(key)).kid);
});

test('the key comes from the variable or the file, never both, and a bad one names no secret', () => {
  const key = pem();
  const kid = signerOf(parsePrivateKey(key)).kid;
  assert.equal(loadSigner({ HOLDRIM_SIGNING_KEY: key }, noFile, true).signer.kid, kid);
  assert.equal(loadSigner({ HOLDRIM_SIGNING_KEY_FILE: '/k' }, (p) => (p === '/k' ? key : noFile()), true).signer.kid, kid);
  // One line of base64 DER, for an environment that takes no newlines.
  const der = parsePrivateKey(key).export({ type: 'pkcs8', format: 'der' });
  assert.equal(loadSigner({ HOLDRIM_SIGNING_KEY: der.toString('base64url') }, noFile, true).signer.kid, kid);
  assert.equal(loadSigner({ HOLDRIM_SIGNING_KEY: der.toString('base64') }, noFile, true).signer.kid, kid);

  assert.throws(() => loadSigner({ HOLDRIM_SIGNING_KEY: key, HOLDRIM_SIGNING_KEY_FILE: '/k' }, () => key, true), /both/);
  assert.throws(() => loadSigner({ HOLDRIM_SIGNING_KEY: '' }, noFile, false), /HOLDRIM_SIGNING_KEY is empty/);
  assert.throws(() => loadSigner({ HOLDRIM_SIGNING_KEY_FILE: '' }, noFile, true), /names no file/);
  assert.throws(() => loadSigner({ HOLDRIM_SIGNING_KEY_FILE: '/missing' }, noFile, true), /could not be read \(ENOENT\)/);
  const secretish = 'MC4CAQAwBQYDK2VwBCIEIDEFINITELYNOTAKEYATALLxxxxxxxxxxxxxxxxxxx';
  assert.throws(() => loadSigner({ HOLDRIM_SIGNING_KEY: secretish }, noFile, true),
    (e) => /does not hold an Ed25519 private key/.test(e.message) && !e.message.includes(secretish));
  const rsa = generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
  assert.throws(() => loadSigner({ HOLDRIM_SIGNING_KEY: rsa }, noFile, true), /an rsa key, not Ed25519/);
});

test('the keyring trusts its own key and every key HOLDRIM_PUBLIC_KEYS names, by a derived kid', () => {
  const ring = loadKeyring({ HOLDRIM_PUBLIC_KEYS: ` ${other.publicKey} ; ` }, signer);
  assert.deepEqual([...ring.keys()].sort(), [signer.kid, other.kid].sort());
  // Computed here, independently of kidOf: the first 16 hex of SHA-256 over the SPKI DER.
  const pub = ring.get(other.kid);
  assert.equal(other.kid, createHash('sha256').update(pub.export({ type: 'spki', format: 'der' })).digest('hex').slice(0, 16));
  assert.equal(kidOf(pub), other.kid);
  assert.equal(publicKeyText(pub), other.publicKey);
  assert.equal(loadKeyring({}).size, 0, 'a reader with nothing set trusts nothing');
  assert.throws(() => loadKeyring({ HOLDRIM_PUBLIC_KEYS: `${other.publicKey};not-a-key` }), /entry 2 of 2/);
  assert.equal(namesPublicKeys({ HOLDRIM_PUBLIC_KEYS: ' ; ' }), false);
  assert.equal(namesPublicKeys({ HOLDRIM_PUBLIC_KEYS: other.publicKey }), true);
});

// ---------------------------------------------------------------- holdrim key new
test('key new writes a PEM readable by its owner alone, and never overwrites one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'holdrim-key-'));
  const file = join(dir, 'signing.key');
  const { publicKey, kid } = newKey(file);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const made = signerOf(parsePrivateKey(readFileSync(file, 'utf8')));
  assert.equal(made.publicKey, publicKey);
  assert.equal(made.kid, kid);
  assert.throws(() => newKey(file), /already exists, and a signing key is never overwritten/);
  assert.equal(signerOf(parsePrivateKey(readFileSync(file, 'utf8'))).kid, kid, 'the first key is still there');
});

test('holdrim key new, run as a person runs it, prints the public key and not the private one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'holdrim-key-cli-'));
  const file = join(dir, 'k.pem');
  const r = spawnSync(process.execPath, [join(ROOT, 'engine/cli/holdrim.ts'), 'key', 'new', file], { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const line = r.stdout.split('\n').find((l) => l.startsWith('HOLDRIM_PUBLIC_KEYS='));
  const key = readFileSync(file, 'utf8');
  assert.equal(line, `HOLDRIM_PUBLIC_KEYS=${signerOf(parsePrivateKey(key)).publicKey}`);
  assert.ok(!r.stdout.includes('PRIVATE KEY') && !r.stdout.includes(key.split('\n')[1]), 'the private key stays in the file');
  const again = spawnSync(process.execPath, [join(ROOT, 'engine/cli/holdrim.ts'), 'key', 'new', file], { cwd: dir, encoding: 'utf8' });
  assert.equal(again.status, 1);
  const usage = spawnSync(process.execPath, [join(ROOT, 'engine/cli/holdrim.ts'), 'key'], { cwd: dir, encoding: 'utf8' });
  assert.equal(usage.status, 2);
  assert.match(usage.stderr, /usage: holdrim key new <file>/);
  // A folder whose holdrim.json would refuse every other command still makes a key.
  writeFileSync(join(dir, 'holdrim.json'), JSON.stringify({ owner: 'someone@example.org' }));
  const refusing = spawnSync(process.execPath, [join(ROOT, 'engine/cli/holdrim.ts'), 'key', 'new', join(dir, 'k2.pem')],
    { cwd: dir, encoding: 'utf8' });
  assert.equal(refusing.status, 0, refusing.stderr);
  assert.ok(existsSync(join(dir, 'k2.pem')));
});
