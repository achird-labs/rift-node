/**
 * Gate for issue #10 — `rift.embedded()` wiring: preflight, `EmbeddedAdmin`'s FFI-first routing
 * over a local registry, and the lazy loopback admin-plane bridge.
 *
 * Everything here runs against a FAKE `NativeEngineLike` (no koffi, no cdylib, no real
 * `worker_threads.Worker`) and — for the bridge — a small real `http` server standing in for the
 * loopback `rift_serve_admin` plane, so it's CI-green on every platform, including one where koffi
 * isn't installed (this worktree). The real-cdylib path is exercised by
 * `test/integration/embedded-quickstart.integration.test.ts`, which self-skips without `RIFT_FFI_LIB`.
 */

import http from 'http';
import type { AddressInfo } from 'net';
import { jest } from '@jest/globals';
import { createEmbeddedEngine } from '../src/create.js';
import type { NativeEngineLike, StartAdminPlane } from '../src/admin.js';
import { EngineVersionError, NativeLibraryError, ImposterNotFound, RiftError, WireValidationError } from '@rift-vs/rift';
import { MIN_ENGINE_VERSION } from '@rift-vs/rift/internal';
import type { AdminApi, Imposter, Stub } from '@rift-vs/rift/internal';

// -------------------------------------------------------------------------------------------
// Fake NativeEngineLike — an in-memory stand-in for `librift_ffi`, driven entirely through the
// same JSON-in/JSON-out contract the real `NativeEngine` facade exposes.
// -------------------------------------------------------------------------------------------

class FakeNativeEngine implements NativeEngineLike {
  readonly buildInfo: string;
  calls: Array<{ fn: string; args: unknown[] }> = [];
  closeCalls = 0;
  recordedByPort = new Map<number, unknown[]>();
  spaceRecordedByPort = new Map<string, unknown[]>();
  serveAdminResult: Record<string, unknown> = { adminUrl: 'http://unused-default-plane.invalid' };

  #imposters = new Map<number, unknown>();
  #nextPort: number;
  #flowState = new Map<string, unknown>();
  #spaceStubs = new Map<string, unknown[]>();

  constructor(buildInfo: Record<string, unknown>, startPort = 6000) {
    this.buildInfo = JSON.stringify(buildInfo);
    this.#nextPort = startPort;
  }

  async createImposter(json: string): Promise<number> {
    this.calls.push({ fn: 'createImposter', args: [json] });
    const parsed = JSON.parse(json) as { port?: number };
    const port = typeof parsed.port === 'number' && parsed.port !== 0 ? parsed.port : this.#nextPort++;
    this.#imposters.set(port, json);
    this.recordedByPort.set(port, []);
    return port;
  }

  async replaceStubs(port: number, json: string): Promise<number> {
    this.calls.push({ fn: 'replaceStubs', args: [port, json] });
    if (!this.#imposters.has(port)) throw new RiftError(`no imposter on port ${port}`);
    return (JSON.parse(json) as unknown[]).length;
  }

  async deleteImposter(port: number): Promise<number> {
    this.calls.push({ fn: 'deleteImposter', args: [port] });
    if (!this.#imposters.has(port)) throw new RiftError(`no imposter on port ${port}`);
    this.#imposters.delete(port);
    this.recordedByPort.delete(port);
    return 0;
  }

  async deleteAll(): Promise<number> {
    this.calls.push({ fn: 'deleteAll', args: [] });
    const n = this.#imposters.size;
    this.#imposters.clear();
    this.recordedByPort.clear();
    return n;
  }

  async applyConfig(json: string): Promise<string> {
    this.calls.push({ fn: 'applyConfig', args: [json] });
    const cfg = JSON.parse(json) as { imposters: Array<Record<string, unknown>> };
    const imposters = cfg.imposters.map((imp) => ({
      ...imp,
      port: typeof imp['port'] === 'number' ? imp['port'] : this.#nextPort++,
    }));
    this.#imposters.clear();
    for (const imp of imposters) {
      const port = imp.port as number;
      this.#imposters.set(port, JSON.stringify(imp));
      if (!this.recordedByPort.has(port)) this.recordedByPort.set(port, []);
    }
    return JSON.stringify({ imposters, failed: [] });
  }

  async recorded(port: number): Promise<string> {
    this.calls.push({ fn: 'recorded', args: [port] });
    return JSON.stringify(this.recordedByPort.get(port) ?? []);
  }

  async flowStateGet(port: number, flowId: string, key: string): Promise<{ found: boolean; value?: unknown }> {
    this.calls.push({ fn: 'flowStateGet', args: [port, flowId, key] });
    const k = `${port}/${flowId}/${key}`;
    return this.#flowState.has(k) ? { found: true, value: this.#flowState.get(k) } : { found: false };
  }

  async flowStatePut(port: number, flowId: string, key: string, valueJson: string): Promise<number> {
    this.calls.push({ fn: 'flowStatePut', args: [port, flowId, key, valueJson] });
    this.#flowState.set(`${port}/${flowId}/${key}`, JSON.parse(valueJson));
    return 0;
  }

  async flowStateDelete(port: number, flowId: string, key: string): Promise<number> {
    this.calls.push({ fn: 'flowStateDelete', args: [port, flowId, key] });
    this.#flowState.delete(`${port}/${flowId}/${key}`);
    return 0;
  }

  async spaceAddStub(port: number, flowId: string, json: string): Promise<number> {
    this.calls.push({ fn: 'spaceAddStub', args: [port, flowId, json] });
    const k = `${port}/${flowId}`;
    const list = this.#spaceStubs.get(k) ?? [];
    list.push(JSON.parse(json));
    this.#spaceStubs.set(k, list);
    return 0;
  }

  async spaceListStubs(port: number, flowId: string): Promise<string> {
    this.calls.push({ fn: 'spaceListStubs', args: [port, flowId] });
    return JSON.stringify({ space: flowId, stubs: this.#spaceStubs.get(`${port}/${flowId}`) ?? [] });
  }

  async spaceDelete(port: number, flowId: string): Promise<number> {
    this.calls.push({ fn: 'spaceDelete', args: [port, flowId] });
    this.#spaceStubs.delete(`${port}/${flowId}`);
    return 0;
  }

  async spaceRecorded(port: number, flowId: string): Promise<string> {
    this.calls.push({ fn: 'spaceRecorded', args: [port, flowId] });
    return JSON.stringify(this.spaceRecordedByPort.get(`${port}/${flowId}`) ?? []);
  }

  interceptRules: unknown[] = [];
  interceptStartResult: Record<string, unknown> = {
    interceptPort: 6699,
    interceptUrl: 'http://127.0.0.1:6699',
  };

  async startIntercept(optionsJson: string): Promise<Record<string, unknown>> {
    this.calls.push({ fn: 'startIntercept', args: [optionsJson] });
    return this.interceptStartResult;
  }

  async interceptAddRules(json: string): Promise<number> {
    this.calls.push({ fn: 'interceptAddRules', args: [json] });
    const rules = JSON.parse(json) as unknown[];
    this.interceptRules.push(...rules);
    return rules.length;
  }

  async interceptClearRules(): Promise<number> {
    this.calls.push({ fn: 'interceptClearRules', args: [] });
    const n = this.interceptRules.length;
    this.interceptRules = [];
    return n;
  }

  async interceptListRules(): Promise<string> {
    this.calls.push({ fn: 'interceptListRules', args: [] });
    return JSON.stringify(this.interceptRules);
  }

  async interceptCaPem(): Promise<string> {
    this.calls.push({ fn: 'interceptCaPem', args: [] });
    return '-----BEGIN CERTIFICATE-----\nFAKE\n-----END CERTIFICATE-----\n';
  }

  async interceptExportTruststore(format: string, password: string, outPath: string): Promise<number> {
    this.calls.push({ fn: 'interceptExportTruststore', args: [format, password, outPath] });
    return 0;
  }

  async serveAdmin(optionsJson: string): Promise<Record<string, unknown>> {
    this.calls.push({ fn: 'serveAdmin', args: [optionsJson] });
    return this.serveAdminResult;
  }

  async close(): Promise<void> {
    this.calls.push({ fn: 'close', args: [] });
    this.closeCalls++;
  }
}

function goodBuildInfo(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { version: MIN_ENGINE_VERSION, commit: 'abc123', builtAt: '2026-01-01T00:00:00Z', features: [], ...overrides };
}

// -------------------------------------------------------------------------------------------
// Fake loopback admin plane — a real `http` server standing in for `rift_serve_admin`, so the
// bridge's actual fetch/auth/error-mapping behavior (via `RemoteClient`) is exercised for real.
// -------------------------------------------------------------------------------------------

interface FakePlane {
  url: string;
  requests: Array<{ method: string; path: string }>;
  setExpectedKey(key: string): void;
  close(): Promise<void>;
}

async function startFakePlane(): Promise<FakePlane> {
  let expectedKey = '(unset)';
  const requests: Array<{ method: string; path: string }> = [];
  const server = http.createServer((req, res) => {
    if (req.headers['authorization'] !== `Bearer ${expectedKey}`) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ errors: [{ message: 'unauthorized' }] }));
      return;
    }
    requests.push({ method: req.method ?? 'GET', path: req.url ?? '' });
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.method === 'GET' && req.url?.includes('/scenarios')) {
      res.end(JSON.stringify({ flowId: 'default', scenarios: [] }));
    } else if (req.method === 'GET' && req.url === '/logs') {
      res.end(JSON.stringify([]));
    } else if (req.method === 'GET' && req.url?.includes('/spaces/')) {
      res.end(JSON.stringify({ flowId: 'x' }));
    } else {
      res.end('');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${addr.port}`,
    requests,
    setExpectedKey: (key: string) => {
      expectedKey = key;
    },
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

function trackedStartAdminPlane(plane: FakePlane): { fn: StartAdminPlane; callCount(): number } {
  let calls = 0;
  const fn: StartAdminPlane = async (_native, opts) => {
    calls++;
    plane.setExpectedKey(opts.apiKey);
    return { adminUrl: plane.url };
  };
  return { fn, callCount: () => calls };
}

// -------------------------------------------------------------------------------------------
// Preflight
// -------------------------------------------------------------------------------------------

describe('preflight — version', () => {
  it('an older version fails by default (versionCheck defaults to "fail")', async () => {
    const native = new FakeNativeEngine(goodBuildInfo({ version: '0.1.0' }));
    await expect(createEmbeddedEngine({}, { loadNativeEngine: async () => native })).rejects.toThrow(
      EngineVersionError
    );
  });

  it('an older version warns and continues under versionCheck: "warn"', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const native = new FakeNativeEngine(goodBuildInfo({ version: '0.1.0' }));
      const engine = await createEmbeddedEngine(
        { versionCheck: 'warn' },
        { loadNativeEngine: async () => native }
      );
      expect(warn).toHaveBeenCalledTimes(1);
      await engine.close();
    } finally {
      warn.mockRestore();
    }
  });

  it('an older version is ignored under versionCheck: "off"', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const native = new FakeNativeEngine(goodBuildInfo({ version: '0.1.0' }));
      const engine = await createEmbeddedEngine(
        { versionCheck: 'off' },
        { loadNativeEngine: async () => native }
      );
      expect(warn).not.toHaveBeenCalled();
      await engine.close();
    } finally {
      warn.mockRestore();
    }
  });

  it('a version at least the minimum passes under the default "fail" policy', async () => {
    const native = new FakeNativeEngine(goodBuildInfo({ version: MIN_ENGINE_VERSION }));
    const engine = await createEmbeddedEngine({}, { loadNativeEngine: async () => native });
    await engine.close();
  });
});

describe('preflight — required features', () => {
  it('a missing required feature throws EngineVersionError naming it as a build-variant property', async () => {
    const native = new FakeNativeEngine(goodBuildInfo({ features: ['xpath'] }));
    let threw: unknown;
    try {
      await createEmbeddedEngine({ requireFeatures: ['javascript'] }, { loadNativeEngine: async () => native });
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeInstanceOf(EngineVersionError);
    expect(String((threw as Error).message)).toContain("without 'javascript'");
    expect(String((threw as Error).message)).toContain('build-variant');
  });

  it('all required features present passes', async () => {
    const native = new FakeNativeEngine(goodBuildInfo({ features: ['javascript', 'xpath'] }));
    const engine = await createEmbeddedEngine(
      { requireFeatures: ['javascript'] },
      { loadNativeEngine: async () => native }
    );
    await engine.close();
  });
});

describe('preflight — v1 ABI / native load failure propagates unchanged', () => {
  it('a NativeLibraryError thrown by loadNativeEngine propagates as-is', async () => {
    const original = new NativeLibraryError('ABI v1 library at /x — rift-node requires C-ABI v2 (rift >= 0.12.0)', {
      path: '/x',
    });
    await expect(
      createEmbeddedEngine(
        {},
        {
          loadNativeEngine: async () => {
            throw original;
          },
        }
      )
    ).rejects.toBe(original);
  });
});

// -------------------------------------------------------------------------------------------
// createImposter — always FFI, never the plane (the routing-decision test)
// -------------------------------------------------------------------------------------------

describe('createImposter — always native, inject stubs work with no allowInjection anywhere', () => {
  it('routes through native.createImposter and never touches the admin plane', async () => {
    const native = new FakeNativeEngine(goodBuildInfo());
    const plane = await startFakePlane();
    try {
      const tracked = trackedStartAdminPlane(plane);
      const engine = await createEmbeddedEngine(
        {},
        { loadNativeEngine: async () => native, startAdminPlane: tracked.fn }
      );

      const def: Imposter = {
        port: 0,
        protocol: 'http',
        stubs: [{ responses: [{ inject: 'function(config) { return { statusCode: 200 }; }' }] }],
      };
      const created = await engine.admin.createImposter(def);

      expect(created.port).toBeGreaterThanOrEqual(6000);
      const call = native.calls.find((c) => c.fn === 'createImposter');
      expect(call).toBeDefined();
      expect(String(call?.args[0])).toContain('inject');
      expect(tracked.callCount()).toBe(0); // no plane started for an FFI-only operation
      await engine.close();
    } finally {
      await plane.close();
    }
  });
});

// -------------------------------------------------------------------------------------------
// registry-backed listImposters / getImposter
// -------------------------------------------------------------------------------------------

describe('registry-backed listImposters/getImposter', () => {
  it('numberOfRequests comes from native.recorded(port).length', async () => {
    const native = new FakeNativeEngine(goodBuildInfo());
    const engine = await createEmbeddedEngine({}, { loadNativeEngine: async () => native });

    const a = await engine.admin.createImposter({ port: 0, protocol: 'http', name: 'a' });
    const b = await engine.admin.createImposter({ port: 0, protocol: 'http', name: 'b' });
    native.recordedByPort.set(a.port as number, [{ method: 'GET', path: '/1' }, { method: 'GET', path: '/2' }]);

    const list = await engine.admin.listImposters();
    expect(list.imposters.find((i) => i.port === a.port)?.numberOfRequests).toBe(2);
    expect(list.imposters.find((i) => i.port === b.port)?.numberOfRequests).toBe(0);

    const single = await engine.admin.getImposter(a.port as number);
    expect(single.numberOfRequests).toBe(2);

    await expect(engine.admin.getImposter(999999)).rejects.toBeInstanceOf(ImposterNotFound);
    await engine.close();
  });

  it('replayable omits numberOfRequests; removeProxies drops proxy stubs', async () => {
    const native = new FakeNativeEngine(goodBuildInfo());
    const engine = await createEmbeddedEngine({}, { loadNativeEngine: async () => native });

    const stubs: Stub[] = [
      { responses: [{ is: { statusCode: 200 } }] },
      { responses: [{ proxy: { to: 'http://origin.example' } }] },
    ];
    const imp = await engine.admin.createImposter({ port: 0, protocol: 'http', stubs });

    const replayable = await engine.admin.getImposter(imp.port as number, { replayable: true });
    expect('numberOfRequests' in replayable).toBe(false);

    const noProxies = await engine.admin.getImposter(imp.port as number, { removeProxies: true });
    expect(noProxies.stubs).toHaveLength(1);
    await engine.close();
  });
});

// -------------------------------------------------------------------------------------------
// getSavedRequests: flow_id -> spaceRecorded, other match entries -> #6 evaluator
// -------------------------------------------------------------------------------------------

describe('getSavedRequests match filtering', () => {
  it('flow_id=<id> routes to native.spaceRecorded, not native.recorded', async () => {
    const native = new FakeNativeEngine(goodBuildInfo());
    const engine = await createEmbeddedEngine({}, { loadNativeEngine: async () => native });
    const imp = await engine.admin.createImposter({ port: 0, protocol: 'http' });
    const port = imp.port as number;

    native.spaceRecordedByPort.set(`${port}/flow-1`, [{ method: 'GET', path: '/scoped' }]);
    native.recordedByPort.set(port, [{ method: 'GET', path: '/unscoped' }]);

    const scoped = await engine.admin.getSavedRequests(port, ['flow_id=flow-1']);
    expect(scoped).toEqual([{ method: 'GET', path: '/scoped' }]);
    expect(native.calls.some((c) => c.fn === 'spaceRecorded')).toBe(true);

    const unscoped = await engine.admin.getSavedRequests(port);
    expect(unscoped).toEqual([{ method: 'GET', path: '/unscoped' }]);
    await engine.close();
  });

  it('non-flow_id match entries filter client-side via the #6 evaluator', async () => {
    const native = new FakeNativeEngine(goodBuildInfo());
    const engine = await createEmbeddedEngine({}, { loadNativeEngine: async () => native });
    const imp = await engine.admin.createImposter({ port: 0, protocol: 'http' });
    const port = imp.port as number;

    native.recordedByPort.set(port, [
      { method: 'GET', path: '/keep' },
      { method: 'POST', path: '/drop' },
    ]);

    const filtered = await engine.admin.getSavedRequests(port, ['method=GET']);
    expect(filtered).toEqual([{ method: 'GET', path: '/keep' }]);
    await engine.close();
  });
});

// -------------------------------------------------------------------------------------------
// stub surgery: read-modify-write, differential vs a reference (remote-shaped) implementation
// -------------------------------------------------------------------------------------------

/** Mirrors `RemoteClient`'s index/id stub-surgery semantics against a plain in-memory array, so the
 * embedded transport's registry-backed read-modify-write can be checked against it operation-by-operation. */
class ReferenceStubStore {
  stubs: Stub[] = [];
  addStub(stub: Stub, index?: number): void {
    if (index !== undefined) this.stubs.splice(index, 0, stub);
    else this.stubs.push(stub);
  }
  updateStub(ref: number | { id: string }, stub: Stub): void {
    const i = typeof ref === 'number' ? ref : this.stubs.findIndex((s) => s.id === ref.id);
    this.stubs[i] = stub;
  }
  deleteStub(ref: number | { id: string }): void {
    const i = typeof ref === 'number' ? ref : this.stubs.findIndex((s) => s.id === ref.id);
    this.stubs.splice(i, 1);
  }
}

describe('stub surgery — differential vs a reference index/id implementation', () => {
  it('addStub@index, updateStub byId, deleteStub byId produce the same final stub list', async () => {
    const native = new FakeNativeEngine(goodBuildInfo());
    const engine = await createEmbeddedEngine({}, { loadNativeEngine: async () => native });
    const imp = await engine.admin.createImposter({ port: 0, protocol: 'http', stubs: [] });
    const port = imp.port as number;
    const ref = new ReferenceStubStore();

    const s1: Stub = { id: 'one', responses: [{ is: { statusCode: 200 } }] };
    const s2: Stub = { id: 'two', responses: [{ is: { statusCode: 201 } }] };
    const s3: Stub = { id: 'three', responses: [{ is: { statusCode: 202 } }] };

    await engine.admin.addStub(port, s1);
    ref.addStub(s1);
    await engine.admin.addStub(port, s2, 0);
    ref.addStub(s2, 0);
    await engine.admin.addStub(port, s3);
    ref.addStub(s3);

    const updated: Stub = { id: 'two', responses: [{ is: { statusCode: 299 } }] };
    await engine.admin.updateStub(port, { id: 'two' }, updated);
    ref.updateStub({ id: 'two' }, updated);

    await engine.admin.deleteStub(port, { id: 'one' });
    ref.deleteStub({ id: 'one' });

    const final = (await engine.admin.getImposter(port)).stubs;
    expect(final).toEqual(ref.stubs);
    expect(final?.map((s) => s.id)).toEqual(['two', 'three']);
    await engine.close();
  });

  it('getStub/updateStub/deleteStub on an unknown ref throw ImposterNotFound', async () => {
    const native = new FakeNativeEngine(goodBuildInfo());
    const engine = await createEmbeddedEngine({}, { loadNativeEngine: async () => native });
    const imp = await engine.admin.createImposter({ port: 0, protocol: 'http', stubs: [] });
    const port = imp.port as number;

    await expect(engine.admin.getStub(port, { id: 'missing' })).rejects.toBeInstanceOf(ImposterNotFound);
    await expect(engine.admin.updateStub(port, 5, { responses: [] })).rejects.toBeInstanceOf(ImposterNotFound);
    await expect(engine.admin.deleteStub(port, { id: 'missing' })).rejects.toBeInstanceOf(ImposterNotFound);
    await engine.close();
  });
});

// -------------------------------------------------------------------------------------------
// Bridge: lazy admin plane, started at most once, no plane for FFI-only usage
// -------------------------------------------------------------------------------------------

describe('bridge — lazy loopback admin plane', () => {
  it('starts the plane exactly once across two concurrently-issued bridge methods', async () => {
    const native = new FakeNativeEngine(goodBuildInfo());
    const plane = await startFakePlane();
    try {
      const tracked = trackedStartAdminPlane(plane);
      const engine = await createEmbeddedEngine(
        {},
        { loadNativeEngine: async () => native, startAdminPlane: tracked.fn }
      );
      const imp = await engine.admin.createImposter({ port: 0, protocol: 'http' });
      const port = imp.port as number;

      await Promise.all([engine.admin.logs(), engine.admin.getScenarios(port)]);

      expect(tracked.callCount()).toBe(1);
      await engine.close();
    } finally {
      await plane.close();
    }
  });

  it('never starts the plane when only FFI-backed methods are used', async () => {
    // No real server here: a `startAdminPlane` that's genuinely never called doesn't need one — and
    // asserting that is the whole point of this test.
    let planeCalls = 0;
    const startAdminPlane: StartAdminPlane = async () => {
      planeCalls++;
      return { adminUrl: 'http://should-never-be-reached.invalid' };
    };
    const native = new FakeNativeEngine(goodBuildInfo());
    const engine = await createEmbeddedEngine({}, { loadNativeEngine: async () => native, startAdminPlane });
    const imp = await engine.admin.createImposter({ port: 0, protocol: 'http' });
    await engine.admin.addStub(imp.port as number, { responses: [{ is: { statusCode: 200 } }] });
    await engine.admin.getSavedRequests(imp.port as number);
    await engine.admin.listImposters();

    expect(planeCalls).toBe(0);
    await engine.close();
  });

  it('a bridge request without the generated key is rejected (401) by the plane', async () => {
    const native = new FakeNativeEngine(goodBuildInfo());
    const plane = await startFakePlane();
    try {
      const tracked = trackedStartAdminPlane(plane);
      const engine = await createEmbeddedEngine(
        {},
        { loadNativeEngine: async () => native, startAdminPlane: tracked.fn }
      );
      await engine.admin.logs(); // starts the plane, sets the expected key

      const res = await fetch(`${plane.url}/logs`); // no Authorization header
      expect(res.status).toBe(401);
      await engine.close();
    } finally {
      await plane.close();
    }
  });

  it('adminUrl() starts the plane exactly once, even when called twice', async () => {
    const native = new FakeNativeEngine(goodBuildInfo());
    const plane = await startFakePlane();
    try {
      const tracked = trackedStartAdminPlane(plane);
      const engine = await createEmbeddedEngine(
        {},
        { loadNativeEngine: async () => native, startAdminPlane: tracked.fn }
      );
      const [first, second] = await Promise.all([engine.adminUrl(), engine.adminUrl()]);
      expect(first).toBe(plane.url);
      expect(second).toBe(plane.url);
      expect(tracked.callCount()).toBe(1);
      await engine.close();
    } finally {
      await plane.close();
    }
  });
});

// -------------------------------------------------------------------------------------------
// buildInfo(), close() idempotency, engine independence
// -------------------------------------------------------------------------------------------

describe('engine.buildInfo() returns the parsed static value with no admin round-trip', () => {
  it('reflects version/commit/builtAt/features from native.buildInfo', async () => {
    const native = new FakeNativeEngine(
      goodBuildInfo({ version: MIN_ENGINE_VERSION, commit: 'deadbeef', builtAt: '2026-02-02T00:00:00Z', features: ['javascript'] })
    );
    const engine = await createEmbeddedEngine({}, { loadNativeEngine: async () => native });
    const info = await engine.buildInfo();
    expect(info).toEqual({
      version: MIN_ENGINE_VERSION,
      commit: 'deadbeef',
      builtAt: '2026-02-02T00:00:00Z',
      features: ['javascript'],
    });
    await engine.close();
  });
});

describe('close() is idempotent', () => {
  it('a second close() does not call native.close() again', async () => {
    const native = new FakeNativeEngine(goodBuildInfo());
    const engine = await createEmbeddedEngine({}, { loadNativeEngine: async () => native });
    await engine.close();
    await engine.close();
    expect(native.closeCalls).toBe(1);
  });
});

describe('two engines are independent', () => {
  it('separate registries, and closing one does not affect the other', async () => {
    const nativeA = new FakeNativeEngine(goodBuildInfo(), 7000);
    const nativeB = new FakeNativeEngine(goodBuildInfo(), 8000);
    const engineA = await createEmbeddedEngine({}, { loadNativeEngine: async () => nativeA });
    const engineB = await createEmbeddedEngine({}, { loadNativeEngine: async () => nativeB });

    const a = await engineA.admin.createImposter({ port: 0, protocol: 'http' });
    const b = await engineB.admin.createImposter({ port: 0, protocol: 'http' });
    expect(a.port).not.toBe(b.port);

    await expect(engineA.admin.getImposter(b.port as number)).rejects.toBeInstanceOf(ImposterNotFound);

    await engineA.close();
    expect(nativeA.closeCalls).toBe(1);
    expect(nativeB.closeCalls).toBe(0);

    await expect(engineB.admin.getImposter(b.port as number)).resolves.toMatchObject({ port: b.port });
    await engineB.close();
  });
});

// -------------------------------------------------------------------------------------------
// Bridge method passthrough — the individual bridge-routed AdminApi methods reach the plane
// (auth'd) — issue #10 acceptance (setScenarioState/resetScenarios/deleteSavedRequests/disable)
// -------------------------------------------------------------------------------------------

describe('bridge — individual method passthrough', () => {
  it('setScenarioState / resetScenarios / deleteSavedRequests / disableImposter reach the auth\'d plane', async () => {
    const native = new FakeNativeEngine(goodBuildInfo());
    const plane = await startFakePlane();
    try {
      const tracked = trackedStartAdminPlane(plane);
      const engine = await createEmbeddedEngine(
        {},
        { loadNativeEngine: async () => native, startAdminPlane: tracked.fn }
      );
      const imp = await engine.admin.createImposter({ port: 0, protocol: 'http' });
      const port = imp.port as number;

      // Each resolves (proves wiring + Bearer auth — a keyless/wrong-key request would 401 and throw).
      await engine.admin.setScenarioState(port, 'flow', 'LoggedIn');
      await engine.admin.resetScenarios(port);
      await engine.admin.deleteSavedRequests(port);
      await engine.admin.disableImposter(port);

      // All four landed on the loopback plane (the plane records only authenticated requests).
      expect(plane.requests.length).toBeGreaterThanOrEqual(4);
      expect(tracked.callCount()).toBe(1); // one shared plane for all four
      await engine.close();
    } finally {
      await plane.close();
    }
  });
});

// -------------------------------------------------------------------------------------------
// Two engines — independent admin PLANES (distinct loopback URLs + keys), not just registries
// -------------------------------------------------------------------------------------------

describe('two engines — independent admin planes', () => {
  it('each engine starts its own plane with a distinct url and key', async () => {
    const planeA = await startFakePlane();
    const planeB = await startFakePlane();
    try {
      const trackedA = trackedStartAdminPlane(planeA);
      const trackedB = trackedStartAdminPlane(planeB);
      const keys: string[] = [];
      const wrap = (t: { fn: StartAdminPlane }): StartAdminPlane => async (native, opts) => {
        keys.push(opts.apiKey);
        return t.fn(native, opts);
      };
      const engineA = await createEmbeddedEngine(
        {},
        { loadNativeEngine: async () => new FakeNativeEngine(goodBuildInfo()), startAdminPlane: wrap(trackedA) }
      );
      const engineB = await createEmbeddedEngine(
        {},
        { loadNativeEngine: async () => new FakeNativeEngine(goodBuildInfo()), startAdminPlane: wrap(trackedB) }
      );

      const urlA = await engineA.adminUrl();
      const urlB = await engineB.adminUrl();
      expect(urlA).toBe(planeA.url);
      expect(urlB).toBe(planeB.url);
      expect(urlA).not.toBe(urlB); // distinct planes
      expect(keys).toHaveLength(2);
      expect(keys[0]).not.toBe(keys[1]); // independent per-engine random keys

      // Closing one leaves the other's plane usable.
      await engineA.close();
      await expect(engineB.admin.logs()).resolves.toBeDefined();
      await engineB.close();
    } finally {
      await planeA.close();
      await planeB.close();
    }
  });
});

// -------------------------------------------------------------------------------------------
// issue #112 — the embedded transport serializes caller data with the same JSON-safety guard the
// remote/spawn transports use. Without it, `NaN` reached the native engine as `null`.
// -------------------------------------------------------------------------------------------

describe('issue #112 — embedded FFI payloads are JSON-safe', () => {
  async function engineWithFake(): Promise<{ engine: Awaited<ReturnType<typeof createEmbeddedEngine>>; native: FakeNativeEngine }> {
    const native = new FakeNativeEngine(goodBuildInfo());
    const engine = await createEmbeddedEngine({}, { loadNativeEngine: async () => native });
    return { engine, native };
  }

  it('createImposter refuses a non-finite number instead of handing the native engine a null', async () => {
    const { engine, native } = await engineWithFake();
    try {
      await expect(
        engine.admin.createImposter({
          port: 0,
          protocol: 'http',
          stubs: [{ responses: [{ is: { body: { temperature: NaN } } } as never] }],
        })
      ).rejects.toThrow(WireValidationError);
      expect(native.calls.filter((c) => c.fn === 'createImposter')).toEqual([]);
    } finally {
      await engine.close();
    }
  });

  it('createImposter refuses a bigint with a typed error, not a raw TypeError', async () => {
    const { engine, native } = await engineWithFake();
    try {
      const thrown = await engine.admin
        .createImposter({ port: 0, protocol: 'http', meta: 1n } as never)
        .catch((e: unknown) => e);
      expect(thrown).toBeInstanceOf(WireValidationError);
      expect(thrown).not.toBeInstanceOf(TypeError);
      expect(native.calls.filter((c) => c.fn === 'createImposter')).toEqual([]);
    } finally {
      await engine.close();
    }
  });

  it('setFlowState refuses a non-finite value', async () => {
    const { engine, native } = await engineWithFake();
    try {
      const created = await engine.admin.createImposter({ port: 0, protocol: 'http', stubs: [] });
      await expect(
        engine.admin.setFlowState(created.port, 'flow', 'key', Infinity)
      ).rejects.toThrow(WireValidationError);
      expect(native.calls.filter((c) => c.fn === 'flowStatePut')).toEqual([]);
    } finally {
      await engine.close();
    }
  });

  // Each embedded site calls stringifyJsonSafe independently — there is no chokepoint like
  // RemoteClient.toRequestInit — so every one needs its own test or a future edit can revert that
  // single line back to JSON.stringify with the suite still green.
  const badStub: Stub = { responses: [{ is: { body: { n: NaN } } } as never] };
  const stubRoutes: Array<[string, (a: AdminApi, port: number) => Promise<unknown>]> = [
    ['addStub', (a, port) => a.addStub(port, badStub)],
    ['replaceStubs', (a, port) => a.replaceStubs(port, [badStub])],
    ['updateStub', (a, port) => a.updateStub(port, 0, badStub)],
    ['addSpaceStub', (a, port) => a.addSpaceStub(port, 'flow', badStub)],
  ];

  it.each(stubRoutes)('%s refuses a non-finite number and calls no native fn', async (name, call) => {
    const { engine, native } = await engineWithFake();
    try {
      const created = await engine.admin.createImposter({
        port: 0,
        protocol: 'http',
        stubs: [{ responses: [{ is: { statusCode: 200 } }] }],
      });
      const before = native.calls.length;
      await expect(call(engine.admin, created.port)).rejects.toThrow(WireValidationError);
      expect(native.calls.slice(before)).toEqual([]);
    } finally {
      await engine.close();
    }
  });

  it('replaceImposters refuses a non-finite number', async () => {
    const { engine, native } = await engineWithFake();
    try {
      await expect(
        engine.admin.replaceImposters({
          imposters: [
            { port: 0, protocol: 'http', stubs: [{ responses: [{ is: { body: { n: Infinity } } } as never] }] },
          ],
        })
      ).rejects.toThrow(WireValidationError);
      expect(native.calls.filter((c) => c.fn === 'applyConfig')).toEqual([]);
    } finally {
      await engine.close();
    }
  });

  it('names the offending key and refuses a circular reference on the embedded path too', async () => {
    const { engine } = await engineWithFake();
    try {
      await expect(
        engine.admin.createImposter({
          port: 0,
          protocol: 'http',
          stubs: [{ responses: [{ is: { body: { temperature: NaN } } } as never] }],
        })
      ).rejects.toThrow(/temperature/);
      const circular: Record<string, unknown> = { port: 0, protocol: 'http' };
      circular.self = circular;
      await expect(engine.admin.createImposter(circular as never)).rejects.toThrow(WireValidationError);
    } finally {
      await engine.close();
    }
  });

  it('refuses a top-level undefined rather than serializing no JSON at all', async () => {
    // setFlowState passes the raw value straight to stringifyJsonSafe, so this is the one caller
    // that can reach the `encoded === undefined` branch.
    const { engine, native } = await engineWithFake();
    try {
      const created = await engine.admin.createImposter({ port: 0, protocol: 'http', stubs: [] });
      await expect(
        engine.admin.setFlowState(created.port, 'flow', 'key', undefined)
      ).rejects.toThrow(WireValidationError);
      expect(native.calls.filter((c) => c.fn === 'flowStatePut')).toEqual([]);
    } finally {
      await engine.close();
    }
  });

  it('leaves a valid imposter byte-identical to the unguarded serialization', async () => {
    const { engine, native } = await engineWithFake();
    try {
      const def: Imposter = { port: 0, protocol: 'http', stubs: [] };
      await engine.admin.createImposter(def);
      const call = native.calls.find((c) => c.fn === 'createImposter');
      expect(call?.args[0]).toBe(JSON.stringify(def));
    } finally {
      await engine.close();
    }
  });
});
