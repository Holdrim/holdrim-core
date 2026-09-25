import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import type { Event } from '../api/types.ts';
import { withAuthors, personEmail, newPersonId, FIRESTORE_PEOPLE as LAYOUT } from '../api/people.ts';
import { textKey, withTexts, withTextsRetrying, reportTampered, TEXT_REMOVED,
  type RawEvent as Raw, type TextField, type TextRow, type TamperReport } from '../api/texts.ts';

/** `Event`, as this file's own reads carry the two fields `withTexts` needs and then strips. */
type RawEvent = Raw<Event>;

const exec = promisify(execFile);

/**
 * Where events come from for the agent's tool: the cloud (REST, with a gcloud token), a local
 * SQLite file, or a local server in memory.
 *
 * ⚠️ Writing straight to the cloud store bypasses the API — and therefore the cycle, the roles and
 * the limits. The right path is for the agent to come in through the API with an identity of its
 * own. Until that exists, reading happens here.
 *
 * ⚠️ Every message thrown from here is English and hard-coded. These are the lines somebody pastes
 * into a chat when the tool refuses to start, and each one names the exact command that fixes it —
 * a message that changes wording with the machine's locale cannot be searched for, and a message
 * that only states the failure leaves the reader to guess the remedy.
 */
/**
 * The Firestore emulator's address, when one is named — the variable Google's own client reads, so
 * the CLI's REST path and the server's store point at the same place. It is what lets the path
 * that writes the cloud directly be proved against a real Firestore instead of a stub.
 */
const emulator = (): string | undefined => process.env.FIRESTORE_EMULATOR_HOST || undefined;

/**
 * A Firestore `timestampValue`, normalized to the plain ms ISO string the server itself writes and
 * compares (round 2's review, MINOR). Firestore's own JSON mapping for a timestamp
 * (`google.protobuf.Timestamp`) emits 0, 3, 6 or 9 fractional digits depending on the value, while
 * every comparison of `when` in this codebase (`legacyLock`, `earliestLockBaseline`, this file's own
 * history sort) is a plain `<`/`localeCompare` on the raw string. Left un-normalized, a whole-second
 * timestamp sorts AFTER a fractional one from the same second — `'…10:00:00Z' > '…10:00:00.5Z'`
 * lexically, because `Z` (0x5A) sorts after `.` (0x2E) — even though the first is the LATER instant.
 * `Date` accepts any of the four shapes and always answers back with exactly three digits, matching
 * the server's own `new Date().toISOString()` (store-sqlite.ts, `append`).
 */
export function normalizeWhen(timestampValue: string | null | undefined): string {
  return timestampValue ? new Date(timestampValue).toISOString() : '';
}

/**
 * One Firestore document → the raw event shape `withTexts` expects. Pulled out of `Source` (it reads
 * nothing private) so a test can drive the exact parsing `events()` runs on a real document — this
 * function calling `normalizeWhen` on `when` included — without standing up the whole REST protocol
 * behind it (round 2's review, MINOR: nothing pinned that this reader calls `normalizeWhen` at all,
 * so reverting `when` back to the raw `timestampValue` string survived every test in the suite).
 */
export function firestoreEventOf(d: Record<string, any>): RawEvent {
  const f = d.fields ?? {};
  const s = (k: string) => f[k]?.stringValue ?? null;
  const data: Record<string, string> = {};
  for (const [k, v] of Object.entries(f.data?.mapValue?.fields ?? {})) {
    data[k] = (v as any).stringValue;
  }
  return {
    id: String(d.name).split('/').pop()!,
    type: s('type')!, page: s('page')!, block: s('block'), fingerprint: s('fingerprint'),
    // Absent on a document from before texts were extracted, or one the CLI's own `add` wrote —
    // that path writes straight to the cloud with no hash, a gap docs/PRIVACY.md, section 3 already
    // names — and `text`/`snapshot` there already hold their own plain value: read as such.
    text: s('text'), snapshot: s('snapshot'), textHash: s('textHash'), snapshotHash: s('snapshotHash'),
    author: s('author')!,
    when: normalizeWhen(f.when?.timestampValue),
    data: Object.keys(data).length ? data : null,
    textRemoved: null, snapshotRemoved: null, textTampered: false, snapshotTampered: false,
  };
}

export class Source {
  #local: boolean;
  #db?: string;
  #project: string;
  #localUrl: string;
  #token?: string;
  #account?: string;
  #preferredAccount?: string;
  #pageSize: number;

  constructor(options: { local?: boolean; project?: string; localUrl?: string; account?: string;
                        db?: string; pageSize?: number } = {}) {
    this.#local = options.local ?? false;
    // The events file, when the project runs without a cloud. This is what closes the loop
    // offline: without it, `sync` only works against the cloud store or against a server in
    // development mode — and a Holdrim started from a container is neither.
    this.#db = options.db ?? process.env.HOLDRIM_EVENTS_PATH;
    // No hard-coded value: it comes from the project's holdrim.json, or from the environment.
    this.#project = options.project ?? process.env.HOLDRIM_PROJECT ?? '';
    this.#localUrl = options.localUrl ?? process.env.HOLDRIM_LOCAL_URL ?? 'http://localhost:8095';
    // Not an adopter's setting — nothing here reads an environment variable for it. It exists so a
    // test can force more than one page without writing hundreds of documents to prove pagination
    // holds (round 2, finding D): the real cloud never sees anything but the default.
    this.#pageSize = options.pageSize ?? 300;
    this.#preferredAccount = process.env.HOLDRIM_ACCOUNT ?? options.account;
  }

  /**
   * With no project, the URL comes out as `projects//databases/...` and the cloud answers 400
   * "Invalid resource field value" — an error that tells the reader nothing. Failing here, naming
   * what is missing, costs one line and saves the whole investigation.
   */
  #requireProject(): string {
    if (this.#project) return this.#project;
    throw new Error(
      'I do not know which cloud project to look in.\n' +
      '  Fill in `cloud.project` in holdrim.json, or export HOLDRIM_PROJECT.\n' +
      '  To work with no cloud, use --local with the server up (bash engine/run-local.sh), or --db <events file>.');
  }

  /**
   * A local server's refusal, in words that name the fix. It answered, so asking "is it running?"
   * of every refusal would send people to restart a server that is up. A 401 is a server that does
   * not take the agent's development identity (one started without run-local.sh, behind a
   * sign-in); anything else is the server's own sentence, which says why.
   */
  async #localRefusal(r: Response): Promise<Error> {
    // The Holdrim server says why in `error`; whatever else answers on that port — another
    // service, a proxy — says it in plain text, and dropping that would leave only a number.
    const body = await r.text().catch(() => '');
    let said: unknown = body.slice(0, 200);
    try { said = (JSON.parse(body) as { error?: unknown })?.error ?? said; } catch { /* not JSON: the text is the sentence */ }
    if (r.status === 401) {
      return new Error(`the server at ${this.#localUrl} is up, but does not take the agent's development identity`
        + ' — start it with bash engine/run-local.sh, or read the events file with --db <path>');
    }
    return new Error(`the server at ${this.#localUrl} refused it (${r.status})${said ? `: ${String(said)}` : ''}`);
  }

  /**
   * The local server, or an error that says which one and what to do. With nothing listening,
   * `fetch` rejects with "fetch failed" and nothing else — the person is left to guess the address.
   */
  async #reachLocal(path: string, init: RequestInit): Promise<Response> {
    try {
      return await fetch(`${this.#localUrl}${path}`, init);
    } catch {
      throw new Error(`nothing answered at ${this.#localUrl}. Is the server running? (bash engine/run-local.sh,`
        + ' or set HOLDRIM_LOCAL_URL to where it is)');
    }
  }

  /**
   * The first gcloud account that actually issues a token.
   *
   * With the account hard-coded, an expired credential — with the owner on a remote session and no
   * way to redo the login — would simply stop the tool, even when ANOTHER authenticated account on
   * the same machine has access to the project.
   */
  async #accountWithToken(): Promise<string> {
    if (this.#account) return this.#account;
    // The emulator takes any token and has no accounts: asking gcloud would reach the real cloud
    // for a credential the emulator never reads.
    if (emulator()) return (this.#account = this.#preferredAccount ?? 'emulator');
    let accounts: string[] = [];
    try {
      const { stdout } = await exec('gcloud', ['auth', 'list', '--format=value(account)']);
      accounts = stdout.split('\n').map((s) => s.trim()).filter(Boolean);
    } catch { /* no gcloud: falls through to the clear error below */ }

    // The preferred one first, the others after: the choice stops depending on which account
    // gcloud happens to list first. If the preferred one exists but issues nothing, the others
    // still count — working remotely, with no way to redo a login, must not stop the tool.
    const order = this.#preferredAccount
      ? [this.#preferredAccount, ...accounts.filter((c) => c !== this.#preferredAccount)]
      : accounts;

    for (const candidate of order) {
      try {
        await exec('gcloud', ['auth', 'print-access-token', '--account', candidate]);
        // Reading the cloud as an identity other than the expected one is something you say out
        // loud.
        if (this.#preferredAccount && candidate !== this.#preferredAccount) {
          console.warn(`  ⚠ the credential for ${this.#preferredAccount} issues no token; reading as ${candidate}.\n` +
            `    To get back to normal:  gcloud auth login ${this.#preferredAccount} --no-launch-browser`);
        }
        return (this.#account = candidate);
      } catch { /* this one issues nothing; try the next */ }
    }

    throw new Error(
      'no gcloud account issues a token.\n' +
      '  Almost always an expired credential. Fix it with:  gcloud auth login <your e-mail>\n' +
      '  With no browser on the machine (remote access), add:  --no-launch-browser');
  }

  async #gcloudToken(): Promise<string> {
    if (this.#token) return this.#token;
    // `owner` is the emulator's own word for a caller its security rules do not apply to.
    if (emulator()) return (this.#token = 'owner');
    const account = await this.#accountWithToken();
    try {
      const { stdout } = await exec('gcloud', ['auth', 'print-access-token', '--account', account]);
      return (this.#token = stdout.trim());
    } catch {
      throw new Error(`gcloud could not get a token for ${account}.\n` +
        `  Fix it with:  gcloud auth login ${account}`);
    }
  }

  /**
   * The cloud's message comes buried in JSON; what helps is that message plus what to do.
   *
   * `what` is a verb phrase — `reading` or `writing to` — so the sentence reads as one line
   * instead of a template with a hole in it.
   */
  async #cloudError(r: Response, what: string): Promise<Error> {
    const raw = await r.text();
    let detail = raw.slice(0, 200);
    try { detail = JSON.parse(raw).error?.message ?? detail; } catch { /* it was not JSON */ }
    const account = this.#account ?? '(unknown account)';
    const out = [`error ${r.status} ${what} Firestore: ${detail}`];
    if (r.status === 403) {
      out.push(`  ${account} has no access to project ${this.#project}.`,
        '  Sign in with the account that does, or fix `cloud.account` in holdrim.json.');
    }
    if (r.status === 401) out.push(`  the token for ${account} expired:  gcloud auth login ${account} --no-launch-browser`);
    return new Error(out.join('\n'));
  }

  /**
   * Reads events straight from the SQLite file. READ ONLY — never writes: writing through here
   * would bypass the cycle, the roles and the limits.
   *
   * The four reads — events, people, texts, the extraction boundary — inside one read transaction,
   * the same fix `SqliteEventStore.list()` already has (store-sqlite.ts) and this file's own doc
   * comment already claimed for itself: round 1 of the #91 review, finding 2, is that this reader
   * never actually took it. Autocommitted one at a time on a WAL file, a `removeText` from the real
   * server landing between the events SELECT and the texts SELECT reads back as tampering that never
   * happened — a false CRITICAL alert, which is worse than none: it teaches whoever sees it that this
   * alert cries wolf.
   */
  async #fromFile(path: string): Promise<Event[]> {
    const { DatabaseSync } = await import('node:sqlite');
    const { extractionBoundary, rollbackQuietly } = await import('../api/store-sqlite.ts');
    const db = new DatabaseSync(path, { readOnly: true });
    let rows: Record<string, any>[];
    let people: Map<string, string | null>;
    let texts: Map<string, TextRow>;
    let boundary: number | null;
    try {
      db.exec('BEGIN DEFERRED');
      try {
        // `*, rowid`, not a named list: a file from before `text_hash`/`snapshot_hash` existed has no
        // such columns at all, and naming them would fail the query outright rather than read the
        // file's own, older shape — the same reason `hasPeople` below asks before it reads that
        // table. `rowid`, same as the server's own `SqliteEventStore.list()` (store-sqlite.ts): a
        // removal is always inserted after the event it names, so a tie inside one `happened_at`
        // millisecond — `notBefore` clamping a removal to its target's own timestamp — has to keep
        // breaking toward recorded order, not whatever the planner happens to pick, or the two
        // readers of one file could disagree about which side of the tie a removal falls on. As
        // store-sqlite.ts's own comment says of its identical clause: today's SQLite already hands
        // ties back in rowid order, so dropping this changes nothing the suite below can see; naming
        // it turns that accident into a promise. `rowid DESC` does fail it. It is also what
        // `extractionBoundary` below is compared against, per row, for the downgrade check.
        rows = db.prepare('SELECT *, rowid FROM events ORDER BY happened_at, rowid').all() as Record<string, any>[];
        // A file written before the people table existed has no such table, and every author in it
        // is an address: an empty table resolves none of them, which is what they need. The read
        // is the same rule the server's store applies, through the same resolver.
        const hasPeople = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'people'").get();
        people = new Map(hasPeople
          ? (db.prepare('SELECT id, email FROM people').all() as { id: string; email: string | null }[])
            .map((p) => [p.id, p.email ?? null])
          : []);
        // A file written before texts were extracted has no `texts` table either, and every row's
        // `text`/`snapshot` already holds its own plain value with no hash to check — the same rule
        // an empty people map gives an author (docs/PRIVACY.md, section 4).
        const hasTexts = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'texts'").get();
        texts = new Map(hasTexts
          ? (db.prepare('SELECT event, field, value, salt FROM texts').all() as
              { event: string; field: TextField; value: string; salt: string }[])
            .map((t) => [textKey(t.event, t.field), { value: t.value, salt: t.salt } as TextRow])
          : []);
        // Same rule again: a file with no `text_hash` column at all has never been touched by any
        // version that hashes, so nothing in it can be proven `afterExtraction` either.
        const hasHashColumns = (db.prepare('PRAGMA table_info(events)').all() as { name: string }[])
          .some((c) => c.name === 'text_hash');
        boundary = hasHashColumns ? extractionBoundary(db) : null;
        db.exec('COMMIT');
      } catch (err) {
        // Round 3 of the #91 review, MINOR: a ROLLBACK that itself throws — the transaction was
        // never actually open, say — would otherwise replace `err`, the real reason this read
        // failed, with a complaint about undoing a failure that already happened. `rollbackQuietly`
        // (engine/api/store-sqlite.ts) is the one place the ROLLBACK-swallowing lives, so
        // `SqliteEventStore.list()` and `installGuards` in that same file share the identical fix,
        // not a second copy of it; the `throw err` stays here; a version that also rethrew inside
        // the helper left `rows`/`people`/`texts` below "used before being assigned" to `tsc` — see
        // the helper's own comment for why.
        rollbackQuietly(db);
        throw err;
      }
      const events = withAuthors(rows.map((row) => ({
        id: String(row.id), type: String(row.type), page: String(row.page),
        block: row.block ?? null, fingerprint: row.fingerprint ?? null, text: row.text ?? null,
        snapshot: row.snapshot ?? null, textHash: row.text_hash ?? null, snapshotHash: row.snapshot_hash ?? null,
        author: String(row.author), when: String(row.happened_at),
        data: row.data ? JSON.parse(String(row.data)) : null,
        textRemoved: null, snapshotRemoved: null, textTampered: false, snapshotTampered: false,
        afterExtraction: boundary != null && (row.rowid as number) >= boundary,
      })), people);
      // Read straight from the file, so this is one of the two CLI readers issue #91 names: the
      // server, reading through the API, already raises this alert on its own; a person pointing
      // `--db` at the file directly gets no such server in between, so this is the only place left
      // for the alert to come from.
      const reports: TamperReport[] = [];
      const out = withTexts(events, texts, reports);
      for (const r of reports) reportTampered(r);
      return out;
    } finally {
      db.close();
    }
  }

  async events(): Promise<Event[]> {
    // The file comes before the cloud: whoever configured a local database wanted the local one.
    if (this.#db && existsSync(this.#db)) return this.#fromFile(this.#db);
    if (this.#local) {
      const r = await this.#reachLocal('/api/events', { headers: { 'X-Dev-Email': 'agent@local' } });
      if (!r.ok) throw await this.#localRefusal(r);
      return r.json() as Promise<Event[]>;
    }

    // The project before the token: with none, gcloud would be asked for a credential to send to
    // an address that does not exist.
    this.#requireProject();
    const headers = { Authorization: `Bearer ${await this.#gcloudToken()}` };
    const out = (await this.#collection(headers, 'events')).map((d) => firestoreEventOf(d));
    // The people after the events, as the server's Firestore store reads them and for its reason:
    // a person is made before their first event, so every author read above is in this read.
    const people = new Map((await this.#collection(headers, LAYOUT.rows)).map((d) =>
      [String(d.name).split('/').pop()!, (d.fields?.[LAYOUT.email]?.stringValue as string | undefined) ?? null]));
    const events = withAuthors(out, people).sort((a, b) => a.when.localeCompare(b.when));
    // The texts after the events, as the server's Firestore store reads them, for the same reason.
    const texts = new Map((await this.#collection(headers, 'texts')).map((d) => {
      const f = d.fields ?? {};
      return [textKey(f.event?.stringValue, f.field?.stringValue),
        { value: f.value?.stringValue, salt: f.salt?.stringValue } as TextRow];
    }));
    // Round 2, finding A: these three used to be one Firestore transaction, the CLI's twin of the
    // server's own (store-firestore.ts, `list`) — dropped for the same reason: a read-only
    // transaction aborts after 270 seconds and is not retried, and events/texts only grow, so
    // holding one open across a full scan of both eventually fails outright. `withTextsRetrying`
    // (engine/api/texts.ts) is the one rule both readers now share: for a field a first pass calls
    // tampered, ask once more, later, for the removal events that first pass could not have seen.
    // The other CLI reader issue #91 names: reading the cloud directly, bypassing the server and
    // therefore the alert it would otherwise have raised on this same event.
    const reports: TamperReport[] = [];
    const resolved = await withTextsRetrying(events, texts, async () => {
      // Ignores `suspects`: see withTextsRetrying's own doc comment (engine/api/texts.ts) for why.
      const removed = await this.#collection(headers, 'events',
        { fieldFilter: { field: { fieldPath: 'type' }, op: 'EQUAL', value: { stringValue: TEXT_REMOVED } } });
      return withAuthors(removed.map((d) => firestoreEventOf(d)), people);
    }, reports);
    for (const r of reports) reportTampered(r);
    return resolved;
  }

  /**
   * Every document of one collection, over as many pages as the cloud answers in, via
   * `documents:runQuery` rather than the plain `documents.list` REST read — needed for the `where`
   * the removals re-read above narrows by, which `documents.list` has no way to express. Ordered by
   * document name so a cursor (`startAt` on the last name seen) can page it. `pageSize` is `#pageSize`
   * unless a call needs its own — none here does; it exists for the constructor option of the same
   * name, which only a test sets.
   */
  async #collection(headers: Record<string, string>, name: string, where?: Record<string, unknown>):
    Promise<Record<string, any>[]> {
    const docs: Record<string, any>[] = [];
    let after: string | undefined;
    for (;;) {
      const structuredQuery: Record<string, unknown> = {
        from: [{ collectionId: name }],
        orderBy: [{ field: { fieldPath: '__name__' }, direction: 'ASCENDING' }],
        limit: this.#pageSize,
      };
      if (where) structuredQuery.where = where;
      if (after) structuredQuery.startAt = { values: [{ referenceValue: after }], before: false };
      const r = await fetch(`${this.#database()}/documents:runQuery`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ structuredQuery }),
      });
      if (!r.ok) throw await this.#cloudError(r, 'reading');
      const rows = (await r.json()) as { document?: Record<string, any> }[];
      let onThisPage = 0;
      for (const row of rows) {
        if (row.document) { docs.push(row.document); after = row.document.name as string; onThisPage++; }
      }
      if (onThisPage < this.#pageSize) break; // fewer than the limit: nothing left to page for
    }
    return docs;
  }

  /** The project's database over REST, in the cloud or in the emulator the variable names. */
  #database(): string {
    const host = emulator();
    return `${host ? `http://${host}` : 'https://firestore.googleapis.com'}/v1/projects/${this.#requireProject()}`
      + '/databases/(default)';
  }

  /** A document's full name, as a write names it: `path` is `collection/id`. */
  #documentName(path: string): string {
    return `projects/${this.#requireProject()}/databases/(default)/documents/${path}`;
  }

  /** One atomic commit of `writes`: all of them land, or none. The response is the caller's to read. */
  #commit(headers: Record<string, string>, writes: unknown[]): Promise<Response> {
    return fetch(`${this.#database()}/documents:commit`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ writes }),
    });
  }

  /**
   * The id of the person with this address in the cloud's people table, made on first sight —
   * the same rows, under the same document ids, as the server's Firestore store makes, from the
   * one layout both read (FIRESTORE_PEOPLE), so a person the CLI makes is the one the server finds,
   * and the other way round. The pointer is created only if absent; when another writer made it
   * first, theirs is the person.
   */
  async #cloudPersonFor(author: string, headers: Record<string, string>): Promise<string> {
    const email = personEmail(author);
    const key = LAYOUT.pointerId(email);
    // Encoded again in the URL: `key` is the document's own id, and the path undoes one encoding —
    // without the second, `%40` would arrive as `@`, another id.
    const pointer = `${this.#database()}/documents/${LAYOUT.pointers}/${encodeURIComponent(key)}`;
    const read = async (): Promise<string | null> => {
      const r = await fetch(pointer, { headers });
      if (r.status === 404) return null;
      if (!r.ok) throw await this.#cloudError(r, 'reading');
      return ((await r.json()) as Record<string, any>).fields?.[LAYOUT.id]?.stringValue ?? null;
    };
    const found = await read();
    if (found) return found;
    const id = newPersonId();
    const r = await this.#commit(headers, [
      { update: { name: this.#documentName(`${LAYOUT.rows}/${id}`), fields: { [LAYOUT.email]: { stringValue: email } } },
        currentDocument: { exists: false } },
      { update: { name: this.#documentName(`${LAYOUT.pointers}/${key}`), fields: { [LAYOUT.id]: { stringValue: id } } },
        currentDocument: { exists: false } },
    ]);
    if (r.ok) return id;
    // Refused with no winner to take: the event is not written, since it would name a person who
    // does not exist.
    const winner = await read();
    if (winner) return winner;
    throw await this.#cloudError(r, 'writing to');
  }

  /**
   * Records an event. Locally it goes through the API (and therefore through the cycle, the roles
   * and the limits); in the cloud, it writes to the store directly.
   *
   * ⚠️ Writing directly BYPASSES the API, and therefore every validation. The right path is for
   * the agent to have an identity of its own and come in through the API. Until that exists, this
   * is the path — and it is marked as such.
   */
  async add(event: Record<string, unknown>): Promise<string> {
    // The project before the author: naming the author asks gcloud for an account, and with no
    // project that is two gcloud runs for a write that cannot happen.
    if (!this.#local) this.#requireProject();
    const author = `agent via ${await this.#accountWithToken().catch(() => 'local')}`;

    if (this.#local) {
      const r = await this.#reachLocal('/api/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Dev-Email': author },
        body: JSON.stringify(event),
      });
      if (!r.ok) throw await this.#localRefusal(r);
      return ((await r.json()) as { id: string }).id;
    }

    const token = { Authorization: `Bearer ${await this.#gcloudToken()}` };
    // An id, as the server writes it: the address stays in the people table, where forgetting
    // the person can empty it (docs/PRIVACY.md, section 1).
    const fields: Record<string, unknown> = { author: { stringValue: await this.#cloudPersonFor(author, token) } };
    for (const [k, v] of Object.entries(event)) {
      if (v == null) continue;
      fields[k] = typeof v === 'object'
        ? { mapValue: { fields: Object.fromEntries(Object.entries(v as object).map(([a, b]) => [a, { stringValue: String(b) }])) } }
        : { stringValue: String(v) };
    }
    const id = crypto.randomUUID().replace(/-/g, '').slice(0, 20);
    const r = await this.#commit(token, [{
      update: { name: this.#documentName(`events/${id}`), fields },
      currentDocument: { exists: false },                     // insert only, never overwrite
      updateTransforms: [{ fieldPath: 'when', setToServerValue: 'REQUEST_TIME' }],
    }]);
    if (!r.ok) throw await this.#cloudError(r, 'writing to');
    return id;
  }
}
