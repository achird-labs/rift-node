/**
 * Gate for issue #170 — the engine's `_rift.warnings` (stub analysis, `config_key_ignored`,
 * `state_ops_never_runs`) surfaced through `ImposterHandle.warnings()` and the `stubWarnings`
 * policy applied by `create()` / `replaceAll()`. Wire facts from the engine (0.18.0):
 * `POST /imposters` and `GET /imposters/:port` carry `_rift.warnings`, `PUT /imposters` answers
 * summaries without it, and the embedded transport reads them through `rift_stub_warnings`.
 */

import { jest } from '@jest/globals';
import { Engine, type AdminApi } from '../../src/engine.js';
import { imposter, onGet, ok } from '../../src/dsl/index.js';
import { RiftError, StubWarningsError } from '../../src/errors.js';
import { parseEngineWarnings } from '../../src/model/warnings.js';
import { RemoteClient } from '../../src/remote/client.js';
import type { EngineWarning, Imposter, ImpostersConfig } from '../../src/model/index.js';

const IGNORED: EngineWarning = {
  warningType: 'config_key_ignored',
  message: '`recordMatches` has no effect: this engine does not record per-stub `matches`',
};
const SHADOWED: EngineWarning = {
  warningType: 'potentially_shadowed',
  message: 'Stub at index 1 may be shadowed by stub at index 0',
  stubIndex: 1,
  shadowedByIndex: 0,
};
const CATCH_ALL: EngineWarning = {
  warningType: 'catch_all',
  message: 'Stub at index 0 has empty predicates and will match ALL requests',
  stubIndex: 0,
};
const TRUNCATED: EngineWarning = { warningType: 'truncated', message: '12 further warnings suppressed' };

/** Records every admin call; `createImposter` echoes `_rift.warnings` from `createWarnings` the way
 * the engine's POST body does, and `stubWarnings` answers from `byPort`. Anything else throws. */
class Admin {
  calls: string[] = [];
  posted: Imposter[] = [];
  deleted: number[] = [];
  createWarnings: EngineWarning[] | undefined;
  /** Overrides the whole `_rift` of the POST reply (a malformed engine answer). */
  createRift: unknown;
  byPort = new Map<number, EngineWarning[]>();
  failDelete = false;
  #next = 5000;

  async createImposter(imp: Imposter): Promise<Imposter> {
    this.calls.push('createImposter');
    this.posted.push(imp);
    const port = typeof imp.port === 'number' ? imp.port : this.#next++;
    const body: Imposter = { ...imp, port };
    if (this.createWarnings !== undefined) body._rift = { ...(imp._rift ?? {}), warnings: this.createWarnings };
    if (this.createRift !== undefined) body._rift = this.createRift as Imposter['_rift'];
    return body;
  }
  async replaceImposters(config: ImpostersConfig): Promise<ImpostersConfig> {
    this.calls.push('replaceImposters');
    // PUT answers summaries: port/protocol/name, no `_rift`.
    return {
      imposters: config.imposters.map((imp) => ({ port: imp.port, protocol: imp.protocol, name: imp.name })),
    };
  }
  async stubWarnings(port: number): Promise<EngineWarning[]> {
    this.calls.push(`stubWarnings:${port}`);
    return this.byPort.get(port) ?? [];
  }
  async deleteImposter(port: number): Promise<Imposter> {
    this.calls.push(`deleteImposter:${port}`);
    if (this.failDelete) throw new Error('delete blew up');
    this.deleted.push(port);
    return { port };
  }

  asAdminApi(): AdminApi {
    const base = { url: 'http://127.0.0.1:2525', closed: false, async close() {}, async [Symbol.asyncDispose]() {} };
    return new Proxy(this, {
      get: (target, prop, receiver) => {
        if (prop in target) {
          const value = Reflect.get(target, prop, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        }
        if (prop in base) return Reflect.get(base, prop);
        return () => {
          throw new Error(`unexpected AdminApi.${String(prop)}() call`);
        };
      },
    }) as unknown as AdminApi;
  }
}

function warnSpy() {
  return jest.spyOn(console, 'warn').mockImplementation(() => {});
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('parseEngineWarnings (issue #170)', () => {
  it('reads an absent block as no warnings', () => {
    expect(parseEngineWarnings(undefined, 'GET /imposters/1')).toEqual([]);
  });

  it('passes a well-formed list through, unknown kinds and extra keys included', () => {
    const future = { warningType: 'some_future_kind', message: 'm', extra: 1 };
    expect(parseEngineWarnings([IGNORED, future], 'x')).toEqual([IGNORED, future]);
  });

  it('refuses a block that is present but not a list, rather than reporting no warnings', () => {
    expect(() => parseEngineWarnings('nope', 'GET /imposters/7')).toThrow(RiftError);
    expect(() => parseEngineWarnings({ warningType: 'x', message: 'y' }, 'GET /imposters/7')).toThrow(
      /GET \/imposters\/7.*_rift\.warnings/
    );
  });

  it('refuses an entry without a string warningType or message', () => {
    expect(() => parseEngineWarnings([{ message: 'no type' }], 'x')).toThrow(RiftError);
    expect(() => parseEngineWarnings([{ warningType: 'catch_all' }], 'x')).toThrow(RiftError);
    expect(() => parseEngineWarnings([null], 'x')).toThrow(RiftError);
  });
});

describe('create() applies the stubWarnings policy (issue #170)', () => {
  it("default 'warn': one console.warn per actionable warning, naming the imposter and the kind", async () => {
    const admin = new Admin();
    admin.createWarnings = [IGNORED, CATCH_ALL, SHADOWED, TRUNCATED];
    const spy = warnSpy();
    const engine = new Engine(admin.asAdminApi(), 'remote', { hostHint: '127.0.0.1' });

    const handle = await engine.create(imposter('orders').port(4545));

    expect(handle.port).toBe(4545);
    expect(spy.mock.calls.map((c) => c[0])).toEqual([
      'rift: imposter "orders" (port 4545): `recordMatches` has no effect: this engine does not record per-stub `matches` [config_key_ignored]',
      'rift: imposter "orders" (port 4545): Stub at index 1 may be shadowed by stub at index 0 [potentially_shadowed]',
    ]);
    // Remote/spawn read the POST body: no extra round-trip.
    expect(admin.calls).toEqual(['createImposter']);
  });

  it('labels an unnamed imposter by its port', async () => {
    const admin = new Admin();
    admin.createWarnings = [IGNORED];
    const spy = warnSpy();
    await new Engine(admin.asAdminApi(), 'remote').create({ port: 4600, protocol: 'http' });
    expect(spy.mock.calls[0]?.[0]).toMatch(/^rift: imposter \(port 4600\): /);
  });

  it('is silent when the engine reports only catch_all / truncated, or nothing', async () => {
    const spy = warnSpy();
    for (const warnings of [[CATCH_ALL, TRUNCATED], [], undefined]) {
      const admin = new Admin();
      admin.createWarnings = warnings;
      await new Engine(admin.asAdminApi(), 'remote', { stubWarnings: 'fail' }).create(imposter('x').port(1));
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it("'ignore' prints nothing and makes no extra call", async () => {
    const admin = new Admin();
    admin.createWarnings = [IGNORED];
    const spy = warnSpy();
    const engine = new Engine(admin.asAdminApi(), 'embedded', { stubWarnings: 'ignore' });
    await engine.create(imposter('x').port(4545));
    expect(spy).not.toHaveBeenCalled();
    expect(admin.calls).toEqual(['createImposter']);
  });

  it("'fail' deletes the imposter and throws StubWarningsError carrying the actionable warnings", async () => {
    const admin = new Admin();
    admin.createWarnings = [CATCH_ALL, IGNORED];
    const engine = new Engine(admin.asAdminApi(), 'remote', { stubWarnings: 'fail' });

    const err = await engine.create(imposter('orders').port(4545)).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(StubWarningsError);
    expect(err).toBeInstanceOf(RiftError);
    expect((err as StubWarningsError).name).toBe('StubWarningsError');
    expect((err as StubWarningsError).imposters).toEqual([{ port: 4545, name: 'orders', warnings: [IGNORED] }]);
    expect((err as Error).message).toContain('imposter "orders" (port 4545)');
    expect((err as Error).message).toContain('[config_key_ignored]');
    expect(admin.deleted).toEqual([4545]);
  });

  it("'fail' still throws StubWarningsError when deleting the imposter fails", async () => {
    const admin = new Admin();
    admin.createWarnings = [IGNORED];
    admin.failDelete = true;
    const err = await new Engine(admin.asAdminApi(), 'remote', { stubWarnings: 'fail' })
      .create(imposter('x').port(4545))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StubWarningsError);
    expect((err as Error).message).toContain('Still live, delete failed: port 4545 (Error: delete blew up)');
    expect(((err as Error).cause as Error).message).toBe('delete blew up');
  });

  it("a _rift that is not an object is malformed, not 'no warnings': 'fail' deletes and throws, 'warn' reports", async () => {
    for (const rift of ['warnings-disabled', [IGNORED], 42]) {
      const admin = new Admin();
      admin.createRift = rift;
      const err = await new Engine(admin.asAdminApi(), 'remote', { stubWarnings: 'fail' })
        .create(imposter('x').port(4545))
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RiftError);
      expect((err as Error).message).toMatch(/POST \/imposters: _rift is not an object/);
      expect(admin.deleted).toEqual([4545]);
    }
    const admin = new Admin();
    admin.createRift = 'warnings-disabled';
    const spy = warnSpy();
    await new Engine(admin.asAdminApi(), 'remote').create(imposter('x').port(4545));
    expect(spy.mock.calls[0]?.[0]).toMatch(/could not read the engine's warnings: .*_rift is not an object/);
  });

  it("an unreadable warnings block: 'warn' reports it and keeps the imposter", async () => {
    const admin = new Admin();
    admin.createWarnings = 'garbage' as unknown as EngineWarning[];
    const spy = warnSpy();
    const handle = await new Engine(admin.asAdminApi(), 'remote').create(imposter('x').port(4545));
    expect(handle.port).toBe(4545);
    expect(spy.mock.calls[0]?.[0]).toMatch(/^rift: imposter "x" \(port 4545\): could not read the engine's warnings: .*_rift\.warnings is not a list/);
    expect(admin.deleted).toEqual([]);
  });

  it("an unreadable warnings block: 'fail' deletes the imposter and throws, never leaving it behind", async () => {
    const admin = new Admin();
    admin.createWarnings = 'garbage' as unknown as EngineWarning[];
    const err = await new Engine(admin.asAdminApi(), 'remote', { stubWarnings: 'fail' })
      .create(imposter('x').port(4545))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RiftError);
    expect(err).not.toBeInstanceOf(StubWarningsError);
    expect((err as Error).message).toMatch(/could not read the engine's warnings/);
    expect(((err as Error).cause as Error).message).toMatch(/_rift\.warnings is not a list/);
    expect(admin.deleted).toEqual([4545]);
  });

  it('embedded: reads the warnings through stubWarnings(port), never from the returned object', async () => {
    const admin = new Admin();
    admin.createWarnings = [SHADOWED]; // what a POST body would carry — embedded must not read it
    admin.byPort.set(4545, [IGNORED]);
    const spy = warnSpy();
    await new Engine(admin.asAdminApi(), 'embedded').create(imposter('x').port(4545));
    expect(admin.calls).toEqual(['createImposter', 'stubWarnings:4545']);
    expect(spy.mock.calls.map((c) => c[0])).toEqual([
      'rift: imposter "x" (port 4545): `recordMatches` has no effect: this engine does not record per-stub `matches` [config_key_ignored]',
    ]);
  });
});

describe('replaceAll() applies the stubWarnings policy (issue #170)', () => {
  const batch = () => [imposter('a').port(1), imposter('b').port(2), imposter('c').port(3)];

  it("reads each imposter's warnings with stubWarnings(port) — PUT carries none", async () => {
    const admin = new Admin();
    admin.byPort.set(2, [IGNORED]);
    const spy = warnSpy();
    const handles = await new Engine(admin.asAdminApi(), 'remote').replaceAll(batch());
    expect(handles.map((h) => h.port)).toEqual([1, 2, 3]);
    expect(admin.calls).toEqual(['replaceImposters', 'stubWarnings:1', 'stubWarnings:2', 'stubWarnings:3']);
    expect(spy.mock.calls.map((c) => c[0])).toEqual([
      'rift: imposter "b" (port 2): `recordMatches` has no effect: this engine does not record per-stub `matches` [config_key_ignored]',
    ]);
  });

  it("'fail' deletes the whole batch and names only the offending imposters", async () => {
    const admin = new Admin();
    admin.byPort.set(1, [CATCH_ALL]);
    admin.byPort.set(2, [IGNORED]);
    admin.byPort.set(3, [SHADOWED]);
    const err = await new Engine(admin.asAdminApi(), 'remote', { stubWarnings: 'fail' })
      .replaceAll(batch())
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StubWarningsError);
    expect((err as StubWarningsError).imposters).toEqual([
      { port: 2, name: 'b', warnings: [IGNORED] },
      { port: 3, name: 'c', warnings: [SHADOWED] },
    ]);
    expect([...admin.deleted].sort()).toEqual([1, 2, 3]);
  });

  it("'ignore' makes no stubWarnings call", async () => {
    const admin = new Admin();
    admin.byPort.set(2, [IGNORED]);
    await new Engine(admin.asAdminApi(), 'remote', { stubWarnings: 'ignore' }).replaceAll(batch());
    expect(admin.calls).toEqual(['replaceImposters']);
  });
});

describe('ImposterHandle.warnings() and the wire (issue #170)', () => {
  it('returns every warning the engine reports now, catch_all included', async () => {
    const admin = new Admin();
    const handle = await new Engine(admin.asAdminApi(), 'remote', { stubWarnings: 'ignore' }).create(
      imposter('x').port(4545).stub(onGet('/a').willReturn(ok()))
    );
    admin.byPort.set(4545, [CATCH_ALL, SHADOWED]);
    expect(await handle.warnings()).toEqual([CATCH_ALL, SHADOWED]);
  });

  it('never posts a read-back _rift.warnings block, and keeps the rest of _rift', async () => {
    const admin = new Admin();
    const engine = new Engine(admin.asAdminApi(), 'remote', { stubWarnings: 'ignore' });
    await engine.create({ port: 1, protocol: 'http', _rift: { warnings: [IGNORED] } });
    await engine.create({ port: 2, protocol: 'http', _rift: { warnings: [IGNORED], flowState: { backend: 'inmemory' } } });
    expect(admin.posted[0]).toEqual({ port: 1, protocol: 'http' });
    expect(admin.posted[1]).toEqual({ port: 2, protocol: 'http', _rift: { flowState: { backend: 'inmemory' } } });
  });
});

describe('RemoteClient.stubWarnings (issue #170)', () => {
  function mockImposter(body: unknown): jest.Mock {
    const fn = jest.fn(async () => new Response(JSON.stringify(body), { status: 200 }));
    globalThis.fetch = fn as unknown as typeof fetch;
    return fn as unknown as jest.Mock;
  }

  it('GETs the imposter and returns its _rift.warnings', async () => {
    const fn = mockImposter({ port: 4545, _rift: { warnings: [IGNORED], flowState: {} } });
    expect(await new RemoteClient('http://127.0.0.1:2525').stubWarnings(4545)).toEqual([IGNORED]);
    const [url, init] = fn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:2525/imposters/4545');
    expect((init?.method ?? 'GET').toUpperCase()).toBe('GET');
  });

  it('reads an imposter without _rift, or _rift without warnings, as no warnings', async () => {
    mockImposter({ port: 4545 });
    expect(await new RemoteClient('http://127.0.0.1:2525').stubWarnings(4545)).toEqual([]);
    mockImposter({ port: 4545, _rift: { flowState: {} } });
    expect(await new RemoteClient('http://127.0.0.1:2525').stubWarnings(4545)).toEqual([]);
  });

  it('refuses a malformed block instead of reporting no warnings', async () => {
    mockImposter({ port: 4545, _rift: { warnings: 'x' } });
    await expect(new RemoteClient('http://127.0.0.1:2525').stubWarnings(4545)).rejects.toThrow(RiftError);
    mockImposter({ port: 4545, _rift: 'x' });
    await expect(new RemoteClient('http://127.0.0.1:2525').stubWarnings(4545)).rejects.toThrow(RiftError);
  });
});

describe('rift.connect carries stubWarnings to the engine (issue #170)', () => {
  it("connect(url, { stubWarnings: 'fail' }) → create() deletes and throws", async () => {
    const { rift } = await import('../../src/index.js');
    const seen: string[] = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      seen.push(`${method} ${new URL(url).pathname}`);
      if (method === 'POST') {
        return new Response(JSON.stringify({ port: 4545, protocol: 'http', _rift: { warnings: [IGNORED] } }), {
          status: 201,
        });
      }
      return new Response(JSON.stringify({ port: 4545 }), { status: 200 });
    }) as unknown as typeof fetch;

    const engine = await rift.connect('http://127.0.0.1:2525', { versionCheck: 'off', stubWarnings: 'fail' });
    await expect(engine.create(imposter('x').port(4545))).rejects.toBeInstanceOf(StubWarningsError);
    expect(seen).toEqual(['POST /imposters', 'DELETE /imposters/4545']);
  });
});
