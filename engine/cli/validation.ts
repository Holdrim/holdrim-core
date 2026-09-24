import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseHTML } from 'linkedom';
import { fingerprintOfText } from '../core/fingerprint.js';
import { readBlocks, sheetFiles, findBlockFile, shortName, ofProject, projectRoles, type Block } from './pages.ts';
import { trafficLight, dependentsOf, COLOURS } from '../core/validity.js';
import { layerOf } from '../core/kinds.js';
import { createRoles } from '../core/roles.js';
import { Source } from './remote.ts';

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

export function saveRegistry(root: string, registry: Registry) {
  const sorted: Registry = {};
  for (const k of Object.keys(registry).sort()) sorted[k] = registry[k];
  writeFileSync(registryPath(root), JSON.stringify(sorted, null, 1) + '\n', 'utf8');
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
  problems += await orphanMarks(root, registry);
  problems += missingProofs(root, blocks);
  problems += upwardDependencies(blocks);
  console.log(`${Object.keys(registry).length} validated · ${problems ? `${problems} problem(s)` : 'all intact'}`);
  return problems;
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

/** Writes a block's lock: marks the HTML and records the fingerprint. */
export async function mark(root: string, registry: Registry, id: string, when: string,
                           source: string, event?: string,
                           fingerprintsNow?: Map<string, string>): Promise<string | null> {
  const found = findBlockFile(root, id);
  if (!found) { console.log(`  ✗ ${id}: not found`); return null; }

  const marked = found.html.replace(
    new RegExp(`(data-id="${id.replace(/\./g, '\\.')}")(?! data-validated=)`),
    `$1 data-validated="${when}"`);
  if (marked !== found.html) writeFileSync(found.path, marked, 'utf8');

  const { document } = parseHTML(marked);
  const el = document.querySelector(`[data-id="${id}"]`)!;
  const copy = el.cloneNode(true) as Element;
  copy.querySelectorAll('[data-review-ui]').forEach((x: Element) => x.remove());
  const text = copy.textContent ?? '';
  const fingerprint = await fingerprintOfText(text);

  // What this block depends on, and how each dependency looked RIGHT NOW. Keeping the snapshot of the
  // dependencies is what allows saying, months later, "the text is still the same but the base moved".
  // Without it the red light would have nothing to compare against.
  const declared = (el.getAttribute('data-depends') ?? '').split(/\s+/).filter(Boolean);
  const dependsOn: Record<string, string> = {};
  for (const other of declared) {
    const d = fingerprintsNow?.get(other);
    if (d) dependsOn[other] = d;
    else console.log(`  ⚠ ${id} declares a dependency on ${other}, which does not exist`);
  }

  // The browser needs two snapshots to paint the traffic light without asking the server:
  //   data-validated-fingerprint  the text that was approved  → without it there is no 🟡
  //   data-depended-on            the ground at that moment   → without it there is no 🔴
  // The JSON is the truth; these attributes are the copy that travels with the page.
  const attributes: Record<string, string> = { 'data-validated-fingerprint': fingerprint };
  if (Object.keys(dependsOn).length) {
    attributes['data-depended-on'] = JSON.stringify(dependsOn).replace(/"/g, '&quot;');
  }
  let html = readFileSync(found.path, 'utf8');
  for (const [attr, value] of Object.entries(attributes)) {
    const target = new RegExp(`(data-id="${id.replace(/\./g, '\\.')}")((?:(?!${attr})[^>])*?)>`);
    html = html.replace(target, `$1$2 ${attr}="${value}">`);
  }
  writeFileSync(found.path, html, 'utf8');

  registry[id] = {
    file: shortName(root, found.path),
    date: when, fingerprint, source,
    text: text.replace(/\s+/g, ' ').trim().slice(0, 120),
    ...(Object.keys(dependsOn).length ? { dependsOn } : {}),
    ...(event ? { event } : {}),
  };
  return fingerprint;
}

/** Brings into the repository the ✓ the owner gave on the site. Only theirs: a reviewer's approval does not lock. */
export async function sync(root: string, source: Pick<Source, 'events'>, options: { owner?: string } = {}) {
  // The server's own rule, not a second copy of it: one e-mail, compared the way the server
  // compares it, and zero or two refused before the cloud is even asked. A comparison written here
  // would drift from it — a space around the address, and the owner's ✓ would lock nothing; two
  // addresses, and they would be read as one owner nobody matches, with no error either way.
  // WHO the owner is comes from `projectRoles`, the server's resolution too: read from the variable
  // alone, a project naming its owner only in holdrim.json would sync no ✓ at all. `options.owner`
  // is for a caller that already knows the owner, and replaces the resolution rather than joining it.
  const roles = options.owner === undefined ? projectRoles(root) : createRoles(options.owner, '');

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
    return { added: 0, unchanged: 0, expired: 0, offline: true };
  }
  const approvals = events.filter((e) => e.type === 'approval');
  const theOwners = approvals.filter((e) => roles.isOwner(e.author));
  if (approvals.length !== theOwners.length) {
    console.log(`  · ${approvals.length - theOwners.length} approval(s) by somebody else ignored: only the owner's ✓ locks`);
  }

  const registry = loadRegistry(root);
  const blocks = await readBlocks(root);
  const fingerprintsNow = new Map([...blocks].map(([id, b]) => [id, b.fingerprint]));
  let added = 0, unchanged = 0, expired = 0;

  for (const e of theOwners.sort((a, b) => a.when.localeCompare(b.when))) {
    const id = e.block;
    if (!id) continue;
    const when = (e.when || '').slice(0, 10);
    const block = blocks.get(id);
    if (!block) { console.log(`  ✗ ${id}: approved on the site, and does not exist in the repository`); continue; }
    if (e.fingerprint !== block.fingerprint) {
      console.log(`  ⚠ ${id}: the ✓ from ${when} is for an earlier version of the text — it does not hold any more`);
      expired++; continue;
    }
    if (registry[id]?.fingerprint === block.fingerprint) { unchanged++; continue; }
    if (await mark(root, registry, id, when, 'site', e.id, fingerprintsNow)) {
      console.log(`  ✓ ${id} validated by you on the site on ${when}`);
      added++;
    }
  }
  saveRegistry(root, registry);
  console.log(`${added} new · ${unchanged} already there · ${expired} ✓ expired · ${Object.keys(registry).length} validated in all`);
  return { added, unchanged, expired, offline: false };
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
  let written = 0, alreadyHad = 0, noSuchBlock = 0;
  const willTurnYellow: string[] = [];

  for (const [id, entry] of Object.entries(registry)) {
    const recorded = entry.fingerprint;
    if (!recorded) continue;
    const found = findBlockFile(root, id);
    if (!found) { noSuchBlock++; continue; }

    const current = blocks.get(id)?.fingerprint;
    if (current && current !== recorded) willTurnYellow.push(id);

    const escaped = id.replace(/\./g, '\\.');
    if (new RegExp(`data-id="${escaped}"[^>]*data-validated-fingerprint`).test(found.html)) {
      alreadyHad++; continue;
    }

    const attributes: Record<string, string> = { 'data-validated-fingerprint': recorded };
    if (entry.dependsOn && Object.keys(entry.dependsOn).length) {
      attributes['data-depended-on'] = JSON.stringify(entry.dependsOn).replace(/"/g, '&quot;');
    }

    let html = readFileSync(found.path, 'utf8');
    for (const [attr, value] of Object.entries(attributes)) {
      html = html.replace(new RegExp(`(data-id="${escaped}")((?:(?!${attr})[^>])*?)>`),
                          `$1$2 ${attr}="${value}">`);
    }
    writeFileSync(found.path, html, 'utf8');
    written++;
  }

  console.log(`\n${written} block(s) got the mark they were missing · ${alreadyHad} already had it`);
  if (noSuchBlock) console.log(`⚠ ${noSuchBlock} entries in the registry no longer exist in the pages`);
  if (willTurnYellow.length) {
    console.log(`\n🟡 ${willTurnYellow.length} will show up YELLOW on the site, and that is right —`);
    console.log(`   the text changed after the ✓:\n   ${willTurnYellow.join('  ')}`);
  }
  console.log('');
  return written;
}

/** What else do I have to look at if I touch this? The question to ask BEFORE editing. */
export async function ifITouch(root: string, id: string) {
  const blocks = await readBlocks(root);
  if (!blocks.has(id)) { console.log(`✗ no such block: ${id}`); return 1; }

  const dependents = dependentsOf(id, blocks);
  const registry = loadRegistry(root);

  console.log(`\nIf you touch ${id}:\n`);
  if (!dependents.length) {
    console.log('  nothing declares a dependency on this block.');
    console.log('  (which does not mean nothing depends on it — only that nobody declared it)\n');
    return 0;
  }
  console.log(`  ${dependents.length} block(s) will turn 🔴 and need a check:\n`);
  for (const d of dependents) {
    const validated = registry[d] ? `✓ validated on ${registry[d].date}` : 'never validated';
    console.log(`  ${d.padEnd(14)} ${validated}`);
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
