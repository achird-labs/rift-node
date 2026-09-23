import path from 'path';
import { InvalidDefinition } from './errors.js';

/**
 * The engine's outbound TLS trust policy — what its `proxy` stubs, `https:` config sources and the
 * intercept tunnel's WebSocket relay trust when they dial an origin (engine >= 0.18.0, rift#974).
 * One policy per engine. A union rather than three fields so that a file beside an inline PEM, or
 * `skipVerify` beside a CA, cannot be expressed at all; the engine refuses the first and would
 * silently prefer the second.
 *
 * - `caFile`: extra CA certificate(s), PEM, **appended** to the OS trust store. The path is resolved
 *   against this process's cwd at option time — a spawned engine may run elsewhere.
 * - `caPem`: the same anchor inline. Embedded transport only: the engine CLI has no inline flag.
 * - `skipVerify`: accept any certificate. Development only; the SDK emits a process warning.
 *
 * Not `SSL_CERT_FILE`: the engine honours that too, but it *replaces* the trust store, so pointing
 * it at a lone private CA silently drops every public root. `caFile` exists because it appends.
 */
export type UpstreamTrust = { caFile: string } | { caPem: string } | { skipVerify: true };

/** The engine release that added the outbound trust options (`--upstream-ca-file`,
 * `--upstream-tls-skip-verify`, and the three serve options). Below it the CLI flag does not exist. */
export const MIN_UPSTREAM_TRUST_ENGINE = '0.18.0';

export function assertUpstreamTrust(trust: UpstreamTrust): void {
  // The union keeps a typed caller to one variant; a merged or JSON-sourced object is not typed,
  // and silently preferring one key over another is the "config block dropped" failure on a
  // TLS-trust surface.
  const present = (['caFile', 'caPem', 'skipVerify'] as const).filter((k) => k in trust);
  if (present.length > 1) {
    throw new InvalidDefinition(`upstreamTrust must carry exactly one of caFile, caPem or skipVerify — got ${present.join(' and ')}`);
  }
  if ('caFile' in trust) {
    if (typeof trust.caFile !== 'string' || trust.caFile.trim() === '') {
      throw new InvalidDefinition('upstreamTrust.caFile must be a path to a PEM file');
    }
    return;
  }
  if ('caPem' in trust) {
    if (typeof trust.caPem !== 'string' || !trust.caPem.includes('-----BEGIN CERTIFICATE-----')) {
      throw new InvalidDefinition('upstreamTrust.caPem must contain a -----BEGIN CERTIFICATE----- block');
    }
    return;
  }
  if ('skipVerify' in trust && trust.skipVerify === true) return;
  throw new InvalidDefinition('upstreamTrust must be one of { caFile }, { caPem } or { skipVerify: true }');
}

/** The one `rift_serve_admin` key a variant sends — and so the one the engine must advertise in
 * `serveOptions` before it is sent (presence, never version: an older engine ignores the key). */
export function upstreamTrustServeKey(trust: UpstreamTrust): 'upstreamCaFile' | 'upstreamCaPem' | 'upstreamTlsSkipVerify' {
  if ('caFile' in trust) return 'upstreamCaFile';
  if ('caPem' in trust) return 'upstreamCaPem';
  return 'upstreamTlsSkipVerify';
}

export function upstreamTrustServeOptions(
  trust: UpstreamTrust
): { upstreamCaFile: string } | { upstreamCaPem: string } | { upstreamTlsSkipVerify: true } {
  assertUpstreamTrust(trust);
  if ('caFile' in trust) return { upstreamCaFile: path.resolve(trust.caFile) };
  if ('caPem' in trust) return { upstreamCaPem: trust.caPem };
  return { upstreamTlsSkipVerify: true };
}

export function upstreamTrustSpawnArgs(trust: UpstreamTrust): string[] {
  assertUpstreamTrust(trust);
  if ('caFile' in trust) return ['--upstream-ca-file', path.resolve(trust.caFile)];
  if ('caPem' in trust) {
    throw new InvalidDefinition(
      'upstreamTrust.caPem is not available on the spawn transport: the engine CLI has no inline-PEM flag. Write the PEM to a file and pass { caFile }, or use rift.embedded().'
    );
  }
  return ['--upstream-tls-skip-verify'];
}

/** The engine logs its own warning, but an embedder installs no tracing subscriber and a spawned
 * child's stderr is drained, so neither reaches the SDK caller. */
export function warnUpstreamTrustSkipVerify(): void {
  process.emitWarning(
    'upstreamTrust.skipVerify accepts any upstream certificate — recordings made this way are of MITM-able traffic; development only',
    { code: 'RIFT_UPSTREAM_TLS_SKIP_VERIFY' }
  );
}
