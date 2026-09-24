/**
 * One of several threads asking one SQLite file for the same people at the same moment.
 *
 * A thread and not a second store in the test's own thread: `node:sqlite` is synchronous, so two
 * stores in one thread take turns and never meet — the race between two processes on one file is
 * only there when each connection runs on its own.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { SqliteEventStore } from '../../api/store-sqlite.ts';

const { path, emails, gate } = workerData;
const s = new SqliteEventStore(path);
const flag = new Int32Array(gate);
parentPort.postMessage({ ready: true });
// Every thread waits here until the last one has opened the file, so the writes start together.
Atomics.wait(flag, 0, 0);
try {
  const ids = [];
  for (const e of emails) ids.push(await s.personFor(e));
  parentPort.postMessage({ ids });
} catch (err) {
  parentPort.postMessage({ error: String(err?.message ?? err) });
} finally {
  await s.close();
}
