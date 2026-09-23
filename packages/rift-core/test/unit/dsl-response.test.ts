/**
 * DSL response-completion gate (issue #23)
 *
 * Pins the EXACT wire JSON for every response-side builder the issue adds: full `_behaviors`
 * (copy/lookup/decorate/shellTransform/wait-variants), binary body + multi-value headers +
 * templated, typed faults (Fault + withFault merge/conflict), the Script builder, and the full
 * proxy builder — including the regression that proxy/inject responses must carry `_behaviors`
 * (the silent-drop bug at response.ts:88-93). Also pins `willReturn` append semantics.
 */

import {
  ok,
  okJson,
  badRequest,
  script,
  fault,
  proxyTo,
  inject,
  onGet,
  Fault,
  Script,
} from '../../src/dsl/index.js';
import { InvalidDefinition } from '../../src/errors.js';

describe('DSL #23 — behaviors', () => {
  it('copy (single spec) emits a one-element _behaviors.copy array', () => {
    const r = ok('hi ${NAME}')
      .copy({ from: 'path', into: '${NAME}', using: { method: 'regex', selector: '\\w+$' } })
      .build();
    expect(r).toEqual({
      is: { statusCode: 200, body: 'hi ${NAME}' },
      _behaviors: {
        copy: [{ from: 'path', into: '${NAME}', using: { method: 'regex', selector: '\\w+$' } }],
      },
    });
  });

  it('copy (array) and lookup emit arrays; from-object shapes pass through', () => {
    const r = ok()
      .copy([
        { from: { query: 'token' }, into: '${T}', using: { method: 'regex', selector: '.+' } },
      ])
      .lookup({
        key: { from: 'path', using: { method: 'regex', selector: '/(\\d+)$' } },
        fromDataSource: { csv: { path: 'users.csv', keyColumn: 'id' } },
        into: '${ROW}',
      })
      .build();
    expect(r._behaviors?.copy).toEqual([
      { from: { query: 'token' }, into: '${T}', using: { method: 'regex', selector: '.+' } },
    ]);
    expect(r._behaviors?.lookup).toEqual([
      {
        key: { from: 'path', using: { method: 'regex', selector: '/(\\d+)$' } },
        fromDataSource: { csv: { path: 'users.csv', keyColumn: 'id' } },
        into: '${ROW}',
      },
    ]);
  });

  it('decorate and shellTransform (1 → string, n → array)', () => {
    expect(ok().decorate('function(req, res) { res.body += "!"; }').build()._behaviors).toEqual({
      decorate: 'function(req, res) { res.body += "!"; }',
    });
    expect(ok().shellTransform('sed s/a/b/').build()._behaviors).toEqual({
      shellTransform: 'sed s/a/b/',
    });
    expect(ok().shellTransform('a', 'b').build()._behaviors).toEqual({
      shellTransform: ['a', 'b'],
    });
  });

  it('behavior(raw) shallow-merges as an escape hatch', () => {
    expect(ok().repeat(2).behavior({ decorate: 'fn' }).build()._behaviors).toEqual({
      repeat: 2,
      decorate: 'fn',
    });
  });
});

describe('DSL #23 — latency variants (never {inject})', () => {
  it('number → wait number', () => {
    expect(ok().latency(50).build()._behaviors).toEqual({ wait: 50 });
  });
  it('range → wait {min,max}', () => {
    expect(ok().latency({ min: 100, max: 500 }).build()._behaviors).toEqual({
      wait: { min: 100, max: 500 },
    });
  });
  it('string → bare function-string wait, NOT {inject}', () => {
    const b = ok().latency('function() { return 500; }').build();
    expect(b._behaviors).toEqual({ wait: 'function() { return 500; }' });
    expect(JSON.stringify(b)).not.toContain('inject');
  });
});

describe('DSL #23 — binary body, multi-value headers, templated', () => {
  it('binaryBody(Uint8Array) base64-encodes and marks _mode binary', () => {
    const r = ok().binaryBody(new Uint8Array([1, 2, 3, 255])).build();
    expect(r.is?.body).toBe(Buffer.from([1, 2, 3, 255]).toString('base64'));
    expect(r.is?._mode).toBe('binary');
  });
  it('binaryBody(string) is trusted as already-base64', () => {
    const r = ok().binaryBody('AQID').build();
    expect(r.is).toMatchObject({ body: 'AQID', _mode: 'binary' });
  });
  it('header(string[]) emits a multi-value array', () => {
    const r = ok().header('Set-Cookie', ['a=1', 'b=2']).build();
    expect(r.is?.headers).toEqual({ 'Set-Cookie': ['a=1', 'b=2'] });
  });
  it('templated() sets _rift.templated', () => {
    expect(ok('${x}').templated().build()._rift).toEqual({ templated: true });
  });
});

describe('DSL #23 — willReturn append semantics', () => {
  it('two willReturn calls cycle both responses (append, not replace)', () => {
    const s = onGet('/x').willReturn(ok('a')).willReturn(ok('b')).build();
    expect(s.responses).toEqual([
      { is: { statusCode: 200, body: 'a' } },
      { is: { statusCode: 200, body: 'b' } },
    ]);
  });
  it('respond is an alias and also appends', () => {
    const s = onGet('/x').respond(ok('a'), ok('b')).respond(ok('c')).build();
    expect(s.responses).toHaveLength(3);
  });
});

describe('DSL #23 — typed faults', () => {
  it('fault(kind) is a top-level Mountebank fault (no is)', () => {
    expect(fault(Fault.CONNECTION_RESET).build()).toEqual({ fault: 'CONNECTION_RESET_BY_PEER' });
  });
  it('withFault(latency range) → _rift.fault.latency', () => {
    const r = ok().withFault(Fault.latency({ min: 100, max: 500 }, { probability: 0.3 })).build();
    expect(r._rift).toEqual({
      fault: { latency: { probability: 0.3, minMs: 100, maxMs: 500 } },
    });
  });
  it('withFault(latency fixed ms) defaults probability 1.0 with ms', () => {
    expect(ok().withFault(Fault.latency(1000)).build()._rift).toEqual({
      fault: { latency: { probability: 1.0, ms: 1000 } },
    });
  });
  it('withFault(error) → _rift.fault.error', () => {
    const r = ok()
      .withFault(Fault.error({ status: 503, body: 'down' }, { probability: 0.5 }))
      .build();
    expect(r._rift).toEqual({
      fault: { error: { probability: 0.5, status: 503, body: 'down' } },
    });
  });
  it('latency + tcp faults MERGE into one _rift.fault block', () => {
    const r = ok()
      .withFault(Fault.latency(100))
      .withFault(Fault.tcp(Fault.CONNECTION_RESET))
      .build();
    expect(r._rift).toEqual({
      fault: { latency: { probability: 1.0, ms: 100 }, tcp: 'CONNECTION_RESET_BY_PEER' },
    });
  });
  it('two faults of the SAME kind throw InvalidDefinition', () => {
    expect(() => ok().withFault(Fault.latency(100)).withFault(Fault.latency(200))).toThrow(
      InvalidDefinition
    );
  });
});

describe('DSL #23 — Script builder', () => {
  it('rhai(code) → _rift.script with engine rhai', () => {
    expect(script(Script.rhai('respond(http(200))')).build()._rift).toEqual({
      script: { engine: 'rhai', code: 'respond(http(200))' },
    });
  });
  it('js(code) → _rift.script with engine js', () => {
    expect(script(Script.js('return 1')).build()._rift).toEqual({
      script: { engine: 'js', code: 'return 1' },
    });
  });
  it('rhaiFile/jsFile omit engine (extension implies it)', () => {
    expect(script(Script.rhaiFile('s.rhai')).build()._rift).toEqual({
      script: { file: 's.rhai' },
    });
    expect(script(Script.jsFile('s.js')).build()._rift).toEqual({ script: { file: 's.js' } });
  });
  it('ref(name) → { ref: name }', () => {
    expect(script(Script.ref('greet')).build()._rift).toEqual({ script: { ref: 'greet' } });
  });
  it('a hand-built spec with >1 of code/file/ref throws InvalidDefinition', () => {
    // The union's per-arm index signature can't stop this at compile time; script() guards at runtime.
    const bad = { engine: 'js', code: 'x', file: 'y' } as unknown as Parameters<typeof script>[0];
    expect(() => script(bad)).toThrow(InvalidDefinition);
  });
});

describe('DSL #23 — loud failures (no silent drop/misroute)', () => {
  it('is-content alongside proxy/inject/native-fault throws InvalidDefinition (not silent drop)', () => {
    expect(() => proxyTo('http://up').status(500).body({ e: 1 }).build()).toThrow(InvalidDefinition);
    expect(() => inject('function(){}').status(200).build()).toThrow(InvalidDefinition);
    expect(() => fault(Fault.EMPTY_RESPONSE).header('X', '1').build()).toThrow(InvalidDefinition);
  });
  it('tcp fault set via BOTH fault() and withFault(Fault.tcp) throws (no clobber)', () => {
    expect(() =>
      ok().fault('ECONNRESET').withFault(Fault.tcp(Fault.CONNECTION_RESET)).build()
    ).toThrow(InvalidDefinition);
  });
  it('fault() rejects a case-variant near-miss of a native kind', () => {
    expect(() => fault('connection_reset_by_peer')).toThrow(InvalidDefinition);
  });
  it('fault() still routes a genuine legacy identifier to _rift.fault.tcp', () => {
    expect(fault('ECONNRESET').build()).toEqual({ _rift: { fault: { tcp: 'ECONNRESET' } } });
  });
  it('empty shellTransform()/copy([]) are no-ops (no stray empty collection)', () => {
    expect(ok().shellTransform().build()._behaviors).toBeUndefined();
    expect(ok().copy([]).build()._behaviors).toBeUndefined();
  });
});

describe('DSL #23 — proxy builder', () => {
  it('injectHeader() refuses a case-variant of an existing name, naming both spellings (issue #145)', () => {
    // `proxy.injectHeaders` is single-valued: engine 0.18.0 refuses a second spelling with a 400
    // ("header `X-Trace` is already given as `x-trace`"). Fail here, naming the builder call.
    const build = () => proxyTo('http://u').injectHeader('x-trace', 'a').injectHeader('X-Trace', 'b');
    expect(build).toThrow(InvalidDefinition);
    expect(build).toThrow(/`X-Trace` is already given as `x-trace`/);
    expect(build).toThrow(/injectHeader/);
  });

  it('injectHeader() with three spellings throws on the first collision (issue #145)', () => {
    expect(() =>
      proxyTo('http://u').injectHeader('X-Id', '1').injectHeader('X-Other', '2').injectHeader('x-id', '3')
    ).toThrow(/`x-id` is already given as `X-Id`/);
  });

  it('injectHeader() with the same spelling twice replaces the value (issue #145)', () => {
    const r = proxyTo('http://u').injectHeader('X-A', '1').injectHeader('X-A', '2').build();
    expect(r.proxy).toMatchObject({ injectHeaders: { 'X-A': '2' } });
  });

  it('injectHeader() folds ASCII case only, as the engine does — non-ASCII pairs stay distinct (issue #145)', () => {
    // The engine compares with `eq_ignore_ascii_case`; a Unicode fold would wrongly collide these.
    const r = proxyTo('http://u').injectHeader('ß', '1').injectHeader('SS', '2').injectHeader('İ', '3').build();
    expect(r.proxy).toMatchObject({ injectHeaders: { ß: '1', SS: '2', İ: '3' } });
  });

  it('Fault.error() with an empty headers map is a no-op for the check (issue #145)', () => {
    const r = ok().withFault(Fault.error({ status: 503, headers: {} })).build();
    expect(r._rift).toEqual({ fault: { error: { probability: 1.0, status: 503, headers: {} } } });
  });

  it('Fault.error() refuses case-variant duplicate header names (issue #145)', () => {
    const build = () => Fault.error({ status: 503, headers: { 'x-a': '1', 'X-A': '2' } });
    expect(build).toThrow(InvalidDefinition);
    expect(build).toThrow(/`X-A` is already given as `x-a`/);
    expect(build).toThrow(/Fault\.error/);
  });

  it('Fault.error() keeps distinct header names (issue #145)', () => {
    const r = ok().withFault(Fault.error({ status: 503, headers: { 'X-A': '1', 'X-B': '2' } })).build();
    expect(r._rift).toEqual({
      fault: { error: { probability: 1.0, status: 503, headers: { 'X-A': '1', 'X-B': '2' } } },
    });
  });

  it('is.headers keeps case-variant names as separate keys — multi-valued, out of #145 scope', () => {
    // The engine folds case variants of a multi-valued header into one entry (rift#1039); that is
    // how a stub sends two Set-Cookie lines, so the DSL must not refuse it here.
    const r = ok().header('x-a', '1').header('X-A', '2').build();
    expect(r.is?.headers).toEqual({ 'x-a': '1', 'X-A': '2' });
  });

  it('full proxy: mode, generators, wait/decorate, injectHeaders, pathRewrite, clientCert', () => {
    const r = proxyTo('http://up.example')
      .proxyAlways()
      .generatePredicates({ matches: { method: true, path: true } })
      .addWaitBehavior()
      .addDecorateBehavior('function(r){}')
      .injectHeader('X-A', '1')
      .injectHeader('X-B', '2')
      .rewritePath('^/api', '/')
      .clientCert({ key: 'KEY', cert: 'CERT' })
      .build();
    expect(r.proxy).toEqual({
      to: 'http://up.example',
      mode: 'proxyAlways',
      predicateGenerators: [{ matches: { method: true, path: true } }],
      addWaitBehavior: true,
      addDecorateBehavior: 'function(r){}',
      injectHeaders: { 'X-A': '1', 'X-B': '2' },
      pathRewrite: { from: '^/api', to: '/' },
      key: 'KEY',
      cert: 'CERT',
    });
  });

  it('REGRESSION: proxy response carries _behaviors (silent-drop bug fixed)', () => {
    expect(proxyTo('http://up').latency(500).build()).toEqual({
      proxy: { to: 'http://up' },
      _behaviors: { wait: 500 },
    });
  });

  it('REGRESSION: inject response carries _behaviors too', () => {
    expect(inject('function(){}').repeat(2).build()).toEqual({
      inject: 'function(){}',
      _behaviors: { repeat: 2 },
    });
  });
});

describe('DSL #23 — raw patch + badRequest', () => {
  it('badRequest(body) → 400', () => {
    expect(badRequest({ error: 'bad' }).build()).toEqual({
      is: { statusCode: 400, body: { error: 'bad' } },
    });
  });
  it('raw(patch) applies a last-wins shallow merge', () => {
    const r = okJson({ a: 1 }).raw({ statusCode: 418 }).build();
    expect(r.statusCode).toBe(418);
  });
});
