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
import { InterceptUnavailable, InvalidDefinition, WireValidationError, ImposterNotFound } from '../../src/errors.js';
import type { InterceptRule, IsResponse, JsonValue, ServeStub } from '../../src/model/index.js';
import type { InterceptBackend } from '../../src/intercept/types.js';
import { buildSpawnArgs } from '../../src/spawn/index.js';
import { connect } from '../../src/remote/client.js';
import { interceptDispatcher, type ProxyAgentConfig } from '../../src/intercept-undici.js';

/** U+0085 (NEL): whitespace to Rust's `str::trim`, not to JavaScript's. Written as an escape
 * because the literal character is invisible in an editor. */
const NEL = '\u0085';

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
    // A latency() is a `_behaviors.wait` the serve action cannot carry, so it is refused rather
    // than quietly served without the delay (issue #131) — it used to resolve.
    await expect(handle.serve('x.example.com', created().latency(10))).rejects.toThrow(InvalidDefinition);
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

  it('stringifies an object body — key order follows the caller, the engine would sort it', async () => {
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

  it('sends a multi-value header as an array — one line per value on engine >= 0.18.0 (issue #144)', async () => {
    expect(await serveWire({ headers: { 'Set-Cookie': ['a=1', 'b=2'], 'X-One': ['only'] } })).toEqual({
      headers: { 'Set-Cookie': ['a=1', 'b=2'], 'X-One': ['only'] },
    });
  });

  it('rules() reads array headers and an object body back typed (issue #144)', async () => {
    const fake = new FakeInterceptBackend();
    fake.listResult = JSON.stringify([
      { host: 'x.example.com', action: { serve: { statusCode: 200, headers: { 'Set-Cookie': ['a=1', 'b=2'] }, body: { a: 1 } } } },
    ]);
    const { engine } = engineOf(fake);
    const handle = await engine.intercept();
    const [rule] = await handle.rules();
    const serve = (rule?.action as { serve: ServeStub }).serve;
    const cookies: string | string[] | undefined = serve.headers?.['Set-Cookie'];
    expect(cookies).toEqual(['a=1', 'b=2']);
    const body: JsonValue | null | undefined = serve.body;
    expect(body).toEqual({ a: 1 });
  });

  it('refuses a case-variant duplicate name — the json()+header() back door (issue #144)', async () => {
    // `json()` pre-sets `Content-Type`; a lowercase re-set used to pass and the engine served the
    // header twice, which is exactly the multi-value outcome the SDK refused to allow explicitly.
    const fake = new FakeInterceptBackend();
    const { engine } = engineOf(fake);
    const handle = await engine.intercept();
    const attempt = handle.serve('x.example.com', okJson({ a: 1 }).header('content-type', 'text/plain'));
    await expect(attempt).rejects.toThrow(InvalidDefinition);
    await expect(attempt).rejects.toThrow(/`content-type` is already given as `Content-Type`/);
    expect(fake.addRulesCalls).toHaveLength(0);
  });

  it('refuses three spellings with one report naming the first collision (issue #144)', async () => {
    const fake = new FakeInterceptBackend();
    const { engine } = engineOf(fake);
    const handle = await engine.intercept();
    const attempt = handle.serve('x.example.com', { headers: { 'X-A': '1', 'X-Other': '2', 'x-a': '3', 'X-a': '4' } });
    await expect(attempt).rejects.toThrow(/`x-a` is already given as `X-A`/);
    await expect(attempt).rejects.not.toThrow(/X-a/);
  });

  it('names the first-seen casing when the lowercase spelling came first (issue #144)', async () => {
    const fake = new FakeInterceptBackend();
    const { engine } = engineOf(fake);
    const handle = await engine.intercept();
    await expect(handle.serve('x.example.com', { headers: { 'x-a': '1', 'X-A': '2' } })).rejects.toThrow(
      /`X-A` is already given as `x-a`/
    );
  });

  it('refuses an invalid header name the engine would skip with only a log line (issue #144)', async () => {
    await serveRejects({ headers: { 'X Bad': '1' } });
    await serveRejects({ headers: { ' x': '1' } });
    await serveRejects({ headers: { 'x:y': '1' } });
    await serveRejects({ headers: { '': '1' } });
  });

  it('refuses a non-string array element and an empty array (issue #144)', async () => {
    await serveRejects({ headers: { 'X-A': ['a', 1] as unknown as string[] } });
    await serveRejects({ headers: { 'X-A': [] } });
  });

  it('refuses a control character in a value but allows HTAB (issue #144)', async () => {
    await serveRejects({ headers: { 'X-A': 'a\u0000b' } });
    await serveRejects({ headers: { 'X-A': ['ok', 'bad\u007f'] } });
    await serveRejects({ headers: { 'X-A': 'split\r\nInjected: yes' } });
    expect(await serveWire({ headers: { 'X-A': 'a\tb' } })).toEqual({ headers: { 'X-A': 'a\tb' } });
  });

  it('refuses an engine-managed name inside an array-valued entry too (issue #144)', async () => {
    await serveRejects({ headers: { Connection: ['close', 'keep-alive'] } });
  });

  it('rejects binary mode rather than serving the base64 as literal text', async () => {
    await serveRejects(ok().binaryBody(Buffer.from([0, 1, 2])));
    await serveRejects({ _mode: 'binary', body: 'AAEC' });
  });

  it("drops _mode:'text' and does not mutate the caller's response", async () => {
    // `_mode:'text'` is the one key that is genuinely droppable — it is the engine's only mode, so
    // removing it changes nothing that would be served. A `_behaviors` block is NOT droppable and
    // now rejects (issue #131), so it is no longer part of this case.
    const response: IsResponse = { statusCode: 200, body: 'hi', _mode: 'text' };
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

  // --- issue #131: constructs the serve action cannot deliver ---

  /** The InvalidDefinition message from a rejected serve(), for asserting on what it NAMES. */
  async function serveError(response: ResponseBuilder | IsResponse): Promise<string> {
    const fake = new FakeInterceptBackend();
    const { engine } = engineOf(fake);
    const handle = await engine.intercept();
    const caught = await handle.serve('x.example.com', response).catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(InvalidDefinition);
    return (caught as InvalidDefinition).message;
  }

  it('rejects every _behaviors key, naming it and the DSL method that set it (issue #131)', async () => {
    const cases: Array<[ResponseBuilder, string, string]> = [
      [ok('x').latency(10), '_behaviors.wait', 'latency()'],
      [ok('x').repeat(2), '_behaviors.repeat', 'repeat()'],
      [ok('x').decorate('(r) => r'), '_behaviors.decorate', 'decorate()'],
      [ok('x').shellTransform('cat'), '_behaviors.shellTransform', 'shellTransform()'],
      [ok('x').copy({ from: 'path', into: '${p}', using: { method: 'regex', selector: '.' } }), '_behaviors.copy', 'copy()'],
      [ok('x').lookup({ key: { from: 'q', using: { method: 'regex', selector: '.' } }, fromDataSource: { csv: { path: 'p', keyColumn: 'k' } }, into: '${x}' }), '_behaviors.lookup', 'lookup()'],
    ];
    for (const [builder, wireKey, method] of cases) {
      const message = await serveError(builder);
      expect(message).toContain(wireKey);
      expect(message).toContain(method);
    }
  });

  it('rejects an unknown _behaviors key set through behavior() (issue #131)', async () => {
    // `behavior()` is the open escape hatch, so the guard cannot work off a fixed key list alone.
    expect(await serveError(ok('x').behavior({ someFutureBehavior: 1 }))).toContain('_behaviors.someFutureBehavior');
  });

  it('rejects every _rift extension, naming it and its DSL method (issue #131)', async () => {
    const { Fault } = await import('../../src/dsl/fault.js');
    expect(await serveError(ok('x').templated())).toContain('_rift.templated');
    expect(await serveError(ok('x').templated())).toContain('templated()');
    expect(await serveError(ok('x').script({ code: 'return 1' }))).toContain('_rift.script');
    expect(await serveError(ok('x').script({ code: 'return 1' }))).toContain('script()');
    expect(await serveError(ok('x').incrementState('hits'))).toContain('_rift.stateOps');
    expect(await serveError(ok('x').incrementState('hits'))).toContain('stateOps()');
    // The fault family carries a method annotation too — that is the whole "name the caller's own
    // spelling" guarantee, so assert it here and not only the wire key.
    expect(await serveError(ok('x').withFault(Fault.latency(50)))).toContain('_rift.fault.latency');
    expect(await serveError(ok('x').withFault(Fault.latency(50)))).toContain('withFault(');
    expect(await serveError(ok('x').withFault(Fault.error({ status: 500 })))).toContain('_rift.fault.error');
    expect(await serveError(ok('x').withFault(Fault.error({ status: 500 })))).toContain('withFault(');
    expect(await serveError(ok('x').withFault(Fault.tcp('reset')))).toContain('_rift.fault.tcp');
    expect(await serveError(ok('x').withFault(Fault.tcp('reset')))).toContain('withFault(');
    // The legacy fault() spelling lands in the same _rift.fault.tcp slot.
    expect(await serveError(ok('x').fault('reset'))).toContain('_rift.fault.tcp');
  });

  it('names EVERY offender in one error rather than the first one found (issue #131)', async () => {
    // First-wins would send a caller round the loop once per construct, each time reporting a rule
    // they had already been told was unusable.
    const message = await serveError(ok('x').latency(10).repeat(2).templated().script({ code: 'return 1' }));
    for (const named of ['_behaviors.wait', '_behaviors.repeat', '_rift.templated', '_rift.script']) {
      expect(message).toContain(named);
    }
  });

  it('points at redirectTo() and explains why, matching the sibling SDKs (issue #131)', async () => {
    const message = await serveError(ok('x').latency(10));
    expect(message).toContain('intercept serve cannot deliver');
    expect(message).toContain('statusCode, headers and body');
    expect(message).toContain('redirectTo(imposter)');
  });

  it('rejects the same constructs inside a raw IsResponse literal (issue #131)', async () => {
    // The literal path never went through ResponseBuilder, so it needs its own guard — these used to
    // be dropped as unknown keys.
    expect(await serveError({ statusCode: 200, _behaviors: { wait: 5 } })).toContain('_behaviors.wait');
    expect(await serveError({ statusCode: 200, _rift: { templated: true } })).toContain('_rift.templated');
    expect(await serveError({ statusCode: 200, _rift: { fault: { tcp: 'reset' } } })).toContain('_rift.fault.tcp');
  });

  it('rejects an unknown key rather than dropping it (issue #131)', async () => {
    // Top level, via raw() — the whole patch used to vanish.
    expect(await serveError(ok('x').raw({ bogusTopLevel: 1 } as never))).toContain('bogusTopLevel');
    // Inside the is literal.
    expect(await serveError({ statusCode: 200, bogusIsKey: 1 } as never)).toContain('bogusIsKey');
  });

  it('still serves a plain response, and leaves forward()/redirectTo() untouched (issue #131)', async () => {
    expect(await serveWire(ok('hi').header('X-A', 'b'))).toEqual({
      statusCode: 200,
      headers: { 'X-A': 'b' },
      body: 'hi',
    });
    const fake = new FakeInterceptBackend();
    const { engine } = engineOf(fake);
    const handle = await engine.intercept();
    await expect(handle.forward('a.example.com', 4545)).resolves.toBeUndefined();
    await expect(handle.redirectTo({ port: 4545 } as ImposterHandle)).resolves.toBeUndefined();
  });

  it('refuses a _behaviors/_rift block that is not an object, instead of letting it through', async () => {
    // The guard walks a block's own keys, and a NON-object has none — `Object.keys(Object(false))`,
    // `Object.keys(Object(5))` and `Object.keys(new Map([['wait',10]]))` are all `[]`. Walking those
    // reported nothing and served the response silently, which is the very drop this guard exists to
    // stop. `_behaviors: cond && behaviours` collapsing to `false` is the ordinary way to write it.
    for (const bad of [false, 5, 'abc', ['a'], new Map([['wait', 10]]), null]) {
      expect(await serveError({ statusCode: 200, _behaviors: bad } as never)).toContain('_behaviors');
      expect(await serveError({ statusCode: 200, _rift: bad } as never)).toContain('_rift');
      expect(await serveError({ statusCode: 200, _rift: { fault: bad } } as never)).toContain('_rift.fault');
    }
  });

  it('names a malformed block whole rather than enumerating its characters', async () => {
    // The string case used to produce `_behaviors.0`, `_behaviors.1`, `_behaviors.2` — loud, but
    // nonsense to act on.
    const message = await serveError({ statusCode: 200, _behaviors: 'abc' } as never);
    expect(message).toContain('`_behaviors`');
    expect(message).not.toContain('_behaviors.0');
  });

  it('treats an absent or explicitly-undefined block as nothing to deliver (issue #131)', async () => {
    // `_behaviors: {}` carries no behaviour, and an `undefined` property is dropped by JSON.stringify
    // anyway — neither loses anything, so neither may be refused (an optional spread produces both).
    expect(await serveWire({ statusCode: 200, _behaviors: {} } as never)).toEqual({ statusCode: 200 });
    expect(await serveWire({ statusCode: 200, _behaviors: undefined, _rift: undefined } as never)).toEqual({
      statusCode: 200,
    });
  });

  it('refuses a non-object response with InvalidDefinition, not a raw TypeError (issue #131)', async () => {
    // `null` used to escape as `TypeError: Cannot read properties of null`, breaking serve()'s
    // InvalidDefinition-only error contract (issue #101); a string registered an empty `serve: {}`.
    for (const bad of [null, 'hello', 42]) {
      expect(await serveError(bad as never)).toContain('must be an object');
    }
    expect(await serveError(ok('x').raw({ is: 'oops' } as never))).toContain('must be an object');
  });

  it('names offenders from every level in one error (issue #131)', async () => {
    // All four branches of the traversal firing at once: a top-level raw() key, a behaviour, a _rift
    // extension, and an unknown key inside the is block.
    const message = await serveError(
      ok('x').latency(10).templated().raw({ bogusTop: 1, is: { statusCode: 200, bogusIs: 2 } } as never)
    );
    for (const named of ['bogusTop', '_behaviors.wait', '_rift.templated', 'bogusIs']) {
      expect(message).toContain(named);
    }
  });

  it('reports the undeliverable construct before the body-serialization guard (issue #131)', async () => {
    // Ordering is observable: the #131 guard runs before toServeStub/toBody, so a response with both
    // an undeliverable behaviour and an unserializable body names the behaviour.
    const message = await serveError({ statusCode: 200, body: new Set([1]), _behaviors: { wait: 5 } } as never);
    expect(message).toContain('_behaviors.wait');
  });

  it('rejects a Map or Set body instead of serving it as {} (issue #126)', async () => {
    await serveRejects({ body: new Set(['a', 'b']) as never });
    await serveRejects({ body: { hosts: new Map([['a', 1]]) } as never });
  });

  it('names the built-in type when it rejects such a body (issue #126)', async () => {
    const fake = new FakeInterceptBackend();
    const { engine } = engineOf(fake);
    const handle = await engine.intercept();
    await expect(handle.serve('x.example.com', { body: { hosts: new Set(['a']) } as never })).rejects.toThrow(
      /Set/
    );
  });

  it('passes a structured auth credential straight through to the engine (issue #124)', async () => {
    // The engine's InterceptStartOptions takes `auth: {username, password}` verbatim (camelCase,
    // deny_unknown_fields), so the option needs no transformation on the way out.
    const fake = new FakeInterceptBackend();
    const { engine } = engineOf(fake);
    await engine.intercept({ auth: { username: 'u', password: 'p' } });
    expect(JSON.parse(fake.startCalls[0] ?? '{}')).toMatchObject({
      auth: { username: 'u', password: 'p' },
    });
  });

  it('refuses a blank half on the runtime door too (issue #124)', async () => {
    const fake = new FakeInterceptBackend();
    const { engine } = engineOf(fake);
    await expect(engine.intercept({ auth: { username: '  ', password: 'p' } })).rejects.toThrow(
      InvalidDefinition
    );
    await expect(engine.intercept({ auth: { username: 'u', password: '' } })).rejects.toThrow(
      InvalidDefinition
    );
    // U+0085 is whitespace to Rust's str::trim but not to JavaScript's, so a JS-only blank check
    // would pass it and the engine would then refuse it itself (issue #116).
    await expect(engine.intercept({ auth: { username: NEL, password: 'p' } })).rejects.toThrow(
      InvalidDefinition
    );
  });

  it('refuses auth on the spawn and remote transports rather than dropping it (issue #124)', async () => {
    // Only the embedded backend actually starts a listener from these options. On spawn/remote,
    // RemoteInterceptBackend.startIntercept reads host+port off the JSON and discards the rest —
    // attach-only by design (issue #129) — so accepting `auth` here would hand back a
    // handle to an UNAUTHENTICATED MITM proxy while the caller believed it was guarded.
    for (const transport of ['spawn', 'remote'] as const) {
      const engine = new Engine(noopAdmin('http://127.0.0.1:2525'), transport, {
        ...(transport === 'spawn' ? { interceptSpawn: { host: '127.0.0.1', port: 6800 } } : {}),
      });
      const err = await engine
        .intercept({ auth: { username: 'u', password: 'p' } })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(InterceptUnavailable);
      // The message has to name the door that does work, or the caller is simply stuck.
      expect((err as Error).message).toMatch(/rift\.spawn/);
      // The engine has had POST /intercept since v0.13.0; the reason is attach-only by design.
      expect((err as Error).message).not.toMatch(/493/);
    }
  });

  it('refuses caCertPath/caKeyPath on spawn and remote, naming both and the spawn door (issue #129)', async () => {
    // A CA the engine never receives is the silent failure this issue was filed for: the handle
    // would look configured while traffic is signed by whatever CA the listener was started with.
    for (const transport of ['spawn', 'remote'] as const) {
      const engine = new Engine(noopAdmin('http://127.0.0.1:2525'), transport, {
        ...(transport === 'spawn' ? { interceptSpawn: { host: '127.0.0.1', port: 6800 } } : {}),
      });
      const err = await engine.intercept({ caCertPath: '/ca.pem', caKeyPath: '/ca.key' }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(InterceptUnavailable);
      expect((err as Error).message).toMatch(/caCertPath\/caKeyPath/);
      expect((err as Error).message).toMatch(/rift\.spawn\(\{ intercept: \{ caCertPath, caKeyPath, auth \} \}\)/);
      expect((err as Error).message).toMatch(/rift\.embedded\(\)/);
    }
  });

  it('refuses auth and the CA pair together with ONE error naming all of them (issue #129)', async () => {
    for (const transport of ['spawn', 'remote'] as const) {
      const engine = new Engine(noopAdmin('http://127.0.0.1:2525'), transport, {
        ...(transport === 'spawn' ? { interceptSpawn: { host: '127.0.0.1', port: 6800 } } : {}),
      });
      const err = await engine
        .intercept({ auth: { username: 'u', password: 'p' }, caCertPath: '/ca.pem', caKeyPath: '/ca.key' })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(InterceptUnavailable);
      expect((err as Error).message).toMatch(/auth and caCertPath\/caKeyPath/);
    }
  });

  it('embedded still forwards caCertPath/caKeyPath verbatim (issue #129)', async () => {
    const fake = new FakeInterceptBackend();
    const { engine } = engineOf(fake);
    await engine.intercept({ caCertPath: '/ca.pem', caKeyPath: '/ca.key', auth: { username: 'u', password: 'p' } });
    expect(JSON.parse(fake.startCalls[0] ?? '{}')).toMatchObject({ caCertPath: '/ca.pem', caKeyPath: '/ca.key' });
  });

  it('allows a colon in the username on the runtime door (issue #124)', async () => {
    // Only the spawn door is colon-joined into one env var; the JSON door carries the two halves
    // separately, so it must not inherit that restriction.
    const fake = new FakeInterceptBackend();
    const { engine } = engineOf(fake);
    await engine.intercept({ auth: { username: 'has:colon', password: 'p' } });
    expect(JSON.parse(fake.startCalls[0] ?? '{}')).toMatchObject({
      auth: { username: 'has:colon' },
    });
  });

  it('locates a bad body value by full path (issue #118)', async () => {
    // toBody() serializes the body as its OWN root, unlike addRule() where the rule is nested in an
    // array — so this call site exercises a distinct path-construction shape and gets its own pin.
    const fake = new FakeInterceptBackend();
    const { engine } = engineOf(fake);
    const handle = await engine.intercept();
    const caught = await handle
      .serve('x.example.com', { body: { readings: [1, { temperature: NaN }] } })
      .catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(InvalidDefinition);
    expect(((caught as InvalidDefinition).cause as WireValidationError).path).toBe(
      '$.readings[1].temperature'
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

  it('names which rule in the array carried the bad value (issue #118)', async () => {
    // The whole point of the issue: with three rules posted at once, "statusCode" alone forced the
    // caller to bisect by hand. addRule() is a second, independent caller of the replacer, so the
    // full locator has to reach this path too and not just toWireString()'s.
    const fake = new FakeInterceptBackend();
    const { engine } = engineOf(fake);
    const handle = await engine.intercept();
    const rules = [
      { host: 'a.example.com', action: { serve: { statusCode: 200 } } },
      { host: 'b.example.com', action: { serve: { statusCode: 200 } } },
      { host: 'c.example.com', action: { serve: { statusCode: NaN } } },
    ] as unknown as InterceptRule[];
    const caught = await handle.addRule(rules).catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(InvalidDefinition);
    expect((caught as InvalidDefinition).cause).toBeInstanceOf(WireValidationError);
    expect(((caught as InvalidDefinition).cause as WireValidationError).path).toBe(
      '$[2].action.serve.statusCode'
    );
    expect(fake.addRulesCalls).toEqual([]);
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

  it.each(['::1', '[::1]'])(
    'with the spawn-time flag on IPv6 host %s: the attached handle URL is bracketed (issue #143)',
    async (host) => {
      // `spawnEngine` hands over `new URL(url).hostname`, which keeps the brackets; a caller's own
      // `intercept({ host: '::1' })` is the bare form. Both must yield one dialable URL.
      mockFetch(new Response('[]', { status: 200 }));
      const engine = new Engine(connect('http://[::1]:2525'), 'spawn', {
        interceptSpawn: { host, port: 6901 },
      });
      const handle = await engine.intercept();
      expect(handle.port).toBe(6901);
      expect(handle.url).toBe('http://[::1]:6901');
    }
  );

  it('remote transport on an IPv6 admin URL: the attached handle URL is bracketed (issue #143)', async () => {
    // `#startRemoteIntercept` derives the host from the admin URL's `hostname`, which keeps the
    // brackets — a different path from the spawn-time `{host, port}` above.
    mockFetch(new Response('[]', { status: 200 }));
    const engine = new Engine(connect('http://[::1]:2525'), 'remote', {});
    const handle = await engine.intercept({ port: 6902 });
    expect(handle.port).toBe(6902);
    expect(handle.url).toBe('http://[::1]:6902');
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

  const status404 = () =>
    new Response(JSON.stringify({ errors: [{ message: 'intercept listener not running' }] }), { status: 404 });

  it('no port: GET /intercept 404 → InterceptUnavailable("the Rift server must be started with --intercept-port"), nothing else called', async () => {
    const fn = mockFetch(status404());
    const engine = new Engine(connect('http://localhost:2525'), 'remote', {});
    await expect(engine.intercept()).rejects.toThrow(InterceptUnavailable);
    mockFetch(status404());
    await expect(engine.intercept()).rejects.toThrow('the Rift server must be started with --intercept-port');
    expect(fn).toHaveBeenCalledTimes(1);
    expect((fn.mock.calls[0] as [string])[0]).toBe('http://localhost:2525/intercept');
  });

  it('no port: GET /intercept resolves the listener port; the handle uses the admin hostname, not the engine bind address (issue #129)', async () => {
    // The intercept listener never shares the admin port, so the old admin-port default was always
    // wrong. `GET /intercept` has reported the real port since engine v0.13.0; its `interceptUrl`
    // is the BIND address (0.0.0.0 here), which is not what a SUT can dial.
    const fn = mockFetch(new Response(JSON.stringify({ interceptPort: 8443, interceptUrl: 'http://0.0.0.0:8443' }), { status: 200 }));
    const engine = new Engine(connect('http://localhost:2525'), 'remote', {});
    const handle = await engine.intercept();
    expect(handle.port).toBe(8443);
    expect(handle.url).toBe('http://localhost:8443');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('no port on an IPv6 admin URL: the handle stays bracketed (issue #129)', async () => {
    mockFetch(new Response(JSON.stringify({ interceptPort: 8443, interceptUrl: 'http://[::]:8443' }), { status: 200 }));
    const engine = new Engine(connect('http://[::1]:2525'), 'remote', {});
    expect((await engine.intercept()).url).toBe('http://[::1]:8443');
  });

  it('no port: a malformed GET /intercept body is refused rather than attached (issue #129)', async () => {
    mockFetch(new Response('{}', { status: 200 }));
    const engine = new Engine(connect('http://localhost:2525'), 'remote', {});
    await expect(engine.intercept()).rejects.toThrow(/unexpected shape/);
  });

  it('no port and no admin port in the URL: GET /intercept still answers the port (issue #129)', async () => {
    mockFetch(new Response(JSON.stringify({ interceptPort: 8443, interceptUrl: 'http://0.0.0.0:8443' }), { status: 200 }));
    const engine = new Engine(connect('https://api.example.com'), 'remote', {});
    const handle = await engine.intercept();
    expect(handle.url).toBe('http://api.example.com:8443');
  });

  it('explicit port: probes GET /intercept/rules only — the engine < 0.13.0 path — and attaches there (issue #129)', async () => {
    const fn = mockFetch(new Response('[]', { status: 200 }));
    const engine = new Engine(connect('http://localhost:2525'), 'remote', {});
    const handle = await engine.intercept({ port: 9999 });
    expect(handle.port).toBe(9999);
    expect(handle.url).toBe('http://localhost:9999');
    expect(fn).toHaveBeenCalledTimes(1);
    expect((fn.mock.calls[0] as [string])[0]).toBe('http://localhost:2525/intercept/rules');
  });

  it('explicit port: 404 on the rules probe → InterceptUnavailable', async () => {
    mockFetch(new Response(JSON.stringify({ errors: [{ message: 'not found' }] }), { status: 404 }));
    const engine = new Engine(connect('http://localhost:2525'), 'remote', {});
    await expect(engine.intercept({ port: 9999 })).rejects.toThrow('the Rift server must be started with --intercept-port');
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

  it('interceptStatus → GET /intercept, returns {interceptPort, interceptUrl} (issue #129)', async () => {
    const fn = mockFetch(new Response(JSON.stringify({ interceptPort: 8443, interceptUrl: 'http://0.0.0.0:8443' }), { status: 200 }));
    const status = await connect(BASE).interceptStatus();
    expect(status).toEqual({ interceptPort: 8443, interceptUrl: 'http://0.0.0.0:8443' });
    expect(lastCall(fn)).toMatchObject({ method: 'GET', url: `${BASE}/intercept` });
  });

  it('interceptStatus refuses a 200 body without a numeric interceptPort — never a handle at :undefined (issue #129)', async () => {
    for (const body of [{}, { interceptPort: '8443', interceptUrl: 'http://0.0.0.0:8443' }, { interceptPort: 8443 }]) {
      mockFetch(new Response(JSON.stringify(body), { status: 200 }));
      await expect(connect(BASE).interceptStatus()).rejects.toThrow(/unexpected shape/);
    }
  });

  it('interceptStatus → 404 (listener not running) maps through the generic 404 path (issue #129)', async () => {
    mockFetch(new Response(JSON.stringify({ errors: [{ message: 'intercept listener not running' }] }), { status: 404 }));
    await expect(connect(BASE).interceptStatus()).rejects.toThrow(ImposterNotFound);
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
