/**
 * sdk-conformance corpus loader gate (issue #98).
 *
 * PURE: no engine, no network, no tarball. The shipped corpus layout (rift#460) is reproduced
 * synthetically in a temp dir, so these assertions pin the loader against the REAL schema — the
 * schema the java/go lanes consume — on every CI run, not only when `RIFT_CORPUS_DIR` happens to be
 * set. The loader's corpus half was previously written against a speculated layout that never
 * shipped, which is precisely the failure a synthetic-but-accurate fixture catches.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  loadCorpus,
  readCorpusManifest,
  resolveCorpusDir,
  unmetRequirements,
  type Fixture,
} from './loader.js';
import { toFetchInit } from './driver.js';

function writeCorpus(
  root: string,
  opts: {
    manifest?: unknown;
    imposter?: unknown;
    imposterFile?: string;
  } = {}
): string {
  const imposterFile = opts.imposterFile ?? 'corpus/imposters/01-sample.json';
  const imposter = opts.imposter ?? {
    name: 'Sample',
    port: 4501,
    protocol: 'http',
    stubs: [
      {
        predicates: [{ equals: { path: '/a' } }],
        responses: [{ is: { statusCode: 200, body: 'A' } }],
        _verify: {
          sequence: [
            { request: { path: '/a' }, expect: { status: 200, bodyContains: 'A' } },
            {
              request: { method: 'POST', path: '/a', headers: { 'x-k': 'v' }, body: { n: 1 } },
              expect: { status: 201, bodyEquals: { ok: true } },
            },
          ],
        },
      },
    ],
  };

  // Derived rather than hardcoded so a caller's custom imposter can't drift from the manifest's
  // claim — the loader now enforces that agreement, and a helper asserting a stale `true` would only
  // be testing the helper's own bug.
  const declaresVerify = JSON.stringify(imposter).includes('"_verify"');
  const manifest = opts.manifest ?? {
    schemaVersion: 1,
    engineVersion: 'v0.17.0',
    fixtures: [
      { file: imposterFile, port: 4501, name: '01 · Sample', requires: [], hasVerify: declaresVerify },
    ],
  };

  fs.mkdirSync(path.join(root, path.dirname(imposterFile)), { recursive: true });
  fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(root, imposterFile), JSON.stringify(imposter));
  return root;
}

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rift-corpus-'));
}

describe('corpus loader — shipped manifest schema (issue #98)', () => {
  it('reads schemaVersion/engineVersion and the fixture entry objects', () => {
    const manifest = readCorpusManifest(writeCorpus(tempRoot()));
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.engineVersion).toBe('v0.17.0');
    expect(manifest.fixtures).toHaveLength(1);
    expect(manifest.fixtures[0]).toMatchObject({
      file: 'corpus/imposters/01-sample.json',
      port: 4501,
      name: '01 · Sample',
      requires: [],
      hasVerify: true,
    });
  });

  it('flattens stubs[]._verify.sequence into interactions, in stub order', () => {
    const [fixture] = loadCorpus(writeCorpus(tempRoot()));
    expect(fixture.name).toBe('01 · Sample');
    expect(fixture.requires).toEqual([]);
    expect(fixture.interactions).toHaveLength(2);
  });

  it('defaults an omitted request.method to GET', () => {
    const [fixture] = loadCorpus(writeCorpus(tempRoot()));
    expect(fixture.interactions[0].request.method).toBe('GET');
    expect(fixture.interactions[1].request.method).toBe('POST');
  });

  it('maps bodyEquals to the driver expect.body, and passes bodyContains through', () => {
    const [fixture] = loadCorpus(writeCorpus(tempRoot()));
    expect(fixture.interactions[0].expect).toEqual({ status: 200, bodyContains: 'A' });
    expect(fixture.interactions[1].expect).toEqual({ status: 201, body: { ok: true } });
  });

  it('carries request headers and body through unchanged', () => {
    const [fixture] = loadCorpus(writeCorpus(tempRoot()));
    expect(fixture.interactions[1].request.headers).toEqual({ 'x-k': 'v' });
    expect(fixture.interactions[1].request.body).toEqual({ n: 1 });
  });

  it('unwraps the { imposters: [...] } envelope form', () => {
    const root = writeCorpus(tempRoot(), {
      imposter: { imposters: [{ name: 'Enveloped', port: 4501, protocol: 'http', stubs: [] }] },
    });
    const [fixture] = loadCorpus(root);
    expect(JSON.parse(fixture.imposterJson)).toMatchObject({ name: 'Enveloped' });
  });

  it('absolutizes a data-file path against the corpus root, so no cwd is required', () => {
    const root = tempRoot();
    writeCorpus(root, {
      imposter: {
        name: 'Lookup',
        port: 4503,
        protocol: 'http',
        stubs: [
          {
            responses: [
              {
                is: { statusCode: 200 },
                _behaviors: { lookup: { fromDataSource: { csv: { path: 'data/products.csv' } } } },
              },
            ],
          },
        ],
      },
    });
    fs.mkdirSync(path.join(root, 'corpus', 'data'), { recursive: true });
    fs.writeFileSync(path.join(root, 'corpus', 'data', 'products.csv'), 'id,name\n1,x\n');

    const [fixture] = loadCorpus(root);
    const csvPath = JSON.parse(fixture.imposterJson).stubs[0].responses[0]._behaviors.lookup
      .fromDataSource.csv.path as string;
    expect(path.isAbsolute(csvPath)).toBe(true);
    expect(fs.existsSync(csvPath)).toBe(true);
  });

  it('leaves a path that is already absolute alone', () => {
    const root = tempRoot();
    const abs = path.join(root, 'corpus', 'data', 'products.csv');
    writeCorpus(root, {
      imposter: {
        name: 'Lookup',
        port: 4503,
        protocol: 'http',
        stubs: [
          {
            responses: [
              {
                is: { statusCode: 200 },
                _behaviors: { lookup: { fromDataSource: { csv: { path: abs } } } },
              },
            ],
          },
        ],
      },
    });
    const [fixture] = loadCorpus(root);
    expect(
      JSON.parse(fixture.imposterJson).stubs[0].responses[0]._behaviors.lookup.fromDataSource.csv
        .path
    ).toBe(abs);
  });
});

// A malformed corpus must be LOUD. Silently degrading to the two local mb fixtures would leave the
// suite green while proving nothing — the exact drift-blindness issue #98 exists to remove.
describe('corpus loader — a malformed corpus throws, never silently degrades (issue #98)', () => {
  it('rejects an unsupported schemaVersion', () => {
    const root = writeCorpus(tempRoot(), {
      manifest: { schemaVersion: 2, engineVersion: 'v0.17.0', fixtures: [] },
    });
    expect(() => readCorpusManifest(root)).toThrow(/schemaVersion/);
  });

  it('rejects a manifest whose fixtures are the old speculated string[] form', () => {
    const root = writeCorpus(tempRoot(), {
      manifest: { schemaVersion: 1, engineVersion: 'v0.17.0', fixtures: ['01-sample'] },
    });
    expect(() => readCorpusManifest(root)).toThrow();
  });

  it('rejects a manifest missing fixtures entirely', () => {
    const root = writeCorpus(tempRoot(), {
      manifest: { schemaVersion: 1, engineVersion: 'v0.17.0' },
    });
    expect(() => readCorpusManifest(root)).toThrow();
  });

  it('names the fixture when its imposter file is missing', () => {
    const root = tempRoot();
    fs.writeFileSync(
      path.join(root, 'manifest.json'),
      JSON.stringify({
        schemaVersion: 1,
        engineVersion: 'v0.17.0',
        fixtures: [
          { file: 'corpus/imposters/99-gone.json', port: 4599, name: '99 · Gone', requires: [], hasVerify: false },
        ],
      })
    );
    expect(() => loadCorpus(root)).toThrow(/99 · Gone/);
  });
});

describe('corpus discovery — RIFT_CORPUS_DIR (issue #98)', () => {
  it('returns undefined when unset, so the local mb fixtures stay the fallback', () => {
    expect(resolveCorpusDir({})).toBeUndefined();
  });

  it('returns the directory when it holds a manifest.json', () => {
    const root = writeCorpus(tempRoot());
    expect(resolveCorpusDir({ RIFT_CORPUS_DIR: root })).toBe(root);
  });

  it('THROWS when set but invalid — set-but-broken never falls back to local fixtures', () => {
    expect(() => resolveCorpusDir({ RIFT_CORPUS_DIR: path.join(os.tmpdir(), 'no-such-corpus') })).toThrow(
      /RIFT_CORPUS_DIR/
    );
  });

  it('THROWS when set to a directory that exists but has no manifest.json', () => {
    expect(() => resolveCorpusDir({ RIFT_CORPUS_DIR: tempRoot() })).toThrow(/manifest\.json/);
  });
});

// The corpus is the first fixture source that sends request bodies, and it authors them as raw
// strings. Pinning this here keeps the regression visible in ordinary CI, where no corpus and no
// engine binary are available to catch it through the integration lane.
describe('replay driver — request bodies (issue #98)', () => {
  it('sends a string body verbatim rather than double-encoding it', () => {
    const init = toFetchInit({ method: 'POST', path: '/x', body: '{"type":"order"}' });
    expect(init.body).toBe('{"type":"order"}');
  });

  it('sends a non-JSON string body (XML) untouched', () => {
    const init = toFetchInit({ method: 'POST', path: '/x', body: '<user role="admin"/>' });
    expect(init.body).toBe('<user role="admin"/>');
  });

  it('serializes a structured body', () => {
    const init = toFetchInit({ method: 'POST', path: '/x', body: { type: 'order' } });
    expect(init.body).toBe('{"type":"order"}');
  });

  it('omits the body entirely when the step has none', () => {
    expect(toFetchInit({ method: 'GET', path: '/x' }).body).toBeUndefined();
  });
});

// The real v0.17.0 corpus uses `bodyEquals` exactly once (10-correlated-isolation) and its value is
// a bare STRING, not an object — the shape a synthetic fixture is most likely to get wrong, and the
// one that reaches driver.ts's string-specific comparison branches.
describe('corpus loader — bodyEquals as the real corpus writes it (issue #98)', () => {
  it('carries a string bodyEquals through as an exact-body expectation', () => {
    const root = writeCorpus(tempRoot(), {
      imposter: {
        name: 'Iso',
        port: 4510,
        protocol: 'http',
        stubs: [
          {
            responses: [{ is: { statusCode: 200, body: 'OK' } }],
            _verify: { sequence: [{ request: { path: '/x' }, expect: { status: 200, bodyEquals: 'OK' } }] },
          },
        ],
      },
    });
    const [fixture] = loadCorpus(root);
    expect(fixture.interactions[0].expect).toEqual({ status: 200, body: 'OK' });
  });
});

// A transcript that goes missing must be LOUD. Silently yielding zero interactions would downgrade
// the fixture to a serve smoke test and report green while asserting almost nothing.
describe('corpus loader — a dropped _verify transcript is an error (issue #98)', () => {
  const stubWith = (verify: unknown): unknown => ({
    name: 'S',
    port: 4501,
    protocol: 'http',
    stubs: [{ responses: [{ is: { statusCode: 200 } }], _verify: verify }],
  });

  it('rejects a _verify whose sequence key was renamed upstream', () => {
    const root = writeCorpus(tempRoot(), {
      imposter: stubWith({ steps: [{ request: { path: '/a' }, expect: { status: 200 } }] }),
    });
    expect(() => loadCorpus(root)).toThrow(/non-empty sequence/);
  });

  it('rejects an empty sequence', () => {
    const root = writeCorpus(tempRoot(), { imposter: stubWith({ sequence: [] }) });
    expect(() => loadCorpus(root)).toThrow(/non-empty sequence/);
  });

  it('rejects a fixture the manifest says hasVerify=true when no transcript survives', () => {
    const root = writeCorpus(tempRoot(), {
      imposter: { name: 'S', port: 4501, protocol: 'http', stubs: [{ responses: [] }] },
      manifest: {
        schemaVersion: 1,
        engineVersion: 'v0.17.0',
        fixtures: [
          { file: 'corpus/imposters/01-sample.json', port: 4501, name: '01 · Sample', requires: [], hasVerify: true },
        ],
      },
    });
    expect(() => loadCorpus(root)).toThrow(/hasVerify=true/);
  });

  it('rejects a fixture the manifest says hasVerify=false that in fact carries a transcript', () => {
    const root = tempRoot();
    writeCorpus(root, {
      manifest: {
        schemaVersion: 1,
        engineVersion: 'v0.17.0',
        fixtures: [
          { file: 'corpus/imposters/01-sample.json', port: 4501, name: '01 · Sample', requires: [], hasVerify: false },
        ],
      },
    });
    expect(() => loadCorpus(root)).toThrow(/hasVerify=false/);
  });

  it('names the stub and step index when a step is malformed', () => {
    const root = writeCorpus(tempRoot(), { imposter: stubWith({ sequence: [{ request: {} }] }) });
    expect(() => loadCorpus(root)).toThrow(/stubs\[0\]\._verify\.sequence\[0\]/);
  });

  it('rejects a step asserting both bodyContains and bodyEquals, since only one would be checked', () => {
    const root = writeCorpus(tempRoot(), {
      imposter: stubWith({
        sequence: [{ request: { path: '/a' }, expect: { status: 200, bodyContains: 'a', bodyEquals: 'b' } }],
      }),
    });
    expect(() => loadCorpus(root)).toThrow(/both bodyContains and bodyEquals/);
  });
});

describe('corpus loader — capability skips are driven only by requires (issue #98)', () => {
  const fixture = (requires: string[]): Fixture => ({
    name: 'f',
    imposterJson: '{}',
    interactions: [],
    requires,
  });

  it('reports nothing unmet when the lane covers every declared capability', () => {
    expect(unmetRequirements(fixture(['injection']), new Set(['injection']))).toEqual([]);
  });

  it('reports exactly the capabilities the lane lacks', () => {
    expect(unmetRequirements(fixture(['injection', 'proxy']), new Set(['injection']))).toEqual(['proxy']);
  });

  it('never reports anything for a fixture declaring no capabilities', () => {
    expect(unmetRequirements(fixture([]), new Set())).toEqual([]);
  });

  it('leaves 13 of the 15 v0.17.0 fixtures runnable on an injection-capable lane', () => {
    // The real manifest's requires distribution: 6 injection, 2 proxy (one of which declares both).
    const REAL_REQUIRES = [[], [], ['injection'], [], ['injection'], ['injection'], ['proxy'], [], [],
      ['injection'], [], [], ['injection'], [], ['injection', 'proxy']];
    const lane = new Set(['injection']);
    const runnable = REAL_REQUIRES.filter((r) => unmetRequirements(fixture(r), lane).length === 0);
    expect(REAL_REQUIRES).toHaveLength(15);
    expect(runnable).toHaveLength(13);
  });
});

// rift's sdk-matrix node guard greps for a PASSED spec under an ancestor title containing this
// string. Renaming the describe would pass every test in THIS repo and silently re-open rift#920 in
// the engine repo's CI, so the cross-repo contract is pinned here rather than left to a comment.
describe('replay suite — describe titles are a cross-repo contract (issue #98, rift#920)', () => {
  it('keeps the title rift sdk-matrix greps for', () => {
    const source = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'replay.integration.test.ts'), 'utf8');
    expect(source).toContain('conformance replay over the embedded transport');
    expect(source).toContain('conformance replay over a spawned engine');
  });
});
