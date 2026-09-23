/**
 * Gate for issue #136 — `UpstreamTrust` is one option, one policy per engine, translated for the
 * two doors that start an engine: the spawn command line and the embedded `rift_serve_admin`
 * payload. The variants are a union so file+PEM and skip+CA are unrepresentable.
 */

import path from 'path';
import {
  assertUpstreamTrust,
  upstreamTrustServeKey,
  upstreamTrustServeOptions,
  upstreamTrustSpawnArgs,
  MIN_UPSTREAM_TRUST_ENGINE,
} from '../../src/upstream-trust.js';
import { InvalidDefinition } from '../../src/errors.js';

const PEM = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n';

describe('issue #136 — upstreamTrust translation', () => {
  it('pins the engine floor for the spawn gate', () => {
    expect(MIN_UPSTREAM_TRUST_ENGINE).toBe('0.18.0');
  });

  it('serve options: exactly one key per variant, the file made absolute', () => {
    expect(upstreamTrustServeOptions({ caFile: '/etc/ssl/corp-ca.pem' })).toEqual({ upstreamCaFile: '/etc/ssl/corp-ca.pem' });
    expect(upstreamTrustServeOptions({ caFile: 'certs/ca.pem' })).toEqual({
      upstreamCaFile: path.resolve('certs/ca.pem'),
    });
    expect(upstreamTrustServeOptions({ caPem: PEM })).toEqual({ upstreamCaPem: PEM });
    expect(upstreamTrustServeOptions({ skipVerify: true })).toEqual({ upstreamTlsSkipVerify: true });
  });

  it('names the one serve key each variant needs the engine to advertise', () => {
    expect(upstreamTrustServeKey({ caFile: '/c.pem' })).toBe('upstreamCaFile');
    expect(upstreamTrustServeKey({ caPem: PEM })).toBe('upstreamCaPem');
    expect(upstreamTrustServeKey({ skipVerify: true })).toBe('upstreamTlsSkipVerify');
  });

  it('spawn args: caFile and skipVerify have CLI flags, caPem does not', () => {
    expect(upstreamTrustSpawnArgs({ caFile: '/etc/ssl/corp-ca.pem' })).toEqual(['--upstream-ca-file', '/etc/ssl/corp-ca.pem']);
    expect(upstreamTrustSpawnArgs({ caFile: 'certs/ca.pem' })).toEqual(['--upstream-ca-file', path.resolve('certs/ca.pem')]);
    expect(upstreamTrustSpawnArgs({ skipVerify: true })).toEqual(['--upstream-tls-skip-verify']);
    expect(() => upstreamTrustSpawnArgs({ caPem: PEM })).toThrow(InvalidDefinition);
    expect(() => upstreamTrustSpawnArgs({ caPem: PEM })).toThrow(/caFile/);
  });

  it('refuses a blank caFile, a PEM without a certificate block, and a falsy skipVerify', () => {
    expect(() => assertUpstreamTrust({ caFile: '' })).toThrow(InvalidDefinition);
    expect(() => assertUpstreamTrust({ caFile: '   ' })).toThrow(InvalidDefinition);
    expect(() => assertUpstreamTrust({ caPem: 'not a pem' })).toThrow(/BEGIN CERTIFICATE/);
    expect(() => assertUpstreamTrust({ skipVerify: false } as unknown as { skipVerify: true })).toThrow(InvalidDefinition);
    expect(() => assertUpstreamTrust({} as unknown as { skipVerify: true })).toThrow(InvalidDefinition);
    // Two variants at once — reachable from a merged or JSON-sourced object — is refused, not
    // resolved by picking one.
    expect(() => assertUpstreamTrust({ caFile: '/c.pem', caPem: PEM } as unknown as { caFile: string })).toThrow(/caFile and caPem/);
    expect(() => upstreamTrustServeOptions({ caFile: '/c.pem', skipVerify: true } as unknown as { caFile: string })).toThrow(InvalidDefinition);
    expect(() => assertUpstreamTrust({ caFile: '/c.pem' })).not.toThrow();
    expect(() => assertUpstreamTrust({ caPem: PEM })).not.toThrow();
    expect(() => assertUpstreamTrust({ skipVerify: true })).not.toThrow();
  });
});
