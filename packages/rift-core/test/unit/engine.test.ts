/**
 * Gate for issue #21 (RiftEngine + handles arm) — the facade is implemented once over an AdminApi.
 * Uses an in-memory FakeAdminApi (which also pins the AdminApi interface shape) to test create →
 * url/port, get/list/deleteAll, stub surgery, space/flow-state handles, disposal idempotency, and
 * buildInfo mapping — with no live engine. Version preflight is tested through rift.connect.
 */

import { jest } from '@jest/globals';
import { Engine, type AdminApi } from '../../src/engine.js';
import { imposter, onGet, okJson } from '../../src/dsl/index.js';
import { ImposterNotFound, EngineVersionError, EngineUnavailable } from '../../src/errors.js';
import type { Imposter, ImpostersConfig, Stub, RecordedRequest } from '../../src/model/index.js';

/** In-memory AdminApi backing store. Assigns ports from 5000 up when a create omits `port`. */
class FakeAdminApi implements AdminApi {
  imposters = new Map<number, Imposter>();
  flow = new Map<string, unknown>();
  #closed = false;
  #nextPort = 5000;
  configVersion: string | undefined = '0.99.0';
  configCommit: string | undefined;
  configBuiltAt: string | undefined;
  url?: string;
  // call tracking for facade glue assertions
  enabled: number[] = [];
  disabled: number[] = [];
  scenarioStateCalls: Array<{ port: number; name: string; state: string; flowId?: string }> = [];
  resetScenarioCalls: Array<{ port: number; flowId?: string }> = [];
  spaceStubs: Array<{ port: number; flowId: string; stub: Stub }> = [];
  deletedSpaces: Array<{ port: number; flowId: string }> = [];
  replaceStubsCalls: Array<{ port: number; stubs: Stub[] }> = [];
  replaceImpostersCalls = 0;

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
    const imp = this.imposters.get(port);
    if (!imp) throw new ImposterNotFound(`no imposter on ${port}`);
    this.imposters.delete(port);
    return imp;
  }
  async deleteAllImposters(): Promise<void> {
    this.imposters.clear();
  }
  async replaceImposters(config: ImpostersConfig): Promise<ImpostersConfig> {
    this.replaceImpostersCalls++;
    this.imposters.clear();
    for (const imp of config.imposters) await this.createImposter(imp);
    return { imposters: [...this.imposters.values()] };
  }
  async addStub(port: number, stub: Stub): Promise<void> {
    const imp = await this.getImposter(port);
    imp.stubs = [...(imp.stubs ?? []), stub];
  }
  async replaceStubs(port: number, stubs: Stub[]): Promise<void> {
    this.replaceStubsCalls.push({ port, stubs });
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
  async getSavedRequests(): Promise<RecordedRequest[]> {
    return [];
  }
  async deleteSavedRequests(): Promise<void> {}
  async deleteSavedProxyResponses(): Promise<void> {}
  async enableImposter(port: number): Promise<void> {
    this.enabled.push(port);
  }
  async disableImposter(port: number): Promise<void> {
    this.disabled.push(port);
  }
  async getScenarios(
    _port: number,
    opts?: { flowId?: string }
  ): Promise<{ flowId: string; scenarios: Array<{ name: string; state: string }> }> {
    return { flowId: opts?.flowId ?? 'default', scenarios: [{ name: 'checkout', state: 'Started' }] };
  }
  async setScenarioState(port: number, name: string, state: string, opts?: { flowId?: string }): Promise<void> {
    this.scenarioStateCalls.push({ port, name, state, flowId: opts?.flowId });
  }
  async resetScenarios(port: number, opts?: { flowId?: string }): Promise<void> {
    this.resetScenarioCalls.push({ port, flowId: opts?.flowId });
  }
  async addSpaceStub(port: number, flowId: string, stub: Stub): Promise<void> {
    this.spaceStubs.push({ port, flowId, stub });
  }
  async listSpaceStubs(_port: number, flowId: string): Promise<{ space: string; stubs: Stub[] }> {
    return { space: flowId, stubs: this.spaceStubs.filter((s) => s.flowId === flowId).map((s) => s.stub) };
  }
  async getSpace<T>(): Promise<T> {
    return {} as T;
  }
  async deleteSpace(port: number, flowId: string): Promise<void> {
    this.deletedSpaces.push({ port, flowId });
  }
  async getFlowState<T>(_p: number, flowId: string, key: string): Promise<T | undefined> {
    return this.flow.get(`${flowId}/${key}`) as T | undefined;
  }
  async setFlowState(_p: number, flowId: string, key: string, value: unknown): Promise<void> {
    this.flow.set(`${flowId}/${key}`, value);
  }
  async deleteFlowState(_p: number, flowId: string, key: string): Promise<void> {
    this.flow.delete(`${flowId}/${key}`);
  }
  async config(): Promise<Record<string, unknown>> {
    const options: Record<string, unknown> = {};
    if (this.configVersion !== undefined) options['version'] = this.configVersion;
    if (this.configCommit !== undefined) options['commit'] = this.configCommit;
    if (this.configBuiltAt !== undefined) options['builtAt'] = this.configBuiltAt;
    return { options };
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

describe('issue #21 — RiftEngine facade over AdminApi', () => {
  it('create() returns a handle whose port comes from the engine and url normalizes the bind host', async () => {
    const admin = new FakeAdminApi();
    const engine = engineOf(admin);
    const h = await engine.create(imposter('users').stub(onGet('/x').willReturn(okJson({ ok: true }))));
    expect(h.port).toBe(5000); // assigned by the fake engine
    expect(h.url).toBe('http://127.0.0.1:5000');
    expect(h.name).toBe('users');
  });

  it('create() respects an explicit port and https protocol', async () => {
    const engine = engineOf(new FakeAdminApi());
    const h = await engine.create(imposter('s').port(8443).protocol('https'));
    expect(h.port).toBe(8443);
    expect(h.url).toBe('https://127.0.0.1:8443');
  });

  it('create() accepts a raw wire.Imposter (fromJson path) and respects its port', async () => {
    const engine = engineOf(new FakeAdminApi());
    const h = await engine.create({ port: 6001, protocol: 'http', stubs: [] });
    expect(h.port).toBe(6001);
  });

  it('get() attaches to an existing imposter; list() summarizes', async () => {
    const admin = new FakeAdminApi();
    const engine = engineOf(admin);
    await engine.create(imposter('a').port(7001));
    await engine.create(imposter('b').port(7002));
    const h = await engine.get(7001);
    expect(h.port).toBe(7001);
    const summary = await engine.list();
    expect(summary.map((s) => s.port).sort()).toEqual([7001, 7002]);
    expect(summary.find((s) => s.port === 7001)?.name).toBe('a');
  });

  it('handle stub surgery delegates: add, then update/delete by index and by id', async () => {
    const admin = new FakeAdminApi();
    const engine = engineOf(admin);
    const h = await engine.create(imposter('s').port(7100));
    await h.addStub(onGet('/a').willReturn(okJson({ a: 1 })));
    await h.addStub({ id: 'sid', responses: [] });
    expect((await h.stubs()).length).toBe(2);
    await h.updateStub(0, onGet('/b').willReturn(okJson({ b: 2 })));
    await h.deleteStub({ id: 'sid' });
    expect((await h.stubs()).length).toBe(1);
  });

  it('space() and flowState() handles scope to a flow id; flow-state get is undefined when absent', async () => {
    const admin = new FakeAdminApi();
    const engine = engineOf(admin);
    const h = await engine.create(imposter('s').port(7200));
    const fs = h.flowState('flow-1');
    expect(await fs.get('missing')).toBeUndefined();
    await fs.set('k', { n: 5 });
    expect(await fs.get('k')).toEqual({ n: 5 });
    await fs.delete('k');
    expect(await fs.get('k')).toBeUndefined();
    expect(h.space('flow-1').flowId).toBe('flow-1');
  });

  it('handle disposal deletes; double-dispose swallows ImposterNotFound', async () => {
    const admin = new FakeAdminApi();
    const engine = engineOf(admin);
    const h = await engine.create(imposter('s').port(7300));
    await h.delete();
    expect(admin.imposters.has(7300)).toBe(false);
    await expect(h.delete()).resolves.toBeUndefined(); // idempotent
    await expect(h[Symbol.asyncDispose]()).resolves.toBeUndefined();
  });

  it('engine.close() closes the AdminApi and is idempotent', async () => {
    const admin = new FakeAdminApi();
    const engine = engineOf(admin);
    await engine.close();
    expect(admin.closed).toBe(true);
    expect(engine.closed).toBe(true);
    await expect(engine.close()).resolves.toBeUndefined();
  });

  it('buildInfo() maps /config into { version, features }', async () => {
    const admin = new FakeAdminApi();
    admin.configVersion = '0.13.1';
    const info = await engineOf(admin).buildInfo();
    expect(info.version).toBe('0.13.1');
    expect(Array.isArray(info.features)).toBe(true);
  });

  it('toJson() round-trips: created imposter is retrievable as wire JSON', async () => {
    const engine = engineOf(new FakeAdminApi());
    const h = await engine.create(imposter('rt').port(7400).stub(onGet('/z').willReturn(okJson({ z: 1 }))));
    const json = await h.toJson();
    expect(json.port).toBe(7400);
    expect(json.stubs?.length).toBe(1);
  });

  it('handle enable()/disable() delegate to the admin with the handle port', async () => {
    const admin = new FakeAdminApi();
    const h = await engineOf(admin).create(imposter('s').port(7500));
    await h.enable();
    await h.disable();
    expect(admin.enabled).toEqual([7500]);
    expect(admin.disabled).toEqual([7500]);
  });

  it('handle replaceStubs() replaces the whole stub list', async () => {
    const admin = new FakeAdminApi();
    const h = await engineOf(admin).create(imposter('s').port(7550).stub(onGet('/old').willReturn(okJson({}))));
    await h.replaceStubs(onGet('/a').willReturn(okJson({ a: 1 })), onGet('/b').willReturn(okJson({ b: 2 })));
    expect(admin.replaceStubsCalls).toHaveLength(1);
    expect(admin.replaceStubsCalls[0]?.stubs).toHaveLength(2);
    expect((await h.stubs()).length).toBe(2);
  });

  it('handle scenarios()/setScenarioState()/resetScenarios() flow through, incl. flowId', async () => {
    const admin = new FakeAdminApi();
    const h = await engineOf(admin).create(imposter('s').port(7600));
    expect(await h.scenarios()).toEqual([{ name: 'checkout', state: 'Started' }]);
    await h.setScenarioState('checkout', 'paid', 'flow-9');
    await h.resetScenarios('flow-9');
    expect(admin.scenarioStateCalls[0]).toEqual({ port: 7600, name: 'checkout', state: 'paid', flowId: 'flow-9' });
    expect(admin.resetScenarioCalls[0]).toEqual({ port: 7600, flowId: 'flow-9' });
  });

  it('space() handle scopes addStub/stubs/teardown and scenarios to its flow id', async () => {
    const admin = new FakeAdminApi();
    const h = await engineOf(admin).create(imposter('s').port(7700));
    const space = h.space('flow-A');
    await space.addStub(onGet('/scoped').willReturn(okJson({ s: 1 })));
    expect(admin.spaceStubs[0]).toMatchObject({ port: 7700, flowId: 'flow-A' });
    expect((await space.stubs()).stubs).toHaveLength(1);
    await space.setScenarioState('checkout', 'shipped');
    expect(admin.scenarioStateCalls.at(-1)).toMatchObject({ flowId: 'flow-A', state: 'shipped' });
    await space.delete();
    expect(admin.deletedSpaces).toEqual([{ port: 7700, flowId: 'flow-A' }]);
  });

  it('engine.replaceAll() replaces the imposter set and returns handles', async () => {
    const admin = new FakeAdminApi();
    const engine = engineOf(admin);
    await engine.create(imposter('old').port(7800));
    const handles = await engine.replaceAll([imposter('a').port(7801), imposter('b').port(7802)]);
    expect(admin.replaceImpostersCalls).toBe(1);
    expect(handles.map((x) => x.port).sort()).toEqual([7801, 7802]);
    expect(admin.imposters.has(7800)).toBe(false);
  });

  // await using requires Symbol.asyncDispose, available since Node 20.12.0
  const hasAsyncDispose = Symbol.asyncDispose !== undefined;

  it('await using disposes the engine and the handle (Symbol.asyncDispose wiring)', async () => {
    if (!hasAsyncDispose) {
      // Guard for Node versions that don't support Symbol.asyncDispose yet
      expect(true).toBe(true); // placeholder
      return;
    }

    const admin = new FakeAdminApi();
    {
      await using engine = engineOf(admin);
      await using h = await engine.create(imposter('s').port(7900));
      expect(admin.imposters.has(7900)).toBe(true);
      void h;
    }
    // Block exit disposed the handle (delete) then the engine (close).
    expect(admin.imposters.has(7900)).toBe(false);
    expect(admin.closed).toBe(true);
  });

  it('adminUrl() returns the admin client url, and throws EngineUnavailable when absent', async () => {
    const withUrl = new FakeAdminApi();
    withUrl.url = 'http://localhost:2525';
    expect(await new Engine(withUrl, 'remote').adminUrl()).toBe('http://localhost:2525');

    const noUrl = new FakeAdminApi();
    let threw: unknown;
    try {
      await new Engine(noUrl, 'embedded').adminUrl();
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeInstanceOf(EngineUnavailable);
  });

  it('buildInfo() maps commit and builtAt when the engine reports them', async () => {
    const admin = new FakeAdminApi();
    admin.configVersion = '0.14.0';
    admin.configCommit = 'abc1234';
    admin.configBuiltAt = '2026-07-09T00:00:00Z';
    const info = await engineOf(admin).buildInfo();
    expect(info).toMatchObject({ version: '0.14.0', commit: 'abc1234', builtAt: '2026-07-09T00:00:00Z' });
  });

  it('handle.url normalizes an any-interface hostHint (0.0.0.0) to loopback', async () => {
    const engine = new Engine(new FakeAdminApi(), 'spawn', { hostHint: '0.0.0.0' });
    const h = await engine.create(imposter('s').port(7950));
    expect(h.url).toBe('http://127.0.0.1:7950');
  });

  it('engine.close() still closes the admin client when onClose throws', async () => {
    const admin = new FakeAdminApi();
    const engine = new Engine(admin, 'spawn', {
      hostHint: '127.0.0.1',
      onClose: async () => {
        throw new Error('kill failed');
      },
    });
    await expect(engine.close()).rejects.toThrow('kill failed');
    expect(admin.closed).toBe(true); // no client leak despite the onClose failure
  });
});

describe('issue #21 — rift.connect version preflight', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    jest.restoreAllMocks();
  });

  function stubConfig(version: string): void {
    // rift.connect issues GET /config during preflight; everything else is unused here.
    globalThis.fetch = jest.fn(async () =>
      new Response(JSON.stringify({ options: { version } }), { status: 200 })
    ) as unknown as typeof fetch;
  }

  it("versionCheck 'fail' throws EngineVersionError for an engine below minEngineVersion", async () => {
    const { rift } = await import('../../src/index.js');
    stubConfig('0.1.0');
    await expect(rift.connect('http://localhost:2525', { versionCheck: 'fail' })).rejects.toBeInstanceOf(
      EngineVersionError
    );
  });

  it("versionCheck 'warn' resolves (warns) for an old engine", async () => {
    const { rift } = await import('../../src/index.js');
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    stubConfig('0.1.0');
    const engine = await rift.connect('http://localhost:2525', { versionCheck: 'warn' });
    expect(engine.transport).toBe('remote');
    expect(warn).toHaveBeenCalled();
    await engine.close();
  });

  it("versionCheck 'off' skips the check entirely", async () => {
    const { rift } = await import('../../src/index.js');
    stubConfig('0.0.1');
    const engine = await rift.connect('http://localhost:2525', { versionCheck: 'off' });
    expect(engine.transport).toBe('remote');
    await engine.close();
  });

  it('a current engine connects cleanly under the default (fail) policy', async () => {
    const { rift } = await import('../../src/index.js');
    stubConfig('0.99.0');
    const engine = await rift.connect('http://localhost:2525');
    expect(engine.transport).toBe('remote');
    await engine.close();
  });

  it("'fail' throws when the engine reports no version at all (can't-check is not a pass)", async () => {
    const { rift } = await import('../../src/index.js');
    globalThis.fetch = jest.fn(async () =>
      new Response(JSON.stringify({ options: {} }), { status: 200 })
    ) as unknown as typeof fetch;
    await expect(rift.connect('http://localhost:2525', { versionCheck: 'fail' })).rejects.toBeInstanceOf(
      EngineVersionError
    );
  });

  it("'warn' does not hard-throw on an unrecognizable version string (degrades to a warning)", async () => {
    const { rift } = await import('../../src/index.js');
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    stubConfig('nightly-build');
    const engine = await rift.connect('http://localhost:2525', { versionCheck: 'warn' });
    expect(warn).toHaveBeenCalled();
    await engine.close();
  });
});

// The guard lives in the RemoteClient constructor, so the facade is covered by construction — but
// only if `connect()` doesn't reach the network first. This pins that it throws before the version
// preflight, which would otherwise turn a blank key into a confusing connectivity/version error.
describe('rift.connect — blank apiKey is rejected before any request (issue #96)', () => {
  it('rejects an empty apiKey without calling fetch', async () => {
    const { rift } = await import('../../src/index.js');
    const { InvalidDefinition } = await import('../../src/errors.js');
    const fetchMock = jest.fn(async () => new Response('{}', { status: 200 }));
    // @ts-expect-error override global for the test
    globalThis.fetch = fetchMock;

    await expect(rift.connect('http://localhost:2525', { apiKey: '' })).rejects.toThrow(
      InvalidDefinition
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
