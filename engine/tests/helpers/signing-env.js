/**
 * The signing key a contract server was started with, for a script that writes to the same store
 * directly (engine/test-contract.sh): what the store signs with, read the way the server reads it,
 * from `HOLDRIM_SIGNING_KEY_FILE` or `HOLDRIM_SIGNING_KEY`.
 */
import { readFileSync } from 'node:fs';
import { loadSigner, loadKeyring } from '../../api/signing.ts';

export function signingFromEnv() {
  const { signer } = loadSigner(process.env, (path) => readFileSync(path, 'utf8'), true);
  return { signer, keyring: loadKeyring(process.env, signer) };
}
