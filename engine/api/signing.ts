import {
  createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject,
} from 'node:crypto';
import { findingOf, type TamperReport } from './texts.ts';

/**
 * Events signed by the server (docs/PRIVACY.md, section 3; SECURITY.md, "The signing key").
 *
 * Every event a store writes is sealed here, at the one moment every field of it is known — its id,
 * its time, its author's person id, the salted hashes of its texts and its `data` — and every reader
 * checks the seal before an event counts for anything. Whoever can write the store directly can
 * insert a row, but not a signature: the private key lives in the server's environment alone, never
 * in the store, the log or the repository. So a ✓ written straight into the file is shown, marked as
 * not signed, and is no lock; a `request_state` written the same way queues nothing for the agent.
 *
 * Ed25519, from `node:crypto`, and no new dependency. Asymmetric on purpose: `holdrim sync` checks
 * events on a developer's machine, and with a shared secret (an HMAC) every machine that checks
 * could also mint — the split between whoever reads and whoever deploys that the rest of the engine
 * keeps. Ed25519 has no parameters to choose wrong, signs deterministically (no randomness at sign
 * time to go bad) and fits a key on one line.
 *
 * **The envelope is stored as it was signed, and verified as stored.** A reader never rebuilds it
 * from the row's columns: three stores and two CLI readers would each have to serialize a map, a
 * timestamp and a null identically, forever, and the day one of them drifted every event would read
 * as forged — or, worse, one forged row would read as signed. Instead the columns are an index of
 * the envelope: a reader verifies the envelope, takes the event from it, and treats any column that
 * disagrees with it as a forgery. `kid` names the key that signed, so a reader asks exactly that key
 * and never tries each one it knows.
 *
 * What the signature does not cover, on purpose: the people table (a person's e-mail must stay
 * removable, and signing it would put it into an event nothing can empty — docs/PRIVACY.md, sections
 * 1 and 5), and the texts, which the event binds through their salted hashes instead, so a text can
 * still be removed and a hash rewritten still fails. What it cannot show: that a genuine event was
 * deleted. That needs a signed sequence (SECURITY.md, "Known limits").
 */

/** Names what the bytes are before anything else in them, so a signature over one kind of message
 *  is never mistaken for a signature over another. */
export const ENVELOPE_TAG = 'holdrim-event';
/** The envelope's shape. A version this reader does not know is not guessed at: it is not signed. */
export const ENVELOPE_VERSION = 1;

/** Every field of an event the signature binds, exactly as the store keeps it. */
export interface Sealable {
  id: string;
  type: string;
  page: string;
  block: string | null;
  fingerprint: string | null;
  textHash: string | null;
  snapshotHash: string | null;
  /** The person's id as stored, never an address: the id→address link is the people table's. */
  author: string;
  when: string;
  data: Record<string, unknown> | null;
}

/** What a store writes beside an event's columns. */
export interface Seal {
  envelope: string;
  sig: string;
  kid: string;
}

/** Signs. The private key stays in its closure: nothing reads it back out of a `Signer`. */
export interface Signer {
  readonly kid: string;
  /** The public half, as `HOLDRIM_PUBLIC_KEYS` takes it: SPKI DER in base64url, one line. */
  readonly publicKey: string;
  sign(message: string): string;
}

/** The public keys a reader trusts, by `kid`. */
export type Keyring = ReadonlyMap<string, KeyObject>;

/** What a server store is built with: the key it signs with, and the keys it reads with. */
export interface Signing {
  signer: Signer;
  keyring: Keyring;
}

// ---------------------------------------------------------------- keys

/**
 * A key's id: the first 16 hex characters of the SHA-256 of its public half. Derived, never chosen,
 * so an event cannot name one key and be checked by another, and two deployments cannot collide on a
 * label somebody typed.
 */
export function kidOf(publicKey: KeyObject): string {
  return createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex').slice(0, 16);
}

/** The public key as one line: what the boot log prints and `HOLDRIM_PUBLIC_KEYS` takes. */
export function publicKeyText(publicKey: KeyObject): string {
  return publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
}

/** A PEM block, or one line of base64 (either alphabet) holding DER. Nothing else is a key here. */
const BASE64 = /^[A-Za-z0-9+/_-]+={0,2}$/;

function parseKey(text: string, kind: 'private' | 'public'): KeyObject {
  const t = text.trim();
  let key: KeyObject;
  if (t.startsWith('-----BEGIN')) {
    key = kind === 'private' ? createPrivateKey(t) : createPublicKey(t);
  } else {
    if (!BASE64.test(t)) throw new Error('not PEM and not base64');
    const der = Buffer.from(t, 'base64');
    key = kind === 'private'
      ? createPrivateKey({ key: der, format: 'der', type: 'pkcs8' })
      : createPublicKey({ key: der, format: 'der', type: 'spki' });
  }
  // A valid key of another algorithm would sign and verify just the same, under rules this file
  // never chose: RSA without a padding named here, or a curve with parameters to get wrong.
  if (key.asymmetricKeyType !== 'ed25519') throw new Error(`an ${key.asymmetricKeyType} key, not Ed25519`);
  return key;
}

/** An Ed25519 private key, from PEM (what `holdrim key new` and `openssl genpkey` write) or base64 PKCS8. */
export function parsePrivateKey(text: string): KeyObject {
  return parseKey(text, 'private');
}

/** An Ed25519 public key, from base64 SPKI (what the boot log prints) or PEM. */
export function parsePublicKey(text: string): KeyObject {
  return parseKey(text, 'public');
}

export function signerOf(privateKey: KeyObject): Signer {
  const publicKey = createPublicKey(privateKey);
  return {
    kid: kidOf(publicKey),
    publicKey: publicKeyText(publicKey),
    sign: (message: string) => sign(null, Buffer.from(message, 'utf8'), privateKey).toString('base64url'),
  };
}

/** A fresh key pair: the private key as PEM, for a file, and the public key as one line. */
export function newKeyPair(): { privatePem: string; publicKey: string; kid: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
    publicKey: publicKeyText(publicKey),
    kid: kidOf(publicKey),
  };
}

/** The line every refusal to load a key ends on: the one command that makes one. */
const HOW_TO_MAKE_ONE = 'Make one with  holdrim key new <file>  (or  openssl genpkey -algorithm ed25519 -out <file>), '
  + 'and set HOLDRIM_SIGNING_KEY_FILE to that file, or HOLDRIM_SIGNING_KEY to its contents (SECURITY.md, "The signing key").';

/**
 * The key this process signs with, from where the deployment put it — or a throwaway one, only when
 * nothing this process writes outlives it.
 *
 * `lasting` is whether the events store keeps anything past this process (a SQLite file, Firestore).
 * Such a store refuses to start without a key: a key made up here and kept beside the store would be
 * readable by exactly the person signing exists to stop, and one made up and thrown away would leave
 * every event signed today unverifiable tomorrow. A store in memory dies with the process, and so
 * may its key: `run-local.sh` and the tests start with no setup at all, which is their promise.
 *
 * Never echoes a value it was given: a refusal names the variable and what is wrong with it, since
 * a message quoting a half-pasted private key is a private key in a log.
 */
export function loadSigner(
  env: Record<string, string | undefined>, readFile: (path: string) => string, lasting: boolean,
): { signer: Signer; ephemeral: boolean } {
  const inline = env.HOLDRIM_SIGNING_KEY;
  const file = env.HOLDRIM_SIGNING_KEY_FILE;
  if (inline !== undefined && file !== undefined) {
    throw new Error('both HOLDRIM_SIGNING_KEY and HOLDRIM_SIGNING_KEY_FILE are set: set one, so there is no '
      + 'question which key signs');
  }
  if (inline === undefined && file === undefined) {
    if (lasting) {
      throw new Error('the events store keeps what it writes, and no signing key is set: every event is signed '
        + `with a key only this server holds, so a row written into the store directly is no lock. ${HOW_TO_MAKE_ONE}`);
    }
    const { privateKey } = generateKeyPairSync('ed25519');
    return { signer: signerOf(privateKey), ephemeral: true };
  }
  const variable = inline !== undefined ? 'HOLDRIM_SIGNING_KEY' : 'HOLDRIM_SIGNING_KEY_FILE';
  let text: string;
  if (inline !== undefined) {
    text = inline;
  } else {
    if (file!.trim() === '') throw new Error(`HOLDRIM_SIGNING_KEY_FILE is empty and names no file. ${HOW_TO_MAKE_ONE}`);
    try {
      text = readFile(file!);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      throw new Error(`HOLDRIM_SIGNING_KEY_FILE names ${file}, which could not be read${code ? ` (${code})` : ''}`);
    }
  }
  if (text.trim() === '') throw new Error(`${variable} is empty. ${HOW_TO_MAKE_ONE}`);
  try {
    return { signer: signerOf(parsePrivateKey(text)), ephemeral: false };
  } catch (error) {
    // The reason from the parser, never the text: see the doc comment.
    throw new Error(`${variable} does not hold an Ed25519 private key (${(error as Error).message}). ${HOW_TO_MAKE_ONE}`);
  }
}

/**
 * The public keys a reader trusts: every one `HOLDRIM_PUBLIC_KEYS` names, `;` separated as
 * `HOLDRIM_AGENTS` is, plus `own` — the server's own signing key, which it trusts without being told.
 * Only from the environment where the reader runs: never from `holdrim.json`, which whoever commits
 * can edit (`AUTHORITY_KEYS`, engine/core/config.js), and never from the store, whose writer would
 * add their own. An entry that is not a key refuses, naming its place in the list: skipping it would
 * leave an operator's rotation silently half done, every event of the key they meant to keep read
 * as not signed.
 */
export function loadKeyring(env: Record<string, string | undefined>, own?: Signer): Map<string, KeyObject> {
  const ring = new Map<string, KeyObject>();
  if (own) ring.set(own.kid, parsePublicKey(own.publicKey));
  const listed = (env.HOLDRIM_PUBLIC_KEYS ?? '').split(';').map((s) => s.trim()).filter(Boolean);
  for (const [i, text] of listed.entries()) {
    let key: KeyObject;
    try {
      key = parsePublicKey(text);
    } catch (error) {
      throw new Error(`HOLDRIM_PUBLIC_KEYS, entry ${i + 1} of ${listed.length}, is not an Ed25519 public key `
        + `(${(error as Error).message}): copy it from the server's boot log, or from GET /api/signing-keys`);
    }
    ring.set(kidOf(key), key);
  }
  return ring;
}

/** Whether `HOLDRIM_PUBLIC_KEYS` names any key at all — what `sync`, `apply` and `state` ask first. */
export function namesPublicKeys(env: Record<string, string | undefined>): boolean {
  return (env.HOLDRIM_PUBLIC_KEYS ?? '').split(';').some((s) => s.trim() !== '');
}

// ---------------------------------------------------------------- the envelope

/**
 * `value` with every object's keys sorted, at every depth. Only ever compared with another output
 * of this same function — the envelope a store signed, a row a reader holds — so what matters is
 * that one value always gives one string. (JavaScript lists integer-like keys first whatever the
 * order they were set in; that is still one string per value.)
 */
function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value).sort()) {
      const v = (value as Record<string, unknown>)[k];
      if (v !== undefined) out[k] = sorted(v);
    }
    return out;
  }
  return value;
}

export function canonical(value: unknown): string {
  return JSON.stringify(sorted(value) ?? null);
}

/**
 * The bytes signed, as a JSON array: a fixed order, so no field can move into another's place, and
 * the tag and the version first.
 */
function envelopeOf(f: Sealable): string {
  return JSON.stringify([ENVELOPE_TAG, ENVELOPE_VERSION, f.id, f.type, f.page, f.block, f.fingerprint,
    f.textHash, f.snapshotHash, f.author, f.when, sorted(f.data ?? null)]);
}

/** Seals one event. Called by each store's write, after every field in `fields` is final. */
export function seal(fields: Sealable, signer: Signer): Seal {
  const envelope = envelopeOf(fields);
  return { envelope, sig: signer.sign(envelope), kid: signer.kid };
}

/**
 * Seals an event as a store is about to write it: `e` as `stored()` (types.ts) built it, its author
 * already the person's id, and `hashes` the salted hashes `saltFields` (texts.ts) gave its texts —
 * the one place every store turns its row into the fields signed, so no store can sign a field
 * another leaves out.
 */
export function sealEvent(
  e: { id: string; type: string; page: string; block?: string | null; fingerprint?: string | null; author: string;
       when: string; data?: Record<string, unknown> | null },
  hashes: { text: string | null; snapshot: string | null }, signer: Signer,
): Seal {
  return seal({ id: e.id, type: e.type, page: e.page, block: e.block ?? null, fingerprint: e.fingerprint ?? null,
    textHash: hashes.text, snapshotHash: hashes.snapshot, author: e.author, when: e.when, data: e.data ?? null }, signer);
}

const nullableString = (v: unknown) => v === null || typeof v === 'string';

/** The envelope read back into fields, or null for anything that is not exactly version 1's shape. */
function fieldsOf(envelope: string): Sealable | null {
  let a: unknown;
  try { a = JSON.parse(envelope); } catch { return null; }
  if (!Array.isArray(a) || a.length !== 12 || a[0] !== ENVELOPE_TAG || a[1] !== ENVELOPE_VERSION) return null;
  const [, , id, type, page, block, fingerprint, textHash, snapshotHash, author, when, data] = a;
  if (typeof id !== 'string' || typeof type !== 'string' || typeof page !== 'string' || typeof author !== 'string'
    || typeof when !== 'string' || ![block, fingerprint, textHash, snapshotHash].every(nullableString)
    || !(data === null || (typeof data === 'object' && !Array.isArray(data)))) return null;
  return { id, type, page, block, fingerprint, textHash, snapshotHash, author, when, data };
}

// ---------------------------------------------------------------- verifying

/** A row as a reader holds it: the event's columns, and the three the seal left beside them. */
export interface SealedRow {
  id: string;
  type: string;
  page: string;
  block?: string | null;
  fingerprint?: string | null;
  text?: string | null;
  snapshot?: string | null;
  textHash?: string | null;
  snapshotHash?: string | null;
  author: string;
  when: string;
  data?: Record<string, unknown> | null;
  // Of whatever type the store holds: a direct writer to Firestore can put a map where a string
  // goes, and `verifyRow` answers "forged" for it rather than trusting a type it never checked.
  envelope?: unknown;
  sig?: unknown;
  kid?: unknown;
}

/** Not signed: no seal at all, or one that does not hold. The reason is English, for the log. */
export type SignatureKind = 'unsigned' | 'forged';

export type Verdict =
  | { signed: true; kid: string; fields: Sealable }
  | { signed: false; kind: SignatureKind; reason: string };

/**
 * Seals already checked, per key. Events never change, so a seal that verified once verifies again,
 * and without this a whole-site read pays one Ed25519 check per event on every request — about a
 * tenth of a millisecond each, seconds for a long history. Only successes are kept, keyed by the key
 * object itself, so a reader with another keyring — a key retired — never inherits an answer given
 * under a key it does not hold. An entry is a digest of the signature AND the envelope together: a
 * memo keyed by the signature alone would accept a genuine signature beside a forged envelope.
 */
const verified = new WeakMap<KeyObject, Set<string>>();
/**
 * A ceiling on the memo, per key: past it the memo starts over, which costs time, never an answer.
 * Well above any history a whole-site read already holds in memory on every request.
 */
const MEMO_CEILING = 1_000_000;

function checks(key: KeyObject, envelope: string, sig: string): boolean {
  const memo = verified.get(key) ?? new Set<string>();
  const entry = createHash('sha256').update(sig, 'utf8').update('\n').update(envelope, 'utf8').digest('base64');
  if (memo.has(entry)) return true;
  let ok = false;
  try {
    ok = verify(null, Buffer.from(envelope, 'utf8'), key, Buffer.from(sig, 'base64url'));
  } catch {
    ok = false; // a signature of the wrong length, say: not signed, never a crash of the read
  }
  if (ok) {
    if (memo.size >= MEMO_CEILING) memo.clear();
    memo.add(entry);
    verified.set(key, memo);
  }
  return ok;
}

/** The columns a row carries that the envelope also says, compared one by one. */
const COLUMNS = ['id', 'type', 'page', 'block', 'fingerprint', 'textHash', 'snapshotHash', 'author', 'when'] as const;

/**
 * Whether a row is an event this deployment's server signed, and if so, the event its envelope
 * says. Three things, in this order, each failing closed:
 *
 * 1. the key the row names is one this reader trusts — by `kid`, and only that key is asked;
 * 2. the signature holds over the envelope exactly as stored;
 * 3. every column the row carries agrees with the envelope — a row whose `page`, `when`, `data` or
 *    `author` was changed beside a genuine envelope is a forgery, not the envelope's event with a
 *    harmless difference. `text` and `snapshot` must be empty: a signed event keeps its texts by
 *    hash, so a value written into the row itself is not the event's.
 *
 * Never throws: a malformed row is an answer ("forged"), and a reader that crashed on one would let
 * a single bad row hide every good one.
 */
export function verifyRow(row: SealedRow, keyring: Keyring): Verdict {
  const { envelope, sig, kid } = row;
  if (envelope == null && sig == null && kid == null) return { signed: false, kind: 'unsigned', reason: 'no signature' };
  if (typeof envelope !== 'string' || typeof sig !== 'string' || typeof kid !== 'string') {
    return { signed: false, kind: 'forged', reason: 'an incomplete signature' };
  }
  const key = keyring.get(kid);
  if (!key) return { signed: false, kind: 'forged', reason: `signed by key ${kid.slice(0, 32)}, which this reader does not trust` };
  if (!checks(key, envelope, sig)) return { signed: false, kind: 'forged', reason: 'a signature that does not verify' };
  const fields = fieldsOf(envelope);
  if (!fields) return { signed: false, kind: 'forged', reason: 'an envelope of a shape this version does not read' };
  for (const c of COLUMNS) {
    if ((row[c] ?? null) !== fields[c]) return { signed: false, kind: 'forged', reason: `its ${c} disagrees with what was signed` };
  }
  if (canonical(row.data ?? null) !== canonical(fields.data)) {
    return { signed: false, kind: 'forged', reason: 'its data disagrees with what was signed' };
  }
  if (row.text != null || row.snapshot != null) {
    return { signed: false, kind: 'forged', reason: 'a text inside a signed event, which keeps its texts by hash' };
  }
  return { signed: true, kid, fields };
}

/** What a report of an unsigned event hashes: the row as found, so rewriting it is a new finding. */
function observedRow(row: SealedRow): string {
  const { id, type, page, block, fingerprint, text, snapshot, textHash, snapshotHash, author, when, data, envelope, sig, kid } = row;
  return createHash('sha256').update(canonical({ id, type, page, block, fingerprint, text, snapshot, textHash,
    snapshotHash, author, when, data, envelope, sig, kid }), 'utf8').digest('hex');
}

/**
 * Every row, verified: `signed: true` with its fields from the envelope, or `signed: false` with the
 * row as found and one report each, for `reportTampered` to raise (engine/api/texts.ts) — CRITICAL,
 * like a text that fails its hash, since in a store where every genuine event is signed, one that is
 * not was written from outside the product. Readers show it, marked, and give it no authority
 * (`isLocked`, `authorCouldTriage` and the rest, engine/api/types.ts): hidden, it would hide the
 * evidence of the forgery. `envelope`, `sig` and `kid` never leave: what a reader needs is `signed`.
 *
 * Runs on rows as stored — `author` still the person's id — before `withAuthors` resolves anybody.
 */
export function withSignatures<R extends SealedRow>(
  rows: R[], keyring: Keyring, reports?: TamperReport[],
): (Omit<R, 'envelope' | 'sig' | 'kid'> & { signed: boolean })[] {
  return rows.map((row) => {
    const { envelope: _e, sig: _s, kid: _k, ...rest } = row;
    const verdict = verifyRow(row, keyring);
    if (verdict.signed) return { ...rest, ...verdict.fields, text: null, snapshot: null, signed: true };
    reports?.push({ event: row.id, field: 'event', kind: verdict.kind, reason: verdict.reason,
      finding: findingOf(row.id, 'event', verdict.kind, observedRow(row)) });
    return { ...rest, signed: false };
  });
}
