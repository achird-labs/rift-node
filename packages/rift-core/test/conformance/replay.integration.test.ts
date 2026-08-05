/**
 * Conformance replay over a live engine (issue #7), plus an embedded-transport lane (issue #13),
 * driven by the published `sdk-conformance-<version>` corpus when one is available (issue #98).
 *
 * The spawn lane requires a rift/mb binary; self-skips in CI without one (same `describeOrSkip`
 * convention as `quickstart.integration.test.ts`/`spawn.integration.test.ts`). The embedded lane
 * requires BOTH `RIFT_FFI_LIB` (a real `librift_ffi` C-ABI v2 build) AND `koffi` to be resolvable
 * (an `optionalDependency` — absent by default, including in this worktree), mirroring
 * `embedded-quickstart.integration.test.ts`'s gate; it self-skips without either.
 *
 * The corpus (rift#460) HAS shipped and is published per engine release; rift's `sdk-matrix.yml`
 * already exports `RIFT_CORPUS_DIR` job-wide. When it resolves, each manifest fixture becomes its
 * own spec in both lanes, replaying the transcripts inlined in its stubs. When it does not, the two
 * local mb fixtures are the fallback — they carry no transcripts, so a few interactions are authored
 * inline here to match the stubs each defines. `replayFixture` (driver.ts) is already
 * transport-agnostic, so a lane is just an engine factory over identical fixtures.
 *
 * The local specs run unconditionally rather than only as a fallback: rift's sdk-matrix node guard
 * requires at least one PASSED spec under an ancestor title containing "conformance replay over the
 * embedded transport", and a corpus that resolved to zero runnable fixtures (all capability-skipped)
 * would otherwise leave that guard with nothing to find and re-open rift#920. Both describe titles
 * below are load-bearing for that guard — do not rename them.
 */

import { execSync } from 'child_process';
import fs from 'fs';
import { createRequire } from 'module';

import { rift, type RiftEngine } from '../../src/index.js';
import { fromJson, type Imposter } from '../../src/model/index.js';
import { replayFixture } from './driver.js';
import {
  loadCorpus,
  loadMbFixture,
  resolveCorpusDir,
  unmetRequirements,
  type Fixture,
} from './loader.js';

function binaryAvailable(): boolean {
  if (process.env.RIFT_BINARY_PATH) return fs.existsSync(process.env.RIFT_BINARY_PATH);
  if (process.env.RIFT_OFFLINE || process.env.RIFT_SKIP_BINARY_DOWNLOAD) return false;
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  for (const name of ['rift-http-proxy', 'rift', 'mb']) {
    try {
      execSync(`${cmd} ${name}`, { stdio: 'pipe' });
      return true;
    } catch {
      /* try next */
    }
  }
  return false;
}

function koffiIsInstalled(): boolean {
  try {
    createRequire(import.meta.url).resolve('koffi');
    return true;
  } catch {
    return false;
  }
}

const describeOrSkip = binaryAvailable() ? describe : describe.skip;

const embeddedLibPath = process.env.RIFT_FFI_LIB;
const embeddedRunnable = Boolean(embeddedLibPath) && koffiIsInstalled();
const describeEmbeddedOrSkip = embeddedRunnable ? describe : describe.skip;

// Module scope on purpose: a set-but-invalid RIFT_CORPUS_DIR throws here and fails the whole suite,
// rather than degrading to the local fixtures and reporting a green run that proved nothing.
const corpusDir = resolveCorpusDir();
const corpusFixtures: Fixture[] = corpusDir === undefined ? [] : loadCorpus(corpusDir);

/**
 * Capabilities these lanes provide, against the manifest's closed set
 * `["injection","proxy","redis","https","shell"]`. Per the corpus contract (§4) a fixture may be
 * skipped ONLY for a capability its lane lacks — never ad hoc.
 *
 * `injection` is available on both lanes: spawn passes `--allow-injection` below, and the embedded
 * transport needs no flag at all, because `createImposter` always routes through
 * `rift_create_imposter` and never the HTTP admin surface that `allowInjection` gates (see
 * `rift-embedded/src/admin.ts`). `proxy` is not: those fixtures need an upstream this suite does not
 * stand up, which is the same posture as the java lane. `redis`/`https`/`shell` are likewise absent.
 */
const LANE_CAPABILITIES: ReadonlySet<string> = new Set(['injection']);

/**
 * A fixture with no `_verify` transcripts still has to prove it *serves* — create it and confirm the
 * imposter is actually listening. Create-only would pass even if the engine accepted the config and
 * then bound nothing, which is the failure mode worth catching for these three fixtures.
 *
 * The assertion is that `fetch` RESOLVED: reaching a listener is the whole claim, and the status is
 * deliberately not constrained because a fixture with no transcript declares no expected response
 * (an unmatched request legitimately answers 4xx here).
 */
async function smokeServe(engine: RiftEngine, fixture: Fixture): Promise<void> {
  const imposter = fromJson<Imposter>(fixture.imposterJson);
  delete imposter.port;
  const handle = await engine.create(imposter);
  try {
    const res = await fetch(new URL('/', handle.url));
    expect(res).toBeInstanceOf(Response);
  } finally {
    await handle.delete();
  }
}

/** Registers one spec per manifest fixture against a lane's engine factory. */
function registerCorpusSpecs(makeEngine: () => Promise<RiftEngine>): void {
  for (const fixture of corpusFixtures) {
    const unmet = unmetRequirements(fixture, LANE_CAPABILITIES);
    const run = unmet.length === 0 ? it : it.skip;
    const label =
      unmet.length === 0
        ? `replays ${fixture.name}`
        : `replays ${fixture.name} [skipped: lane lacks ${unmet.join(', ')}]`;

    run(
      label,
      async () => {
        await using engine = await makeEngine();
        if (fixture.interactions.length === 0) {
          await smokeServe(engine, fixture);
        } else {
          await replayFixture(engine, fixture);
        }
      },
      60000
    );
  }
}

function basicApiFixture(): Fixture {
  return {
    ...loadMbFixture('basic-api.json'),
    interactions: [
      { request: { method: 'GET', path: '/health' }, expect: { status: 200, body: 'OK' } },
      {
        request: { method: 'GET', path: '/api/users' },
        expect: {
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: [
            { id: 1, name: 'Alice' },
            { id: 2, name: 'Bob' },
          ],
        },
      },
      {
        request: { method: 'POST', path: '/api/users' },
        expect: { status: 201, body: { id: 999, message: 'Created' } },
      },
    ],
  };
}

function errorTestingFixture(): Fixture {
  return {
    ...loadMbFixture('error-testing.json'),
    interactions: [
      { request: { method: 'GET', path: '/success' }, expect: { status: 200, body: { status: 'ok' } } },
      {
        request: { method: 'GET', path: '/error/404' },
        expect: { status: 404, body: { error: 'Not Found' } },
      },
      {
        request: { method: 'GET', path: '/error/503' },
        expect: { status: 503, headers: { 'retry-after': '30' }, bodyContains: 'Service Unavailable' },
      },
    ],
  };
}

describeOrSkip('issue #7 — conformance replay over a spawned engine', () => {
  it('replays basic-api.json: health check, list, and create', async () => {
    await using engine = await rift.spawn();
    await replayFixture(engine, basicApiFixture());
  }, 30000);

  it('replays error-testing.json: a success path and a documented error path', async () => {
    await using engine = await rift.spawn();
    await replayFixture(engine, errorTestingFixture());
  }, 30000);

  it('fails loudly, naming the fixture and step, on a genuine mismatch', async () => {
    await using engine = await rift.spawn();
    const fixture: Fixture = {
      ...loadMbFixture('basic-api.json'),
      interactions: [{ request: { method: 'GET', path: '/health' }, expect: { status: 999 } }],
    };

    await expect(replayFixture(engine, fixture)).rejects.toThrow(
      'conformance replay failed: fixture "basic-api.json" step 0'
    );
  }, 30000);

  // --allow-injection so the `injection` fixtures are run rather than skipped (contract §4).
  registerCorpusSpecs(() => rift.spawn({ allowInjection: true }));
});

describeEmbeddedOrSkip('issue #13 — conformance replay over the embedded transport', () => {
  it('replays basic-api.json: health check, list, and create', async () => {
    await using engine = await rift.embedded({ libPath: embeddedLibPath });
    await replayFixture(engine, basicApiFixture());
  }, 30000);

  it('replays error-testing.json: a success path and a documented error path', async () => {
    await using engine = await rift.embedded({ libPath: embeddedLibPath });
    await replayFixture(engine, errorTestingFixture());
  }, 30000);

  it('fails loudly, naming the fixture and step, on a genuine mismatch', async () => {
    await using engine = await rift.embedded({ libPath: embeddedLibPath });
    const fixture: Fixture = {
      ...loadMbFixture('basic-api.json'),
      interactions: [{ request: { method: 'GET', path: '/health' }, expect: { status: 999 } }],
    };

    await expect(replayFixture(engine, fixture)).rejects.toThrow(
      'conformance replay failed: fixture "basic-api.json" step 0'
    );
  }, 30000);

  registerCorpusSpecs(() => rift.embedded({ libPath: embeddedLibPath }));
});
