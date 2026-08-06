/**
 * Gate for issue #11 — TLS-MITM intercept surface.
 *
 * Everything here runs against a FAKE `InterceptBackend` (no koffi/cdylib/live engine) or a
 * `RemoteClient` with a mocked global `fetch` (no live engine either), so it's CI-green with neither
 * koffi nor undici installed. Covers: pure rule-building wire shapes, the `InterceptHandle` surface
 * (rules/clearRules/caPem/caFile/exportTruststore/env), per-transport availability + attach
 * dispatch on `Engine.intercept()` (embedded memoization, spawn's opt-in gate, remote's 404 probe),
 * `buildSpawnArgs`'s intercept flag, `RemoteClient`'s new intercept HTTP routes, and
 * `interceptDispatcher`'s injectable `proxyAgentFactory` (the real `undici.ProxyAgent` path is
 * integration-only — see test/integration/intercept.integration.test.ts).
 */

import { jest } from '@jest/globals';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { Engine, type AdminApi, type ImposterHandle } from '../../src/engine.js';
import { ok, okJson, created, req } from '../../src/dsl/index.js';
import type { ResponseBuilder } from '../../src/dsl/response.js';
import { InterceptUnavailable, InvalidDefinition, WireValidationError } from '../../src/errors.js';
import type { InterceptRule, IsResponse } from '../../src/model/index.js';
import type { InterceptBackend } from '../../src/intercept/types.js';
import { buildSpawnArgs } from '../../src/spawn/index.js';
import { connect } from '../../src/remote/client.js';
import { interceptDispatcher, type ProxyAgentConfig } from '../../src/intercept-undici.js';

// -------------------------------------------------------------------------------------------
// Fake InterceptBackend — records every call, returns canned JSON/PEM.
// -------------------------------------------------------------------------------------------

class FakeInterceptBackend implements InterceptBackend {
  startCalls: string[] = [];
  addRulesCalls: string[] = [];
  clearCalls = 0;
  listResult = '[]';
  caPemResult = '-----BEGIN CERTIFICATE-----\nFAKE\n-----END CERTIFICATE-----\n';
  exportCalls: Array<{ format: string; password: string; outPath: string }> = [];
  startResult = { interceptPort: 6800, interceptUrl: 'http://127.0.0.1:6800' };

  async startIntercept(optionsJson: string): Promise<{ interceptPort: number; interceptUrl: string }> {
    this.startCalls.push(optionsJson);
    return this.startResult;
  }

  async addRules(rulesJson: string): Promise<void> {
    this.addRulesCalls.push(rulesJson);
  }

  async listRules(): Promise<string> {
    return this.listResult;
  }

  async clearRules(): Promise<void> {
    this.clearCalls++;
  }

  async caPem(): Promise<string> {
    return this.caPemResult;
  }

  async exportTruststore(format: string, password: string, outPath: string): Promise<void> {
    this.exportCalls.push({ format, password, outPath });
  }
}

/** An `AdminApi` that throws if anything beyond `url`/`close`/disposal is touched — the intercept
 * dispatch tests below never need real imposter/stub/etc. behavior. */
function noopAdmin(url?: string): AdminApi {
  const base = {
    url,
    closed: false,
    async close(): Promise<void> {},
    async [Symbol.asyncDispose](): Promise<void> {},
  };
  return new Proxy(base as unknown as AdminApi, {
    get(target, prop, receiver) {
      if (prop in target) return Reflect.get(target, prop, receiver);
      return () => {
        throw new Error(`unexpected AdminApi.${String(prop)}() call in intercept test`);
      };
    },
  });
}

function engineOf(backend: InterceptBackend): { engine: Engine; backend: FakeInterceptBackend } {
  const fake = backend as FakeInterceptBackend;
  const engine = new Engine(noopAdmin(), 'embedded', { interceptBackend: fake });
  return { engine, backend: fake };
}

const target: ImposterHandle = { port: 7777 } as unknown as ImposterHandle;

describe('issue #11 — intercept rule building (wire snapshots)', () => {
  it('serve(host, ResponseBuilder) → {host, action:{serve}}', async () => {
    const fake = new FakeInterceptBackend();
    const { engine } = engineOf(fake);
    const handle = await engine.intercept();
    await handle.serve('cdn.example.com', okJson({ stub: true }));
    const rules = JSON.parse(fake.addRulesCalls[0] as string) as InterceptRule[];
    expect(rules).toEqual([
      {
        host: 'cdn.example.com',
        action: {
          serve: {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: '{"stub":true}',
          },
        },
      },
    ]);
  });

  it('serve(predicates, IsResponse) → {predicates, action:{serve}}', async () => {
    const fake = new FakeInterceptBackend();
    const { engine } = engineOf(fake);
    const handle = await engine.intercept();
    await handle.serve([req.path('/x')], { statusCode: 204 });
    const rules = JSON.parse(fake.addRulesCalls[0] as string) as InterceptRule[];
    expect(rules[0]?.action).toEqual({ serve: { statusCode: 204 } });
    expect(rules[0]?.host).toBeUndefined();
    expect(rules[0]?.predicates).toEqual([{ equals: { path: '/x' } }]);
  });

  it('forward(host, port) and forward(predicates, ImposterHandle) → {..., action:{forward:{port}}}', async () => {
    const fake = new FakeInterceptBackend();
    const { engine } = engineOf(fake);
    const handle = await engine.intercept();

    await handle.forward('api.example.com', 9000);
    let rules = JSON.parse(fake.addRulesCalls[0] as string) as InterceptRule[];
    expect(rules).toEqual([{ host: 'api.example.com', action: { forward: { port: 9000 } } }]);

    await handle.forward([req.path('/api')], target);
    rules = JSON.parse(fake.addRulesCalls[1] as string) as InterceptRule[];
    expect(rules[0]?.action).toEqual({ forward: { port: 7777 } });
    expect(rules[0]?.host).toBeUndefined();
    expect(rules[0]?.predicates).toEqual([{ equals: { path: '/api' } }]);
  });

  it('redirectTo(imposter) → a catch-all forward rule (no host/predicates)', async () => {
    const fake = new FakeInterceptBackend();
    const { engine } = engineOf(fake);
    const handle = await engine.intercept();
    await handle.redirectTo(target);
    const rules = JSON.parse(fake.addRulesCalls[0] as string) as InterceptRule[];
    expect(rules).toEqual([{ action: { forward: { port: 7777 } } }]);
  });

  it('addRule accepts a single raw rule or an array', async () => {
    const fake = new FakeInterceptBackend();
    const { engine } = engineOf(fake);
    const handle = await engine.intercept();

    const one: InterceptRule = { host: 'a.example.com', action: { serve: { statusCode: 200 } } };
    await handle.addRule(one);
    expect(JSON.parse(fake.addRulesCalls[0] as string)).toEqual([one]);

    const two: InterceptRule = { host: 'b.example.com', action: { serve: { statusCode: 201 } } };
    await handle.addRule([one, two]);
    expect(JSON.parse(fake.addRulesCalls[1] as string)).toEqual([one, two]);
  });

  it('serve() rejects a ResponseBuilder that does not build an `is` block', async () => {
    const fake = new FakeInterceptBackend();
    const { engine } = engineOf(fake);
    const handle = await engine.intercept();
    await expect(handle.serve('x.example.com', created().latency(10))).resolves.toBeUndefined();
    // A proxy-only builder has no `is` block — that IS rejected.
    const { proxyTo } = await import('../../src/dsl/proxy.js');
    await expect(handle.serve('x.example.com', proxyTo('http://origin.example.com'))).rejects.toThrow(
      InvalidDefinition
    );
  });
});

describe('issue #101 — serve() normalizes the response into the engine ServeStub wire shape', () => {
  /** The `action.serve` object as it actually goes over the wire — parsed back from the JSON the
   * backend received, so these assertions see exactly what serde will. */
  async function serveWire(response: ResponseBuilder | IsResponse): Promise<Record<string, unknown>> {
    const fake = new FakeInterceptBackend();
    const { engine } = engineOf(fake);
    const handle = await engine.intercept();
    await handle.serve('x.example.com', response);
    const rules = JSON.parse(fake.addRulesCalls[0] as string) as InterceptRule[];
    return (rules[0]?.action as { serve: Record<string, unknown> }).serve;
  }

  async function serveRejects(response: ResponseBuilder | IsResponse): Promise<void> {
    const fake = new FakeInterceptBackend();
    const { engine } = engineOf(fake);
    const handle = await engine.intercept();
    await expect(handle.serve('x.example.com', response)).rejects.toThrow(InvalidDefinition);
  }

  it('stringifies an object body — engine ServeStub.body is Option<String>', async () => {
    expect(await serveWire(okJson({ stub: true }))).toEqual({
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: '{"stub":true}',
    });
  });

  it('stringifies array, number and boolean bodies the same compact way', async () => {
    expect((await serveWire({ body: [1, 2] })).body).toBe('[1,2]');
    expect((await serveWire({ body: 42 })).body).toBe('42');
    expect((await serveWire({ body: false })).body).toBe('false');
  });

  it('passes a string body through verbatim — never double-encoded', async () => {
    expect((await serveWire({ body: '{"already":"json"}' })).body).toBe('{"already":"json"}');
    expect((await serveWire({ body: 'plain text' })).body).toBe('plain text');
  });

  it('omits an absent or null body rather than sending a null', async () => {
    expect(await serveWire({ statusCode: 204 })).toEqual({ statusCode: 204 });
    expect(await serveWire({ statusCode: 204, body: null })).toEqual({ statusCode: 204 });
  });

  it('coerces a numeric-string statusCode to a number — engine status_code is u16', async () => {
    expect((await serveWire({ statusCode: '404' })).statusCode).toBe(404);
  });

  it('rejects a statusCode outside the 100..999 the engine can render as a status line', async () => {
    await serveRejects({ statusCode: 'not-a-number' });
    await serveRejects({ statusCode: 200.5 });
    await serveRejects({ statusCode: 70000 });
    await serveRejects({ statusCode: -1 });
    // Boundaries: the engine writes `HTTP/1.1 <code> <reason>` with an empty reason for anything
    // hyper's StatusCode::from_u16 rejects, so 99/1000 would emit an unparseable status line.
    await serveRejects({ statusCode: 99 });
    await serveRejects({ statusCode: 1000 });
    expect((await serveWire({ statusCode: 100 })).statusCode).toBe(100);
    expect((await serveWire({ statusCode: 999 })).statusCode).toBe(999);
  });

  it('rejects the values Number() would quietly turn into a real status code', async () => {
    // Number('') === 0, Number(true) === 1, Number('0x1F4') === 500, Number('1e3') === 1000 — each
    // would have passed a u16 range check and produced a status the caller never asked for.
    await serveRejects({ statusCode: '' as unknown as number });
    await serveRejects({ statusCode: '   ' as unknown as number });
    await serveRejects({ statusCode: true as unknown as number });
    await serveRejects({ statusCode: [] as unknown as number });
    await serveRejects({ statusCode: '0x1F4' });
    await serveRejects({ statusCode: '1e3' });
  });

  it('rejects a null statusCode rather than quietly answering the engine default', async () => {
    // Unlike `body`, whose `JsonValue` type includes null, `statusCode` is `number | string` — so a
    // null is out of contract and must not resolve to a status the caller never asked for.
    await serveRejects({ statusCode: null as unknown as number, body: 'x' });
  });

  it('rejects an unrecognized _mode instead of falling through to the text path', async () => {
    await serveRejects({ _mode: 'BINARY' as unknown as 'binary' });
    await serveRejects({ _mode: 'base64' as unknown as 'binary' });
  });

  it('rejects a multi-value header instead of silently joining it', async () => {
    await serveRejects({ headers: { 'Set-Cookie': ['a=1', 'b=2'] } });
  });

  it('rejects binary mode rather than serving the base64 as literal text', async () => {
    await serveRejects(ok().binaryBody(Buffer.from([0, 1, 2])));
    await serveRejects({ _mode: 'binary', body: 'AAEC' });
  });

  it("drops _mode:'text' and unknown keys, and does not mutate the caller's response", async () => {
    const response: IsResponse = { statusCode: 200, body: 'hi', _mode: 'text', _behaviors: { wait: 5 } };
    const before = JSON.parse(JSON.stringify(response)) as IsResponse;
    expect(await serveWire(response)).toEqual({ statusCode: 200, body: 'hi' });
    expect(response).toEqual(before);
  });

  it('reports an unserializable body as InvalidDefinition, not a raw TypeError', async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    await serveRejects({ body: circular as never });
  });

  it('rejects a non-finite number in the body instead of serving it as null (issue #106)', async () => {
    await serveRejects({ body: { n: NaN } });
    await serveRejects({ body: { n: Infinity } });
    await serveRejects({ body: [1, -Infinity] });
    await serveRejects({ body: NaN });
  });

  it('names the offending key when it rejects a non-finite body value (issue #106)', async () => {
    const fake = new FakeInterceptBackend();
    const { engine } = engineOf(fake);
    const handle = await engine.intercept();
    await expect(handle.serve('x.example.com', { body: { temperature: NaN } })).rejects.toThrow(
      /temperature/
    );
  });

  it("rejects the four headers the engine's proxy manages itself (issue #107)", async () => {
    for (const name of ['Host', 'Connection', 'content-Length', 'TRANSFER-ENCODING']) {
      await serveRejects({ headers: { [name]: 'x' } });
    }
  });

  it('rejects a header whose name or value carries CR/LF (issue #107)', async () => {
    await serveRejects({ headers: { 'X-A': 'v\r\nInjected: 1' } });
    await serveRejects({ headers: { 'X-A': 'v\nInjected: 1' } });
    await serveRejects({ headers: { 'X-A': 'v\rInjected: 1' } });
    await serveRejects({ headers: { 'X-A\r\nInjected': 'v' } });
  });

  it('points refusals at the engine, never at forward() — which strips the same names (issue #107)', async () => {
    const fake = new FakeInterceptBackend();
    const { engine } = engineOf(fake);
    const handle = await engine.intercept();
    // forward_and_relay applies is_hop_by_hop on both legs, so suggesting forward() would send the
    // caller to a path with the identical restriction.
    await expect(handle.serve('x.example.com', { headers: { Connection: 'keep-alive' } })).rejects.toThrow(
      /engine/i
    );
    await expect(
      handle.serve('x.example.com', { headers: { Connection: 'keep-alive' } })
    ).rejects.not.toThrow(/forward\(\)/);
    await expect(
      handle.serve('x.example.com', { headers: { 'X-A': 'v\r\nb' } })
    ).rejects.not.toThrow(/forward\(\)/);
  });

  it('still sends Keep-Alive and ordinary headers — the guard mirrors the engine, not RFC 7230 (issue #107)', async () => {
    // rift's is_hop_by_hop matches exactly host/connection/content-length/transfer-encoding.
    // Keep-Alive, Proxy-Authenticate, TE and Upgrade are RFC 7230 hop-by-hop but the engine passes
    // them through — rejecting them here would refuse headers the SUT would actually have received.
    expect((await serveWire({ headers: { 'Keep-Alive': 'timeout=5' } })).headers).toEqual({
      'Keep-Alive': 'timeout=5',
    });
    expect((await serveWire({ headers: { Upgrade: 'websocket', TE: 'trailers' } })).headers).toEqual({
      Upgrade: 'websocket',
      TE: 'trailers',
    });
    expect((await serveWire({ headers: { 'X-Custom': 'v', 'Content-Type': 'text/plain' } })).headers).toEqual({
      'X-Custom': 'v',
      'Content-Type': 'text/plain',
    });
  });

  it('sends a header literally named __proto__ instead of swallowing it (issue #107)', async () => {
    // On a plain object `out[name] = value` hits the prototype setter for this one name and the
    // header disappears with no error. Only reachable when the headers came from JSON.parse — an
    // object literal never creates the own property in the first place.
    const headers = JSON.parse('{"__proto__":"x","X-A":"1"}') as Record<string, string>;
    const wire = (await serveWire({ headers })).headers;
    expect(JSON.stringify(wire)).toContain('"__proto__":"x"');
    expect(JSON.stringify(wire)).toContain('"X-A":"1"');
  });

  it('rejects a function or symbol in the body rather than dropping it (issue #106)', async () => {
    // Sharing the wire-model replacer tightened this path: JSON.stringify used to drop a
    // function-valued key outright and null one inside an array. Pinned so a future refactor of
    // toBody() cannot quietly restore the silent-drop behaviour.
    await serveRejects({ body: { cb: (() => 1) as never } });
    await serveRejects({ body: [1, (() => 1) as never] });
    await serveRejects({ body: { s: Symbol('x') as never } });
  });

  it('rejects an undefined element in a body array rather than serving it as null (issue #119)', async () => {
    // toBody() is a second, independent caller of the shared replacer, so pin the guard here too:
    // a future refactor that pre-processed the body before serializing would restore the silent
    // null on this path alone and the addRule() test would still pass.
    await serveRejects({ body: [1, undefined as never] });
    // A body OBJECT property stays droppable — that is the omitted-optional contract, not the bug.
    expect(await serveWire({ body: { a: 1, b: undefined as never } })).toMatchObject({
      body: JSON.stringify({ a: 1 }),
    });
  });
});

describe('issue #111 — addRule() refuses values JSON cannot represent', () => {
  /** A rule the engine would accept — the byte-identity baseline. */
  const validRule = (): InterceptRule => ({
    host: 'x.example.com',
    action: { serve: { statusCode: 200 } },
  });

  async function addRuleRejects(rule: InterceptRule | InterceptRule[]): Promise<void> {
    const fake = new FakeInterceptBackend();
    const { engine } = engineOf(fake);
    const handle = await engine.intercept();
    await expect(handle.addRule(rule)).rejects.toThrow(InvalidDefinition);
    // The point of the guard is that nothing reaches the wire — a rule that threw but was still
    // posted would be the silent-null bug wearing an error message.
    expect(fake.addRulesCalls).toEqual([]);
  }

  it('rejects a non-finite number in a predicate instead of nulling it on the wire', async () => {
    const fake = new FakeInterceptBackend();
    const { engine } = engineOf(fake);
    const handle = await engine.intercept();
    await expect(
      handle.serve([{ equals: { count: NaN } }], { statusCode: 200 })
    ).rejects.toThrow(InvalidDefinition);
    expect(fake.addRulesCalls).toEqual([]);
  });

  it('rejects non-finite predicate values on forward() too', async () => {
    const fake = new FakeInterceptBackend();
    const { engine } = engineOf(fake);
    const handle = await engine.intercept();
    await expect(handle.forward([{ equals: { n: Infinity } }], 7777)).rejects.toThrow(
      InvalidDefinition
    );
    expect(fake.addRulesCalls).toEqual([]);
  });

  it('rejects a non-finite statusCode handed to the addRule() escape hatch', async () => {
    // serve() screens this via toStatusCode(); addRule() is documented as verbatim, so before this
    // guard a NaN here reached the engine as `"statusCode": null`.
    await addRuleRejects({ host: 'x.example.com', action: { serve: { statusCode: NaN } } });
    await addRuleRejects({ host: 'x.example.com', action: { serve: { statusCode: Infinity } } });
    await addRuleRejects({ host: 'x.example.com', action: { serve: { statusCode: -Infinity } } });
  });

  it('rejects an undefined element in a rule array instead of sending it as null (issue #119)', async () => {
    // The issue's motivating shape: an untyped or JSON.parse-derived caller hands addRule() an
    // array with a hole. JSON.stringify nulls an undefined ELEMENT (unlike a property, which it
    // drops), so before this guard the engine received a rule the caller never wrote.
    const valid = { host: 'x.example.com', action: { serve: { statusCode: 200 } } };
    await addRuleRejects([valid, undefined] as unknown as InterceptRule[]);

    // The wrapping keeps the replacer's own error reachable (issue #121), so a caller can tell
    // this apart from any other InvalidDefinition without parsing the message.
    const fake = new FakeInterceptBackend();
    const { engine } = engineOf(fake);
    const handle = await engine.intercept();
    const caught = await handle.addRule([valid, undefined] as unknown as InterceptRule[]).catch((e: unknown) => e);
    expect((caught as InvalidDefinition).cause).toBeInstanceOf(WireValidationError);
  });

  it('rejects a non-finite value nested inside and/or/not predicate combinators', async () => {
    // The replacer recurses, but `and`/`or`/`not` are the shapes a real caller nests into — pinned
    // so a future guard that only walks top-level predicate fields fails here.
    await addRuleRejects({
      action: { serve: { statusCode: 200 } },
      predicates: [{ and: [{ equals: { a: 1 } }, { equals: { deep: NaN } }] }],
    });
    await addRuleRejects({
      action: { serve: { statusCode: 200 } },
      predicates: [{ not: { equals: { deep: Infinity } } }],
    });
    await addRuleRejects({
      action: { serve: { statusCode: 200 } },
      predicates: [{ or: [{ equals: { deep: NaN } }] }],
    });
  });

  it('rejects function and symbol values, which JSON.stringify would drop silently', async () => {
    // jsonSafeReplacer refuses function/bigint/symbol in one condition; without a test for each,
    // narrowing that condition to bigint alone would ship unnoticed and restore the silent drop.
    await addRuleRejects({
      host: 'x.example.com',
      action: { serve: { statusCode: 200 } },
      predicates: [{ equals: { cb: (() => 1) as never } }],
    });
    await addRuleRejects({
      host: 'x.example.com',
      action: { serve: { statusCode: 200 } },
      predicates: [{ equals: { s: Symbol('x') as never } }],
    });
  });

  it('rejects a bigint with a typed error rather than a raw TypeError', async () => {
    const rule = {
      host: 'x.example.com',
      action: { serve: { statusCode: 200, body: 1n as never } },
    } as unknown as InterceptRule;
    const fake = new FakeInterceptBackend();
    const { engine } = engineOf(fake);
    const handle = await engine.intercept();
    const thrown = await handle.addRule(rule).catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(InvalidDefinition);
    expect(thrown).not.toBeInstanceOf(TypeError);
    expect(fake.addRulesCalls).toEqual([]);
  });

  it('names the offending key and preserves the WireValidationError as cause', async () => {
    const rule = {
      host: 'x.example.com',
      action: { serve: { statusCode: 200 } },
      predicates: [{ equals: { temperature: NaN } }],
    } as unknown as InterceptRule;
    const fake = new FakeInterceptBackend();
    const { engine } = engineOf(fake);
    const handle = await engine.intercept();
    const thrown = (await handle.addRule(rule).catch((e: unknown) => e)) as InvalidDefinition;
    expect(thrown).toBeInstanceOf(InvalidDefinition);
    expect(thrown.message).toMatch(/temperature/);
    expect((thrown as { cause?: unknown }).cause).toBeInstanceOf(WireValidationError);
  });

  it('rejects an array argument if any rule in it is unserializable', async () => {
    await addRuleRejects([
      { host: 'ok.example.com', action: { serve: { statusCode: 200 } } },
      { host: 'bad.example.com', action: { serve: { statusCode: NaN } } },
    ]);
  });

  it('leaves a valid rule byte-identical to the unguarded serialization', async () => {
    const fake = new FakeInterceptBackend();
    const { engine } = engineOf(fake);
    const handle = await engine.intercept();
    const rule = validRule();
    await handle.addRule(rule);
    expect(fake.addRulesCalls[0]).toBe(JSON.stringify([rule]));
  });
});

describe('issue #11 — InterceptHandle surface', () => {
  it('rules() parses the backend JSON array', async () => {
    const fake = new FakeInterceptBackend();
    fake.listResult = JSON.stringify([{ host: 'a', action: { serve: { statusCode: 200 } } }]);
    const { engine } = engineOf(fake);
    const handle = await engine.intercept();
    expect(await handle.rules()).toEqual([{ host: 'a', action: { serve: { statusCode: 200 } } }]);
  });

  it('clearRules() delegates to the backend', async () => {
    const fake = new FakeInterceptBackend();
    const { engine } = engineOf(fake);
    const handle = await engine.intercept();
    await handle.clearRules();
    expect(fake.clearCalls).toBe(1);
  });

  it('caPem() returns the backend PEM verbatim', async () => {
    const fake = new FakeInterceptBackend();
    const { engine } = engineOf(fake);
    const handle = await engine.intercept();
    expect(await handle.caPem()).toBe(fake.caPemResult);
  });

  it('caFile() writes the PEM to a tmp dir and returns the path', async () => {
    const fake = new FakeInterceptBackend();
    const { engine } = engineOf(fake);
    const handle = await engine.intercept();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rift-intercept-test-'));
    try {
      const file = await handle.caFile(dir);
      expect(file.startsWith(dir)).toBe(true);
      expect(await fs.readFile(file, 'utf8')).toBe(fake.caPemResult);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('caFile() defaults to os.tmpdir() when no dir is given', async () => {
    const fake = new FakeInterceptBackend();
    const { engine } = engineOf(fake);
    const handle = await engine.intercept();
    const file = await handle.caFile();
    try {
      expect(file.startsWith(os.tmpdir())).toBe(true);
      expect(await fs.readFile(file, 'utf8')).toBe(fake.caPemResult);
    } finally {
      await fs.rm(file, { force: true });
    }
  });

  it('exportTruststore() forwards format/path and defaults password to "changeit"', async () => {
    const fake = new FakeInterceptBackend();
    const { engine } = engineOf(fake);
    const handle = await engine.intercept();
    await handle.exportTruststore({ format: 'pkcs12', path: '/tmp/x.p12' });
    expect(fake.exportCalls).toEqual([{ format: 'pkcs12', password: 'changeit', outPath: '/tmp/x.p12' }]);

    await handle.exportTruststore({ format: 'jks', path: '/tmp/x.jks', password: 'secret' });
    expect(fake.exportCalls[1]).toEqual({ format: 'jks', password: 'secret', outPath: '/tmp/x.jks' });
  });

  it('env() returns HTTPS_PROXY/HTTP_PROXY/NODE_EXTRA_CA_CERTS with a real CA file path', async () => {
    const fake = new FakeInterceptBackend();
    const { engine } = engineOf(fake);
    const handle = await engine.intercept();
    const env = await handle.env();
    expect(env['HTTPS_PROXY']).toBe(handle.url);
    expect(env['HTTP_PROXY']).toBe(handle.url);
    expect(typeof env['NODE_EXTRA_CA_CERTS']).toBe('string');
    expect(await fs.readFile(env['NODE_EXTRA_CA_CERTS'] as string, 'utf8')).toBe(fake.caPemResult);
    await fs.rm(env['NODE_EXTRA_CA_CERTS'] as string, { force: true });
  });
});

describe('issue #11 — embedded transport: start, memoize, "already started"', () => {
  it('intercept() starts via the backend and exposes {port, url} from its result', async () => {
    const fake = new FakeInterceptBackend();
    const { engine } = engineOf(fake);
    const handle = await engine.intercept({ host: '127.0.0.1' });
    expect(handle.port).toBe(6800);
    expect(handle.url).toBe('http://127.0.0.1:6800');
    expect(JSON.parse(fake.startCalls[0] as string)).toEqual({ host: '127.0.0.1' });
  });

  it('refuses a non-finite intercept port instead of starting on a null one (issue #112)', async () => {
    // A null port reaches the embedded FFI as a started-looking handle, and leaves the remote/spawn
    // backend building the url `http://host:null`.
    const fake = new FakeInterceptBackend();
    const { engine } = engineOf(fake);
    await expect(engine.intercept({ port: NaN })).rejects.toThrow(WireValidationError);
    expect(fake.startCalls).toEqual([]);
  });

  it('a second call without options returns the memoized handle (no second backend start)', async () => {
    const fake = new FakeInterceptBackend();
    const { engine } = engineOf(fake);
    const first = await engine.intercept();
    const second = await engine.intercept();
    expect(second).toBe(first);
    expect(fake.startCalls).toHaveLength(1);
  });

  it('a second call WITH options throws InterceptUnavailable("intercept already started")', async () => {
    const fake = new FakeInterceptBackend();
    const { engine } = engineOf(fake);
    await engine.intercept();
    await expect(engine.intercept({ port: 1 })).rejects.toThrow(InterceptUnavailable);
    await expect(engine.intercept({ port: 1 })).rejects.toThrow('intercept already started');
  });

  it('embedded with no wired backend throws InterceptUnavailable', async () => {
    const engine = new Engine(noopAdmin(), 'embedded', {});
    await expect(engine.intercept()).rejects.toThrow(InterceptUnavailable);
  });

  it('caCertPath without caKeyPath (and vice versa) throws InvalidDefinition', async () => {
    const fake = new FakeInterceptBackend();
    const { engine } = engineOf(fake);
    await expect(engine.intercept({ caCertPath: '/c.pem' })).rejects.toThrow(InvalidDefinition);
    const { engine: engine2 } = engineOf(new FakeInterceptBackend());
    await expect(engine2.intercept({ caKeyPath: '/k.pem' })).rejects.toThrow(InvalidDefinition);
  });
});

describe('issue #11 — spawn transport availability + attach', () => {
  function mockFetch(response: Response): jest.Mock {
    const fn = jest.fn(async () => response);
    // @ts-expect-error override global for the test
    globalThis.fetch = fn;
    return fn as unknown as jest.Mock;
  }

  it('without the spawn-time flag: InterceptUnavailable("pass intercept: true to rift.spawn(...)")', async () => {
    const engine = new Engine(noopAdmin('http://127.0.0.1:2525'), 'spawn', {});
    await expect(engine.intercept()).rejects.toThrow(InterceptUnavailable);
    await expect(engine.intercept()).rejects.toThrow('pass intercept: true to rift.spawn(...)');
  });

  it('with the spawn-time flag: attaches using the pre-resolved {host, port}', async () => {
    mockFetch(new Response('[]', { status: 200 }));
    const engine = new Engine(connect('http://127.0.0.1:2525'), 'spawn', {
      interceptSpawn: { host: '127.0.0.1', port: 6900 },
    });
    const handle = await engine.intercept();
    expect(handle.port).toBe(6900);
    expect(handle.url).toBe('http://127.0.0.1:6900');
  });

  it('flag passed but engine has no intercept listener (404) → actionable InterceptUnavailable, not a raw 404', async () => {
    mockFetch(new Response(JSON.stringify({ errors: [{ message: 'not found' }] }), { status: 404 }));
    const engine = new Engine(connect('http://127.0.0.1:2525'), 'spawn', {
      interceptSpawn: { host: '127.0.0.1', port: 6900 },
    });
    await expect(engine.intercept()).rejects.toThrow(InterceptUnavailable);
    mockFetch(new Response(JSON.stringify({ errors: [{ message: 'not found' }] }), { status: 404 }));
    await expect(engine.intercept()).rejects.toThrow('did not start an intercept listener');
  });
});

describe('issue #11 — remote transport: attach-only probe', () => {
  function mockFetch(response: Response): jest.Mock {
    const fn = jest.fn(async () => response);
    // @ts-expect-error override global for the test
    globalThis.fetch = fn;
    return fn as unknown as jest.Mock;
  }

  it('404 on GET /intercept/rules → InterceptUnavailable("the Rift server must be started with --intercept-port")', async () => {
    mockFetch(new Response(JSON.stringify({ errors: [{ message: 'not found' }] }), { status: 404 }));
    const engine = new Engine(connect('http://localhost:2525'), 'remote', {});
    await expect(engine.intercept()).rejects.toThrow(InterceptUnavailable);
    mockFetch(new Response(JSON.stringify({ errors: [{ message: 'not found' }] }), { status: 404 }));
    await expect(engine.intercept()).rejects.toThrow('the Rift server must be started with --intercept-port');
  });

  it('admin URL with no explicit port → InterceptUnavailable (no silent :0), unless a port is passed', async () => {
    mockFetch(new Response('[]', { status: 200 }));
    const engine = new Engine(connect('https://api.example.com'), 'remote', {});
    await expect(engine.intercept()).rejects.toThrow(InterceptUnavailable);
    mockFetch(new Response('[]', { status: 200 }));
    await expect(engine.intercept()).rejects.toThrow('needs an explicit port');
    // ...but an explicit port makes it attachable.
    mockFetch(new Response('[]', { status: 200 }));
    const engine2 = new Engine(connect('https://api.example.com'), 'remote', {});
    const handle = await engine2.intercept({ port: 8443 });
    expect(handle.port).toBe(8443);
  });

  it('200 on GET /intercept/rules → attaches (defaults the port to the admin port)', async () => {
    mockFetch(new Response('[]', { status: 200 }));
    const engine = new Engine(connect('http://localhost:2525'), 'remote', {});
    const handle = await engine.intercept();
    expect(handle.port).toBe(2525);
    expect(handle.url).toBe('http://localhost:2525');
  });

  it('an explicit options.port overrides the admin-port fallback', async () => {
    mockFetch(new Response('[]', { status: 200 }));
    const engine = new Engine(connect('http://localhost:2525'), 'remote', {});
    const handle = await engine.intercept({ port: 9999 });
    expect(handle.port).toBe(9999);
    expect(handle.url).toBe('http://localhost:9999');
  });
});

describe('issue #11 — RemoteClient intercept HTTP routes (mocked fetch)', () => {
  type FetchArgs = { url: string; method: string; body: unknown };

  function mockFetch(response: Response): jest.Mock {
    const fn = jest.fn(async () => response);
    // @ts-expect-error override global for the test
    globalThis.fetch = fn;
    return fn as unknown as jest.Mock;
  }

  function lastCall(fn: jest.Mock): FetchArgs {
    const [url, init] = fn.mock.calls[fn.mock.calls.length - 1] as [string, RequestInit];
    return {
      url,
      method: (init?.method ?? 'GET').toUpperCase(),
      body: init?.body !== undefined ? JSON.parse(init.body as string) : undefined,
    };
  }

  const BASE = 'http://localhost:2525';

  it('interceptAddRules → POST /intercept/rules with the parsed rules array', async () => {
    const fn = mockFetch(new Response('', { status: 200 }));
    const rule: InterceptRule = { host: 'a', action: { serve: { statusCode: 200 } } };
    await connect(BASE).interceptAddRules(JSON.stringify([rule]));
    const call = lastCall(fn);
    expect(call.method).toBe('POST');
    expect(call.url).toBe(`${BASE}/intercept/rules`);
    expect(call.body).toEqual([rule]);
  });

  it('interceptListRules → GET /intercept/rules, returns a JSON string', async () => {
    const rule: InterceptRule = { host: 'a', action: { serve: { statusCode: 200 } } };
    const fn = mockFetch(new Response(JSON.stringify([rule]), { status: 200 }));
    const raw = await connect(BASE).interceptListRules();
    expect(JSON.parse(raw)).toEqual([rule]);
    expect(lastCall(fn)).toMatchObject({ method: 'GET', url: `${BASE}/intercept/rules` });
  });

  it('interceptClearRules → DELETE /intercept/rules', async () => {
    const fn = mockFetch(new Response('', { status: 200 }));
    await connect(BASE).interceptClearRules();
    expect(lastCall(fn)).toMatchObject({ method: 'DELETE', url: `${BASE}/intercept/rules` });
  });

  it('interceptCaPem → GET /intercept/ca.pem, returns raw text', async () => {
    const fn = mockFetch(new Response('-----BEGIN CERTIFICATE-----\nX\n-----END CERTIFICATE-----\n', { status: 200 }));
    const pem = await connect(BASE).interceptCaPem();
    expect(pem).toContain('BEGIN CERTIFICATE');
    expect(lastCall(fn)).toMatchObject({ method: 'GET', url: `${BASE}/intercept/ca.pem` });
  });

  it('interceptExportTruststore → GET /intercept/truststore.<format>?password=..., writes the file', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const fn = mockFetch(new Response(bytes, { status: 200 }));
    const outPath = path.join(os.tmpdir(), `rift-intercept-truststore-test-${Date.now()}.p12`);
    try {
      await connect(BASE).interceptExportTruststore('p12', 'changeit', outPath);
      expect(lastCall(fn)).toMatchObject({
        method: 'GET',
        url: `${BASE}/intercept/truststore.p12?password=changeit`,
      });
      expect(await fs.readFile(outPath)).toEqual(Buffer.from(bytes));
    } finally {
      await fs.rm(outPath, { force: true });
    }
  });
});

describe('issue #11 — buildSpawnArgs intercept flag', () => {
  it('intercept: true → --intercept-port 0 (engine-ephemeral, no CA flags)', () => {
    expect(buildSpawnArgs(2525, { intercept: true })).toEqual(['--port', '2525', '--intercept-port', '0']);
  });

  it('intercept: {port} → --intercept-port <port>', () => {
    expect(buildSpawnArgs(2525, { intercept: { port: 4444 } })).toEqual([
      '--port',
      '2525',
      '--intercept-port',
      '4444',
    ]);
  });

  it('intercept with both CA paths → adds --intercept-ca-cert/--intercept-ca-key', () => {
    expect(
      buildSpawnArgs(2525, {
        intercept: { port: 4444, caCertPath: '/ca.pem', caKeyPath: '/ca-key.pem' },
      })
    ).toEqual([
      '--port',
      '2525',
      '--intercept-port',
      '4444',
      '--intercept-ca-cert',
      '/ca.pem',
      '--intercept-ca-key',
      '/ca-key.pem',
    ]);
  });

  it('only one CA path given → throws InvalidDefinition (never silently drops the caller CA)', () => {
    expect(() => buildSpawnArgs(2525, { intercept: { port: 4444, caCertPath: '/ca.pem' } })).toThrow(
      InvalidDefinition
    );
    expect(() => buildSpawnArgs(2525, { intercept: { caKeyPath: '/ca-key.pem' } })).toThrow(
      InvalidDefinition
    );
  });

  it('no intercept option → no intercept flags at all', () => {
    expect(buildSpawnArgs(2525, {})).toEqual(['--port', '2525']);
  });
});

describe('issue #11 — interceptDispatcher (injected proxyAgentFactory; undici not installed here)', () => {
  it('builds { uri, requestTls: { ca }, proxyTls: {} } and hands it to the factory', async () => {
    const fake = new FakeInterceptBackend();
    const { engine } = engineOf(fake);
    const handle = await engine.intercept();

    let seen: ProxyAgentConfig | undefined;
    const sentinel = { dispatcher: true };
    const result = await interceptDispatcher(handle, {
      proxyAgentFactory: (config) => {
        seen = config;
        return sentinel;
      },
    });

    expect(result).toBe(sentinel);
    expect(seen).toEqual({ uri: handle.url, requestTls: { ca: fake.caPemResult }, proxyTls: {} });
  });

  it('without a proxyAgentFactory and without undici installed, rejects with a clear message', async () => {
    const fake = new FakeInterceptBackend();
    const { engine } = engineOf(fake);
    const handle = await engine.intercept();
    await expect(interceptDispatcher(handle)).rejects.toThrow(/undici/i);
  });
});
