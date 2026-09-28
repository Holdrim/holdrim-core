/**
 * A signing key for the tests, made once per process, and the keyring that trusts it.
 *
 * Every store is built with a signer and a keyring, and there is no default (engine/api/signing.ts
 * says why), so each test hands the store this pair — or, to prove a key is NOT trusted, `other`.
 */
import { generateKeyPairSync } from 'node:crypto';
import { signerOf, loadKeyring, seal } from '../../api/signing.ts';

export const signer = signerOf(generateKeyPairSync('ed25519').privateKey);
export const keyring = loadKeyring({}, signer);
/** What a server store takes. */
export const signing = { signer, keyring };

/** A second key, trusted by nobody unless a test says so. */
export const other = signerOf(generateKeyPairSync('ed25519').privateKey);

/**
 * A row as a store would keep it, sealed by `by` (this file's `signer` unless told otherwise): what a
 * test inserts into a file or hands a reader to prove what a genuine event reads as.
 */
export function sealedRow(fields, by = signer) {
  const full = {
    block: null, fingerprint: null, textHash: null, snapshotHash: null, data: null, ...fields,
  };
  return { ...full, text: null, snapshot: null, ...seal(full, by) };
}
