import { writeFileSync } from 'node:fs';
import { newKeyPair } from '../api/signing.ts';

/**
 * `holdrim key new <file>`: the signing key a deployment needs before its store will start
 * (engine/api/signing.ts, `loadSigner`), made in one tested step rather than a pipe of tools that
 * differ per operating system.
 *
 * The private key goes to `file` and nowhere else — not to the terminal, where it would sit in a
 * scrollback and a shell history — readable by its owner alone (0600), and a file already there is
 * never overwritten: replacing a deployment's key by accident leaves every event it signed without
 * the key that verifies it. The public half is printed, since it is no secret and every reader needs
 * it in `HOLDRIM_PUBLIC_KEYS`. PEM, so `openssl pkey -in <file> -pubout` reads it too.
 */
export function newKey(file: string): { publicKey: string; kid: string } {
  const pair = newKeyPair();
  try {
    // `wx`: created here or refused, in one step, so no check-then-write gap lets another file in.
    writeFileSync(file, pair.privatePem, { mode: 0o600, flag: 'wx' });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') {
      throw new Error(`${file} already exists, and a signing key is never overwritten: the events it signed would `
        + 'lose the key that verifies them. Choose another file (SECURITY.md, "Rotating the signing key").');
    }
    throw new Error(`could not write ${file}${code ? ` (${code})` : ''}`);
  }
  return { publicKey: pair.publicKey, kid: pair.kid };
}

/** What `holdrim key new` prints: where the key went, and the two lines a deployment copies. */
export function keyCommand(action: string | undefined, file: string | undefined): number {
  if (action !== 'new' || !file) {
    console.error('usage: holdrim key new <file>   — writes a new signing key to <file>, and prints its public half');
    return 2;
  }
  const { publicKey, kid } = newKey(file);
  console.log(`✓ a new signing key, in ${file} (readable by you alone). Keep it out of the repository and out of `
    + 'the store\'s own volume: whoever holds it can sign a lock.');
  console.log(`  key id: ${kid}`);
  console.log(`  the server signs with it:  HOLDRIM_SIGNING_KEY_FILE=${file}   (or HOLDRIM_SIGNING_KEY="$(cat ${file})")`);
  console.log('  and every machine that runs holdrim sync, list or apply trusts it with:');
  console.log(`HOLDRIM_PUBLIC_KEYS=${publicKey}`);
  return 0;
}
