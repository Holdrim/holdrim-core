import { readFileSync, writeFileSync, existsSync, openSync, closeSync, fsyncSync, renameSync, unlinkSync,
  lstatSync, statSync, chmodSync, accessSync, constants } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { randomBytes } from 'node:crypto';
import { parseHTML } from 'linkedom';
import { fingerprintOfText } from '../core/fingerprint.js';
import { readBlocks, sheetFiles, resolveBlock, locateBlocks, digestOf, fingerprintsByPage, parsePage, spliceAttributes, spliceAll, attributeText, textOf, shortName, ofProject, projectRoles,
  namesNotLowerCase, browserIdOf, browserBlocks, type Block, type Stamp, type MarkPlan } from './pages.ts';
import { trafficLight, dependentsOf, radiusOf, COLOURS } from '../core/validity.js';
import { layerOf } from '../core/kinds.js';
import { createRoles } from '../core/roles.js';
import { Source } from './remote.ts';
import { isLocked, earliestLockBaseline } from '../api/types.ts';
import { suspectsOf } from '../api/texts.ts';
import { warnOfTampering, refuseToActOnBrokenGuards } from './requests.ts';

/**
 * The validation lock: an approved block does not change without permission, and no approval mark
 * exists without a trail.
 *
 * The most critical piece of the method — it decides whether a human approval still holds.
 *
 * ⚠️ Everything printed from here is English, and deliberately NOT routed through
 * `engine/core/i18n.js`. The reader of these lines is whoever operates the tool, and the line they
 * read is also the line they paste into a report and grep for months later. Evidence that changes
 * wording by locale is evidence nobody can search. The reviewer's own language lives in the
 * browser, not here.
 */

/**
 * The approvals registry, as it sits on disk in the adopting project.
 *
 * Its entries carry the same names the core reads (`fingerprint`, `dependsOn`), so
 * `trafficLight` takes the registry as it is. Two vocabularies bridged by a cast would type-check
 * and then hand the core an object whose fingerprint is `undefined` — every validated block read
 * as stale, forever. One vocabulary is the fix, not a better cast.
 */
export interface Registry {
  [id: string]: { file: string; date: string; fingerprint: string; source?: string; event?: string;
                  text?: string;
                  /** The fingerprint EACH dependency had at the moment of the ✓. Without this there is
                   *  no way to tell later that the base moved — the block's own fingerprint stays silent. */
                  dependsOn?: Record<string, string> };
}

/**
 * Where the approval registry lives. It comes from `holdrim.json` (`content.registry`), not from
 * the code: a fixed file name would be one project's decision, written inside the engine.
 */
const registryPath = (root: string) =>
  join(root, ...ofProject(root)
    .registry.split('/'));

export function loadRegistry(root: string): Registry {
  const p = registryPath(root);
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {};
}

/**
 * Fsyncs the file already written at `path`: `writeFileSync` hands the bytes to the kernel's page
 * cache and returns, so without this a rename right after can make the approvals file's name point
 * at data that has not reached disk yet — a crash between the two leaves the next reader with a
 * shorter or garbled file under the name that is supposed to mean "safe".
 */
function fsyncFile(path: string) {
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

/**
 * Fsyncs the directory `dir`. Left to throw whatever `openSync` or `fsyncSync` raise: by the time a
 * caller reaches this, the rename it follows has already succeeded, so there is no "ignorable" code
 * to filter here any more — a platform that cannot do this (Windows refuses the open outright; some
 * filesystems refuse the fsync) and a real failure look the same from here, and `saveRegistry` treats
 * every one of them the same way, as a durability warning rather than a lost write.
 */
function fsyncDir(dir: string) {
  const fd = openSync(dir, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

/**
 * Writes the registry to a temp file beside `approvals.json`, fsyncs it, then renames it over the
 * real name — a reader (this process' own `loadRegistry`, or a person's editor) sees the old file or
 * the new one, in full, never a partial write from a process killed in the middle of it (holdrim#150).
 * A plain `writeFileSync` on the real name is truncated the moment the write starts; every owner ✓
 * recorded in it is then gone until somebody recovers it from git.
 *
 * `interrupt` is the seam a test throws from, between the temp write and the rename, to prove the
 * real file is untouched and the temp file cleaned up when that happens — a no-op by default, the
 * same shape `Verifier` in pages.ts takes for the same reason: a real caller never supplies one.
 */
export function saveRegistry(root: string, registry: Registry, interrupt: () => void = () => {}) {
  const sorted: Registry = {};
  for (const k of Object.keys(registry).sort()) sorted[k] = registry[k];
  const path = registryPath(root);
  const dir = dirname(path);
  const existing = existsSync(path);

  if (existing) {
    // A link is not followed: the rename below would replace the LINK ITSELF with a plain file, and
    // whatever it used to point at — a registry shared between two checkouts, say — would keep
    // whatever it last held forever. The same reason `exportSite` refuses a symlinked `out` rather
    // than write through it.
    if (lstatSync(path).isSymbolicLink()) {
      throw new Error(`refusing to save ${path}: it is a link, and a link is not followed`);
    }
    // A registry made read-only on purpose (0444, to mark "do not touch by hand") used to refuse
    // with EACCES the instant the old in-place write tried to open it. A rename only needs the
    // DIRECTORY to be writable, never its target, so that refusal has to be made explicit here or
    // the fresh temp file would silently land in place of a file nobody meant to be overwritten.
    try {
      accessSync(path, constants.W_OK);
    } catch {
      throw Object.assign(new Error(`EACCES: permission denied, open '${path}'`), { code: 'EACCES', path });
    }
  }

  // Same folder as the target: a rename is only atomic within one filesystem, and a temp directory
  // elsewhere could sit on a different one. pid and randomness only need to keep two runs writing at
  // once from choosing the SAME name — the two are still two different files, so neither can ever
  // see the other's half-written bytes. `sheetFiles` only ever reads `.html`, so this name is never
  // mistaken for a page whatever it is called.
  const tmp = join(dir, `.${basename(path)}.${process.pid}-${randomBytes(6).toString('hex')}.tmp`);
  try {
    writeFileSync(tmp, JSON.stringify(sorted, null, 1) + '\n', 'utf8');
    fsyncFile(tmp);
    // A fresh file gets a fresh mode; copying the target's over the temp file before the rename is
    // what keeps whatever an operator set on approvals.json ITSELF, instead of quietly loosening or
    // tightening it to a new file's default every time a sync writes it.
    if (existing) chmodSync(tmp, statSync(path).mode);
    interrupt();
    renameSync(tmp, path);
  } catch (e) {
    // The temp file is this call's own mess to clean up — nothing else will ever look for it by
    // this name. Ignored here because the write itself may be what threw, leaving nothing to remove.
    try { unlinkSync(tmp); } catch { /* nothing to remove */ }
    throw e;
  }
  try {
    fsyncDir(dir);
  } catch (e) {
    // The rename above already succeeded — the new registry IS saved, safely, under its real name.
    // Losing the directory's own metadata flush in a crash is a durability gap, not a lost write, so
    // this is a warning and a normal return, never the error `sync`'s finally reads as "the registry
    // could not be saved" (holdrim#151) — that message has to stay true to what actually happened.
    console.error(`⚠ ${path} was saved, but its folder could not be flushed: ${(e as Error).message}`);
  }
}

/**
 * Flags what changed after being validated, what is marked without a registry entry, and what
 * claims a proof that is no longer on disk.
 */
export async function check(root: string): Promise<number> {
  const registry = loadRegistry(root);
  const blocks = await readBlocks(root);
  let problems = 0;

  for (const [id, entry] of Object.entries(registry).sort()) {
    const block = blocks.get(id);
    if (!block) { console.log(`  ✗ ${id}: the block is gone (${entry.file})`); problems++; continue; }
    if (!block.validated) { console.log(`  ✗ ${id}: it lost the validated mark`); problems++; }
    if (block.fingerprint !== entry.fingerprint) {
      console.log(`  ✗ ${id}: the TEXT changed after it was validated on ${entry.date} — this needs the owner's permission`);
      problems++;
    }
  }
  problems += duplicateIds(root);
  problems += sealMismatches(registry, blocks);
  problems += caseProblems(root);
  problems += await orphanMarks(root, registry);
  problems += missingProofs(root, blocks);
  problems += upwardDependencies(blocks);
  console.log(`${Object.keys(registry).length} validated · ${problems ? `${problems} problem(s)` : 'all intact'}`);
  return problems;
}

/**
 * The page's copy of each ✓ against the registry's: `data-validated-fingerprint` has to be the
 * entry's `fingerprint`, and `data-depended-on` its `dependsOn` (absent and empty alike).
 *
 * The browser paints the traffic light from these attributes alone — the page is static and the
 * panel never reads the registry — so a seal that disagrees with the record shows a colour the
 * record does not back: an old fingerprint paints 🟡 on a block just approved, and a stale snapshot
 * paints 🔴, or hides it. Comparing only the date, as `orphanMarks` does, passes both. Each value is
 * the one a browser reads — the first copy whatever the case of its name — not linkedom's
 * case-sensitive `getAttribute`.
 */
export function sealMismatches(registry: Registry, blocks: Map<string, Block>): number {
  let found = 0;
  for (const [id, entry] of Object.entries(registry).sort(([a], [b]) => a.localeCompare(b))) {
    const block = blocks.get(id);
    if (!block) continue; // `check` already says the block is gone
    const reads = (name: string) => block.seal.find((a) => a.name.toLowerCase() === name)?.value ?? null;

    const fingerprint = reads('data-validated-fingerprint');
    if (fingerprint === null) {
      console.log(`  ✗ ${id}: the page carries no data-validated-fingerprint, and the registry records `
        + `${entry.fingerprint} — without it the browser cannot show that the text drifted`);
      found++;
    } else if (fingerprint !== entry.fingerprint) {
      console.log(`  ✗ ${id}: the page's data-validated-fingerprint (${fingerprint}) is not the registry's `
        + `(${entry.fingerprint}) — the browser paints the traffic light from the page's copy`);
      found++;
    }

    const written = reads('data-depended-on');
    let dependedOn: unknown = {};
    try {
      dependedOn = written === null ? {} : JSON.parse(written);
    } catch {
      dependedOn = null;
    }
    if (!dependedOn || typeof dependedOn !== 'object' || Array.isArray(dependedOn)) {
      console.log(`  ✗ ${id}: the page's data-depended-on is not a JSON object of dependency fingerprints, `
        + 'which is what the browser judges 🔴 from');
      found++;
    } else if (!sameDependencies(dependedOn as Record<string, unknown>, entry.dependsOn ?? {})) {
      console.log(`  ✗ ${id}: the page's data-depended-on (${written ?? 'absent'}) is not the registry's `
        + `dependsOn (${JSON.stringify(entry.dependsOn ?? {})}) — the browser judges 🔴 from the page's copy`);
      found++;
    }
  }
  return found;
}

/** The same dependencies, each with the same fingerprint, whatever order the keys were written in. */
function sameDependencies(page: Record<string, unknown>, recorded: Record<string, string>): boolean {
  const a = Object.keys(page).sort();
  const b = Object.keys(recorded).sort();
  return a.length === b.length && a.every((k, i) => k === b[i] && page[k] === recorded[k]);
}

/**
 * An attribute the engine reads a block by — its id, code, dependencies or seal (`BLOCK_NAMES`) —
 * whose name is not written in lower case, on ANY element of any page, block or not, recorded or not.
 *
 * A browser lowercases attribute names and keeps the first of two that then collide; linkedom keeps
 * the case, and every other read here asks for the lower-case name. So a `DATA-VALIDATED-FINGERPRINT`
 * ahead of the real one is the value the panel paints from, a `DATA-VALIDATED` alone is a seal the
 * page shows, and a `DATA-ID` is a whole block — seal and all — that `readBlocks`, `orphanMarks` and
 * every sweep built on them never see. Every element, not only `readBlocks`' blocks: those are exactly
 * the ones selected by the lower-case name. Named by the id a browser reads there, or by its page.
 */
export function caseProblems(root: string): number {
  let found = 0;
  for (const path of sheetFiles(root)) {
    const { document } = parseHTML(readFileSync(path, 'utf8'));
    for (const el of document.querySelectorAll('*')) {
      for (const name of namesNotLowerCase(el)) {
        console.log(`  ✗ ${browserIdOf(el) ?? shortName(root, path)}: carries ${name}, which a browser reads as `
          + `${name.toLowerCase()} — and it reads whichever copy comes first, where this engine reads only the `
          + 'lower-case name; write it in lower case');
        found++;
      }
    }
  }
  return found;
}

/**
 * An id carried by more than one block, across every page, read as a browser reads it.
 *
 * `readBlocks` keys blocks by id and keeps the last, so every sweep built on it judges one of the
 * two and never learns the other exists — while the browser paints a seal on each, from its own
 * attributes. A twin whose seal matches its own text passes every other check here; so a second
 * block under one id is a problem in itself, whichever of the two is the real one.
 */
export function duplicateIds(root: string): number {
  const where = new Map<string, string[]>();
  for (const path of sheetFiles(root)) {
    const { document } = parseHTML(readFileSync(path, 'utf8'));
    for (const { id } of browserBlocks(document)) where.set(id, [...(where.get(id) ?? []), shortName(root, path)]);
  }
  let found = 0;
  for (const [id, pages] of [...where].sort(([a], [b]) => a.localeCompare(b))) {
    if (pages.length < 2) continue;
    console.log(`  ✗ ${id}: carried by ${pages.length} blocks (${pages.join(', ')}) — a browser paints a seal on `
      + 'each, and this engine judges only one of them');
    found++;
  }
  return found;
}

/**
 * A `data-proof` pointing at a file that is not there.
 *
 * Why this is an issue and not a shrug: `data-proof` is the one attribute in the whole catalogue
 * that points OUTSIDE the documentation. Every other demand — an `alt`, a `<th>`, an owner, a
 * deadline — is satisfied by something the block carries, so the block alone can be trusted to
 * answer for it. This one names a file in the code, and files move, get renamed and get deleted by
 * people who never open the documentation. The attribute survives all three, and a rule whose
 * proof was deleted still LOOKS defended: the kind is `rule`, the demand is satisfied, the page
 * shows nothing amiss. A stale path silently proves nothing, and silence is exactly the failure
 * this engine exists to remove.
 *
 * The value is read as `path/to/file.test.js::name of the test`. Only the PATH is checked here.
 * The name after `::` is informative for now — confirming that a test by that name exists inside
 * the file means running or parsing a test runner, which is a different tool with a different
 * failure mode, and a check that half-works is worse than one that says what it covers.
 *
 * ⚠️ The path is relative to the CONTENT project root — the folder holding `holdrim.json` — not
 * to wherever the CLI was invoked from, and not to the page's own file. Anything else would make
 * the same attribute mean different things depending on which directory somebody was standing in.
 *
 * ⚠️ It does NOT answer the other half of the question — "the rule changed and its proof did not".
 * That one needs to compare two commits, and the git-diff layer does not exist yet.
 */
export function missingProofs(root: string, blocks: Map<string, Block>): number {
  let found = 0;
  for (const [id, block] of [...blocks].sort(([a], [b]) => a.localeCompare(b))) {
    if (block.proof === null) continue;
    const path = block.proof.split('::')[0].trim();
    if (!path) {
      console.log(`  ✗ ${id}: data-proof names no file — write it as `
        + `path/to/file.test.js::name of the test`);
      found++;
      continue;
    }
    if (existsSync(join(root, ...path.split('/')))) continue;
    console.log(`  ✗ ${id}: data-proof points at ${path}, and there is no such file — `
      + `point it at the test that defends this rule, or the rule is not defended`);
    found++;
  }
  return found;
}

/**
 * A `data-depends` edge running from the Fundamental layer into the Application layer.
 *
 * Why this is a defect and not a shrug: the Fundamental is the bottom an agent reads down to when
 * it implements — the blueprint fact that does not itself depend on how the system was built. An
 * edge pointing the other way means there is no bottom: resolving a `rule` by following its
 * dependencies could lead into a screen, whose own dependencies could lead back toward the rule
 * that started the chain, and "implement from the documentation" has nowhere fixed to start
 * reading. Nothing else surfaces this: the fingerprint and the traffic light both compute fine on
 * either endpoint, on its own the block looks ready for approval, and only the direction of the
 * edge is wrong.
 */
export function upwardDependencies(blocks: Map<string, Block>): number {
  let found = 0;
  for (const [id, block] of [...blocks].sort(([a], [b]) => a.localeCompare(b))) {
    for (const other of [...block.dependsOn].sort()) {
      const target = blocks.get(other);
      // A target that is not there has no kind, so it has no layer, so this sweep has nothing to
      // judge. ⚠️ Nor does anything else in `check` sweep for it: the "declares a dependency on X,
      // which does not exist" line lives in `mark`, and only fires when somebody approves that
      // block. A dangling edge on a block nobody has approved is invisible today.
      if (!target) continue;

      const fromLayer = layerOf(block.kind);
      const toLayer = layerOf(target.kind);
      if (fromLayer === null || toLayer === null) continue; // an undeclared kind on either side: no rule to check it against.

      if (fromLayer === 'fundamental' && toLayer === 'application') {
        console.log(`  ✗ ${id} (${block.kind}, Fundamental) depends on ${other} (${target.kind}, `
          + `Application) — a Fundamental block cannot depend on the Application; point the `
          + `dependency the other way, or move ${id} out of the Fundamental`);
        found++;
      }
    }
  }
  return found;
}

/**
 * A validated mark in the HTML with NO matching registry entry.
 *
 * Without this sweep, a hand-written `data-validated` creates an approval out of nothing — and
 * the site shows it, because the seal comes from the attribute.
 * Approval with no trail, in a method whose thesis is traceable approval.
 */
export async function orphanMarks(root: string, registry: Registry, files?: string[]): Promise<number> {
  let found = 0;
  for (const path of files ?? sheetFiles(root)) {
    const { document } = parseHTML(readFileSync(path, 'utf8'));
    for (const el of document.querySelectorAll('[data-validated]')) {
      const id = el.getAttribute('data-id');
      const when = el.getAttribute('data-validated');
      if (!id) {
        console.log(`  ✗ ${path}: a validated mark on a block with NO data-id`); found++;
      } else if (!registry[id]) {
        console.log(`  ✗ ${id}: marked as validated on ${when}, and there is NO registry entry — an approval with no trail`);
        found++;
      } else if (registry[id].date !== when) {
        console.log(`  ✗ ${id}: the date in the HTML (${when}) does not match the one in the registry (${registry[id].date})`);
        found++;
      }
    }
  }
  return found;
}

/** Why a write did not happen, as one line — a single format, so "nothing written" always means it. */
function refusal(id: string, message: string): string {
  return `  ✗ ${id}: ${message}; nothing written`;
}

/** Prints why a write did not happen (`refusal`). */
function refuse(id: string, message: string): null {
  console.log(refusal(id, message));
  return null;
}

/** What a ✓ writes onto one resolved block, and what the registry records for it. */
interface Planned { fingerprint: string; text: string; dependsOn: Record<string, string>; plan: MarkPlan }

/**
 * The seal a ✓ gives the block `element`, decided from the element itself — or why it must not be
 * given. One function for `mark` and `markAll`, so the block that stamps alone and the block that
 * stamps with the rest of its page are held to the same fingerprint check and get the same seal.
 * `say` is where a dependency that does not exist is reported.
 */
async function planSeal(say: (line: string) => void, id: string, element: Element, when: string,
                        fingerprintsNow: Map<string, string> | undefined, expectedFingerprint: string | undefined,
                        reseal: boolean): Promise<Planned | { refused: string }> {
  const text = textOf(element);
  const fingerprint = await fingerprintOfText(text);

  if (expectedFingerprint !== undefined && expectedFingerprint !== fingerprint) {
    return { refused: 'the text resolved here does not match the ✓ that was checked' };
  }

  // What this block depends on, and how each dependency looked RIGHT NOW. Keeping the snapshot of the
  // dependencies is what allows saying, months later, "the text is still the same but the base moved".
  // Without it the red light would have nothing to compare against.
  const declared = (element.getAttribute('data-depends') ?? '').split(/\s+/).filter(Boolean);
  const dependsOn: Record<string, string> = {};
  for (const other of declared) {
    const d = fingerprintsNow?.get(other);
    if (d) dependsOn[other] = d;
    else say(`  ⚠ ${id} declares a dependency on ${other}, which does not exist`);
  }

  // The browser needs two snapshots to paint the traffic light without asking the server:
  //   data-validated-fingerprint  the text that was approved  → without it there is no 🟡
  //   data-depended-on            the ground at that moment   → without it there is no 🔴
  // The JSON is the truth; these attributes are the copy that travels with the page.
  const attributes: Stamp[] = [{ attr: 'data-validated-fingerprint', value: fingerprint }];
  if (Object.keys(dependsOn).length) {
    attributes.push({ attr: 'data-depended-on', value: attributeText(JSON.stringify(dependsOn)) });
  }

  // The FULL plan. Without `reseal`, `spliceAttributes` leaves out whatever the resolved element
  // already carries — the one rule for "already there", shared with `restamp`. With it, the seal on
  // the page is replaced by this one (see `MarkPlan.replace`).
  return { fingerprint, text, dependsOn, plan: { validatedAt: when, attributes, replace: reseal } };
}

/** The registry's entry for a ✓ whose seal is on the page. */
function record(root: string, registry: Registry, id: string, path: string, when: string, source: string,
                event: string | undefined, { fingerprint, text, dependsOn }: Planned) {
  registry[id] = {
    file: shortName(root, path),
    date: when, fingerprint, source,
    // Copied out of the text rather than sliced: V8 keeps a slice of a long string as a view into all
    // of it, and the registry lives until the run ends. Sliced, every entry holds its block's whole
    // text, and a sync's memory grows with the site instead of staying at one page.
    text: Array.from(text.replace(/\s+/g, ' ').trim().slice(0, 120)).join(''),
    ...(Object.keys(dependsOn).length ? { dependsOn } : {}),
    ...(event ? { event } : {}),
  };
}

/** Writes a block's lock: marks the HTML and records the fingerprint.
 *
 * `reseal` replaces a seal the block already carries with this one (`MarkPlan.replace`). `sync` sets
 * it for every ✓ it records; without it, a seal already on the page is kept as it is.
 *
 * `expectedFingerprint`, when given, is the fingerprint a caller already checked the ✓ against
 * (`sync`, against `readBlocks`'s view) — if the block THIS call resolves computes a different one,
 * the two views of the page disagree about what that id names, and writing the seal would be a guess
 * about which view was right. Refusing, rather than trusting either view over the other, is the safe
 * side of a disagreement neither one of them can settle alone.
 */
export async function mark(root: string, registry: Registry, id: string, when: string,
                           source: string, event?: string,
                           fingerprintsNow?: Map<string, string>,
                           expectedFingerprint?: string, reseal = false): Promise<string | null> {
  return markWith(console.log, root, registry, id, when, source, event, fingerprintsNow, expectedFingerprint, reseal);
}

/** `mark`, saying what it has to say through `say` rather than straight to the console. */
async function markWith(say: (line: string) => void, root: string, registry: Registry, id: string, when: string,
                        source: string, event: string | undefined, fingerprintsNow: Map<string, string> | undefined,
                        expectedFingerprint: string | undefined, reseal: boolean): Promise<string | null> {
  const refused = (message: string) => { say(refusal(id, message)); return null; };
  const resolved = resolveBlock(root, id);
  if (!resolved.ok) return refused(resolved.message);
  const { path, html, element } = resolved;

  const planned = await planSeal(say, id, element, when, fingerprintsNow, expectedFingerprint, reseal);
  if ('refused' in planned) return refused(planned.refused);

  const result = spliceAttributes(html, id, planned.plan);
  if ('error' in result) return refused(result.error);
  // The write stays above `record`: `sync` saves the registry even when this write throws.
  if (result.html !== html) writeFileSync(path, result.html, 'utf8');

  record(root, registry, id, path, when, source, event, planned);
  return planned.fingerprint;
}

/** One ✓ for `markAll`: the block, the day and event it came from, and the fingerprint it was checked against. */
interface SiteStamp { id: string; when: string; event: string; expected: string; say: (line: string) => void }

/**
 * `mark(…, 'site', event, fingerprintsNow, expected, true)` for many ✓ at once, with one parse and at
 * most one write per page instead of a whole-page read, parse and verification per block: every id is
 * located once (`locateBlocks`), each page's seals are spliced and verified together (`spliceAll`),
 * and the page is written once, only with the seals that were accepted. A ✓ refused anywhere along
 * the way is said through its own `say`, exactly as `mark` would print it, records nothing, and takes
 * no other ✓ down with it. `settled` hears each ✓'s outcome — the fingerprint recorded, or `null` for
 * a refusal — as soon as its page is done.
 *
 * One page at a time: read, parsed, planned, spliced, verified, written, and let go before the next
 * is read. Locating keeps only which page each id lives on and a digest of that page, so what a sync
 * holds is one page, whatever the size of the site.
 *
 * The page read here is the one located only when its digest matches; one that changed since has
 * its ✓ written one by one through `mark`'s own path, which resolves and fingerprints the block afresh.
 * An edit to a block's own text is refused either way, by its fingerprint; what the digest guards is
 * everything else locating decided about the page. Without it, a `DATA-ID` written onto the page
 * while the run is under way is stamped past, where `mark` refuses the whole page, and a block moved
 * off the page is looked for where it no longer is. The whole text is compared, through its digest:
 * an edit that keeps the page's length is an edit all the same. A page deleted since it was located is
 * treated the same way, rather than letting the read throw and abort the whole run over one ✓:
 * `mark`'s own path re-lists the sheet files and resolves the id fresh, so a page genuinely gone is
 * refused as "not found", exactly as it always was. Any other read error — a page turned into a
 * folder, say — still aborts: `mark`'s path would meet it too, and saying it loudly beats claiming to
 * handle it. `sync` saves the registry on the way out either way, so the pages already written keep
 * their entries (holdrim#148).
 *
 * ⚠️ The digest only re-checks the page THIS id was located on, once, at the moment its turn comes —
 * not every other page, and not again afterwards. A second block gaining this id, or a `DATA-ID`
 * written in upper case, on a DIFFERENT page while this run is under way is not caught here: `mark`'s
 * own per-block path re-scans every page before each write and would see it within that one stamp,
 * where this only sees it on the next `sync`. That is a longer window than main's per-stamp one, and
 * it fails safe rather than silently: the seal that lands here is still checked against this id's own
 * fingerprint, so it lands on text that really was approved; the twin element then shows its seal as
 * stale to the next `check` (`sealMismatches`) or is named outright by `duplicateIds`.
 */
async function markAll(root: string, registry: Registry, stamps: readonly SiteStamp[],
                       fingerprintsNow: Map<string, string>,
                       settled: (index: number, fingerprint: string | null) => void) {
  const located = locateBlocks(root, stamps.map((s) => s.id));
  const pages = new Map<string, { digest: string; entries: number[] }>();
  for (const [index, { id, say }] of stamps.entries()) {
    const where = located.get(id)!;
    if (!where.ok) { say(refusal(id, where.message)); settled(index, null); continue; }
    const page = pages.get(where.path) ?? { digest: where.digest, entries: [] };
    page.entries.push(index);
    pages.set(where.path, page);
  }

  for (const [path, { digest, entries }] of pages) {
    let html: string | null;
    try {
      html = readFileSync(path, 'utf8');
    } catch (e) {
      // ENOENT only: a page deleted since `locateBlocks` ran, which `mark`'s path refuses as "not
      // found". Anything else — a folder where the page was, say — propagates, because `mark`'s path
      // would meet the same error and a loud abort beats a silent "try again below".
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') throw e;
      html = null;
    }
    if (html === null || digestOf(html) !== digest) {
      for (const index of entries) {
        const { id, when, event, expected, say } = stamps[index];
        settled(index, await markWith(say, root, registry, id, when, 'site', event, fingerprintsNow, expected, true));
      }
      continue;
    }
    // The same text parses to the same blocks, so each id names here the one element it was located as.
    const { document, byId } = parsePage(html);
    const planned: { index: number; planned: Planned }[] = [];
    for (const index of entries) {
      const { id, when, expected, say } = stamps[index];
      const plan = await planSeal(say, id, byId.get(id)![0], when, fingerprintsNow, expected, true);
      if ('refused' in plan) { say(refusal(id, plan.refused)); settled(index, null); continue; }
      planned.push({ index, planned: plan });
    }
    const written = spliceAll(html, document, planned.map(({ index, planned: p }) => ({ id: stamps[index].id, plan: p.plan })));
    // The write stays above `record`: `sync` saves the registry even when this write throws.
    if (written.html !== html) writeFileSync(path, written.html, 'utf8');
    for (const [k, { index, planned: p }] of planned.entries()) {
      const { id, when, event, say } = stamps[index];
      const result = written.results[k];
      if ('error' in result) { say(refusal(id, result.error)); settled(index, null); continue; }
      record(root, registry, id, path, when, 'site', event, p);
      settled(index, p.fingerprint);
    }
  }
}

/** Brings into the repository the ✓ the owner gave on the site. Only theirs: a reviewer's approval does not lock. */
export async function sync(root: string, source: Pick<Source, 'events'> & Partial<Pick<Source, 'guardsTampered'>>,
                           options: { owner?: string } = {}) {
  // The server's own rule, not a second copy of it: one e-mail, compared the way the server
  // compares it, and zero or two refused before the cloud is even asked. A comparison written here
  // would drift from it — a space around the address, and the owner's ✓ would lock nothing; two
  // addresses, and they would be read as one owner nobody matches, with no error either way.
  // WHO the owner is comes from `projectRoles`, the server's resolution too: HOLDRIM_OWNER, and never
  // holdrim.json. `options.owner` is for a caller that already knows the owner, and replaces the
  // resolution rather than joining it.
  const roles = options.owner === undefined ? projectRoles(root) : createRoles(options.owner, '');
  // Said before anything is written, because this is whose ✓ is about to become a lock: a variable
  // left over in the shell from another project would otherwise lock that person's approvals here,
  // and nothing on screen would say whose they were.
  //
  // Always "from HOLDRIM_OWNER", with no branch for `options.owner`: the CLI (engine/cli/holdrim.ts)
  // is the one production caller of `sync`, and it never passes that option — only the tests do, to
  // fix the owner without an environment variable. A second arm here would print a sentence no real
  // run ever reaches, and nothing would catch it drifting from the truth.
  console.log(`owner: ${roles.owner} (from HOLDRIM_OWNER)`);

  // The cloud being down must not take the whole session down with it. The registry in the repository
  // is the source of what is already validated; the cloud only adds what came from the site. Without
  // it the local score still holds — what must NOT happen is the session going on unaware it read a
  // frozen snapshot.
  let events: Awaited<ReturnType<typeof source.events>>;
  try {
    events = await source.events();
  } catch (e) {
    const registry = loadRegistry(root);
    console.log(`⚠ could not reach the cloud, so no new ✓ from the site came in:\n  ${(e as Error).message}`);
    console.log(`  Going on with the registry in the repository: ${Object.keys(registry).length} validated (a frozen snapshot).`);
    return { added: 0, unchanged: 0, expired: 0, refused: 0, offline: true, tampered: false };
  }
  // `sync` acts: it writes the owner's ✓ into approvals.json and data-validated into the pages. So
  // on a file whose guards are broken it refuses, as `apply` and `state` do, before one approval is
  // read — with `events_no_update` dropped, an approval's fingerprint can be rewritten to today's
  // text, and a sync that went on would lock what the owner never saw. Outside the `try` above on
  // purpose: in it, the refusal would read as "could not reach the cloud" and sync would go on.
  refuseToActOnBrokenGuards(source);
  // Which of the three cases it was already went out through `reportTampered`, wherever `events` was
  // resolved — this is only the flag `sync` warns from and exits non-zero on (issue #91).
  const tampered = suspectsOf(events).length > 0;
  if (tampered) warnOfTampering();
  const approvals = events.filter((e) => e.type === 'approval');
  // Read from what the server wrote when the ✓ was GIVEN, never recomputed from who holds `lock`
  // NOW (docs/ROLES.md §3): this call runs in a SEPARATE process from the server, so a stale
  // HOLDRIM_OWNER left in this shell — or a real handover since — must not decide a past ✓
  // differently than the server did when it recorded it. A ✓ with nothing written at all is measured
  // against the BASELINE (decision B, round 1's review) — who HOLDRIM_OWNER was the moment a server
  // of this version first read this store — never against `roles.owner` above, which is only this
  // CALL's own HOLDRIM_OWNER and exactly the value a stale shell or a handover since would get wrong.
  const baseline = earliestLockBaseline(events);
  if (!baseline) {
    // A store no server of this version has ever started against — read straight from a file, or
    // from the cloud without HOLDRIM_EVENTS=firestore ever running here. `isLocked` already fails
    // closed for it; this just says why nothing unwritten is about to lock, once, rather than let it
    // look like every old ✓ simply stopped existing.
    console.log('  ⚠ no lock_baseline event in this store yet — a ✓ with nothing written on it reads as no '
      + 'lock. Start a server of this version against it once (it writes the baseline itself), then sync again.');
  }
  const theOwners = approvals.filter((e) => isLocked(e, baseline));
  if (approvals.length !== theOwners.length) {
    console.log(`  · ${approvals.length - theOwners.length} approval(s) by somebody else ignored: only the owner's ✓ locks`);
  }

  const registry = loadRegistry(root);
  // Not `readBlocks`: its `parsed` cache keeps every page's full text and parsed document for the
  // life of the process, which the server needs and a sync does not — a whole sync would then hold
  // the whole site, on top of whatever `markAll` holds one page of at a time (holdrim#144, round 3).
  // `fingerprintsByPage` reads and lets go of one page at a time and keeps only the id and
  // fingerprint pairs below, which is all this loop and `markAll` ask of it.
  const fingerprintsNow = await fingerprintsByPage(root);
  let added = 0, unchanged = 0, expired = 0, refused = 0;

  // Every ✓ still goes through the checks below in the order it was given, and its lines come out in
  // that order — but the ones that reach a page are stamped together (`markAll`), a page at a time,
  // instead of one whole-page read, parse and verification each. A ✓ for a block another ✓ in the
  // same round is already stamping waits for the next round, so it sees the registry that stamp left:
  // the second ✓ on an unchanged text is "already there", exactly as when each was written in turn.
  // A ✓'s lines are printed once it and every ✓ before it are settled, so a line never announces a
  // stamp before the page carrying it is written.
  const sorted = theOwners.sort((a, b) => a.when.localeCompare(b.when));
  const lines: string[][] = sorted.map(() => []);
  const settled: boolean[] = sorted.map(() => false);
  let printed = 0;
  const flush = () => {
    while (printed < sorted.length && settled[printed]) for (const line of lines[printed++]) console.log(line);
  };
  let pending = [...sorted.keys()];
  let unwinding = false;
  try {
    while (pending.length) {
      const later: number[] = [];
      const taken = new Set<string>();
      const stamps: (SiteStamp & { slot: number })[] = [];
      for (const slot of pending) {
        const e = sorted[slot];
        const say = (line: string) => { lines[slot].push(line); };
        const id = e.block;
        if (id && taken.has(id)) { later.push(slot); continue; }
        settled[slot] = true;
        if (!id) continue;
        const when = (e.when || '').slice(0, 10);
        const fingerprint = fingerprintsNow.get(id);
        if (fingerprint === undefined) { say(`  ✗ ${id}: approved on the site, and does not exist in the repository`); continue; }
        if (e.fingerprint !== fingerprint) {
          say(`  ⚠ ${id}: the ✓ from ${when} is for an earlier version of the text — it does not hold any more`);
          expired++; continue;
        }
        if (registry[id]?.fingerprint === fingerprint) { unchanged++; continue; }
        // fingerprint is what was just verified against e.fingerprint above (the two are equal at
        // this point) — passed on so `markAll` refuses instead of writing if the block IT resolves ever
        // disagrees with the one `fingerprintsByPage` saw here.
        // Every seal `markAll` writes replaces the one on the page: this ✓ is newer than whatever seal
        // the page carries — a registry that already held this fingerprint was skipped just above — so
        // the page takes its date, fingerprint and dependencies, and never keeps an older ✓'s (holdrim#140).
        settled[slot] = false;
        taken.add(id);
        stamps.push({ slot, id, when, event: e.id, expected: fingerprint, say });
      }
      flush();
      await markAll(root, registry, stamps, fingerprintsNow, (k, fingerprint) => {
        const { slot, id, when, say } = stamps[k];
        if (fingerprint) {
          say(`  ✓ ${id} validated by you on the site on ${when}`);
          added++;
        } else {
          // The block exists and the ✓ is current, yet `markAll` refused to write it (its own line above
          // says why). Counted and returned so the CLI exits non-zero: without that, the registry never
          // gets the entry, the text can be rewritten afterwards, and `check` passes over it in silence.
          refused++;
        }
        settled[slot] = true;
        flush();
      });
      pending = later;
    }
  } catch (e) {
    unwinding = true;
    throw e;
  } finally {
    // A run that throws half-way still shows what it had to say about every ✓ it got to.
    for (const slot of sorted.keys()) if (slot >= printed) for (const line of lines[slot]) console.log(line);
    // Saved whether the run finished or threw: saved only on success, an abort half-way — a page
    // turned into a folder, which `markAll` lets propagate — leaves the seals of the pages already
    // written on disk with no entry, and `check` calls each of those genuine ✓ "marked without a
    // registry entry" for as long as whatever aborted the run is still there (holdrim#148). Nothing
    // unwritten gets in: `markWith` and `markAll` add an entry only once its page's write has
    // returned. The error still propagates, so the CLI still exits non-zero.
    //
    // Not the registry first and the page after: a process killed between the two would leave an
    // entry for a seal no page carries — a lock recorded for text the ✓ never reached. This order,
    // killed there, leaves the seal without the entry, which `check` flags and the next `sync`
    // records again from the owner's ✓. Nor once per page: every page would rewrite the whole
    // registry, and a sync would grow with pages times entries again (holdrim#144).
    //
    // A save that fails while another error is on its way out is said and let go, so the error that
    // aborted the run is the one the run ends with: thrown from here, it would replace it, and the
    // cause of the abort would be lost behind the registry's. With nothing on its way out, the save's
    // own error is the run's error. `saveRegistry` itself writes aside and renames (holdrim#150), so a
    // process killed during this save leaves the PREVIOUS registry intact, never a truncated one.
    try {
      saveRegistry(root, registry);
    } catch (saveError) {
      if (!unwinding) throw saveError;
      console.error(`⚠ the registry could not be saved either, so the ✓ stamped above are on their pages `
        + `without an entry until the next sync records them: ${(saveError as Error).message}`);
    }
  }
  console.log(`${added} new · ${unchanged} already there · ${expired} ✓ expired · ${refused} refused · `
    + `${Object.keys(registry).length} validated in all`);
  if (refused) console.log(`⚠ ${refused} ✓ could not be stamped safely — see the messages above; this run exits non-zero`);
  return { added, unchanged, expired, refused, offline: false, tampered };
}

/**
 * The documentation traffic light: where each block stands, and what needs a human eye.
 *
 * This is the command that answers "can I trust this documentation today?". `check` answers a
 * smaller and older question — whether someone tampered with a mark. This one answers today's
 * question.
 */
export async function showLights(root: string, options: { only?: string } = {}) {
  // `--only red` keeps the list to what nobody can spot by reading the page. It is the one filter
  // there is: anything else is refused, because ignoring it would print the full list as if it
  // were filtered.
  const onlyRed = options.only === 'red';
  if (options.only !== undefined && !onlyRed) {
    console.error(`--only takes one value, red; got: ${options.only}`);
    return null;
  }
  const blocks = await readBlocks(root);
  const registry = loadRegistry(root);
  const { byBlock, tally } = trafficLight(blocks, registry);

  const total = blocks.size;
  const line = (state: 'valid' | 'stale' | 'broken' | 'none', meaning: string) =>
    `  ${COLOURS[state]} ${String(tally[state]).padStart(4)}  ${meaning}`;

  console.log(`\nDocumentation: ${total} block(s)\n`);
  console.log(line('valid',  'validated, and nothing has changed since'));
  console.log(line('stale',  'the text changed after the ✓ — approve it again'));
  console.log(line('broken', 'the text is the same, but the ground moved — CHECK IT'));
  console.log(line('none',   'nobody has validated it yet'));

  // Red comes first, and named: it is the only state nobody spots on their own by reading the page,
  // because nothing on the page changed.
  const red = [...byBlock].filter(([, r]) => r.state === 'broken');
  if (red.length) {
    console.log(`\n🔴 Need a check — the ground moved, not the text:\n`);
    for (const [id, r] of red) {
      console.log(`  ${id}`);
      console.log(`     depends on: ${r.blame.join(', ')} — and that changed since the ✓`);
    }
  }

  const yellow = [...byBlock].filter(([, r]) => r.state === 'stale');
  if (yellow.length && !onlyRed) {
    console.log(`\n🟡 Approve again (the text changed):\n  ${yellow.map(([id]) => id).join('  ')}`);
  }

  if (!red.length && !yellow.length) {
    console.log(`\n✓ nothing waiting to be checked.`);
  }
  console.log('');
  return tally;
}

/**
 * Writes into the HTML what the approvals registry already knows.
 *
 * Why this has to exist: the registry (`fingerprint`) is the truth, but the BROWSER cannot read
 * it — the page is static and the panel has no server to ask. It paints the traffic light from
 * three attributes that travel with the page, and `mark()` only writes them at the moment an
 * approval arrives. An approval recorded by hand, or by an older tool, has `data-validated` and
 * nothing else.
 *
 * ⚠️ What that costs is exactly the thing this project is about: without
 * `data-validated-fingerprint`, a rewritten block STAYS GREEN in the browser. The seal shows, and
 * the page never warns that the text drifted. Documentation that lies about being checked is
 * worse than documentation nobody checked.
 *
 * ⚠️ It writes the fingerprint FROM THE REGISTRY, never the one computed from the text on disk now.
 * Recomputing would be a silent re-approval: a block whose text changed after the ✓ would be
 * stamped with its new text and turn green, and the drift this exists to reveal would be erased by
 * the very command meant to reveal it. So a block that drifted gets stamped with the OLD
 * fingerprint and correctly shows 🟡.
 */
export async function restamp(root: string) {
  const registry = loadRegistry(root);
  const blocks = await readBlocks(root);
  let written = 0, alreadyHad = 0, noSuchBlock = 0, refused = 0;
  const willTurnYellow: string[] = [];

  for (const [id, entry] of Object.entries(registry)) {
    const recorded = entry.fingerprint;
    if (!recorded) continue;
    const resolved = resolveBlock(root, id);
    if (!resolved.ok) {
      // Not found is the ordinary "the page moved on" case `noSuchBlock` always reported; a
      // duplicate id or an id this format cannot represent is a REFUSAL — the block may well still
      // be there, but nothing can be written to it safely — and gets its own count and its reason.
      if (resolved.kind === 'not-found') { noSuchBlock++; continue; }
      refuse(id, resolved.message); refused++; continue;
    }
    const { path, html } = resolved;

    const current = blocks.get(id)?.fingerprint;
    if (current && current !== recorded) willTurnYellow.push(id);

    const attributes: Stamp[] = [{ attr: 'data-validated-fingerprint', value: attributeText(recorded) }];
    if (entry.dependsOn && Object.keys(entry.dependsOn).length) {
      attributes.push({ attr: 'data-depended-on', value: attributeText(JSON.stringify(entry.dependsOn)) });
    }

    const result = spliceAttributes(html, id, { attributes });
    if ('error' in result) { refuse(id, result.error); refused++; continue; }
    // "Already had it" and "written" are the same question asked in opposite directions — whether
    // this splice changed anything — so one comparison answers both, instead of a text-based check
    // for the first and a write for the second.
    if (result.html === html) { alreadyHad++; continue; }
    writeFileSync(path, result.html, 'utf8');
    written++;
  }

  console.log(`\n${written} block(s) got the mark they were missing · ${alreadyHad} already had it`);
  if (noSuchBlock) console.log(`⚠ ${noSuchBlock} entries in the registry no longer exist in the pages`);
  if (refused) console.log(`⚠ ${refused} entries could not be stamped safely — see the messages above; this run exits non-zero`);
  if (willTurnYellow.length) {
    console.log(`\n🟡 ${willTurnYellow.length} will show up YELLOW on the site, and that is right —`);
    console.log(`   the text changed after the ✓:\n   ${willTurnYellow.join('  ')}`);
  }
  console.log('');
  return { written, alreadyHad, noSuchBlock, refused };
}

/** What else do I have to look at if I touch this? The question to ask BEFORE editing. */
export async function ifITouch(root: string, id: string) {
  const blocks = await readBlocks(root);
  if (!blocks.has(id)) { console.log(`✗ no such block: ${id}`); return 1; }

  const dependents = dependentsOf(id, blocks);
  const registry = loadRegistry(root);
  const list = (ids: string[]) => {
    for (const d of ids) {
      const validated = registry[d] ? `✓ validated on ${registry[d].date}` : 'never validated';
      console.log(`  ${d.padEnd(14)} ${validated}`);
    }
  };

  console.log(`\nIf you touch ${id}:\n`);
  if (!dependents.length) {
    console.log('  nothing declares a dependency on this block.');
    console.log('  (which does not mean nothing depends on it — only that nobody declared it)\n');
    return 0;
  }
  console.log(`  ${dependents.length} block(s) will turn 🔴 and need a check:\n`);
  list(dependents);

  // The traffic light itself only ever advances one hop per human confirmation (docs/IMPACT.md,
  // "One hop, not the transitive closure") — this line does not change that. But BEFORE editing, a
  // person benefits from seeing further than the light will paint today. `radiusOf` is the SAME
  // walk the panel lights when a block is selected (engine/core/validity.js): the CLI and the panel
  // answer "what could this touch" from the one function, not two.
  const further = radiusOf(id, blocks).filter((d) => !dependents.includes(d));
  if (further.length) {
    console.log(`\n  ${further.length} more, worth checking too — reached through another block:\n`);
    list(further);
  }
  console.log('');
  return 0;
}

// ---------------------------------------------------------------- the index in the database

/**
 * Rebuilds the documentation index in the database: which blocks exist, of what kind, what they depend
 * on, and what is missing in each one.
 *
 * ⚠️ The database does not become the truth. The truth stays in the file, versioned — the file is what
 * has diff and authorship. This is a snapshot, and it exists for the questions a file answers badly:
 * "every diagram in the project", "every decision without an owner", "what breaks if I touch this".
 */
export async function rebuildIndex(root: string, databasePath?: string) {
  const { Index } = await import('../api/index-store.ts');
  const { currentCommit } = await import('../core/git.js');
  const database = databasePath ?? process.env.HOLDRIM_EVENTS_PATH ?? join(root, 'data', 'events.db');
  const blocks = await readBlocks(root);

  // Which commit the content was sitting on, so that a later run can ask git which files changed
  // instead of reparsing all of them. ⚠️ null when the content is not in a git repository — a
  // plain folder is a legitimate way to use this tool — and that is not an error: the index is
  // merely less useful, and indexing proceeds exactly the same.
  const commit = currentCommit(root);

  const idx = new Index(database);
  try {
    const howMany = idx.rebuild([...blocks.values()].map((b) => ({
      id: b.id, page: b.page, kind: b.kind, file: b.file, code: b.code || null,
      numbered: b.numbered, fingerprint: b.fingerprint, text: b.text.slice(0, 400),
      dependsOn: b.dependsOn, missing: b.missing,
    })), commit);

    console.log(`\nIndexed ${howMany} block(s) in ${database}\n`);
    for (const { kind, count } of idx.byKind()) {
      console.log(`  ${String(count).padStart(4)}  ${kind}`);
    }

    // The summary of where the dependencies landed, and not the list of them: the funnel is judged
    // by how little reaches a person, and that is a number you can read in one glance and compare
    // with the last run. ⚠️ Matrix only — no "before" text exists at index time, so these are the
    // levels the kinds alone produce; see the note in `rebuild`.
    const levels = idx.bySeverity();
    const pairs = levels.reduce((sum, l) => sum + l.count, 0);
    if (pairs) {
      console.log(`\n${pairs} dependency pair(s), by severity (kinds only, no edit signals):`);
      for (const { severity, count } of levels) {
        console.log(`  ${String(count).padStart(4)}  ${severity}`);
      }
      const needsAPerson = idx.needsAPerson();
      for (const p of needsAPerson.slice(0, 10)) {
        console.log(`    person: ${p.block} (${p.kind}) → ${p.dependsOn} (${p.dependsOnKind ?? '?'})`);
      }
      if (needsAPerson.length > 10) console.log(`    … and ${needsAPerson.length - 10} more`);
    }

    const broken = idx.brokenDependencies();
    if (broken.length) {
      console.log(`\n✗ ${broken.length} dependency(ies) point at a block that does not exist:`);
      for (const b of broken) console.log(`    ${b.block} → ${b.dependsOn}`);
    }

    const issues = idx.issues();
    if (issues.length) {
      console.log(`\n⚠ ${issues.length} block(s) are missing what their kind demands:\n`);
      for (const i of issues.slice(0, 20)) console.log(`  ${i.id.padEnd(14)} ${i.missing}`);
      if (issues.length > 20) console.log(`  … and ${issues.length - 20} more`);
    } else {
      console.log('\n✓ every block has what its kind demands.');
    }
    console.log('');
    return {
      howMany, commit, issues: issues.length, broken: broken.length,
      severities: Object.fromEntries(levels.map((l) => [l.severity, l.count])),
    };
  } finally {
    idx.close();
  }
}

/** The catalogue of kinds, for whoever is writing and wants to know what exists. */
export async function listKinds() {
  const { catalogue } = await import('../core/kinds.js');
  console.log('\nContent kinds — every block that can be validated is one of these:\n');
  for (const kind of catalogue()) {
    console.log(`  ${kind.id.padEnd(11)} ${kind.name}${kind.numbered ? '' : '   (no number on the page)'}`);
    console.log(`  ${''.padEnd(11)} ${kind.description.replace(/\s+/g, ' ')}\n`);
  }
}
