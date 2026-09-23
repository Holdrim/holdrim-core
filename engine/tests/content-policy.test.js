/**
 * Which tag of a page gets the nonce. The browser run proves the policy refuses what carries none;
 * this proves the nonce lands on the panel's own tag and on no tag that only looks like it — the
 * one mistake that would hand a script of the site the panel's permission — and that the page is
 * otherwise served byte for byte.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withPanelNonce, pagePolicy, FILE_POLICY } from '../api/content-policy.ts';

const NONCE = 'n0nce+/=';
const nonced = (html) => withPanelNonce(Buffer.from(html), NONCE).toString();
const gets = (tag) => nonced(tag).includes(`nonce="${NONCE}"`);

test('the panel\'s tag gets the nonce, written either way, and keeps everything else', () => {
  assert.equal(nonced('<script type="module" src="/engine/web/panel-react.js"></script>'),
    `<script nonce="${NONCE}" type="module" src="/engine/web/panel-react.js"></script>`);
  assert.ok(gets("<SCRIPT type='module' SRC='/engine/web/panel-react.js'></SCRIPT>"));
  assert.ok(gets('<script\ntype="module"\nsrc = "/engine/web/panel-react.js"></script>'));
  // ` src=` inside another attribute's value is text, not a second source
  assert.ok(gets('<script type="module" src="/engine/web/panel-react.js" data-note="see src= below"></script>'));
});

test('a tag that only looks like the panel\'s gets nothing', () => {
  for (const tag of [
    '<script>fetch("/api/events")</script>',
    '<script src="/hostile/forge.js"></script>',
    // a suffix resolves elsewhere: this one is /engine/x.js, a path the site itself can serve
    '<script src="/engine/web/panel-react.js/../../x.js"></script>',
    '<script src="/engine/web/panel-react.js?v=1"></script>',
    '<script src="https://elsewhere.example/engine/web/panel-react.js"></script>',
    // the browser runs the FIRST src of a tag that names two
    '<script src="/hostile/forge.js" src="/engine/web/panel-react.js"></script>',
    '<script src="/engine/web/panel-react.js" src="/hostile/forge.js"></script>',
    '<script src="/engine/web/panel-react.js"src="/hostile/forge.js"></script>',
    '<script/src="/hostile/forge.js" src="/engine/web/panel-react.js"></script>',
    '<script data-src="/engine/web/panel-react.js" src="/hostile/forge.js"></script>',
  ]) assert.equal(gets(tag), false, tag);
});

test('a page in any encoding comes out byte for byte, but for the nonce', () => {
  // "Café" in Windows-1252: 0xE9 alone is not valid UTF-8, and a UTF-8 round trip would replace it
  const before = Buffer.concat([Buffer.from('<p>Caf'), Buffer.from([0xe9]), Buffer.from('</p>')]);
  const tag = '<script type="module" src="/engine/web/panel-react.js"></script>';
  const after = withPanelNonce(Buffer.concat([before, Buffer.from(tag)]), NONCE);
  assert.deepEqual(after, Buffer.concat([before, Buffer.from(tag.replace('<script', `<script nonce="${NONCE}"`))]));
});

test('a page runs only what carries its nonce, and nothing moves where its tags point', () => {
  const policy = pagePolicy(NONCE);
  assert.match(policy, new RegExp(`script-src 'nonce-${NONCE.replace(/[+/=]/g, '\\$&')}'(;|$)`));
  assert.match(policy, /base-uri 'none'/);
  assert.doesNotMatch(policy, /unsafe-inline|unsafe-eval|strict-dynamic|\*/);
  assert.match(FILE_POLICY, /script-src 'none'/);
});
