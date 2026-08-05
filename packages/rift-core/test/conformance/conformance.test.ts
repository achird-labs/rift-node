/**
 * Conformance corpus — DSL expressibility gate (issue #7).
 *
 * PURE: no engine, no network. Every one of the 6 `test/fixtures/mb/*.json` fixtures must be
 * accounted for as either a byte-exact DSL reconstruction (`dslCoverage`) or a documented
 * `fromJson`-only escape hatch (`fromJsonOnly`) — see `dsl-coverage.ts` for the map and the
 * reasoning behind each entry. This mirrors `test/unit/dsl.test.ts`'s corpus-accountability test,
 * generalized into a reusable, independently-testable gate (the failure-mode tests below assert
 * the gate's own behavior, not just its happy path).
 */

import fs from 'fs';

import { fromJson, toWireJson, type Imposter, type ImpostersConfig } from '../../src/model/index.js';
import { ImposterBuilder } from '../../src/dsl/index.js';
import { dslCoverage, fromJsonOnly } from './dsl-coverage.js';
import { MB_FIXTURES_DIR, readMbFixtureJson } from './loader.js';

// --- normalize(): documented engine-default elisions, nothing else ---------------------------
//
//  - `protocol: 'http'`      — the engine's implicit default protocol when none is set.
//  - `_mode: 'text'`         — the implicit default response body mode.
//  - `_behaviors.repeat: 1`  — a response with no explicit repeat count cycles once anyway.
//
// Everything else is compared verbatim: an unnormalized structural mismatch is a genuine DSL gap,
// not a normalization gap.
function normalizeValue(value: unknown, keyInParent?: string): unknown {
  if (Array.isArray(value)) return value.map((v) => normalizeValue(v));
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'protocol' && val === 'http') continue;
    if (key === '_mode' && val === 'text') continue;
    if (key === 'repeat' && val === 1 && keyInParent === '_behaviors') continue;
    out[key] = normalizeValue(val, key);
  }
  return out;
}

export function normalize(value: unknown): unknown {
  return normalizeValue(value);
}

// --- structural (key-order-independent) deep equality ----------------------------------------

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a === 'object' && a !== null && typeof b === 'object' && b !== null) {
    const aKeys = Object.keys(a as Record<string, unknown>);
    const bKeys = Object.keys(b as Record<string, unknown>);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((k) =>
      deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])
    );
  }
  return false;
}

function formatMismatch(fixtureName: string, expected: unknown, actual: unknown): string {
  return [
    `fixture ${fixtureName} DSL reconstruction does not match (normalized):`,
    '--- expected (fixture) ---',
    JSON.stringify(expected, null, 2),
    '--- actual (DSL build) ---',
    JSON.stringify(actual, null, 2),
  ].join('\n');
}

// --- the gate's own check functions (also exercised directly by the failure-mode tests) -------

/** Throws naming `fixtureName` when it has neither a `dslCoverage` nor a `fromJsonOnly` entry. */
function assertAccounted(
  fixtureName: string,
  coverage: Record<string, unknown>,
  documented: Record<string, unknown>
): void {
  if (!(fixtureName in coverage) && !(fixtureName in documented)) {
    throw new Error(`fixture ${fixtureName} has no DSL reconstruction — DSL gap or missing mapping`);
  }
}

/** Throws with a JSON diff when `build()`'s wire output doesn't normalize-equal the fixture. */
function assertReconstructs(
  fixtureName: string,
  build: () => Imposter | ImposterBuilder,
  fixtureJson: unknown
): void {
  const built = build();
  const imp = built instanceof ImposterBuilder ? built.build() : built;
  const config: ImpostersConfig = { imposters: [imp] };
  const actual = normalize(toWireJson(config));
  const expected = normalize(fixtureJson);
  if (!deepEqual(actual, expected)) {
    throw new Error(formatMismatch(fixtureName, expected, actual));
  }
}

describe('conformance — DSL expressibility gate (issue #7)', () => {
  const fixtureFiles = fs.readdirSync(MB_FIXTURES_DIR).filter((f) => f.endsWith('.json'));

  it('every fixture is accounted for: DSL-reconstructed or documented fromJson-only', () => {
    for (const f of fixtureFiles) {
      expect(() => assertAccounted(f, dslCoverage, fromJsonOnly)).not.toThrow();
    }
  });

  it('every dslCoverage build normalize-deep-equals its fixture', () => {
    for (const [name, build] of Object.entries(dslCoverage)) {
      const fixtureJson = readMbFixtureJson(name);
      expect(() => assertReconstructs(name, build, fixtureJson)).not.toThrow();
    }
  });

  it('every fromJsonOnly fixture genuinely loads via the fromJson escape hatch', () => {
    for (const name of Object.keys(fromJsonOnly)) {
      const text = fs.readFileSync(`${MB_FIXTURES_DIR}/${name}`, 'utf8');
      expect(() => fromJson(text)).not.toThrow();
    }
  });

  it('dslCoverage and fromJsonOnly partition the 6 fixtures with no overlap and no gap', () => {
    const coveredNames = new Set(Object.keys(dslCoverage));
    const documentedNames = new Set(Object.keys(fromJsonOnly));
    for (const name of coveredNames) {
      expect(documentedNames.has(name)).toBe(false);
    }
    expect(coveredNames.size + documentedNames.size).toBe(fixtureFiles.length);
    for (const f of fixtureFiles) {
      expect(coveredNames.has(f) || documentedNames.has(f)).toBe(true);
    }
  });
});

// --- vendored-fixture integrity: stub ordering (issue #94, rift#805) --------------------------
//
// Stub matching is first-match-wins, so a general stub sitting ahead of a more specific one leaves
// the specific stub permanently dead. rift#805 fixed exactly that in the upstream example. These
// assertions pin the invariant, so re-vendoring a stale copy of the example fails here instead of
// silently shipping unreachable stubs.

interface WireStub {
  scenarioName?: string;
  predicates?: Array<Record<string, unknown>>;
}

function stubsOf(fixtureName: string): WireStub[] {
  const json = readMbFixtureJson(fixtureName) as { imposters?: Array<{ stubs?: WireStub[] }> };
  const stubs = json.imposters?.[0]?.stubs;
  if (!Array.isArray(stubs)) throw new Error(`fixture ${fixtureName} has no imposters[0].stubs array`);
  return stubs;
}

function scenarioIndex(fixtureName: string, stubs: WireStub[], scenarioName: string): number {
  const index = stubs.findIndex((s) => s.scenarioName === scenarioName);
  if (index < 0) {
    throw new Error(`fixture ${fixtureName} has no stub with scenarioName ${scenarioName}`);
  }
  return index;
}

describe('conformance — vendored fixture stub ordering (issue #94, rift#805)', () => {
  const FIXTURE = 'task-management-api.json';

  it('task-management-api.json places each specific stub before the general one that shadows it', () => {
    const stubs = stubsOf(FIXTURE);
    expect(scenarioIndex(FIXTURE, stubs, 'TaskAPI-GetTasks-FilterByStatus')).toBeLessThan(
      scenarioIndex(FIXTURE, stubs, 'TaskAPI-GetTasks-Success')
    );
    expect(scenarioIndex(FIXTURE, stubs, 'TaskAPI-GetTaskById-NotFound')).toBeLessThan(
      scenarioIndex(FIXTURE, stubs, 'TaskAPI-GetTaskById-Success')
    );
  });

  it('the task-999 not-found stub anchors its path so it cannot shadow other task ids', () => {
    const stubs = stubsOf(FIXTURE);
    const notFound = stubs[scenarioIndex(FIXTURE, stubs, 'TaskAPI-GetTaskById-NotFound')];
    const paths = (notFound.predicates ?? [])
      .map((p) => (p.matches as { path?: string } | undefined)?.path)
      .filter((p): p is string => typeof p === 'string');
    expect(paths).toEqual(['^/tasks/task-999$']);
  });
});

describe('conformance gate — failure modes (acceptance criterion)', () => {
  it('a fixture with no coverage entry and no fromJsonOnly entry is named in the failure', () => {
    expect(() => assertAccounted('ghost-fixture.json', dslCoverage, fromJsonOnly)).toThrow(
      'fixture ghost-fixture.json has no DSL reconstruction — DSL gap or missing mapping'
    );
  });

  it('a deliberately-wrong reconstruction fails deepEqual and the error contains a diff', () => {
    const fixtureJson = readMbFixtureJson('basic-api.json');
    const wrongBuild = (): Imposter => ({ name: 'not the same imposter at all', port: 1 });

    let thrown: unknown;
    try {
      assertReconstructs('basic-api.json', wrongBuild, fixtureJson);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain('fixture basic-api.json DSL reconstruction does not match');
    expect(message).toContain('--- expected (fixture) ---');
    expect(message).toContain('--- actual (DSL build) ---');
    expect(message).toContain('Basic REST API');
    expect(message).toContain('not the same imposter at all');
  });
});
