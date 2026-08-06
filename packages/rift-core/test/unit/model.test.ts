/**
 * Wire-model gate (issue #2)
 *
 * The wire model is a *preservation* layer: `fromJson` parses + validates the Mountebank
 * grammar (imposter/stub/predicate/response/behaviors + `_rift` extensions) and hands the
 * structure back verbatim — never rewriting keys, never dropping unknown-but-valid fields,
 * and respecting an explicit port exactly. `toWireJson` emits the exact camelCase JSON the
 * engine speaks. These tests lock that contract via round-trip identity over the real rift
 * example fixtures, a port-clobber regression, validation, and typed-construction casing.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  fromJson,
  toWireJson,
  toWireString,
  WireValidationError,
  type Imposter,
  type ImpostersConfig,
} from '../../src/model/index.js';
import { stringifyJsonSafe } from '../../src/model/serialize.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, '..', 'fixtures', 'mb');
const fixtureFiles = fs.readdirSync(fixturesDir).filter((f) => f.endsWith('.json'));

describe('wire model — round-trip over rift example fixtures', () => {
  it('found the fixtures', () => {
    expect(fixtureFiles.length).toBeGreaterThanOrEqual(6);
  });

  for (const file of fixtureFiles) {
    it(`round-trips ${file} with structural identity`, () => {
      const text = fs.readFileSync(path.join(fixturesDir, file), 'utf8');
      const original = JSON.parse(text);
      const parsed = fromJson(text);
      const emitted = toWireJson(parsed);
      // Nothing is rewritten or dropped: parse→emit is value-identical (deep-equal).
      expect(emitted).toEqual(original);
    });
  }
});

describe('wire model — port preservation (ledger port-clobber regression)', () => {
  it('preserves an explicit port verbatim through fromJson→toWireJson', () => {
    const cfg = fromJson('{"imposters":[{"port":4545,"protocol":"http","stubs":[]}]}') as ImpostersConfig;
    expect(cfg.imposters[0].port).toBe(4545);
    const wire = toWireJson(cfg) as { imposters: Array<{ port?: number }> };
    expect(wire.imposters[0].port).toBe(4545);
  });

  it('never injects/assigns a port when one is absent', () => {
    const original = { imposters: [{ protocol: 'http', stubs: [] }] };
    const wire = toWireJson(fromJson(original)) as {
      imposters: Array<Record<string, unknown>>;
    };
    expect('port' in wire.imposters[0]).toBe(false);
  });

  it('respects an explicit port on a single imposter (POST /imposters body)', () => {
    const imposter = fromJson({ port: 8080, protocol: 'http', stubs: [] }) as Imposter;
    expect(imposter.port).toBe(8080);
    expect((toWireJson(imposter) as { port?: number }).port).toBe(8080);
  });

  it('preserves port 0 verbatim (does not treat it as absent)', () => {
    const cfg = fromJson({ imposters: [{ port: 0, protocol: 'http', stubs: [] }] }) as ImpostersConfig;
    expect(cfg.imposters[0].port).toBe(0);
    const wire = toWireJson(cfg) as { imposters: Array<{ port?: number }> };
    expect(wire.imposters[0].port).toBe(0);
  });

  it('rejects a non-numeric port rather than clobbering it', () => {
    expect(() => fromJson({ imposters: [{ port: '4545', protocol: 'http' }] })).toThrow(
      WireValidationError
    );
    expect(() => fromJson({ imposters: [{ port: NaN, protocol: 'http' }] })).toThrow(
      WireValidationError
    );
  });

  it('never injects a port on the single-imposter form either', () => {
    const wire = toWireJson(fromJson({ protocol: 'http', stubs: [] })) as Record<string, unknown>;
    expect('port' in wire).toBe(false);
  });
});

describe('wire model — fromJson validation', () => {
  it('rejects non-JSON strings', () => {
    expect(() => fromJson('not json')).toThrow(WireValidationError);
  });

  it('rejects a non-array imposters field', () => {
    expect(() => fromJson('{"imposters":"nope"}')).toThrow(WireValidationError);
  });

  it('rejects a stub whose stubs/predicates/responses are not arrays', () => {
    expect(() => fromJson({ imposters: [{ protocol: 'http', stubs: 'x' }] })).toThrow(
      WireValidationError
    );
    expect(() =>
      fromJson({ imposters: [{ protocol: 'http', stubs: [{ predicates: {} }] }] })
    ).toThrow(WireValidationError);
  });

  it('accepts an empty imposters envelope', () => {
    expect(() => fromJson('{"imposters":[]}')).not.toThrow();
  });

  it('rejects a top-level array or null', () => {
    expect(() => fromJson('[]')).toThrow(WireValidationError);
    expect(() => fromJson('null')).toThrow(WireValidationError);
    expect(() => fromJson([] as unknown)).toThrow(WireValidationError);
  });

  it('rejects a response element that is not an object', () => {
    expect(() =>
      fromJson({ imposters: [{ protocol: 'http', stubs: [{ responses: ['nope'] }] }] })
    ).toThrow(WireValidationError);
  });

  it('recursively validates and/or/not predicate combinators', () => {
    expect(() =>
      fromJson({ imposters: [{ protocol: 'http', stubs: [{ predicates: [{ and: 'nope' }] }] }] })
    ).toThrow(WireValidationError);
    expect(() =>
      fromJson({ imposters: [{ protocol: 'http', stubs: [{ predicates: [{ not: 42 }] }] }] })
    ).toThrow(WireValidationError);
    expect(() =>
      fromJson({
        imposters: [
          {
            protocol: 'http',
            stubs: [{ predicates: [{ or: [{ equals: { method: 'GET' } }, 'bad'] }] }],
          },
        ],
      })
    ).toThrow(WireValidationError);
    // a well-formed nested combinator passes
    expect(() =>
      fromJson({
        imposters: [
          {
            protocol: 'http',
            stubs: [
              {
                predicates: [
                  { and: [{ equals: { method: 'GET' } }, { not: { exists: { path: false } } }] },
                ],
              },
            ],
          },
        ],
      })
    ).not.toThrow();
  });

  it('rejects a non-object is/proxy response body', () => {
    expect(() =>
      fromJson({ imposters: [{ protocol: 'http', stubs: [{ responses: [{ is: 'nope' }] }] }] })
    ).toThrow(WireValidationError);
  });

  it('rejects non-plain objects (Map/Date) that would serialize lossily', () => {
    expect(() => fromJson(new Map([['imposters', []]]) as unknown)).toThrow(WireValidationError);
  });

  it('error message names the offending path', () => {
    try {
      fromJson({ imposters: [{ protocol: 'http', stubs: 'x' }] });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(WireValidationError);
      expect((e as Error).message).toMatch(/stubs/);
    }
  });
});

describe('wire model — preserves unknown / _rift extension fields verbatim', () => {
  it('does not drop _rift or unrecognized keys', () => {
    const input = {
      imposters: [
        {
          port: 3000,
          protocol: 'http',
          _rift: { flowState: { backend: 'redis', ttlSeconds: 60 } },
          stubs: [{ predicates: [], responses: [], _verify: { sequence: [1, 2] } }],
          somethingFutureTheEngineAdds: true,
        },
      ],
    };
    expect(toWireJson(fromJson(input))).toEqual(input);
  });
});

describe('wire model — typed construction emits exact camelCase wire keys', () => {
  it('serializes statusCode / caseSensitive / recordRequests without snake_case drift', () => {
    const imposter: Imposter = {
      port: 2525,
      protocol: 'http',
      recordRequests: true,
      stubs: [
        {
          predicates: [{ equals: { method: 'POST', path: '/api/users' }, caseSensitive: true }],
          responses: [{ is: { statusCode: 201, headers: { 'Content-Type': 'application/json' }, body: { id: 1 } } }],
        },
      ],
    };
    const json = JSON.stringify(toWireJson(imposter));
    expect(json).toContain('"statusCode"');
    expect(json).toContain('"caseSensitive"');
    expect(json).toContain('"recordRequests"');
    expect(json).not.toContain('status_code');
    expect(json).not.toContain('case_sensitive');
    expect(json).not.toContain('record_requests');
  });

  it('preserves _behaviors on a response', () => {
    const imposter: Imposter = {
      protocol: 'http',
      stubs: [
        {
          predicates: [{ equals: { path: '/slow' } }],
          responses: [{ is: { statusCode: 200, body: 'ok' }, _behaviors: { wait: 500 } }],
        },
      ],
    };
    const wire = toWireJson(imposter) as {
      stubs: Array<{ responses: Array<{ _behaviors?: { wait?: number } }> }>;
    };
    expect(wire.stubs[0].responses[0]._behaviors?.wait).toBe(500);
  });
});

describe('wire model — comprehensive grammar round-trip + camelCase emission', () => {
  const rich = {
    imposters: [
      {
        port: 4600,
        protocol: 'https',
        host: '127.0.0.1',
        name: 'rich',
        cert: '-----BEGIN CERT-----',
        key: '-----BEGIN KEY-----',
        mutualAuth: true,
        allowCORS: true,
        recordRequests: true,
        recordMatches: true,
        strictBehaviors: true,
        defaultResponse: { statusCode: 404, body: 'nope' },
        defaultForward: 'http://upstream.local',
        _rift: { flowState: { backend: 'redis', ttlSeconds: 60 }, scripts: { s1: { code: 'x' } } },
        futureImposterKey: { anything: [1, 2] },
        stubs: [
          {
            id: 'stub-1',
            scenarioName: 'flow',
            required_scenario_state: 'start',
            new_scenario_state: 'next',
            route_pattern: '/users/:id',
            space: 'tenant-a',
            recorded_from: 'http://origin',
            _verify: { sequence: [1, 2, 3] },
            predicates: [
              { equals: { method: 'GET' }, caseSensitive: true, keyCaseSensitive: true, except: '\\d+' },
              { deepEquals: { path: '/x' } },
              { contains: { body: 'z' } },
              { startsWith: { path: '/a' } },
              { endsWith: { path: '/b' } },
              { matches: { path: '/u/\\d+' } },
              { exists: { 'headers.Authorization': true } },
              { jsonpath: { selector: '$.name' }, equals: { body: 'y' } },
              { xpath: { selector: '//user', ns: { u: 'urn:u' } }, equals: { body: 'v' } },
              { and: [{ equals: { method: 'POST' } }, { not: { exists: { path: false } } }] },
              { or: [{ equals: { method: 'PUT' } }, { equals: { method: 'PATCH' } }] },
              { inject: 'function (req) { return true; }' },
            ],
            responses: [
              {
                is: {
                  statusCode: '201',
                  headers: { 'Content-Type': 'application/json', 'Set-Cookie': ['a=1', 'b=2'] },
                  body: { id: 1, tags: ['x'] },
                  _mode: 'text',
                },
                _behaviors: {
                  wait: 250,
                  repeat: 2,
                  decorate: 'function (req, res) { return res; }',
                  shellTransform: ['cat', 'tr a b'],
                  copy: [{ from: 'path', into: '${p}' }],
                  lookup: [{ key: 'k' }],
                },
                _rift: { fault: { latency: { ms: 10 } }, script: { ref: 's1' }, templated: true },
              },
              { statusCode: 200, headers: { X: 'y' }, body: 'flat-form' },
              {
                proxy: {
                  to: 'http://up',
                  mode: 'proxyOnce',
                  predicateGenerators: [{ matches: { path: true } }],
                  addWaitBehavior: true,
                  addDecorateBehavior: 'function (r) { return r; }',
                },
              },
              { inject: 'function (req) { return { statusCode: 200 }; }' },
              { fault: 'ECONNRESET' },
            ],
          },
        ],
      },
      { port: 4601, protocol: 'http', stubs: [] },
    ],
  };

  it('round-trips the full grammar with value identity', () => {
    expect(toWireJson(fromJson(rich))).toEqual(rich);
  });

  it('emits every camelCase wire key and no snake_case drift', () => {
    const json = JSON.stringify(toWireJson(rich));
    for (const key of [
      'statusCode', 'caseSensitive', 'keyCaseSensitive', 'recordRequests', 'recordMatches',
      'allowCORS', 'mutualAuth', 'strictBehaviors', 'defaultResponse', 'defaultForward',
      'scenarioName', 'predicateGenerators', 'addWaitBehavior', 'addDecorateBehavior',
      'shellTransform', 'flowState', 'ttlSeconds',
    ]) {
      expect(json).toContain(`"${key}"`);
    }
    for (const bad of [
      'status_code', 'case_sensitive', 'record_requests', 'allow_cors', 'default_response',
      'predicate_generators', 'add_wait_behavior', 'shell_transform', 'flow_state',
    ]) {
      expect(json).not.toContain(bad);
    }
  });

  it('preserves the intentionally snake_case FSM/extension keys verbatim', () => {
    const json = JSON.stringify(toWireJson(rich));
    for (const key of ['required_scenario_state', 'new_scenario_state', 'route_pattern', 'recorded_from']) {
      expect(json).toContain(`"${key}"`);
    }
  });

  it('keeps statusCode as a string when given as a string', () => {
    const wire = toWireJson(rich) as {
      imposters: Array<{ stubs?: Array<{ responses: Array<{ is?: { statusCode?: unknown } }> }> }>;
    };
    expect(wire.imposters[0].stubs![0].responses[0].is!.statusCode).toBe('201');
  });
});

describe('wire model — serialization is JSON-safe (no silent loss)', () => {
  it('throws a typed error on a function value instead of dropping it', () => {
    const model = { imposters: [{ protocol: 'http', _rift: { hook: () => 1 } }] } as unknown as ImpostersConfig;
    expect(() => toWireJson(model)).toThrow(WireValidationError);
  });

  it('throws a typed error on a bigint value', () => {
    const model = { imposters: [{ protocol: 'http', _rift: { n: BigInt(1) } }] } as unknown as ImpostersConfig;
    expect(() => toWireString(model)).toThrow(WireValidationError);
  });

  it('wraps a circular reference as a typed error (not a raw TypeError)', () => {
    const model: Record<string, unknown> = { imposters: [] };
    model.self = model;
    expect(() => toWireJson(model as unknown as ImpostersConfig)).toThrow(WireValidationError);
  });

  it('throws a typed error naming the offending key on a non-finite number (issue #106)', () => {
    for (const bad of [NaN, Infinity, -Infinity]) {
      const model = {
        imposters: [{ protocol: 'http', _rift: { temperature: bad } }],
      } as unknown as ImpostersConfig;
      let caught: unknown;
      try {
        toWireString(model);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(WireValidationError);
      expect((caught as WireValidationError).path).toContain('temperature');
      // The message must distinguish NaN from Infinity from -Infinity — "not serializable" alone
      // does not tell the caller which value they wrote.
      expect((caught as WireValidationError).message).toContain(String(bad));
    }
  });

  it('locates a non-finite array element by its index, and throws via toWireJson too (issue #106)', () => {
    const model = {
      imposters: [{ protocol: 'http', _rift: { readings: [1, Infinity] } }],
    } as unknown as ImpostersConfig;
    let caught: unknown;
    try {
      toWireJson(model);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(WireValidationError);
    // JSON.stringify hands the replacer the array index as the key, so that is the locator.
    expect((caught as WireValidationError).path).toBe('…1');
  });

  it('throws on a root-level non-finite value with the root path (issue #106)', () => {
    let caught: unknown;
    try {
      toWireString(NaN as unknown as ImpostersConfig);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(WireValidationError);
    expect((caught as WireValidationError).path).toBe('$');
  });

  it('refuses an undefined array element (issue #119)', () => {
    let caught: unknown;
    try {
      stringifyJsonSafe([1, undefined, 3]);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(WireValidationError);
    // JSON.stringify hands the replacer the array index as the key, so that is the locator.
    expect((caught as WireValidationError).path).toBe('…1');
    expect((caught as WireValidationError).message).toContain('undefined');
  });

  it('refuses a sparse array hole (issue #119)', () => {
    // eslint-disable-next-line no-sparse-arrays
    const sparse = [1, , 3];
    expect(() => stringifyJsonSafe(sparse)).toThrow(WireValidationError);
  });

  it('still drops an undefined object property (issue #119)', () => {
    // The documented contract: an omitted optional wire field must not reach the engine, and is
    // NOT the silent-null bug — JSON.stringify drops it rather than nulling it.
    expect(stringifyJsonSafe({ a: undefined })).toBe('{}');
    expect(stringifyJsonSafe({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it('refuses an array element whose toJSON() returns undefined (issue #119)', () => {
    // toJSON() runs before the replacer, so this reaches the wire as null exactly like a literal
    // undefined element would.
    const vanishing = { toJSON: () => undefined };
    expect(() => stringifyJsonSafe([1, vanishing])).toThrow(WireValidationError);
  });

  it('refuses an undefined element nested inside a model (issue #119)', () => {
    const model = {
      imposters: [{ protocol: 'http', _rift: { readings: [1, undefined] } }],
    } as unknown as ImpostersConfig;
    expect(() => toWireString(model)).toThrow(WireValidationError);
    expect(() => toWireJson(model)).toThrow(WireValidationError);
  });

  it('still reports a root-level undefined as having no JSON representation (issue #119)', () => {
    // The root holder is JSON.stringify's internal {'': value} wrapper, not an array, so this must
    // keep falling through to the existing whole-value check rather than the new array-element one.
    let caught: unknown;
    try {
      stringifyJsonSafe(undefined);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(WireValidationError);
    expect((caught as WireValidationError).path).toBe('$');
    expect((caught as WireValidationError).message).toContain('no JSON representation');
  });

  it('leaves finite numbers untouched — including 0, -0 and MAX_VALUE (issue #106)', () => {
    const model = {
      imposters: [{ protocol: 'http', _rift: { zero: 0, negZero: -0, max: Number.MAX_VALUE, n: 42 } }],
    } as unknown as ImpostersConfig;
    const json = toWireString(model);
    expect(json).toContain('"zero":0');
    expect(json).toContain('"negZero":0');
    expect(json).toContain(`"max":${Number.MAX_VALUE}`);
    expect(json).toContain('"n":42');
  });
});

describe('wire model — a wrapped serialization failure keeps the original error as `cause` (issue #121)', () => {
  it('carries a cause when one is supplied', () => {
    const original = new TypeError('converting circular structure to JSON');
    const err = new WireValidationError('value is not JSON-serializable', '$.imposters', { cause: original });
    expect(err.cause).toBe(original);
    // Widening the constructor must not disturb what it already sets.
    expect(err.path).toBe('$.imposters');
    expect(err.message).toBe('value is not JSON-serializable (at $.imposters)');
    expect(err.name).toBe('WireValidationError');
    expect(err).toBeInstanceOf(WireValidationError);
  });

  it('stays backward compatible with two-arg construction', () => {
    const err = new WireValidationError('value is not JSON-serializable', '$.imposters');
    expect(err.cause).toBeUndefined();
    expect(err.path).toBe('$.imposters');
    expect(err.message).toBe('value is not JSON-serializable (at $.imposters)');
  });

  it('attaches the original TypeError from a circular reference', () => {
    const model: Record<string, unknown> = { imposters: [] };
    model.self = model;
    let caught: unknown;
    try {
      toWireString(model as unknown as ImpostersConfig);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(WireValidationError);
    // The type and stack of the throw JSON.stringify raised are the only description of what went
    // wrong; before #121 only its message text survived.
    expect((caught as WireValidationError).cause).toBeInstanceOf(TypeError);
  });

  it('attaches the RangeError a toJSON() raised', () => {
    const original = new RangeError('Invalid time value');
    const value = {
      toJSON(): never {
        throw original;
      },
    };
    let caught: unknown;
    try {
      stringifyJsonSafe(value);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(WireValidationError);
    expect((caught as WireValidationError).cause).toBe(original);
  });

  it('attaches a non-Error throw verbatim as the cause', () => {
    const value = {
      toJSON(): never {
        throw 'boom';
      },
    };
    let caught: unknown;
    try {
      stringifyJsonSafe(value);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(WireValidationError);
    // A non-Error throw has no `.message` to fold into the text, so the raw value is the only
    // record of it — `ErrorOptions.cause` is `unknown`, so there is nothing to narrow first.
    expect((caught as WireValidationError).cause).toBe('boom');
    expect((caught as WireValidationError).message).toContain('boom');
  });

  it('propagates a replacer WireValidationError un-rewrapped', () => {
    let caught: unknown;
    try {
      stringifyJsonSafe({ n: BigInt(1) });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(WireValidationError);
    // Re-wrapping would flatten the precise key locator to the root and bury the real message one
    // level down, so the replacer's own error must pass straight through — with no cause bolted on.
    expect((caught as WireValidationError).path).toBe('…n');
    expect((caught as WireValidationError).message).toContain('bigint');
    expect((caught as WireValidationError).message).not.toContain('value is not JSON-serializable');
    expect((caught as WireValidationError).cause).toBeUndefined();
  });
});
