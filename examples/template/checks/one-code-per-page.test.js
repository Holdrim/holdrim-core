/**
 * The proof behind Y01.2.4, the template's example of a domain rule: a block code appears once per
 * page.
 *
 * It lives INSIDE the template, next to the pages it guards, because `data-proof` is resolved from
 * the content project's root. A test in the engine's own repository would exist only where the
 * engine is checked out: copy the template into a project and the rule would name a file that is
 * not there, so `holdrim check` would fail on the first day. A proof has to travel with the rule it
 * proves.
 *
 * No dependency on purpose: an adopter runs it with the Node they already have.
 *
 *     node --test 'checks/*.test.js'
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const { content } = JSON.parse(readFileSync(join(ROOT, 'holdrim.json'), 'utf8'));

test('a block code appears once per page', () => {
  let pages = 0;
  for (const folder of content.folders) {
    for (const name of readdirSync(join(ROOT, folder)).filter((n) => n.endsWith('.html'))) {
      pages++;
      const codes = [...readFileSync(join(ROOT, folder, name), 'utf8').matchAll(/data-code="([^"]+)"/g)]
        .map((m) => m[1]);
      const repeated = codes.filter((code, i) => codes.indexOf(code) !== i);
      // Two blocks sharing a code are one block to the engine: the second replaces the first, and
      // an approval given to one text ends up filed against another.
      assert.deepEqual(repeated, [], `${folder}/${name} repeats ${repeated.join(', ')}`);
    }
  }
  // A rule proved over zero pages proves nothing: a renamed folder would pass in silence.
  assert.ok(pages > 0, 'no page was read — check `content.folders` in holdrim.json');
});
