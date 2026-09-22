/**
 * In a test file's process, console output goes to stderr instead of stdout.
 *
 * Loaded by `npm test` with `--import`, so every test file gets it; see package.json.
 *
 * ⚠️ stdout is not a free channel there. The runner reads each test file's stdout as a stream of
 * binary frames, and on Node 22 its parser has a bug (nodejs/node#64061, fixed in 24, never in 22):
 * when a frame and a line of text share one chunk and the text starts with a non-ASCII character,
 * it reads the text's bytes as the next frame's size and fails with "Unable to deserialize cloned
 * data" — or drops the whole file from the report. The CLI's messages start with `✗`, the tests
 * call it in-process, and CI's job on the oldest supported Node failed exactly that way while the
 * same run on Node 24 passed. Whether a given run hits it depends on how the writes are chunked,
 * so it cannot be avoided by luck, only by keeping text off that channel.
 *
 * stderr carries no frames, so any text is safe there, and the runner still shows it. Only the
 * test file's own process is touched (NODE_TEST_CONTEXT is set there): the runner above it, and
 * every process a test spawns, write where they always did.
 */
if (process.env.NODE_TEST_CONTEXT) {
  for (const name of ['log', 'info', 'debug']) console[name] = console.error;
}
