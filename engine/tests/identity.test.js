/**
 * IAP JWT validation.
 *
 * Why this file exists: the contract suite tests IAP with three assertions that expect 401, 401 and
 * 401 — no JWT, forged e-mail, forged JWT. **An unconditional `return 401` passes all three**, and
 * would take down 100% of the legitimate access in production. There was not a single assertion
 * that a VALID JWT is accepted, and that is the most expensive case to break.
 *
 * Here a legitimate ES256 JWT is generated and signed on the spot, against a local JWKS, and what
 * gets checked is that it is ACCEPTED — and that every deviation from it (wrong issuer, wrong
 * audience, expired, swapped algorithm, signed by another key) is refused.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { IapIdentity } from '../api/identity-iap.ts';

const AUDIENCE = '/projects/1/locations/x/services/y';
const ISSUER = 'https://cloud.google.com/iap';

/** Starts a local JWKS and returns what it takes to sign and to validate. */
async function withKeys() {
  const { publicKey, privateKey } = await generateKeyPair('ES256', { extractable: true });
  const jwk = { ...(await exportJWK(publicKey)), kid: 'test', alg: 'ES256', use: 'sig' };
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise((ok) => server.listen(0, ok));
  const port = server.address().port;

  const other = await generateKeyPair('ES256', { extractable: true });
  return {
    privateKey, otherKey: other.privateKey,
    url: `http://127.0.0.1:${port}/jwks`,
    close: () => server.close(),
  };
}

const sign = (key, extra = {}) =>
  new SignJWT({ email: 'person@example.org', ...extra.claims })
    .setProtectedHeader({ alg: 'ES256', kid: 'test' })
    .setIssuer(extra.issuer ?? ISSUER)
    .setAudience(extra.audience ?? AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(extra.exp ?? '5m')
    .sign(key);

test('a valid IAP JWT is ACCEPTED — the assertion that was missing', async () => {
  const c = await withKeys();
  try {
    const id = new IapIdentity({ audience: AUDIENCE, environment: 'Production', jwksUrl: c.url });
    const jwt = await sign(c.privateKey);
    assert.equal(await id.email({ 'x-goog-iap-jwt-assertion': jwt }), 'person@example.org');
  } finally { c.close(); }
});

test('the e-mail comes out lowercase', async () => {
  const c = await withKeys();
  try {
    const id = new IapIdentity({ audience: AUDIENCE, environment: 'Production', jwksUrl: c.url });
    const jwt = await sign(c.privateKey, { claims: { email: 'Person@Example.ORG' } });
    assert.equal(await id.email({ 'x-goog-iap-jwt-assertion': jwt }), 'person@example.org');
  } finally { c.close(); }
});

test('every deviation from the legitimate JWT is refused', async () => {
  const c = await withKeys();
  try {
    const id = new IapIdentity({ audience: AUDIENCE, environment: 'Production', jwksUrl: c.url });
    const cases = {
      'wrong issuer': await sign(c.privateKey, { issuer: 'https://malicious.example' }),
      'audience of another service': await sign(c.privateKey, { audience: '/projects/9/services/z' }),
      'expired': await sign(c.privateKey, { exp: Math.floor(Date.now() / 1000) - 3600 }),
      'signed by another key': await sign(c.otherKey),
    };
    for (const [name, jwt] of Object.entries(cases)) {
      assert.equal(await id.email({ 'x-goog-iap-jwt-assertion': jwt }), null, name + ' should be refused');
    }
    assert.equal(await id.email({}), null, 'no header');
    assert.equal(await id.email({ 'x-goog-authenticated-user-email': 'accounts.google.com:x@y' }), null,
      'the e-mail header on its own is NEVER trustworthy');
  } finally { c.close(); }
});

test('with no audience, outside development, it does not even construct', () => {
  assert.throws(() => new IapIdentity({ environment: 'Production' }), /HOLDRIM_AUDIENCE/);
});

test('the development shortcut demands BOTH conditions', async () => {
  const modeOnly = new IapIdentity({ audience: AUDIENCE, mode: 'local', environment: 'Production' });
  assert.equal(modeOnly.localMode, false, 'local mode asked for in Production has to be ignored');
  assert.equal(await modeOnly.email({ 'x-dev-email': 'anyone@example.org' }), null);

  const both = new IapIdentity({ mode: 'local', environment: 'Development' });
  assert.equal(both.localMode, true);
  assert.equal(await both.email({ 'x-dev-email': 'anyone@example.org' }), 'anyone@example.org');
});
