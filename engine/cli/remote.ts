import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import type { Event } from '../api/types.ts';

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
export class Source {
  #local: boolean;
  #db?: string;
  #project: string;
  #localUrl: string;
  #token?: string;
  #account?: string;
  #preferredAccount?: string;

  constructor(options: { local?: boolean; project?: string; localUrl?: string; account?: string;
                        db?: string } = {}) {
    this.#local = options.local ?? false;
    // The events file, when the project runs without a cloud. This is what closes the loop
    // offline: without it, `sync` only works against the cloud store or against a server in
    // development mode — and a Holdrim started from a container is neither.
    this.#db = options.db ?? process.env.HOLDRIM_EVENTS_PATH;
    // No hard-coded value: it comes from the project's holdrim.json, or from the environment.
    this.#project = options.project ?? process.env.HOLDRIM_PROJECT ?? '';
    this.#localUrl = options.localUrl ?? process.env.HOLDRIM_LOCAL_URL ?? 'http://localhost:8095';
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
   */
  async #fromFile(path: string): Promise<Event[]> {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      const rows = db.prepare(
        'SELECT id, type, page, block, fingerprint, text, snapshot, author, happened_at, data' +
        '  FROM events ORDER BY happened_at').all() as Record<string, any>[];
      return rows.map((row) => ({
        id: String(row.id), type: String(row.type), page: String(row.page),
        block: row.block ?? null, fingerprint: row.fingerprint ?? null, text: row.text ?? null,
        snapshot: row.snapshot ?? null, author: String(row.author), when: String(row.happened_at),
        data: row.data ? JSON.parse(String(row.data)) : null,
      }));
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

    const base = `https://firestore.googleapis.com/v1/projects/${this.#requireProject()}/databases/(default)/documents`;
    const headers = { Authorization: `Bearer ${await this.#gcloudToken()}` };
    const out: Event[] = [];
    let page: string | undefined;
    do {
      const url = `${base}/events?pageSize=300${page ? `&pageToken=${page}` : ''}`;
      const r = await fetch(url, { headers });
      if (!r.ok) throw await this.#cloudError(r, 'reading');
      const body = (await r.json()) as { documents?: unknown[]; nextPageToken?: string };
      for (const d of body.documents ?? []) out.push(this.#fromFirestore(d as Record<string, any>));
      page = body.nextPageToken;
    } while (page);
    return out.sort((a, b) => a.when.localeCompare(b.when));
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

    const base = `https://firestore.googleapis.com/v1/projects/${this.#requireProject()}/databases/(default)/documents`;
    const fields: Record<string, unknown> = { author: { stringValue: author } };
    for (const [k, v] of Object.entries(event)) {
      if (v == null) continue;
      fields[k] = typeof v === 'object'
        ? { mapValue: { fields: Object.fromEntries(Object.entries(v as object).map(([a, b]) => [a, { stringValue: String(b) }])) } }
        : { stringValue: String(v) };
    }
    const id = crypto.randomUUID().replace(/-/g, '').slice(0, 20);
    const r = await fetch(`${base.replace('/documents', '')}/documents:commit`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${await this.#gcloudToken()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        writes: [{
          update: { name: `projects/${this.#project}/databases/(default)/documents/events/${id}`, fields },
          currentDocument: { exists: false },                     // insert only, never overwrite
          updateTransforms: [{ fieldPath: 'when', setToServerValue: 'REQUEST_TIME' }],
        }],
      }),
    });
    if (!r.ok) throw await this.#cloudError(r, 'writing to');
    return id;
  }

  #fromFirestore(d: Record<string, any>): Event {
    const f = d.fields ?? {};
    const s = (k: string) => f[k]?.stringValue ?? null;
    const data: Record<string, string> = {};
    for (const [k, v] of Object.entries(f.data?.mapValue?.fields ?? {})) {
      data[k] = (v as any).stringValue;
    }
    return {
      id: String(d.name).split('/').pop()!,
      type: s('type')!, page: s('page')!, block: s('block'), fingerprint: s('fingerprint'),
      text: s('text'), snapshot: s('snapshot'), author: s('author')!,
      when: f.when?.timestampValue ?? '',
      data: Object.keys(data).length ? data : null,
    };
  }
}
