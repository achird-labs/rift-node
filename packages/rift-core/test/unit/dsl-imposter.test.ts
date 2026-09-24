/**
 * DSL imposter/stub/scenario completion gate (issue #24)
 *
 * Pins the wire JSON for the imposter-level fields the issue adds (HTTPS/mTLS, defaultForward,
 * strictBehaviors, serviceName/Info, the `_rift` config block), the stub-level fields
 * (`id`/`space`/`route_pattern`), and the two scenario-builder fixes (snapshot-at-`when`, variadic
 * `respond`). The full example round-trips through `fromJson(toWireJson(...))`.
 */

import { fromJson, toWireJson } from '../../src/model/index.js';
import {
  imposter,
  onGet,
  onPost,
  ok,
  okJson,
  status,
  script,
  Script,
  proxyTo,
  scenario,
} from '../../src/dsl/index.js';
import { InvalidDefinition } from '../../src/errors.js';

describe('DSL #24 — HTTPS / mTLS', () => {
  it('https({cert,key,mutualAuth}) sets protocol https + inline PEM fields', () => {
    const imp = imposter('s').https({ cert: 'CERT', key: 'KEY', mutualAuth: true }).build();
    expect(imp).toMatchObject({
      protocol: 'https',
      cert: 'CERT',
      key: 'KEY',
      mutualAuth: true,
    });
  });
  const CA1 = '-----BEGIN CERTIFICATE-----\nAAA\n-----END CERTIFICATE-----\n';
  const CA2 = '-----BEGIN CERTIFICATE-----\nBBB\n-----END CERTIFICATE-----\n';

  it('requireClientCertificate() emits mutualAuth only, and sets protocol https (issue #137)', () => {
    expect(imposter('s').requireClientCertificate().build()).toEqual({ name: 's', protocol: 'https', mutualAuth: true });
  });

  it('requireClientCertificate([pem]) emits all three keys, one anchor as a bare string (issue #137)', () => {
    // The engine echoes one anchor back as a string and several as an array; emitting the same
    // spelling keeps toJson() byte-equal to what was posted.
    expect(imposter('s').requireClientCertificate([CA1]).build()).toEqual({
      name: 's',
      protocol: 'https',
      mutualAuth: true,
      rejectUnauthorized: true,
      ca: CA1,
    });
  });

  it('requireClientCertificate([a, b]) emits the anchors as an array (issue #137)', () => {
    expect(imposter('s').requireClientCertificate([CA1, CA2]).build()).toMatchObject({ rejectUnauthorized: true, ca: [CA1, CA2] });
  });

  it('a later requireClientCertificate() call replaces — including dropping the CA (issue #137)', () => {
    const imp = imposter('s').requireClientCertificate([CA1]).requireClientCertificate().build();
    expect(imp).toEqual({ name: 's', protocol: 'https', mutualAuth: true });
  });

  it('refuses a PEM without a certificate block and an empty array (issue #137)', () => {
    expect(() => imposter('s').requireClientCertificate(['not a pem'])).toThrow(InvalidDefinition);
    expect(() => imposter('s').requireClientCertificate(['not a pem'])).toThrow(/BEGIN CERTIFICATE/);
    // `[]` would read as "validate against nothing" == accept any certificate; say so instead.
    expect(() => imposter('s').requireClientCertificate([])).toThrow(InvalidDefinition);
    expect(() => imposter('s').requireClientCertificate([CA1, ''])).toThrow(InvalidDefinition);
  });

  it('client-auth keys on a non-https protocol throw at build(), whichever order (issue #137)', () => {
    // The engine 400s `mutualAuth: true` on http; catch it locally, and after the call too, since
    // `.protocol('http')` can follow `.requireClientCertificate()`.
    expect(() => imposter('s').requireClientCertificate().protocol('http').build()).toThrow(InvalidDefinition);
    expect(() => imposter('s').requireClientCertificate([CA1]).protocol('h2c').build()).toThrow(/https/);
    // `mutualAuth: false` is valid on any protocol and must not trip it.
    expect(imposter('s').https({ mutualAuth: false }).protocol('http').build()).toEqual({ name: 's', protocol: 'http', mutualAuth: false });
  });

  it('requireClientCertificate([...]) keeps its keys when https({ cert, key }) comes after it (issue #137)', () => {
    expect(imposter('s').requireClientCertificate([CA1]).https({ cert: 'C', key: 'K' }).build()).toMatchObject({
      protocol: 'https',
      cert: 'C',
      key: 'K',
      mutualAuth: true,
      rejectUnauthorized: true,
      ca: CA1,
    });
  });

  it('https({ mutualAuth: false }) after requireClientCertificate([...]) is refused at build() — the engine 400s it (issue #137)', () => {
    expect(() => imposter('s').requireClientCertificate([CA1]).https({ mutualAuth: false }).build()).toThrow(InvalidDefinition);
    expect(() => imposter('s').requireClientCertificate([CA1]).https({ mutualAuth: false }).build()).toThrow(/need mutualAuth: true/);
    // Without anchors there is nothing left to refuse: mutualAuth: false alone is valid on any protocol.
    expect(imposter('s').requireClientCertificate().https({ mutualAuth: false }).protocol('http').build()).toEqual({
      name: 's',
      protocol: 'http',
      mutualAuth: false,
    });
  });

  it('raw() is the unchecked escape hatch: it can carry a combination build() would refuse (issue #137)', () => {
    // Deliberate, and the same rule as the model layer — the engine is the authority on raw JSON.
    expect(imposter('s').raw({ mutualAuth: true, protocol: 'http' }).build()).toEqual({ name: 's', mutualAuth: true, protocol: 'http' });
  });

  it('requireClientCertificate() survives every other chain method (issue #137)', () => {
    const imp = imposter('s').port(4443).record().https({ cert: 'C', key: 'K' }).requireClientCertificate([CA1]).allowCORS().build();
    expect(imp).toMatchObject({ port: 4443, recordRequests: true, cert: 'C', key: 'K', mutualAuth: true, rejectUnauthorized: true, ca: CA1, allowCORS: true });
  });

  it('https() with no args sets only protocol https (engine self-signed)', () => {
    const imp = imposter('s').https().build();
    expect(imp.protocol).toBe('https');
    expect(imp.cert).toBeUndefined();
    expect(imp.mutualAuth).toBeUndefined();
  });
});

describe('DSL #24 — imposter metadata', () => {
  it('strictBehaviors / defaultForward / serviceName / serviceInfo are top-level', () => {
    const imp = imposter('s')
      .strictBehaviors()
      .defaultForward('https://real.example')
      .serviceName('payments')
      .serviceInfo({ team: 'core' })
      .build();
    expect(imp).toMatchObject({
      strictBehaviors: true,
      defaultForward: 'https://real.example',
      serviceName: 'payments',
      serviceInfo: { team: 'core' },
    });
  });
  it('raw(patch) is a last-wins shallow merge', () => {
    expect(imposter('s').port(1).raw({ port: 4545 }).build().port).toBe(4545);
  });
});

describe('DSL #24 — _rift config', () => {
  it('flowState(cfg) passes through into _rift.flowState (undefined omitted)', () => {
    const imp = imposter('s')
      .flowState({ backend: 'redis', ttlSeconds: 600, redis: { url: 'redis://localhost:6379' } })
      .build();
    expect(imp._rift?.flowState).toEqual({
      backend: 'redis',
      ttlSeconds: 600,
      redis: { url: 'redis://localhost:6379' },
    });
  });
  it('flowIdFromHeader merges flowIdSource into one _rift.flowState block', () => {
    const imp = imposter('s')
      .flowState({ backend: 'redis' })
      .flowIdFromHeader('X-Flow-Id')
      .build();
    expect(imp._rift?.flowState).toEqual({
      backend: 'redis',
      flowIdSource: 'header:X-Flow-Id',
    });
  });
  it('metrics(port) → _rift.metrics {enabled,port}; metrics() → {enabled}', () => {
    expect(imposter('s').metrics(9090).build()._rift?.metrics).toEqual({
      enabled: true,
      port: 9090,
    });
    expect(imposter('s').metrics().build()._rift?.metrics).toEqual({ enabled: true });
  });
  it("scriptEngine accepts the engine's 'js' spelling, and a Script.* engine always wins over defaultEngine (issue #147)", () => {
    expect(imposter('s').scriptEngine({ defaultEngine: 'js' }).build()._rift?.scriptEngine).toEqual({ defaultEngine: 'js' });
    // The DSL always names an engine (Script.js/rhai set it; *File relies on the extension), so
    // defaultEngine only reaches raw()/fromJson scripts with a bare { code } (rift#1159).
    const imp = imposter('s')
      .scriptEngine({ defaultEngine: 'rhai' })
      .stub(onGet('/x').willReturn(script(Script.js('1'))))
      .build();
    expect(imp.stubs?.[0]?.responses?.[0]?._rift?.script).toEqual({ engine: 'js', code: '1' });
  });

  it('scriptEngine(cfg) → _rift.scriptEngine', () => {
    expect(
      imposter('s').scriptEngine({ defaultEngine: 'rhai', timeoutMs: 2000 }).build()._rift
        ?.scriptEngine
    ).toEqual({ defaultEngine: 'rhai', timeoutMs: 2000 });
  });
  it('registerScript(name, spec) → _rift.scripts.{name}', () => {
    const imp = imposter('s').registerScript('approve', Script.rhaiFile('scripts/approve.rhai')).build();
    expect(imp._rift?.scripts).toEqual({ approve: { file: 'scripts/approve.rhai' } });
  });
  it('multiple flowState() calls merge, preserving earlier keys', () => {
    const imp = imposter('s')
      .flowState({ backend: 'redis' })
      .flowState({ ttlSeconds: 600 })
      .build();
    expect(imp._rift?.flowState).toEqual({ backend: 'redis', ttlSeconds: 600 });
  });
  it('multiple scriptEngine() calls merge, preserving earlier keys', () => {
    const imp = imposter('s')
      .scriptEngine({ defaultEngine: 'rhai' })
      .scriptEngine({ timeoutMs: 5000 })
      .build();
    expect(imp._rift?.scriptEngine).toEqual({ defaultEngine: 'rhai', timeoutMs: 5000 });
  });
  it('multiple registerScript() calls accumulate distinct names', () => {
    const imp = imposter('s')
      .registerScript('a', Script.ref('x'))
      .registerScript('b', Script.rhai('1'))
      .build();
    expect(imp._rift?.scripts).toEqual({ a: { ref: 'x' }, b: { engine: 'rhai', code: '1' } });
  });
});

describe('DSL #24 — defaultResponse error path', () => {
  it('non-is response (proxy) throws InvalidDefinition (not a plain Error)', () => {
    expect(() => imposter('s').defaultResponse(proxyTo('http://up'))).toThrow(InvalidDefinition);
  });
  it('an is response is accepted', () => {
    expect(imposter('s').defaultResponse(okJson({ ok: true })).build().defaultResponse).toMatchObject(
      { statusCode: 200 }
    );
  });
  it('a raw IsResponse object is accepted', () => {
    expect(imposter('s').defaultResponse({ statusCode: 503 }).build().defaultResponse).toEqual({
      statusCode: 503,
    });
  });
  it('an empty / non-is raw object throws InvalidDefinition (no stray empty default)', () => {
    expect(() => imposter('s').defaultResponse({})).toThrow(InvalidDefinition);
    expect(() =>
      imposter('s').defaultResponse({ proxy: { to: 'x' } } as unknown as Parameters<
        ReturnType<typeof imposter>['defaultResponse']
      >[0])
    ).toThrow(InvalidDefinition);
  });
});

describe('DSL #24 — stub-level fields', () => {
  it('id / inSpace / routePattern emit id / space / route_pattern', () => {
    const s = onGet('/x').id('stub-1').inSpace('flow-9').routePattern('/x/:y').build();
    expect(s).toMatchObject({ id: 'stub-1', space: 'flow-9', route_pattern: '/x/:y' });
  });
  it('inScenario emits a bare scenarioName with no FSM state keys (issue #36)', () => {
    const s = onGet('/x').inScenario('Auth-Login').build();
    expect(s.scenarioName).toBe('Auth-Login');
    expect(s.required_scenario_state).toBeUndefined();
    expect(s.new_scenario_state).toBeUndefined();
    expect(onGet('/x').build().scenarioName).toBeUndefined();
  });
  it('explicit routePattern() overrides the opener-derived :param pattern', () => {
    // onGet('/x/:id') auto-derives route_pattern '/x/:id'; the explicit override must win.
    expect(onGet('/x/:id').routePattern('/custom').build().route_pattern).toBe('/custom');
    // ...and without an override, the opener-derived pattern survives.
    expect(onGet('/x/:id').build().route_pattern).toBe('/x/:id');
  });
});

describe('DSL #24 — scenario builder', () => {
  it('imposter.scenario(s) appends the FSM stubs; mixed stub()+scenario() order preserved', () => {
    const imp = imposter('flow')
      .stub(onGet('/first').willReturn(ok('1')))
      .scenario(
        scenario('login')
          .startingAt('Started')
          .when('Started', onPost('/login'))
          .respond(status(200))
          .goTo('LoggedIn')
          .when('LoggedIn', onGet('/me'))
          .respond(okJson({ me: true }))
      )
      .stub(onGet('/last').willReturn(ok('z')))
      .build();
    const stubs = imp.stubs ?? [];
    // first plain stub, then 2 scenario stubs, then last plain stub — order preserved
    expect(stubs).toHaveLength(4);
    expect(stubs[0]?.responses?.[0]).toEqual({ is: { statusCode: 200, body: '1' } });
    expect(stubs[1]).toMatchObject({
      scenarioName: 'login',
      required_scenario_state: 'Started',
      new_scenario_state: 'LoggedIn',
    });
    expect(stubs[2]).toMatchObject({ required_scenario_state: 'LoggedIn' });
    expect(stubs[2]?.new_scenario_state).toBeUndefined(); // terminal
    expect(stubs[3]?.responses?.[0]).toEqual({ is: { statusCode: 200, body: 'z' } });
  });

  it('snapshot-at-when: mutating the stub builder after when() does not change the committed step', () => {
    const sb = onGet('/x');
    const sc = scenario('s').when('Started', sb).respond(ok('committed'));
    sb.when({ equals: { path: '/MUTATED' } }); // mutate after when()
    const stubs = sc.build();
    // the committed predicate is the original single GET /x, not the post-hoc mutation
    expect(stubs[0]?.predicates).toEqual([{ equals: { method: 'GET' } }, { equals: { path: '/x' } }]);
  });

  it('variadic respond(...) cycles multiple responses within a state', () => {
    const stubs = scenario('s')
      .when('Started', onGet('/x'))
      .respond(status(200), status(503))
      .build();
    expect(stubs[0]?.responses).toEqual([{ is: { statusCode: 200 } }, { is: { statusCode: 503 } }]);
  });
});

describe('DSL #24 — full example round-trips', () => {
  it('fromJson(toWireJson(build())) deep-equals the built imposter', () => {
    const imp = imposter('payments')
      .https({ mutualAuth: true })
      .record()
      .flowIdFromHeader('X-Flow-Id')
      .flowState({ backend: 'redis', redis: { url: 'redis://localhost:6379' }, ttlSeconds: 600 })
      .scriptEngine({ defaultEngine: 'rhai', timeoutMs: 2000 })
      .registerScript('approve', Script.rhaiFile('scripts/approve.rhai'))
      .stub(onPost('/pay').willReturn(script(Script.ref('approve'))))
      .build();
    expect(fromJson(toWireJson(imp))).toEqual(imp);
  });
});

describe('DSL #65 — imposter().stub() accepts raw Stub objects', () => {
  it('accepts a raw Stub object (no builder)', () => {
    const rawStub = {
      predicates: [{ equals: { method: 'GET', path: '/x' } }],
      responses: [{ is: { statusCode: 204 } }],
    };
    const imp = imposter('s').stub(rawStub).build();
    expect(imp.stubs).toEqual([rawStub]);
  });

  it('accepts an inject raw Stub (no DSL builder path needed)', () => {
    const imp = imposter('injected')
      .stub({ responses: [{ inject: 'function(config) { return { statusCode: 202 }; }' }] })
      .build();
    expect(imp.stubs?.[0]?.responses?.[0]).toEqual({
      inject: 'function(config) { return { statusCode: 202 }; }',
    });
  });

  it('mixes StubBuilder and raw Stub in call order', () => {
    const imp = imposter('s')
      .stub(onGet('/a').willReturn(okJson({ a: 1 })))
      .stub({ predicates: [{ equals: { path: '/b' } }], responses: [{ is: { statusCode: 200 } }] })
      .build();
    expect(imp.stubs).toHaveLength(2);
    expect(imp.stubs?.[1]).toEqual({
      predicates: [{ equals: { path: '/b' } }],
      responses: [{ is: { statusCode: 200 } }],
    });
  });
});
