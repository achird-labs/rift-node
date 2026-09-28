/**
 * Gate for issue #170 on a live engine (spawn lane): `_rift.warnings` reaches `handle.warnings()`
 * and the `stubWarnings` policy of `create()` / `replaceAll()`. `config_key_ignored` is engine
 * >= 0.18.0 (rift#1152), so the suite self-skips below it and without a Rift binary.
 */

import { execSync } from 'child_process';
import fs from 'fs';
import { jest } from '@jest/globals';
import { rift, imposter, onGet, ok, StubWarningsError } from '../../src/index.js';
import type { wire } from '../../src/index.js';
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

/** `recordMatches: true` is parsed and ignored by every Rift engine; 0.18.0 says so. */
const inert = (port: number): wire.Imposter => ({ port, protocol: 'http', name: 'inert', recordMatches: true });

afterEach(() => {
  jest.restoreAllMocks();
});

describeOrSkip('issue #170 — engine warnings on a live engine (spawn)', () => {
  it('create(): a config_key_ignored warning is printed by default and readable from the handle', async () => {
    const spy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await using engine = await rift.spawn({ binaryPath: bin });
    const handle = await engine.create(inert(0));

    const warnings = await handle.warnings();
    expect(warnings).toContainEqual(expect.objectContaining({ warningType: 'config_key_ignored' }));
    expect(warnings.find((w) => w.warningType === 'config_key_ignored')?.message).toMatch(/recordMatches/);
    expect(spy.mock.calls.map((c) => String(c[0]))).toContainEqual(
      expect.stringMatching(/^rift: imposter "inert" \(port \d+\): .*recordMatches.* \[config_key_ignored\]$/)
    );
  }, 45_000);

  it("stubWarnings: 'fail' deletes the imposter and throws StubWarningsError", async () => {
    await using engine = await rift.spawn({ binaryPath: bin, stubWarnings: 'fail' });
    const err = await engine.create(inert(0)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StubWarningsError);
    const [offender] = (err as StubWarningsError).imposters;
    expect(offender?.warnings.map((w) => w.warningType)).toContain('config_key_ignored');
    expect(await engine.list()).toEqual([]);
  }, 45_000);

  it('a shadowed stub is reported with the index of the stub that wins; a plain catch-all is not an error', async () => {
    await using engine = await rift.spawn({ binaryPath: bin, stubWarnings: 'fail' });
    // One predicate-less stub: the engine reports catch_all, which never trips the policy.
    const plain = await engine.create(imposter('plain').stub({ responses: [{ is: { statusCode: 200 } }] }));
    expect((await plain.warnings()).map((w) => w.warningType)).toEqual(['catch_all']);

    const shadowed = await engine
      .create(imposter('dup').stub(onGet('/a').willReturn(ok('first'))).stub(onGet('/a').willReturn(ok('second'))))
      .catch((e: unknown) => e);
    expect(shadowed).toBeInstanceOf(StubWarningsError);
    const found = (shadowed as StubWarningsError).imposters[0]?.warnings ?? [];
    expect(found).toContainEqual(expect.objectContaining({ stubIndex: 1, shadowedByIndex: 0 }));
  }, 45_000);

  it("replaceAll() reads each imposter's warnings (PUT answers without them)", async () => {
    const spy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await using engine = await rift.spawn({ binaryPath: bin });
    const handles = await engine.replaceAll([imposter('clean').stub(onGet('/x').willReturn(ok())), inert(0)]);
    expect(handles).toHaveLength(2);
    const printed = spy.mock.calls.map((c) => String(c[0]));
    expect(printed.filter((line) => line.includes('[config_key_ignored]'))).toHaveLength(1);
    expect(printed.some((line) => line.includes('"clean"'))).toBe(false);
  }, 45_000);
});
