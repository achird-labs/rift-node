/**
 * Gate for issue #136 — `upstreamTrust` over a live spawned engine. A local HTTPS origin is served
 * with a leaf certificate from a private test CA (fixtures/tls, shared with rift-java); a `proxy`
 * stub against it must fail without trust and succeed with `{ caFile }` and `{ skipVerify }`.
 * Self-skips without a Rift binary, and below engine 0.18.0 (the flags do not exist there).
 */

import { execSync } from 'child_process';
import fs from 'fs';
import https from 'https';
import path from 'path';
import { fileURLToPath } from 'url';
import type { AddressInfo } from 'net';
import { jest } from '@jest/globals';
import { rift, imposter, onGet, proxyTo } from '../../src/index.js';
import { probeBinaryVersion } from '../../src/spawn/spawn.js';
import { isAtLeastVersion } from '../../src/version.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const tls = path.join(here, '..', 'fixtures', 'tls');

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

describeOrSkip('issue #136 — upstreamTrust against a private-CA origin', () => {
  let origin: https.Server;
  let originUrl: string;

  beforeAll(async () => {
    origin = https.createServer(
      { cert: fs.readFileSync(path.join(tls, 'leaf.pem')), key: fs.readFileSync(path.join(tls, 'leaf-key.pem')) },
      (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"origin":"private-ca"}');
      }
    );
    await new Promise<void>((resolve, reject) => {
      origin.once('error', reject);
      origin.listen(0, '127.0.0.1', resolve);
    });
    originUrl = `https://127.0.0.1:${(origin.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => origin.close(() => resolve()));
  });

  async function proxiedStatus(trust: Parameters<typeof rift.spawn>[0]): Promise<{ status: number; body: string }> {
    // The engine that was version-probed above is the one spawned here.
    await using engine = await rift.spawn({ ...trust, binaryPath: bin });
    const h = await engine.create(imposter('t').stub(onGet('/data').willReturn(proxyTo(originUrl).proxyAlways())));
    const res = await fetch(`${h.url}/data`);
    return { status: res.status, body: await res.text() };
  }

  it('without trust the private CA is unknown to the engine and the proxy answers 502', async () => {
    const { status, body } = await proxiedStatus({});
    // The engine's 502 body names the failed upstream, not the TLS reason; the reason is in its log.
    expect(status).toBe(502);
    expect(JSON.parse(body)).toMatchObject({ errors: [{ code: '502', type: 'upstream failure' }] });
  }, 45_000);

  it('with { caFile } the origin is trusted and the recording comes back', async () => {
    const { status, body } = await proxiedStatus({ upstreamTrust: { caFile: path.join(tls, 'ca.pem') } });
    expect(status).toBe(200);
    expect(body).toBe('{"origin":"private-ca"}');
  }, 45_000);

  it('with { skipVerify: true } the origin is accepted, and the SDK warns once', async () => {
    const emitWarning = jest.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
    try {
      const { status } = await proxiedStatus({ upstreamTrust: { skipVerify: true } });
      expect(status).toBe(200);
      expect(emitWarning.mock.calls.filter((c) => /skipVerify/.test(String(c[0])))).toHaveLength(1);
    } finally {
      emitWarning.mockRestore();
    }
  }, 45_000);
});
