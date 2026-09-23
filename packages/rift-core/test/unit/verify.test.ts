/**
 * Gate for issue #6 — the verification API: `RecordedRequest`/`CountMatcher` types, the client-side
 * predicate evaluator, the `VerificationError` renderer, and the `recorded`/`clearRecorded`/`verify`
 * handle methods wired over `AdminApi` (via an in-memory `FakeAdminApi`, same pattern as
 * `test/unit/engine.test.ts`).
 */

import { Engine, type AdminApi } from '../../src/engine.js';
import { imposter, onGet, okJson } from '../../src/dsl/index.js';
import { ImposterNotFound, RiftError, UnsupportedPredicateError, VerificationError } from '../../src/errors.js';
import {
  atLeast,
  atMost,
  between,
  never,
  predicatesOf,
  times,
  toRecordedRequest,
  type RecordedRequest,
} from '../../src/verify/index.js';
import { collectLeafDetails, computeClosest, evalPredicates } from '../../src/verify/eval.js';
import { renderVerificationFailure } from '../../src/verify/render.js';
import * as rootExports from '../../src/index.js';
import type { Imposter, ImpostersConfig, Predicate, Stub, RecordedRequest as WireRecordedRequest } from '../../src/model/index.js';

// --- shared test fixtures ------------------------------------------------------------------------

function rr(overrides: Partial<RecordedRequest> = {}): RecordedRequest {
  return {
    method: 'GET',
    path: '/x',
    query: {},
    headers: {},
    body: undefined,
    from: '127.0.0.1:1234',
    timestamp: '2026-01-01T00:00:00Z',
    raw: { method: 'GET', path: '/x' },
    ...overrides,
  };
}

// --- count matchers --------------------------------------------------------------------------

describe('count matchers', () => {
  it('times(n) is an exact-count matcher', () => {
    const m = times(3);
    expect(m.min).toBe(3);
    expect(m.max).toBe(3);
    expect(m.describe()).toBe('times(3)');
  });

  it('atLeast(n) has no upper bound', () => {
    const m = atLeast(2);
    expect(m.min).toBe(2);
    expect(m.max).toBe(Infinity);
    expect(m.describe()).toBe('atLeast(2)');
  });

  it('atMost(n) allows zero up to n', () => {
    const m = atMost(4);
    expect(m.min).toBe(0);
    expect(m.max).toBe(4);
    expect(m.describe()).toBe('atMost(4)');
  });

  it('between(min, max) is an inclusive range', () => {
    const m = between(2, 5);
    expect(m.min).toBe(2);
    expect(m.max).toBe(5);
    expect(m.describe()).toBe('between(2, 5)');
  });

  it('never() is equivalent to times(0)', () => {
    const m = never();
    expect(m.min).toBe(0);
    expect(m.max).toBe(0);
    expect(m.describe()).toBe('times(0)');
  });

  it('all matchers + RecordedRequest are re-exported from the package root', () => {
    expect(typeof rootExports.times).toBe('function');
    expect(typeof rootExports.atLeast).toBe('function');
    expect(typeof rootExports.atMost).toBe('function');
    expect(typeof rootExports.between).toBe('function');
    expect(typeof rootExports.never).toBe('function');
    // RecordedRequest is a type — assert it flows through by using it in an annotated value.
    const r: rootExports.RecordedRequest = rr();
    expect(r.method).toBe('GET');
  });
});

// --- evaluator ---------------------------------------------------------------------------------

describe('evaluator — evalPredicates', () => {
  it('equals is case-insensitive by default (value)', () => {
    expect(evalPredicates({ equals: { method: 'get' } }, rr({ method: 'GET' }))).toBe(true);
  });

  it('caseSensitive: true makes equals case-sensitive', () => {
    const pred: Predicate = { equals: { method: 'get' }, caseSensitive: true };
    expect(evalPredicates(pred, rr({ method: 'GET' }))).toBe(false);
    expect(evalPredicates(pred, rr({ method: 'get' }))).toBe(true);
  });

  it('deepEquals on a string field behaves like equals', () => {
    expect(evalPredicates({ deepEquals: { path: '/x' } }, rr({ path: '/X' }))).toBe(true);
    expect(evalPredicates({ deepEquals: { path: '/x' }, caseSensitive: true }, rr({ path: '/X' }))).toBe(false);
  });

  it('contains/startsWith/endsWith on path', () => {
    const request = rr({ path: '/api/users/123' });
    expect(evalPredicates({ contains: { path: 'users' } }, request)).toBe(true);
    expect(evalPredicates({ contains: { path: 'nope' } }, request)).toBe(false);
    expect(evalPredicates({ startsWith: { path: '/api' } }, request)).toBe(true);
    expect(evalPredicates({ startsWith: { path: '/x' } }, request)).toBe(false);
    expect(evalPredicates({ endsWith: { path: '123' } }, request)).toBe(true);
    expect(evalPredicates({ endsWith: { path: '456' } }, request)).toBe(false);
  });

  it('matches applies a regex to the field, case-insensitive by default', () => {
    expect(evalPredicates({ matches: { path: '^/api/users/\\d+$' } }, rr({ path: '/api/users/42' }))).toBe(true);
    expect(evalPredicates({ matches: { method: '^get$' } }, rr({ method: 'GET' }))).toBe(true);
    expect(evalPredicates({ matches: { method: '^get$' }, caseSensitive: true }, rr({ method: 'GET' }))).toBe(false);
  });

  it('exists checks field presence, not value', () => {
    expect(evalPredicates({ exists: { headers: true } }, rr({ headers: { a: '1' } }))).toBe(true);
    expect(evalPredicates({ exists: { headers: true } }, rr({ headers: {} }))).toBe(false);
    expect(evalPredicates({ exists: { headers: false } }, rr({ headers: {} }))).toBe(true);
    expect(evalPredicates({ exists: { body: true } }, rr({ body: undefined }))).toBe(false);
    expect(evalPredicates({ exists: { body: true } }, rr({ body: { a: 1 } }))).toBe(true);
  });

  it('and/or/not compose leaf predicates', () => {
    const request = rr({ method: 'GET', path: '/api/users/1' });
    expect(
      evalPredicates({ and: [{ equals: { method: 'GET' } }, { equals: { path: '/api/users/1' } }] }, request)
    ).toBe(true);
    expect(
      evalPredicates({ and: [{ equals: { method: 'GET' } }, { equals: { path: '/nope' } }] }, request)
    ).toBe(false);
    expect(evalPredicates({ or: [{ equals: { method: 'POST' } }, { equals: { path: '/api/users/1' } }] }, request)).toBe(
      true
    );
    expect(evalPredicates({ not: { equals: { method: 'POST' } } }, request)).toBe(true);
    expect(evalPredicates({ not: { equals: { method: 'GET' } } }, request)).toBe(false);
  });

  it('method field: exact string comparison, case-insensitive by default', () => {
    expect(evalPredicates({ equals: { method: 'post' } }, rr({ method: 'POST' }))).toBe(true);
    expect(evalPredicates({ equals: { method: 'post' } }, rr({ method: 'GET' }))).toBe(false);
  });

  it('header/query keys are looked up case-insensitively by default', () => {
    const request = rr({ headers: { Accept: 'application/json' } });
    expect(evalPredicates({ equals: { headers: { accept: 'application/json' } } }, request)).toBe(true);
  });

  it('keyCaseSensitive: true requires an exact key-name match', () => {
    const request = rr({ headers: { Accept: 'application/json' } });
    const pred: Predicate = { equals: { headers: { accept: 'application/json' } }, keyCaseSensitive: true };
    expect(evalPredicates(pred, request)).toBe(false);
    const exact: Predicate = { equals: { headers: { Accept: 'application/json' } }, keyCaseSensitive: true };
    expect(evalPredicates(exact, request)).toBe(true);
  });

  it('multi-value header/query: matches if ANY value matches', () => {
    const request = rr({ headers: { 'x-tag': ['a', 'b', 'c'] } });
    expect(evalPredicates({ equals: { headers: { 'x-tag': 'b' } } }, request)).toBe(true);
    expect(evalPredicates({ equals: { headers: { 'x-tag': 'z' } } }, request)).toBe(false);
    const q = rr({ query: { tag: ['1', '2'] } });
    expect(evalPredicates({ equals: { query: { tag: '2' } } }, q)).toBe(true);
  });

  it('query values scalar-coerce a non-string expected value to a string', () => {
    const request = rr({ query: { n: '5' } });
    expect(evalPredicates({ equals: { query: { n: 5 } } }, request)).toBe(true);
  });

  it('except strips a regex from the actual value before comparison', () => {
    const request = rr({ path: '/api/users/123' });
    const pred: Predicate = { equals: { path: '/api/users/' }, except: '\\d+' };
    expect(evalPredicates(pred, request)).toBe(true);
  });

  it('body equals is field-wise containment against the JSON body', () => {
    const request = rr({ body: { a: 1, b: 2, nested: { c: 3, d: 4 } } });
    expect(evalPredicates({ equals: { body: { a: 1 } } }, request)).toBe(true);
    expect(evalPredicates({ equals: { body: { nested: { c: 3 } } } }, request)).toBe(true);
    expect(evalPredicates({ equals: { body: { a: 999 } } }, request)).toBe(false);
    expect(evalPredicates({ equals: { body: { missing: 1 } } }, request)).toBe(false);
  });

  it('body deepEquals requires exact structural equality (no extra keys allowed)', () => {
    const request = rr({ body: { a: 1, b: 2 } });
    expect(evalPredicates({ deepEquals: { body: { a: 1 } } }, request)).toBe(false);
    expect(evalPredicates({ deepEquals: { body: { a: 1, b: 2 } } }, request)).toBe(true);
  });

  it('body equals vs string body compares as a string', () => {
    expect(evalPredicates({ equals: { body: 'hello world' } }, rr({ body: 'hello world' }))).toBe(true);
    expect(evalPredicates({ equals: { body: 'hello' } }, rr({ body: 'hello world' }))).toBe(false);
  });

  // --- jsonpath subset ---

  it('jsonpath: dot-path selector extracts a nested value', () => {
    const request = rr({ body: { a: { b: 'x' } } });
    const pred: Predicate = { equals: { body: 'x' }, jsonpath: { selector: '$.a.b' } };
    expect(evalPredicates(pred, request)).toBe(true);
  });

  it("jsonpath: bracket string selector ($['x']) extracts a value", () => {
    const request = rr({ body: { x: 'hello' } });
    const pred: Predicate = { equals: { body: 'hello' }, jsonpath: { selector: "$['x']" } };
    expect(evalPredicates(pred, request)).toBe(true);
  });

  it('jsonpath: numeric array index selector ($.a[0].c) extracts a value', () => {
    const request = rr({ body: { a: [{ c: 'first' }, { c: 'second' }] } });
    const pred: Predicate = { equals: { body: 'first' }, jsonpath: { selector: '$.a[0].c' } };
    expect(evalPredicates(pred, request)).toBe(true);
    const predSecond: Predicate = { equals: { body: 'second' }, jsonpath: { selector: '$.a[1].c' } };
    expect(evalPredicates(predSecond, request)).toBe(true);
  });

  it('jsonpath: a selector into a missing path is simply a non-match, not a throw', () => {
    const request = rr({ body: { a: {} } });
    const pred: Predicate = { equals: { body: 'x' }, jsonpath: { selector: '$.a.b.c' } };
    expect(evalPredicates(pred, request)).toBe(false);
  });

  it('jsonpath: wildcard segments throw UnsupportedPredicateError("jsonpath", ...)', () => {
    const request = rr({ body: { a: [1, 2] } });
    const pred: Predicate = { equals: { body: 1 }, jsonpath: { selector: '$.a[*]' } };
    expect(() => evalPredicates(pred, request)).toThrow(UnsupportedPredicateError);
    try {
      evalPredicates(pred, request);
      throw new Error('unreachable');
    } catch (e) {
      expect(e).toBeInstanceOf(UnsupportedPredicateError);
      expect((e as UnsupportedPredicateError).operator).toBe('jsonpath');
    }
  });

  it('jsonpath: recursive descent (..) throws UnsupportedPredicateError', () => {
    const pred: Predicate = { equals: { body: 1 }, jsonpath: { selector: '$..a' } };
    expect(() => evalPredicates(pred, rr({ body: { a: 1 } }))).toThrow(UnsupportedPredicateError);
  });

  it('jsonpath: filter expressions throw UnsupportedPredicateError', () => {
    const pred: Predicate = { equals: { body: 1 }, jsonpath: { selector: '$.a[?(@.b==1)]' } };
    expect(() => evalPredicates(pred, rr({ body: { a: [] } }))).toThrow(UnsupportedPredicateError);
  });

  // --- unsupported operators ---

  it('xpath predicates throw UnsupportedPredicateError("xpath", ...) naming the operator', () => {
    const pred: Predicate = { equals: { body: 'x' }, xpath: { selector: '//x' } };
    try {
      evalPredicates(pred, rr({ body: '<x/>' }));
      throw new Error('unreachable');
    } catch (e) {
      expect(e).toBeInstanceOf(UnsupportedPredicateError);
      expect((e as UnsupportedPredicateError).operator).toBe('xpath');
    }
  });

  it('inject predicates throw UnsupportedPredicateError("inject", ...) naming the operator', () => {
    const pred: Predicate = { inject: 'function(config) { return true; }' };
    try {
      evalPredicates(pred, rr());
      throw new Error('unreachable');
    } catch (e) {
      expect(e).toBeInstanceOf(UnsupportedPredicateError);
      expect((e as UnsupportedPredicateError).operator).toBe('inject');
    }
  });
});

describe('evaluator — collectLeafDetails / computeClosest', () => {
  it('collectLeafDetails flattens and/or/not into per-field pass/fail leaves', () => {
    const predicates: Predicate[] = [{ equals: { method: 'GET' } }, { equals: { path: '/api/users/1' } }];
    const details = collectLeafDetails(predicates, rr({ method: 'GET', path: '/api/users/2' }));
    expect(details).toHaveLength(2);
    expect(details[0]).toMatchObject({ field: 'method', passed: true });
    expect(details[1]).toMatchObject({ field: 'path', passed: false, actual: '/api/users/2' });
  });

  it('computeClosest picks the request with the highest fraction of passing leaves; ties -> most recent', () => {
    const predicates: Predicate[] = [{ equals: { method: 'GET' } }, { equals: { path: '/api/users/1' } }];
    const older = rr({ path: '/api/health', timestamp: '2026-01-01T00:00:00Z' });
    const newer = rr({ path: '/api/users/2', timestamp: '2026-01-02T00:00:00Z' });
    const worst = rr({ method: 'POST', path: '/api/users', timestamp: '2026-01-03T00:00:00Z' });
    const closest = computeClosest(predicates, [older, newer, worst]);
    expect(closest?.request).toBe(newer);
    expect(closest?.failures).toHaveLength(1);
    expect(closest?.failures[0]?.predicate).toEqual({ equals: { path: '/api/users/1' } });
  });

  it('computeClosest returns undefined when nothing was recorded', () => {
    expect(computeClosest([{ equals: { method: 'GET' } }], [])).toBeUndefined();
  });
});

// --- renderer ------------------------------------------------------------------------------------

describe('renderVerificationFailure', () => {
  it('renders a 0-match failure with a compact Expected line and the closest non-match', () => {
    const predicates: Predicate[] = [{ equals: { method: 'GET' } }, { equals: { path: '/api/users/1' } }];
    const recorded = [
      rr({ path: '/api/health', timestamp: '2026-07-09T10:10:00Z', from: '127.0.0.1:52100' }),
      rr({ path: '/api/users/2', timestamp: '2026-07-09T10:12:03Z', from: '127.0.0.1:52114' }),
      rr({ method: 'POST', path: '/api/users', timestamp: '2026-07-09T10:14:00Z', from: '127.0.0.1:52120' }),
    ];
    const closest = computeClosest(predicates, recorded);
    const err = new VerificationError('Verification failed for imposter "users" (port 55123)', {
      expected: predicates,
      count: { matched: 0, total: recorded.length, matcher: times(1) },
      recorded,
      closest,
    });
    expect(renderVerificationFailure(err)).toBe(
      'Verification failed for imposter "users" (port 55123)\n\n' +
        'Expected  GET /api/users/1        times(1)\n' +
        'Actual    0 of 3 recorded requests matched\n\n' +
        'Closest non-match — request #2 at 2026-07-09T10:12:03Z from 127.0.0.1:52114:\n' +
        '  method  GET           ✓\n' +
        '  path    /api/users/2  ✗  expected equals "/api/users/1"\n\n' +
        'All recorded: GET /api/health, GET /api/users/2, POST /api/users'
    );
  });

  it('falls back to JSON for a complex Expected predicate list, and rows include a header line', () => {
    const predicates: Predicate[] = [
      { equals: { method: 'GET' } },
      { equals: { path: '/api/users/1' } },
      { equals: { headers: { accept: 'application/json' } } },
    ];
    const recorded = [
      rr({ path: '/api/health', timestamp: '2026-07-09T10:10:00Z', from: '127.0.0.1:52100' }),
      rr({
        path: '/api/users/2',
        timestamp: '2026-07-09T10:12:03Z',
        from: '127.0.0.1:52114',
        headers: { Accept: 'application/json' },
      }),
      rr({ method: 'POST', path: '/api/users', timestamp: '2026-07-09T10:14:00Z', from: '127.0.0.1:52120' }),
    ];
    const closest = computeClosest(predicates, recorded);
    const err = new VerificationError('Verification failed for imposter "users" (port 55123)', {
      expected: predicates,
      count: { matched: 0, total: recorded.length, matcher: times(1) },
      recorded,
      closest,
    });
    expect(renderVerificationFailure(err)).toBe(
      'Verification failed for imposter "users" (port 55123)\n\n' +
        'Expected  [{"equals":{"method":"GET"}},{"equals":{"path":"/api/users/1"}},' +
        '{"equals":{"headers":{"accept":"application/json"}}}]  times(1)\n' +
        'Actual    0 of 3 recorded requests matched\n\n' +
        'Closest non-match — request #2 at 2026-07-09T10:12:03Z from 127.0.0.1:52114:\n' +
        '  method  GET                       ✓\n' +
        '  path    /api/users/2              ✗  expected equals "/api/users/1"\n' +
        '  header  accept: application/json  ✓\n\n' +
        'All recorded: GET /api/health, GET /api/users/2, POST /api/users'
    );
  });

  it('replaces the closest block with a one-line count explanation when matched > 0 but the count is wrong', () => {
    const predicates: Predicate[] = [{ equals: { method: 'GET' } }, { equals: { path: '/api/users/1' } }];
    const recorded = [
      rr({ path: '/api/users/1', timestamp: '2026-07-09T10:10:00Z' }),
      rr({ path: '/api/health', timestamp: '2026-07-09T10:11:00Z' }),
    ];
    const err = new VerificationError('Verification failed for imposter "users" (port 55123)', {
      expected: predicates,
      count: { matched: 1, total: recorded.length, matcher: times(2) },
      recorded,
      closest: undefined,
    });
    expect(renderVerificationFailure(err)).toBe(
      'Verification failed for imposter "users" (port 55123)\n\n' +
        'Expected  GET /api/users/1        times(2)\n' +
        'Actual    1 of 2 recorded requests matched\n\n' +
        'Matched 1 request(s); times(2) requires exactly 2.\n\n' +
        'All recorded: GET /api/users/1, GET /api/health'
    );
  });

  it('renders an empty journal sensibly, with no closest block and no All-recorded line', () => {
    const predicates: Predicate[] = [{ equals: { method: 'GET' } }, { equals: { path: '/api/users/1' } }];
    const err = new VerificationError('Verification failed for imposter "users" (port 55123)', {
      expected: predicates,
      count: { matched: 0, total: 0, matcher: atLeast(1) },
      recorded: [],
      closest: undefined,
    });
    expect(renderVerificationFailure(err)).toBe(
      'Verification failed for imposter "users" (port 55123)\n\n' +
        'Expected  GET /api/users/1        atLeast(1)\n' +
        'Actual    0 of 0 recorded requests matched\n\n' +
        'No requests have been recorded on this imposter yet.'
    );
  });
});

// --- VerificationError fields --------------------------------------------------------------------

describe('VerificationError', () => {
  it('carries expected/count/recorded/closest and is a RiftError', () => {
    const predicates: Predicate[] = [{ equals: { path: '/x' } }];
    const recorded = [rr({ path: '/y' })];
    const closest = computeClosest(predicates, recorded);
    const err = new VerificationError('boom', {
      expected: predicates,
      count: { matched: 0, total: 1, matcher: times(1) },
      recorded,
      closest,
    });
    expect(err).toBeInstanceOf(RiftError);
    expect(err.name).toBe('VerificationError');
    expect(err.expected).toBe(predicates);
    expect(err.count).toEqual({ matched: 0, total: 1, matcher: expect.objectContaining({ min: 1, max: 1 }) });
    expect(err.recorded).toBe(recorded);
    expect(err.closest?.request).toBe(recorded[0]);
  });
});

// --- predicatesOf / toRecordedRequest -------------------------------------------------------------

describe('predicatesOf / toRecordedRequest', () => {
  it('predicatesOf lifts a StubBuilder to only its predicates (responses ignored)', () => {
    const stub = onGet('/api/users/1');
    expect(predicatesOf(stub)).toEqual(stub.build().predicates);
  });

  it('predicatesOf normalizes a single predicate or a predicate array', () => {
    const p: Predicate = { equals: { path: '/x' } };
    expect(predicatesOf(p)).toEqual([p]);
    expect(predicatesOf([p, p])).toEqual([p, p]);
  });

  it('toRecordedRequest lifts status, latencyMs and node when present (issue #148)', () => {
    // Engine >= 0.18.0 records how each request was answered (rift#364). `latencyMs: 0` is a real
    // reading and must not be defaulted away.
    const r = toRecordedRequest({
      method: 'GET',
      path: '/x',
      status: 503,
      latencyMs: 0,
      node: 'node-a',
    });
    expect(r.status).toBe(503);
    expect(r.latencyMs).toBe(0);
    expect(r.node).toBe('node-a');
  });

  it('toRecordedRequest leaves the outcome fields undefined when the journal has none (issue #148)', () => {
    // A request still in flight when the journal was read, one whose handling errored, or an engine < 0.18.0.
    const r = toRecordedRequest({ method: 'GET', path: '/x' });
    expect(r.status).toBeUndefined();
    expect(r.latencyMs).toBeUndefined();
    expect(r.node).toBeUndefined();
  });

  it('toRecordedRequest maps request_from -> from and preserves raw', () => {
    const raw: WireRecordedRequest = {
      method: 'GET',
      path: '/x',
      query: { q: '1' },
      headers: { Accept: 'json' },
      body: { a: 1 },
      request_from: '10.0.0.1:9999',
      timestamp: '2026-01-01T00:00:00Z',
    };
    const mapped = toRecordedRequest(raw);
    expect(mapped).toEqual({
      method: 'GET',
      path: '/x',
      query: { q: '1' },
      headers: { Accept: 'json' },
      body: { a: 1 },
      from: '10.0.0.1:9999',
      timestamp: '2026-01-01T00:00:00Z',
      raw,
    });
  });
});

// --- handle: recorded / clearRecorded / verify over AdminApi ---------------------------------------

/** Minimal in-memory AdminApi (same shape as engine.test.ts's FakeAdminApi) with saved-requests
 * tracking: a settable backing list plus captured `getSavedRequests`/`deleteSavedRequests` calls. */
class FakeAdminApi implements AdminApi {
  imposters = new Map<number, Imposter>();
  #closed = false;
  #nextPort = 9000;
  savedRequests: WireRecordedRequest[] = [];
  getSavedRequestsCalls: Array<{ port: number; match?: string[] }> = [];
  deleteSavedRequestsCalls: Array<{ port: number; match?: string[] }> = [];

  async createImposter(imp: Imposter): Promise<Imposter> {
    const port = typeof imp.port === 'number' ? imp.port : this.#nextPort++;
    const stored: Imposter = { ...imp, port };
    this.imposters.set(port, stored);
    return stored;
  }
  async listImposters(): Promise<ImpostersConfig> {
    return { imposters: [...this.imposters.values()] };
  }
  async getImposter(port: number): Promise<Imposter> {
    const imp = this.imposters.get(port);
    if (!imp) throw new ImposterNotFound(`no imposter on ${port}`);
    return imp;
  }
  async deleteImposter(port: number): Promise<Imposter> {
    const imp = await this.getImposter(port);
    this.imposters.delete(port);
    return imp;
  }
  async deleteAllImposters(): Promise<void> {
    this.imposters.clear();
  }
  async replaceImposters(config: ImpostersConfig): Promise<ImpostersConfig> {
    this.imposters.clear();
    for (const imp of config.imposters) await this.createImposter(imp);
    return { imposters: [...this.imposters.values()] };
  }
  async addStub(port: number, stub: Stub): Promise<void> {
    const imp = await this.getImposter(port);
    imp.stubs = [...(imp.stubs ?? []), stub];
  }
  async replaceStubs(port: number, stubs: Stub[]): Promise<void> {
    (await this.getImposter(port)).stubs = stubs;
  }
  async getStub(port: number, ref: number | { id: string }): Promise<Stub> {
    const stubs = (await this.getImposter(port)).stubs ?? [];
    const s = typeof ref === 'number' ? stubs[ref] : stubs.find((x) => x.id === ref.id);
    if (!s) throw new ImposterNotFound('no such stub');
    return s;
  }
  async updateStub(port: number, ref: number | { id: string }, stub: Stub): Promise<void> {
    const imp = await this.getImposter(port);
    const stubs = imp.stubs ?? [];
    const i = typeof ref === 'number' ? ref : stubs.findIndex((x) => x.id === ref.id);
    stubs[i] = stub;
    imp.stubs = stubs;
  }
  async deleteStub(port: number, ref: number | { id: string }): Promise<void> {
    const imp = await this.getImposter(port);
    const stubs = imp.stubs ?? [];
    const i = typeof ref === 'number' ? ref : stubs.findIndex((x) => x.id === ref.id);
    stubs.splice(i, 1);
    imp.stubs = stubs;
  }
  async getSavedRequests(port: number, match?: string[]): Promise<WireRecordedRequest[]> {
    this.getSavedRequestsCalls.push({ port, match });
    return this.savedRequests;
  }
  async deleteSavedRequests(port: number, match?: string[]): Promise<void> {
    this.deleteSavedRequestsCalls.push({ port, match });
  }
  async deleteSavedProxyResponses(): Promise<void> {}
  async enableImposter(): Promise<void> {}
  async disableImposter(): Promise<void> {}
  async getScenarios(): Promise<{ flowId: string; scenarios: Array<{ name: string; state: string }> }> {
    return { flowId: 'default', scenarios: [] };
  }
  async setScenarioState(): Promise<void> {}
  async resetScenarios(): Promise<void> {}
  async addSpaceStub(): Promise<void> {}
  async listSpaceStubs(): Promise<{ space: string; stubs: Stub[] }> {
    return { space: '', stubs: [] };
  }
  async getSpace<T>(): Promise<T> {
    return {} as T;
  }
  async deleteSpace(): Promise<void> {}
  async getFlowState<T>(): Promise<T | undefined> {
    return undefined;
  }
  async setFlowState(): Promise<void> {}
  async deleteFlowState(): Promise<void> {}
  async config(): Promise<Record<string, unknown>> {
    return { options: { version: '0.99.0' } };
  }
  async logs(): Promise<unknown[]> {
    return [];
  }
  async reload(): Promise<unknown> {
    return {};
  }
  get closed(): boolean {
    return this.#closed;
  }
  async close(): Promise<void> {
    this.#closed = true;
  }
  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}

const engineOf = (admin: AdminApi) => new Engine(admin, 'remote', { hostHint: '127.0.0.1' });

function wireRecorded(overrides: Partial<WireRecordedRequest>): WireRecordedRequest {
  return { method: 'GET', path: '/x', request_from: '127.0.0.1:1', timestamp: '2026-01-01T00:00:00Z', ...overrides };
}

describe('ImposterHandle.recorded / clearRecorded / verify', () => {
  it('recorded({ flowId }) passes match=[flow_id=<id>] to getSavedRequests and maps the results', async () => {
    const admin = new FakeAdminApi();
    admin.savedRequests = [wireRecorded({ path: '/scoped' })];
    const h = await engineOf(admin).create(imposter('s').port(9100).record());
    const result = await h.recorded({ flowId: 'flow-42' });
    expect(admin.getSavedRequestsCalls).toEqual([{ port: 9100, match: ['flow_id=flow-42'] }]);
    expect(result).toEqual([toRecordedRequest(admin.savedRequests[0]!)]);
  });

  it('recorded() carries the 0.18.0 outcome fields through to the caller (issue #148)', async () => {
    const admin = new FakeAdminApi();
    admin.savedRequests = [wireRecorded({ status: 503, latencyMs: 12, node: 'n1' }), wireRecorded({})];
    const h = await engineOf(admin).create(imposter('s').port(9105).record());
    const [answered, pending] = await h.recorded();
    expect(answered?.status).toBe(503);
    expect(answered?.latencyMs).toBe(12);
    expect(answered?.node).toBe('n1');
    expect(pending?.status).toBeUndefined();
  });

  it('recorded({ match }) fetches all (no server-side match) and filters client-side', async () => {
    const admin = new FakeAdminApi();
    admin.savedRequests = [wireRecorded({ path: '/a' }), wireRecorded({ path: '/b' })];
    const h = await engineOf(admin).create(imposter('s').port(9110).record());
    const result = await h.recorded({ match: { equals: { path: '/b' } } });
    expect(admin.getSavedRequestsCalls).toEqual([{ port: 9110, match: undefined }]);
    expect(result.map((r) => r.path)).toEqual(['/b']);
  });

  it('clearRecorded() deletes saved requests for the imposter port', async () => {
    const admin = new FakeAdminApi();
    const h = await engineOf(admin).create(imposter('s').port(9120).record());
    await h.clearRecorded();
    expect(admin.deleteSavedRequestsCalls).toEqual([{ port: 9120, match: undefined }]);
  });

  it('verify() resolves once the count matcher is satisfied', async () => {
    const admin = new FakeAdminApi();
    admin.savedRequests = [wireRecorded({ path: '/api/users/1' }), wireRecorded({ path: '/api/health' })];
    const h = await engineOf(admin).create(imposter('s').port(9130).record());
    await expect(h.verify(onGet('/api/users/1'), times(1))).resolves.toBeUndefined();
  });

  it('verify() throws VerificationError with the correct .count when the matcher is not satisfied', async () => {
    const admin = new FakeAdminApi();
    admin.savedRequests = [wireRecorded({ path: '/api/health' }), wireRecorded({ method: 'POST', path: '/api/users' })];
    const h = await engineOf(admin).create(imposter('s').port(9140).record());
    let thrown: unknown;
    try {
      await h.verify(onGet('/api/users/1'), times(1));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(VerificationError);
    const err = thrown as VerificationError;
    expect(err.count).toEqual({ matched: 0, total: 2, matcher: expect.objectContaining({ min: 1, max: 1 }) });
    expect(err.recorded).toHaveLength(2);
    expect(err.closest).toBeDefined();
  });

  it('verify() default count is atLeast(1)', async () => {
    const admin = new FakeAdminApi();
    admin.savedRequests = [];
    const h = await engineOf(admin).create(imposter('s').port(9150).record());
    await expect(h.verify(onGet('/api/users/1'))).rejects.toBeInstanceOf(VerificationError);
  });

  it('verify()/recorded() on an imposter created without .record() throws RiftError naming .record()', async () => {
    const admin = new FakeAdminApi();
    const h = await engineOf(admin).create(imposter('s').port(9160)); // no .record()
    let thrown: unknown;
    try {
      await h.verify(onGet('/api/users/1'));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(RiftError);
    expect(thrown).not.toBeInstanceOf(VerificationError);
    expect((thrown as RiftError).message).toContain('.record()');
  });
});

describe('SpaceHandle.recorded / verify', () => {
  it('scope recorded()/verify() to the space via match=[flow_id=<id>]', async () => {
    const admin = new FakeAdminApi();
    admin.savedRequests = [wireRecorded({ path: '/api/users/1' })];
    const h = await engineOf(admin).create(imposter('s').port(9200).record());
    const space = h.space('flow-A');

    await space.recorded();
    expect(admin.getSavedRequestsCalls.at(-1)).toEqual({ port: 9200, match: ['flow_id=flow-A'] });

    await expect(space.verify(onGet('/api/users/1'), times(1))).resolves.toBeUndefined();
    expect(admin.getSavedRequestsCalls.at(-1)).toEqual({ port: 9200, match: ['flow_id=flow-A'] });
  });

  it('space verify() also throws RiftError when the imposter has no recording enabled', async () => {
    const admin = new FakeAdminApi();
    const h = await engineOf(admin).create(imposter('s').port(9210)); // no .record()
    await expect(h.space('flow-B').verify(onGet('/x'))).rejects.toThrow('.record()');
  });
});

// --- review cycle 1: classifier-fail-loud + not-clause diagnostics + recorded() guard ------------

describe('evaluator — modifier-only predicate must fail loudly (no false positive)', () => {
  it('throws UnsupportedPredicateError when no operator/exists accompanies a modifier key', () => {
    // A predicate built from only a selector/param would otherwise match EVERY request, turning
    // verify() into a false positive. Each must throw rather than silently pass.
    expect(() => evalPredicates({ jsonpath: { selector: '$.userId' } }, rr({}))).toThrow(
      UnsupportedPredicateError
    );
    expect(() => evalPredicates({ except: '.*' }, rr({}))).toThrow(UnsupportedPredicateError);
    expect(() => evalPredicates({ caseSensitive: true }, rr({}))).toThrow(UnsupportedPredicateError);
    expect(() => evalPredicates({ keyCaseSensitive: true }, rr({}))).toThrow(
      UnsupportedPredicateError
    );
  });
  it('an empty predicate still matches every request (unchanged)', () => {
    expect(evalPredicates({}, rr({ method: 'GET' }))).toBe(true);
  });
});

describe('evaluator — not-clause is inverted in the closest breakdown', () => {
  it('a satisfied not (i.e. failing verification clause) is scored as a FAILED leaf, not passed', () => {
    // Verify GET AND path != /admin. A recorded `GET /admin` fails only the not-clause.
    const expected: Predicate[] = [{ equals: { method: 'GET' } }, { not: { equals: { path: '/admin' } } }];
    const req = rr({ method: 'GET', path: '/admin' });
    const leaves = collectLeafDetails(expected, req);
    const notLeaf = leaves.find((l) => l.operator.startsWith('not'));
    expect(notLeaf?.passed).toBe(false); // was incorrectly true before the fix
    const methodLeaf = leaves.find((l) => l.field === 'method');
    expect(methodLeaf?.passed).toBe(true);
  });
});

describe('handle — recorded() enforces recording like verify()', () => {
  it('recorded() on an imposter without .record() throws RiftError naming .record()', async () => {
    const admin = new FakeAdminApi();
    const h = await engineOf(admin).create(imposter('s').port(9260)); // no .record()
    await expect(h.recorded()).rejects.toThrow('.record()');
    await expect(h.recorded()).rejects.toBeInstanceOf(RiftError);
  });
});

describe('predicatesOf — responses are genuinely ignored', () => {
  it('a StubBuilder WITH a response contributes only its predicates', () => {
    const stub = onGet('/api/users/1').willReturn(okJson({ id: 1 }));
    expect(stub.build().responses?.length).toBeGreaterThan(0); // a response IS present
    expect(predicatesOf(stub)).toEqual(stub.build().predicates); // yet only predicates lifted
  });
});

describe('issue #33 — evaluator ergonomics (fail-closed boundary, no verdict changes)', () => {
  it('AC1: exists with an unknown field name throws UnsupportedPredicateError naming it', () => {
    expect(() => evalPredicates([{ exists: { pathh: true } }], rr())).toThrow(UnsupportedPredicateError);
    expect(() => evalPredicates([{ exists: { pathh: true } }], rr())).toThrow(/pathh/);
  });

  it('AC1: an operator FieldMatch with an unknown field name throws UnsupportedPredicateError naming it', () => {
    expect(() => evalPredicates([{ equals: { fielddd: 'x' } }], rr())).toThrow(UnsupportedPredicateError);
    expect(() => evalPredicates([{ equals: { fielddd: 'x' } }], rr())).toThrow(/fielddd/);
  });

  it('AC1: known fields still evaluate (headers/query per-key expansion unaffected)', () => {
    const req = rr({ headers: { accept: 'application/json' }, query: { page: '2' } });
    expect(evalPredicates([{ equals: { headers: { accept: 'application/json' } } }], req)).toBe(true);
    expect(evalPredicates([{ equals: { query: { page: '2' } } }], req)).toBe(true);
  });

  it('AC2: a jsonpath predicate against a raw-string body is a non-match with a "body is not JSON" note', () => {
    const req = rr({ body: 'plain text, not json' });
    const preds: Predicate[] = [{ equals: { body: 1 }, jsonpath: { selector: '$.id' } }];
    expect(evalPredicates(preds, req)).toBe(false); // fail-closed verdict unchanged
    const leaves = collectLeafDetails(preds, req);
    expect(leaves).toHaveLength(1);
    expect(leaves[0].note).toBe('body is not JSON');
  });

  it('AC2: an object-equals predicate against a raw-string body carries the note too', () => {
    const req = rr({ body: 'oops' });
    const leaves = collectLeafDetails([{ equals: { body: { id: 1 } } }], req);
    expect(leaves[0].passed).toBe(false);
    expect(leaves[0].note).toBe('body is not JSON');
  });

  it('AC2: the closest-non-match renderer surfaces the note instead of "(absent)"', () => {
    const predicates: Predicate[] = [{ equals: { body: { id: 1 } }, jsonpath: { selector: '$.id' } }];
    const recorded = [rr({ body: 'raw string body', timestamp: '2026-07-09T10:12:03Z' })];
    const closest = computeClosest(predicates, recorded);
    const err = new VerificationError('Verification failed for imposter "users" (port 55123)', {
      expected: predicates,
      count: { matched: 0, total: recorded.length, matcher: times(1) },
      recorded,
      closest,
    });
    const rendered = renderVerificationFailure(err);
    expect(rendered).toContain('(body is not JSON)');
    expect(rendered).not.toContain('(absent)');
  });

  it('AC2: a parsed-JSON body does NOT carry the note', () => {
    const req = rr({ body: { id: 1 } });
    const leaves = collectLeafDetails([{ equals: { body: { id: 1 } } }], req);
    expect(leaves[0].passed).toBe(true);
    expect(leaves[0].note).toBeUndefined();
  });

  it('AC2: plain string-equals against a string body is an ordinary comparison — no note', () => {
    const req = rr({ body: 'plain text' });
    const leaves = collectLeafDetails([{ equals: { body: 'plain text' } }], req);
    expect(leaves[0].passed).toBe(true);
    expect(leaves[0].note).toBeUndefined();
  });

  it('AC1: an unknown field nested in not/and composition still throws', () => {
    expect(() => evalPredicates([{ not: { equals: { fielddd: 'x' } } }], rr())).toThrow(UnsupportedPredicateError);
    expect(() => evalPredicates([{ and: [{ exists: { pathh: true } }] }], rr())).toThrow(UnsupportedPredicateError);
  });

  it('AC3: an invalid regex in matches throws InvalidDefinition, not a raw SyntaxError', () => {
    const req = rr({ path: '/x' });
    expect(() => evalPredicates([{ matches: { path: '(' } }], req)).toThrow(rootExports.InvalidDefinition);
    expect(() => evalPredicates([{ matches: { path: '(' } }], req)).toThrow(/matches/);
  });

  it('AC3: an invalid regex in except throws InvalidDefinition, not a raw SyntaxError', () => {
    const req = rr({ path: '/x' });
    expect(() => evalPredicates([{ equals: { path: '/x' }, except: '(' }], req)).toThrow(
      rootExports.InvalidDefinition
    );
    expect(() => evalPredicates([{ equals: { path: '/x' }, except: '(' }], req)).toThrow(/except/);
  });
});
