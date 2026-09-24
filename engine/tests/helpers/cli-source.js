/**
 * The commands and flags of `holdrim`, read from its source.
 *
 * Read as text rather than imported: `engine/cli/holdrim.ts` runs `main()` and exits the process
 * the moment it is loaded, so there is no module to ask. Shared, because two suites need the same
 * answer — the docs check that every `holdrim <command>` they name exists, and the surface lock
 * checks that no command or flag appears or disappears unannounced — and two parsers of one switch
 * would drift until one of them read a command the other had lost.
 *
 * What the reading would miss: a command dispatched any other way than a `case '…':` of that
 * switch, and a flag declared outside the `options` block handed to `parseArgs`.
 */
import { readFileSync } from 'node:fs';

const SOURCE = readFileSync(new URL('../../cli/holdrim.ts', import.meta.url), 'utf8');

/** Every `holdrim <command>`, as the switch in `main()` dispatches it. */
export const CLI_COMMANDS = new Set([...SOURCE.matchAll(/case '([a-z-]+)':/g)].map((m) => m[1]));

/**
 * Every flag `parseArgs` accepts, spelled as a person types it: `--name`, and `-x` for a short one.
 * An unknown flag is refused by `parseArgs`, so this list is exactly what a script may pass.
 */
export const CLI_FLAGS = (() => {
  const block = SOURCE.split(/\boptions:\s*\{/)[1]?.split(/\n\s*\},\n/)[0] ?? '';
  const flags = new Set();
  for (const [, quoted, bare, body] of block.matchAll(/^\s*(?:'([a-z-]+)'|([a-z]+)):\s*\{([^}]*)\}/gm)) {
    flags.add(`--${quoted ?? bare}`);
    const short = /short:\s*'([a-z])'/.exec(body)?.[1];
    if (short) flags.add(`-${short}`);
  }
  return flags;
})();
