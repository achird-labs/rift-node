/**
 * Gate for issue #137 — mutual TLS on an HTTPS imposter over a live spawned engine, with real
 * handshakes: a client certificate issued by the imposter's trust anchor is accepted, one from an
 * unrelated CA and no certificate at all are refused, and `requireClientCertificate()` with no
 * anchor accepts any client. Fixtures under test/fixtures/tls (shared with rift-java; see its
 * README for the openssl recipe). Self-skips without a Rift binary, and below engine 0.18.0.
 */

import { execSync } from 'child_process';
import fs from 'fs';
import https from 'https';
import path from 'path';
import { fileURLToPath } from 'url';
import { rift, imposter, onGet, okJson } from '../../src/index.js';
import { probeBinaryVersion } from '../../src/spawn/spawn.js';
import { isAtLeastVersion } from '../../src/version.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const tls = path.join(here, '..', 'fixtures', 'tls');
const read = (name: string): Buffer => fs.readFileSync(path.join(tls, name));

function binaryPath(): string | undefined {
  if (process.env.RIFT_BINARY_PATH && fs.existsSync(process.env.RIFT_BINARY_PATH)) return process.env.RIFT_BINARY_PATH;
  if (process.env.RIFT_SKIP_BINARY_DOWNLOAD || process.env.RIFT_OFFLINE) return undefined;
  for (const name of ['rift-http-proxy', 'rift']) {
    try {
      return execSync(`${process.platform === 'win32' ? 'where' : 'which'} ${name}`, { stdio: 'pipe' }).toString().trim().split('\n')[0];
    } catch {
      /* try next */
    }
  }
  return undefined;
}

const bin = binaryPath();
const supported = bin !== undefined && isAtLeastVersion(probeBinaryVersion(bin), '0.18.0');
const describeOrSkip = supported ? describe : describe.skip;

/**
 * One GET with the given client identity; resolves the status, rejects on a handshake failure. A
 * refused client certificate surfaces as a TLS alert or a reset during the handshake — never as a
 * connection refusal, which is what an engine that is not up yet would produce.
 */
const HANDSHAKE_REFUSED = /certificate|alert|EPROTO|ECONNRESET|socket hang up/i;
function get(url: string, client?: { pfx: Buffer; passphrase: string }): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: 'GET', ca: read('ca.pem'), ...client }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
    });
    req.on('error', reject);
    req.end();
  });
}

describeOrSkip('issue #167 — connect() reads the version the engine actually reports', () => {
  it('connects under the default (fail) policy, so the version was read from /config', async () => {
    await using spawned = await rift.spawn({ binaryPath: bin });
    await using connected = await rift.connect(await spawned.adminUrl());
    expect(connected.transport).toBe('remote');
  }, 60_000);
});

describeOrSkip('issue #137 — mutual TLS on an HTTPS imposter', () => {
  const trusted = { pfx: read('client.p12'), passphrase: 'changeit' };
  const untrusted = { pfx: read('untrusted-client.p12'), passphrase: 'changeit' };
  const serverTls = { cert: read('leaf.pem').toString(), key: read('leaf-key.pem').toString() };

  it('with a trust anchor: a chained client cert is accepted, an unrelated one and none are refused', async () => {
    await using engine = await rift.spawn({ binaryPath: bin });
    const h = await engine.create(
      imposter('mtls')
        .https(serverTls)
        .requireClientCertificate([read('ca.pem').toString()])
        .stub(onGet('/who').willReturn(okJson({ ok: true })))
    );
    await expect(get(`${h.url}/who`, trusted)).resolves.toBe(200);
    await expect(get(`${h.url}/who`, untrusted)).rejects.toThrow(HANDSHAKE_REFUSED);
    await expect(get(`${h.url}/who`)).rejects.toThrow(HANDSHAKE_REFUSED);
  }, 60_000);

  it('with no anchor: any client certificate is accepted, none is still refused', async () => {
    await using engine = await rift.spawn({ binaryPath: bin });
    const h = await engine.create(
      imposter('any').https(serverTls).requireClientCertificate().stub(onGet('/who').willReturn(okJson({ ok: true })))
    );
    await expect(get(`${h.url}/who`, untrusted)).resolves.toBe(200);
    await expect(get(`${h.url}/who`)).rejects.toThrow(HANDSHAKE_REFUSED);
  }, 60_000);

  it('the replayable export carries the keys (the per-imposter GET omits them, like cert/key)', async () => {
    await using engine = await rift.spawn({ binaryPath: bin });
    const ca = read('ca.pem').toString();
    const h = await engine.create(imposter('rt').https(serverTls).requireClientCertificate([ca]));
    // Engine 0.18.0 fact: GET /imposters/:port is a runtime view (no cert, key, mutualAuth,
    // rejectUnauthorized or ca) — only the replayable list export echoes the TLS material.
    expect(await h.toJson()).not.toHaveProperty('mutualAuth');
    const exported = (await engine.admin.listImposters({ replayable: true })).imposters;
    expect(exported).toHaveLength(1);
    expect(exported[0]).toMatchObject({ protocol: 'https', mutualAuth: true, rejectUnauthorized: true, ca });
  }, 60_000);
});
