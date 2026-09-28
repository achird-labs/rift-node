/**
 * Gate for issue #170 on the embedded transport (real cdylib): the embedded admin never sees the
 * engine's `_rift.warnings` in the objects it returns, so `create()` and `handle.warnings()` read
 * them through `rift_stub_warnings`. Self-skips without `RIFT_FFI_LIB` + `koffi` (same convention as
 * `embedded-quickstart`).
 */

import { createRequire } from 'module';
import { jest } from '@jest/globals';
import { rift, imposter, onGet, ok, StubWarningsError } from '../../src/index.js';
import type { wire } from '../../src/index.js';
import { isAtLeastVersion } from '../../src/version.js';

function koffiIsInstalled(): boolean {
  try {
    createRequire(import.meta.url).resolve('koffi');
    return true;
  } catch {
    return false;
  }
}

const libPath = process.env.RIFT_FFI_LIB;
const describeOrSkip = Boolean(libPath) && koffiIsInstalled() ? describe : describe.skip;

const inert: wire.Imposter = { protocol: 'http', name: 'inert', recordMatches: true };

afterEach(() => {
  jest.restoreAllMocks();
});

describeOrSkip('issue #170 — engine warnings over the embedded transport (real cdylib)', () => {
  it('create() prints the engine warning and handle.warnings() reads it', async () => {
    const spy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await using engine = await rift.embedded({ libPath });
    const handle = await engine.create(inert);
    const kinds = (await handle.warnings()).map((w) => w.warningType);

    // The embedded package pins its own cdylib, which may predate 0.18.0's config_key_ignored
    // (rift#1152); both branches assert, so an older library never passes this vacuously.
    if (isAtLeastVersion((await engine.buildInfo()).version, '0.18.0')) {
      expect(kinds).toContain('config_key_ignored');
      expect(spy.mock.calls.map((c) => String(c[0]))).toContainEqual(
        expect.stringMatching(/^rift: imposter "inert" \(port \d+\): .*recordMatches.* \[config_key_ignored\]$/)
      );
    } else {
      expect(kinds).not.toContain('config_key_ignored');
      expect(spy).not.toHaveBeenCalled();
    }
  }, 30_000);

  it("stubWarnings: 'fail' deletes the imposter and throws; a shadowed stub carries its winner's index", async () => {
    await using engine = await rift.embedded({ libPath, stubWarnings: 'fail' });
    const err = await engine
      .create(imposter('dup').stub(onGet('/a').willReturn(ok('first'))).stub(onGet('/a').willReturn(ok('second'))))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StubWarningsError);
    expect((err as StubWarningsError).imposters[0]?.warnings).toContainEqual(
      expect.objectContaining({ stubIndex: 1, shadowedByIndex: 0 })
    );
    expect(await engine.list()).toEqual([]);
  }, 30_000);
});
