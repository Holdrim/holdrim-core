/**
 * Issue #107: what identifies a tampered-text finding, which findings the banner shows, and who may
 * acknowledge one. The route itself is proved over HTTP in engine/test-contract.sh ("tampered texts:
 * the banner's findings, and the owner's acknowledgement"); the panel, in engine/test-browser.js.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createRoles, agentByToken } from '../core/roles.js';
import { withTexts, withTextsRetrying, hashText, newSalt, textKey, findingOf, observedOf, TEXT_REMOVED } from '../api/texts.ts';
import {
  TAMPER_ACKNOWLEDGED, TAMPER_KINDS, tamperKey, tamperFieldKey, openFindings, mayAcknowledge,
  acknowledgementRefusal, acknowledgementOf,
} from '../api/tamper.ts';
import { EVENT_TYPES } from '../api/types.ts';
import { SqliteEventStore } from '../api/store-sqlite.ts';

const OWNER = 'owner@example.org';
const ADMIN = 'lead@example.org';
const MEMBER = 'reader@example.org';
const AGENT = 'agent@example.org';
const roles = createRoles(OWNER, ADMIN, '', AGENT);

/** An event whose `text` was recorded under `salt`, resolved against whatever `rows` holds now. */
function recorded(id, value, salt) {
  return { id, type: 'comment', page: 'A01', block: 'A01.1.1', author: MEMBER, when: '2026-01-01T00:00:00.000Z',
    data: null, text: null, snapshot: null, textHash: hashText(value, salt), snapshotHash: null };
}
function read(events, rows) {
  const reports = [];
  const resolved = withTexts(events, rows, reports);
  return { resolved, reports };
}
/** An acknowledgement as the route records it — `asAgent` stamped "false" — read back as an event. */
const acknowledged = (found, id = 'ack1') => {
  const event = acknowledgementOf(found);
  return { id, author: OWNER, when: '2026-01-02T00:00:00.000Z', ...event, data: { ...event.data, asAgent: 'false' } };
};

// ---------------------------------------------------------------- what a finding is
test('a finding is named by the event, the field, the case and what was found — each one tells two apart', () => {
  const base = findingOf('e1', 'text', 'overwritten', 'h1');
  assert.match(base, /^[0-9a-f]{64}$/);
  assert.equal(findingOf('e1', 'text', 'overwritten', 'h1'), base, 'the same finding, read twice, is one finding');
  assert.notEqual(findingOf('e2', 'text', 'overwritten', 'h1'), base, 'another event');
  assert.notEqual(findingOf('e1', 'snapshot', 'overwritten', 'h1'), base, 'another field');
  assert.notEqual(findingOf('e1', 'text', 'unaccounted', 'h1'), base, 'another case');
  assert.notEqual(findingOf('e1', 'text', 'overwritten', 'h2'), base, 'another thing found');
});

test('an overwritten text is identified by its row\'s own salted hash — never by the value it holds', () => {
  const event = recorded('e1', 'the real text', newSalt());
  const overwrittenWith = (salt) => read([event], new Map([[textKey('e1', 'text'), { value: 'a forged text', salt }]])).reports;
  const forgedSalt = newSalt();
  const reports = overwrittenWith(forgedSalt);
  assert.deepEqual(reports.map((r) => [r.event, r.field, r.kind]), [['e1', 'text', 'overwritten']]);
  // The same value under another salt is another finding: an unsalted hash of the value would make
  // these two one, and let anybody holding a guess of the text test it against the id.
  assert.notEqual(overwrittenWith(newSalt())[0].finding, reports[0].finding, 'the salt is part of what was found');
  // And the row's part is the salted hash, computed here with `hashText` rather than by `observedOf`,
  // so an `observedOf` that stops salting cannot also rewrite what this expects of it.
  assert.equal(reports[0].finding, findingOf('e1', 'text', 'overwritten',
    [event.textHash, hashText('a forged text', forgedSalt), ''].join('\u0000')));
  // docs/PRIVACY.md, section 4: nothing a guess of the text could be tested against without the salt.
  assert.doesNotMatch(observedOf(event.textHash, { value: 'a forged text', salt: forgedSalt }, ['r1']), /forged/);
});

test('a second forged removal of a field is a new finding: the removals are what was found', () => {
  const target = { ...recorded('e1', 'gone', newSalt()) };
  const removal = (id, when) => ({ id, type: TEXT_REMOVED, page: 'A01', block: 'A01.1.1', author: OWNER, when,
    data: { event: 'e1', field: 'text' }, text: null, snapshot: null, textHash: null, snapshotHash: null });
  const two = read([target, removal('r1', '2026-01-02T00:00:00.000Z'), removal('r2', '2026-01-03T00:00:00.000Z')], new Map()).reports;
  const three = read([target, removal('r1', '2026-01-02T00:00:00.000Z'), removal('r2', '2026-01-03T00:00:00.000Z'),
    removal('r3', '2026-01-04T00:00:00.000Z')], new Map()).reports;
  assert.deepEqual(two.map((r) => r.kind), ['double_removal']);
  assert.notEqual(three[0].finding, two[0].finding);
});

/** A removal of `e1`'s text, dated after it — `removalsOf` counts it as valid. */
const removalOfE1 = (id, when) => ({ id, type: TEXT_REMOVED, page: 'A01', block: 'A01.1.1', author: OWNER, when,
  data: { event: 'e1', field: 'text' }, text: null, snapshot: null, textHash: null, snapshotHash: null });

test('the same removals in any order are the same finding, however the read gathered them', async () => {
  // Firestore's torn-read retry (`withTextsRetrying`) appends the removals its own unordered query
  // returned: the order they arrive in is not something that was found, so it must not be a new id.
  const target = recorded('e1', 'gone', newSalt());
  const inOrder = read([target, removalOfE1('r1', '2026-01-02T00:00:00.000Z'), removalOfE1('r2', '2026-01-03T00:00:00.000Z')],
    new Map()).reports;
  const retried = [];
  await withTextsRetrying([target], new Map(),
    async () => [removalOfE1('r2', '2026-01-03T00:00:00.000Z'), removalOfE1('r1', '2026-01-02T00:00:00.000Z')], retried);
  assert.deepEqual(retried.map((r) => [r.event, r.kind]), [['e1', 'double_removal']]);
  assert.equal(retried[0].finding, inOrder[0].finding);
});

test('an acknowledged overwrite, then two forged removals of the same field: a new finding', () => {
  const event = recorded('e1', 'the real text', newSalt());
  const rows = new Map([[textKey('e1', 'text'), { value: 'forged', salt: newSalt() }]]);
  const [finding] = openFindings(read([event], rows).reports, [event]);
  const ack = acknowledged(finding);
  const later = [event, ack, removalOfE1('r1', '2026-01-03T00:00:00.000Z'), removalOfE1('r2', '2026-01-04T00:00:00.000Z')];
  const again = openFindings(read(later, rows).reports, later);
  assert.deepEqual(again.map((f) => [f.event, f.kind]), [['e1', 'overwritten']], 'the removals are part of what was found');
  assert.notEqual(again[0].finding, finding.finding);
});

test('an acknowledged overwrite, then the event\'s own recorded hash rewritten: a new finding', () => {
  const event = recorded('e1', 'the real text', newSalt());
  const rows = new Map([[textKey('e1', 'text'), { value: 'forged', salt: newSalt() }]]);
  const [finding] = openFindings(read([event], rows).reports, [event]);
  const ack = acknowledged(finding);
  const rewritten = { ...event, textHash: hashText('another claim', newSalt()) };
  const again = openFindings(read([rewritten, ack], rows).reports, [rewritten, ack]);
  assert.deepEqual(again.map((f) => [f.event, f.kind]), [['e1', 'overwritten']]);
  assert.notEqual(again[0].finding, finding.finding);
  // The same for a field with no row at all: its recorded hash is still what was found.
  const bare = recorded('e1', 'gone', newSalt());
  const [gone] = openFindings(read([bare], new Map()).reports, [bare]);
  const rehashed = { ...bare, textHash: hashText('gone again', newSalt()) };
  assert.notEqual(openFindings(read([rehashed], new Map()).reports, [rehashed])[0].finding, gone.finding);
});

test('two downgraded fields are two findings: acknowledging one leaves the other open', () => {
  const downgraded = (id, field) => ({ id, type: 'comment', page: 'A01', block: 'A01.1.1', author: MEMBER,
    when: '2026-01-01T00:00:00.000Z', data: null, text: field === 'text' ? 'inline' : null,
    snapshot: field === 'snapshot' ? 'inline' : null, textHash: null, snapshotHash: null, afterExtraction: true });
  const events = [downgraded('e1', 'text'), downgraded('e2', 'text'), downgraded('e3', 'snapshot')];
  const open = openFindings(read(events, new Map()).reports, events);
  assert.deepEqual(open.map((f) => [f.event, f.field, f.kind]),
    [['e1', 'text', 'downgraded'], ['e2', 'text', 'downgraded'], ['e3', 'snapshot', 'downgraded']]);
  assert.equal(new Set(open.map((f) => f.finding)).size, 3, 'one id per event and field, never one for the case');
  const after = openFindings(read(events, new Map()).reports, [...events, acknowledged(open[0])]);
  assert.deepEqual(after.map((f) => f.event), ['e2', 'e3']);
});

test('an acknowledged downgrade, then a forged row or a forged removal for it: a new finding', () => {
  // A downgraded field has no recorded hash, so a row or a removal written for it after the
  // acknowledgement is all that could tell it apart — the case alone would swallow both.
  const event = { id: 'e1', type: 'comment', page: 'A01', block: 'A01.1.1', author: MEMBER, when: '2026-01-01T00:00:00.000Z',
    data: null, text: 'inline', snapshot: null, textHash: null, snapshotHash: null, afterExtraction: true };
  const [finding] = openFindings(read([event], new Map()).reports, [event]);
  const ack = acknowledged(finding);
  assert.deepEqual(openFindings(read([event, ack], new Map()).reports, [event, ack]), [], 'acknowledged, and nothing else changed');

  const rows = new Map([[textKey('e1', 'text'), { value: 'a forged row', salt: newSalt() }]]);
  const withRow = openFindings(read([event, ack], rows).reports, [event, ack]);
  assert.deepEqual(withRow.map((f) => [f.event, f.kind]), [['e1', 'downgraded']], 'a row forged for it');
  assert.notEqual(withRow[0].finding, finding.finding);

  const later = [event, ack, removalOfE1('r1', '2026-01-03T00:00:00.000Z')];
  const withRemoval = openFindings(read(later, new Map()).reports, later);
  assert.deepEqual(withRemoval.map((f) => [f.event, f.kind]), [['e1', 'downgraded']], 'a removal forged for it');
  assert.notEqual(withRemoval[0].finding, finding.finding);
});

// ---------------------------------------------------------------- which findings are open
test('an acknowledged finding leaves the banner, and only that one', () => {
  const rows = new Map([[textKey('e1', 'text'), { value: 'forged', salt: newSalt() }]]);
  const events = [recorded('e1', 'real', newSalt()), recorded('e2', 'also real', newSalt())];
  const { reports } = read(events, rows); // e2 has no row at all: unaccounted
  const open = openFindings(reports, events);
  assert.deepEqual(open.map((f) => [f.event, f.kind]), [['e1', 'overwritten'], ['e2', 'unaccounted']]);
  assert.deepEqual(open.map((f) => [f.page, f.block, f.key, f.fieldKey]),
    [['A01', 'A01.1.1', 'panel.tamper.overwritten', 'panel.tamper.field.text'],
      ['A01', 'A01.1.1', 'panel.tamper.unaccounted', 'panel.tamper.field.text']]);
  const after = openFindings(reports, [...events, acknowledged(open[0])]);
  assert.deepEqual(after.map((f) => f.event), ['e2']);
});

test('a new tampering of an acknowledged field raises the banner again', () => {
  const salt = newSalt();
  const event = recorded('e1', 'the real text', salt);
  const rows = new Map([[textKey('e1', 'text'), { value: 'first forgery', salt: newSalt() }]]);
  const first = read([event], rows);
  const [finding] = openFindings(first.reports, [event]);
  const ack = acknowledged(finding);
  assert.deepEqual(openFindings(read([event, ack], rows).reports, [event, ack]), [], 'acknowledged, and nothing else changed');

  // The same field, the same case, edited again: a finding nobody has acknowledged.
  rows.set(textKey('e1', 'text'), { value: 'second forgery', salt: newSalt() });
  const again = openFindings(read([event, ack], rows).reports, [event, ack]);
  assert.deepEqual(again.map((f) => [f.event, f.field, f.kind]), [['e1', 'text', 'overwritten']]);
  assert.notEqual(again[0].finding, finding.finding);

  // And the same field in another case: the row gone altogether.
  rows.delete(textKey('e1', 'text'));
  assert.deepEqual(openFindings(read([event, ack], rows).reports, [event, ack]).map((f) => f.kind), ['unaccounted']);
});

test('only an acknowledgement quiets a finding: not another event naming it, not one written as an agent', () => {
  const events = [recorded('e1', 'real', newSalt())];
  const { reports } = read(events, new Map());
  const [finding] = openFindings(reports, events);
  // What `POST /events` lets any member write: `data` is the client's.
  const comment = { id: 'c1', type: 'comment', page: 'A01', block: 'A01.1.1', author: MEMBER,
    when: '2026-01-02T00:00:00.000Z', data: { finding: finding.finding, asAgent: 'false' } };
  assert.equal(openFindings(reports, [...events, comment]).length, 1, 'a comment carrying the id quiets nothing');
  // The route stamps `asAgent: "false"` and nothing else; any other value did not come through it.
  const markedAs = (value) => {
    const ack = acknowledged(finding);
    const data = { ...ack.data };
    if (value === undefined) delete data.asAgent; else data.asAgent = value;
    return { ...ack, data };
  };
  for (const [value, why] of [['true', 'recorded as an agent\'s'], [true, 'marked with a boolean'], [false, 'marked with the boolean false'], [undefined, 'with no mark at all']]) {
    assert.equal(openFindings(reports, [...events, markedAs(value)]).length, 1, `an acknowledgement ${why} counts for nothing`);
  }
  assert.equal(openFindings(reports, [...events, markedAs('false')]).length, 0, 'the owner\'s, as the route writes it, does');
});

test('a finding reported twice by one read is drawn once', () => {
  const events = [recorded('e1', 'real', newSalt())];
  const { reports } = read(events, new Map());
  assert.equal(openFindings([...reports, ...reports], events).length, 1);
});

// ---------------------------------------------------------------- who may acknowledge
test('only the owner may acknowledge: not an admin, not a member, not an agent', () => {
  assert.equal(mayAcknowledge(roles, OWNER), true);
  assert.equal(mayAcknowledge(roles, ` ${OWNER.toUpperCase()} `), true, 'the owner, however the address was typed');
  assert.equal(mayAcknowledge(roles, ADMIN), false, 'admin holds every capability but lock, and still not this');
  assert.equal(mayAcknowledge(roles, MEMBER), false);
  assert.equal(mayAcknowledge(roles, AGENT), false);
});

test('an agent is refused even when the owner\'s own address is marked as one', () => {
  // `rolesOf` refuses to start like this; `createRoles` builds it anyway, so this layer is provable
  // on its own (roles.js, `createRoles`'s own comment).
  const contradictory = createRoles(OWNER, '', '', OWNER);
  assert.equal(mayAcknowledge(contradictory, OWNER), false);
});

test('a token carrying the owner\'s own address still cannot acknowledge (issue #138)', () => {
  // `agentByToken(OWNER)` is what a request signs in as when the owner's address is behind a
  // token, not a session (server.ts, `apiViewerOf`). Asked of the ADDRESS ALONE — the mistake this
  // guards against — `isAgent` would miss it and `isOwner` would answer "yes": `email` is the
  // owner's, and nothing about a plain string says it came in with a token. Asked of the identity
  // itself, `isAgent` catches it first, the same as any other token (roles.js, `isAgent`).
  const asToken = agentByToken(OWNER);
  assert.equal(mayAcknowledge(roles, asToken), false);
  assert.equal(mayAcknowledge(roles, OWNER), true, 'the same address, signed in with a session, still may');

  const open = openOne();
  assert.deepEqual(
    acknowledgementRefusal(roles, asToken, { finding: open[0].finding }, open),
    { refused: { status: 403, key: 'api.tamper.ownerOnly' } },
  );

  // `AS_AGENT_FIELD` on the event server.ts writes: `String(roles.isAgent(who))`. A token identity
  // must stamp "true" so `isAcknowledgement` (this file) never reads it as the owner's — asking of
  // `email` instead would stamp "false", the one shape that quiets the banner.
  assert.equal(roles.isAgent(asToken), true);
});

const openOne = () => {
  const events = [recorded('e1', 'real', newSalt())];
  return openFindings(read(events, new Map()).reports, events);
};

test('an acknowledgement is refused to a non-owner before the body is looked at, forged fields and all', () => {
  const open = openOne();
  const forged = { finding: open[0].finding, owner: true, isOwner: true, author: OWNER, asAgent: 'false',
    data: { event: 'e1', field: 'text' }, type: TAMPER_ACKNOWLEDGED };
  for (const who of [ADMIN, MEMBER, AGENT]) {
    assert.deepEqual(acknowledgementRefusal(roles, who, forged, open), { refused: { status: 403, key: 'api.tamper.ownerOnly' } }, who);
  }
  assert.deepEqual(acknowledgementRefusal(roles, '', forged, open), { refused: { status: 403, key: 'api.tamper.ownerOnly' } }, 'nobody');
  // Naming no finding, and naming one that is not open: a non-owner still hears only "not yours",
  // never the 400 or the 409 the owner would — identity is asked before anything the body says.
  for (const who of [ADMIN, MEMBER, AGENT]) {
    for (const body of [{}, { finding: 'a'.repeat(64) }]) {
      assert.deepEqual(acknowledgementRefusal(roles, who, body, open), { refused: { status: 403, key: 'api.tamper.ownerOnly' } },
        `${who} ${JSON.stringify(body)}`);
    }
  }
});

test('the owner acknowledges only a finding that is open now', () => {
  const open = openOne();
  const refusal = (body, list = open) => acknowledgementRefusal(roles, OWNER, body, list);
  assert.deepEqual(refusal({}), { refused: { status: 400, key: 'api.tamper.findingRequired' } });
  assert.deepEqual(refusal({ finding: 7 }), { refused: { status: 400, key: 'api.tamper.findingRequired' } });
  assert.deepEqual(refusal({ finding: 'not-a-finding' }), { refused: { status: 400, key: 'api.tamper.findingRequired' } });
  assert.deepEqual(refusal({ finding: 'a'.repeat(64) }), { refused: { status: 409, key: 'api.tamper.notOpen' } },
    'one nobody found — or one predicted before it happens');
  assert.deepEqual(refusal({ finding: open[0].finding }, []), { refused: { status: 409, key: 'api.tamper.notOpen' } },
    'one already acknowledged');
  assert.deepEqual(refusal({ finding: open[0].finding }), { found: open[0] });
});

test('the acknowledgement is built from what the server found, and carries no text', () => {
  const [found] = openOne();
  const event = acknowledgementOf(found);
  assert.deepEqual(event, { type: TAMPER_ACKNOWLEDGED, page: 'A01', block: 'A01.1.1',
    data: { event: 'e1', field: 'text', kind: 'unaccounted', finding: found.finding } });
  assert.equal('text' in event || 'snapshot' in event, false, 'nothing in it is ever a text to erase');
});

test('the general events path refuses the acknowledgement type as unknown', () => {
  // `refusalOf` (server.ts) answers 400 for any type outside EVENT_TYPES; engine/test-contract.sh
  // proves the answer over HTTP.
  assert.equal(EVENT_TYPES.has(TAMPER_ACKNOWLEDGED), false);
});

test('every case the server can send has its sentence in every dictionary', () => {
  const keys = [...TAMPER_KINDS.map(tamperKey), tamperFieldKey('text'), tamperFieldKey('snapshot')];
  for (const lang of ['en', 'pt-BR', 'es']) {
    const dictionary = JSON.parse(readFileSync(new URL(`../locales/${lang}.json`, import.meta.url), 'utf8'));
    assert.deepEqual(keys.filter((k) => typeof dictionary[k] !== 'string'), [], lang);
  }
});

// ---------------------------------------------------------------- it never repairs
test('the acknowledgement does not repair the text: it still reads as tampered, and is still reported', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'holdrim-tamper-'));
  const path = join(dir, 'events.db');
  const s = new SqliteEventStore(path);
  try {
    // A direct writer: an event whose hash is of a text its own row does not hold.
    const db = new DatabaseSync(path);
    db.prepare("INSERT INTO events (id, type, page, block, author, happened_at, text_hash) VALUES " +
      "('e1', 'comment', 'A01', 'A01.1.1', 'r@example.org', '2026-01-01T00:00:00.000Z', ?)").run(hashText('the real text', newSalt()));
    db.prepare("INSERT INTO texts (event, field, value, salt) VALUES ('e1', 'text', 'a forged text', ?)").run(newSalt());
    db.close();

    const found = [];
    const [finding] = openFindings(found, await s.list(null, found));
    assert.equal(finding?.kind, 'overwritten');
    // As the route appends it, with the `asAgent` it stamps from the identity it saw.
    const incoming = acknowledgementOf(finding);
    const ack = await s.append({ ...incoming, data: { ...incoming.data, asAgent: 'false' } }, OWNER);
    assert.equal(ack.text, null);

    const again = [];
    const after = await s.list(null, again);
    const e1 = after.find((e) => e.id === 'e1');
    assert.equal(e1.textTampered, true, 'the field goes on reading as tampered');
    assert.equal(e1.text, null, 'and its forged value is still not handed out');
    assert.deepEqual(again.map((r) => r.finding), [finding.finding], 'and the read still reports it, for the CRITICAL line');
    assert.deepEqual(openFindings(again, after), [], 'only the banner is quiet');
  } finally { await s.close(); rmSync(dir, { recursive: true, force: true }); }
});
