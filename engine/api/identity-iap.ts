import { createRemoteJWKSet, jwtVerify } from 'jose';
import { log } from './log.ts';

/**
 * Who is using it comes from IAP: the `x-goog-iap-jwt-assertion` header is signed by Google
 * (ES256). Signature, issuer and audience all get validated — the e-mail header alone is NOT
 * trustworthy and is ignored on purpose.
 *
 * The development shortcut (`X-Dev-Email`) demands TWO conditions: development environment AND
 * `HOLDRIM_MODE=local`. The second one alone is not enough: it can be turned on in a published
 * service, and then anyone becomes owner with one header, no JWT at all.
 *
 * jose's `createRemoteJWKSet` already solves what would otherwise be hand-written: key cache, a
 * lock against concurrent fetches, and a new fetch when an unknown `kid` shows up (Google rotation).
 */
export class IapIdentity {
  #jwks: ReturnType<typeof createRemoteJWKSet>;
  #audience: string;
  #local: boolean;
  #devEmail?: string;

  /** `jwksUrl` exists so a test can start a local JWKS and prove that a VALID JWT is accepted —
   *  without it only refusal is testable, and an unconditional `return null` would pass everything. */
  constructor(cfg: { audience?: string; mode?: string; environment?: string; devEmail?: string; jwksUrl?: string }) {
    this.#jwks = createRemoteJWKSet(
      new URL(cfg.jwksUrl ?? 'https://www.gstatic.com/iap/verify/public_key-jwk'),
      { cacheMaxAge: 6 * 60 * 60 * 1000, timeoutDuration: 5000 });
    this.#audience = cfg.audience ?? '';
    const askedLocal = cfg.mode === 'local';
    const isDevelopment = (cfg.environment ?? 'Production') === 'Development';
    this.#local = askedLocal && isDevelopment;
    this.#devEmail = cfg.devEmail;

    if (askedLocal && !this.#local) {
      // Through the shared logger, in English: with its own envelope, this line would put the
      // severity under a field no collector reads, so the warning would arrive with no severity
      // and match no alert rule.
      log('WARNING', 'local_mode_ignored', {
        environment: cfg.environment,
        message: 'HOLDRIM_MODE=local asked for outside Development: IGNORED. '
          + 'Identity still comes from the IAP JWT.',
      });
    }
    if (!this.#local && !this.#audience) {
      // English, hard-coded: this refuses the boot, so there is no request and nobody whose
      // language could have been chosen. Same rule as every other configuration error.
      throw new Error(
        'HOLDRIM_AUDIENCE is required outside development: it is what ties the IAP JWT to THIS ' +
        'service. Format: /projects/<number>/locations/<region>/services/<service>.');
    }
  }

  get localMode() { return this.#local; }

  /** E-mail of the caller, or null. Null = 401. */
  async email(headers: Record<string, string | string[] | undefined>): Promise<string | null> {
    if (this.#local) {
      const dev = headers['x-dev-email'];
      return (Array.isArray(dev) ? dev[0] : dev) ?? this.#devEmail ?? null;
    }
    const raw = headers['x-goog-iap-jwt-assertion'];
    const jwt = Array.isArray(raw) ? raw[0] : raw;
    if (!jwt) return null;

    try {
      const { payload } = await jwtVerify(jwt, this.#jwks, {
        issuer: 'https://cloud.google.com/iap',
        audience: this.#audience,
        algorithms: ['ES256'],
        clockTolerance: 30,
      });
      const email = payload.email;
      return typeof email === 'string' ? email.toLowerCase() : null;
    } catch (error) {
      // The reason and nothing else: the token itself would be a credential in the log.
      log('WARNING', 'jwt_rejected', { reason: error instanceof Error ? error.message : String(error) });
      return null;
    }
  }
}
