/**
 * Gate for issue #147 — what engine 0.18.0 does with behaviors on a proxy response, and the
 * --allowInjection gate on a scripted block there (rift#1189, rift#1181). Pins the facts the docs
 * state. Self-skips without a Rift binary and below 0.18.0.
 */

import { execSync } from 'child_process';
import fs from 'fs';
import { rift, imposter, onGet, ok, proxyTo } from '../../src/index.js';
import { InvalidDefinition } from '../../src/errors.js';
import { probeBinaryVersion } from '../../src/spawn/spawn.js';
import { isAtLeastVersion } from '../../src/version.js';

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

const DECORATE = "function (config) { config.response.body = config.response.body + '!'; }";

describeOrSkip('issue #147 — behaviors on a proxy response in engine 0.18.0', () => {
  it('a scripted block on a proxy response needs allowInjection; a plain wait does not', async () => {
    await using engine = await rift.spawn({ binaryPath: bin });
    const upstream = await engine.create(imposter('up').stub(onGet('/x').willReturn(ok('hi'))));
    const gated = engine.create(imposter('px').stub(onGet('/x').willReturn(proxyTo(upstream.url).decorate(DECORATE))));
    await expect(gated).rejects.toThrow(InvalidDefinition);
    await expect(gated).rejects.toThrow(/injection/i);
    await expect(engine.create(imposter('pw').stub(onGet('/x').willReturn(proxyTo(upstream.url).latency(1))))).resolves.toBeDefined();
  }, 60_000);

  it('with allowInjection, the behaviors run on the upstream response: decorate transforms, wait delays', async () => {
    await using engine = await rift.spawn({ binaryPath: bin, allowInjection: true });
    const upstream = await engine.create(imposter('up').stub(onGet('/x').willReturn(ok('hi'))));
    const px = await engine.create(
      imposter('px').stub(onGet('/x').willReturn(proxyTo(upstream.url).proxyAlways().decorate(DECORATE).latency(300)))
    );
    const started = Date.now();
    const body = await (await fetch(`${px.url}/x`)).text();
    expect(body).toBe('hi!');
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
  }, 60_000);
});
