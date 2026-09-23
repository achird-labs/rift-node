/**
 * Gate for issue #149 — `_rift.stateOps` on a live spawned engine (>= 0.18.0): declarative
 * flow-state writes run after an `is` response, in order, against the request's flow, and a
 * templated body reads them back. Self-skips without a Rift binary and below 0.18.0.
 */

import { execSync } from 'child_process';
import fs from 'fs';
import { rift, imposter, onGet, ok } from '../../src/index.js';
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

describeOrSkip('issue #149 — _rift.stateOps on a live engine', () => {
  it('increments, seeds, deletes and clears flow state that a templated body reads back', async () => {
    await using engine = await rift.spawn({ binaryPath: bin });
    const h = await engine.create(
      imposter('counter')
        .stub(onGet('/hit').willReturn(ok().incrementState('hits')))
        .stub(onGet('/hit10').willReturn(ok().incrementState('hits', 10)))
        .stub(onGet('/seed').willReturn(ok().setState('hits', '40').setState('note', 'seeded')))
        .stub(onGet('/seed-and-bump').willReturn(ok().setState('hits', '50').incrementState('hits', 2)))
        .stub(onGet('/trail').willReturn(ok().setState('trail', '{{ previousValue }}x')))
        .stub(onGet('/trail-read').willReturn(ok('{{ state.trail }}').templated()))
        .stub(onGet('/forget').willReturn(ok().deleteState('note')))
        .stub(onGet('/clear').willReturn(ok().clearFlowState()))
        .stub(onGet('/count').willReturn(ok('{{ state.hits }}|{{ state.note }}').templated()))
        // Reads the value BEFORE this request's ops run (show the count, then bump it).
        .stub(onGet('/show-then-bump').willReturn(ok('{{ state.hits }}').templated().incrementState('hits')))
    );
    const text = async (path: string): Promise<string> => (await fetch(`${h.url}${path}`)).text();

    expect(await text('/count')).toBe('|');
    await text('/hit');
    await text('/hit');
    expect(await text('/count')).toBe('2|');
    await text('/hit10');
    expect(await text('/count')).toBe('12|');
    await text('/seed');
    expect(await text('/count')).toBe('40|seeded');
    // `set` of a canonical integer seeds a number that `increment` continues from...
    await text('/hit');
    expect(await text('/count')).toBe('41|seeded');
    // ...also within one response, where the ops run in list order.
    await text('/seed-and-bump');
    expect(await text('/count')).toBe('52|seeded');
    // `previousValue` is the key's value before this op — empty the first time.
    await text('/trail');
    await text('/trail');
    expect(await text('/trail-read')).toBe('xx');
    await text('/forget');
    expect(await text('/count')).toBe('52|');
    expect(await text('/show-then-bump')).toBe('52');
    expect(await text('/show-then-bump')).toBe('53');
    await text('/clear');
    expect(await text('/count')).toBe('|');
    expect(await text('/trail-read')).toBe('');
  }, 60_000);
});
