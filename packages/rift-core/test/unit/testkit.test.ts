/**
 * Gate for issue #12 (testkit: Vitest fixtures + Jest helpers + assertReceived).
 *
 * Everything here runs against a fake `RiftEngine`/`ImposterHandle` (no real engine, no process
 * spawn, no cdylib) so the core tracking/acquisition machinery (`src/testkit/core.ts`) and the real
 * `setupRift` (`src/testkit/jest.ts`) are exercised deterministically under CI. `vitest.ts` isn't
 * touched here at all — it statically imports `vitest`, which isn't installed in this worktree; see
 * `test/integration/testkit-vitest.integration.test.ts` for its self-skipping coverage.
 */

import { jest } from '@jest/globals';
import { imposter, onGet } from '../../src/dsl/index.js';
import { EngineUnavailable, VerificationError } from '../../src/errors.js';
import { times, type CountMatcher, type RequestMatch } from '../../src/verify/index.js';
import type {
  AdminApi,
  BuildInfo,
  ImposterHandle,
  ImposterSummary,
  InterceptHandle,
  RiftEngine,
  Transport,
} from '../../src/engine.js';
import type { ImposterBuilder } from '../../src/dsl/imposter.js';
import type { Imposter } from '../../src/model/index.js';
import { acquireEngine, disposeTracked, trackCreates, type AcquireEngineDeps } from '../../src/testkit/core.js';
import { assertReceived } from '../../src/testkit/assert.js';
import { setupRift } from '../../src/testkit/jest.js';

// --- fakes -----------------------------------------------------------------------------------

function unimplemented(name: string): () => never {
  return () => {
    throw new Error(`fake ImposterHandle.${name} was not expected to be called in this test`);
  };
}

/** A minimal, fully-typed `ImposterHandle` fake: only `verify`/`delete` are meaningfully
 * implemented (injectable), everything else throws if touched — this gate never needs it. */
function fakeImposterHandle(
  port: number,
  overrides: { verify?: ImposterHandle['verify']; deleteMock?: () => Promise<void> } = {}
): ImposterHandle {
  const deleteMock = overrides.deleteMock ?? (async () => {});
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    name: undefined,
    protocol: 'http',
    addStub: unimplemented('addStub'),
    replaceStubs: unimplemented('replaceStubs'),
    updateStub: unimplemented('updateStub'),
    deleteStub: unimplemented('deleteStub'),
    stubs: unimplemented('stubs'),
    recorded: unimplemented('recorded'),
    clearRecorded: unimplemented('clearRecorded'),
    verify: overrides.verify ?? unimplemented('verify'),
    requests: unimplemented('requests'),
    scenarios: unimplemented('scenarios'),
    setScenarioState: unimplemented('setScenarioState'),
    resetScenarios: unimplemented('resetScenarios'),
    space: unimplemented('space'),
    flowState: unimplemented('flowState'),
    enable: unimplemented('enable'),
    disable: unimplemented('disable'),
    clearProxyRecordings: unimplemented('clearProxyRecordings'),
    toJson: unimplemented('toJson'),
    warnings: unimplemented('warnings'),
    delete: deleteMock,
    [Symbol.asyncDispose]: deleteMock,
  };
}

/** A minimal, fully-typed `RiftEngine` fake with in-memory create/get/deleteAll/replaceAll and
 * `deletedPorts` tracking so tests can assert which handles were actually torn down. */
class FakeEngine implements RiftEngine {
  readonly transport: Transport;
  #closed = false;
  #nextPort = 9500;
  #handles = new Map<number, ImposterHandle>();
  deletedPorts: number[] = [];
  createCalls: Array<ImposterBuilder | Imposter> = [];
  replaceAllCalls: Array<Array<ImposterBuilder | Imposter>> = [];
  getCalls: number[] = [];
  deleteAllCalls = 0;
  closeCalls = 0;

  constructor(transport: Transport = 'spawn') {
    this.transport = transport;
  }

  #makeHandle(port: number): ImposterHandle {
    return fakeImposterHandle(port, {
      deleteMock: async () => {
        this.deletedPorts.push(port);
      },
    });
  }

  async create(def: ImposterBuilder | Imposter): Promise<ImposterHandle> {
    this.createCalls.push(def);
    const port = this.#nextPort++;
    const handle = this.#makeHandle(port);
    this.#handles.set(port, handle);
    return handle;
  }

  async get(port: number): Promise<ImposterHandle> {
    this.getCalls.push(port);
    const existing = this.#handles.get(port);
    if (existing !== undefined) return existing;
    const handle = this.#makeHandle(port);
    this.#handles.set(port, handle);
    return handle;
  }

  async list(): Promise<ImposterSummary[]> {
    return [];
  }

  async deleteAll(): Promise<void> {
    this.deleteAllCalls++;
    this.#handles.clear();
  }

  async replaceAll(defs: Array<ImposterBuilder | Imposter>): Promise<ImposterHandle[]> {
    this.replaceAllCalls.push(defs);
    return defs.map(() => {
      const port = this.#nextPort++;
      const handle = this.#makeHandle(port);
      this.#handles.set(port, handle);
      return handle;
    });
  }

  async buildInfo(): Promise<BuildInfo> {
    throw new Error('fake RiftEngine.buildInfo was not expected to be called in this test');
  }

  async adminUrl(): Promise<string> {
    return 'http://127.0.0.1:0';
  }

  async intercept(): Promise<InterceptHandle> {
    throw new Error('fake RiftEngine.intercept was not expected to be called in this test');
  }

  get admin(): AdminApi {
    throw new Error('fake RiftEngine.admin was not expected to be read in this test');
  }

  async close(): Promise<void> {
    this.closeCalls++;
    this.#closed = true;
  }

  get closed(): boolean {
    return this.#closed;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}

function neverCalled(label: string) {
  return jest.fn(async () => {
    throw new Error(`${label} was not expected to be called`);
  });
}

// --- trackCreates ------------------------------------------------------------------------------

describe('trackCreates', () => {
  it('tracks .create() and .replaceAll() handles, but not .get()-attached ones', async () => {
    const engine = new FakeEngine();
    const tracked = trackCreates(engine);

    const created = await tracked.create(imposter('a').port(1));
    const [r1, r2] = await tracked.replaceAll([imposter('b').port(2), imposter('c').port(3)]);
    const attached = await tracked.get(42);

    expect(tracked.created).toEqual([created, r1, r2]);
    expect(tracked.created).not.toContain(attached);
    expect(engine.getCalls).toEqual([42]);
  });

  it('deleteAll() clears the tracked list (and still calls through to the engine)', async () => {
    const engine = new FakeEngine();
    const tracked = trackCreates(engine);
    await tracked.create(imposter('a').port(1));
    expect(tracked.created).toHaveLength(1);

    await tracked.deleteAll();

    expect(tracked.created).toEqual([]);
    expect(engine.deleteAllCalls).toBe(1);
  });

  it('passes every other member through untouched, bound to the real engine', async () => {
    const engine = new FakeEngine('embedded');
    const tracked = trackCreates(engine);

    expect(tracked.transport).toBe('embedded');
    expect(tracked.closed).toBe(false);
    await tracked.close(); // exercises a method relying on a private class field (`#closed`)
    expect(tracked.closed).toBe(true);
    expect(engine.closeCalls).toBe(1);
  });
});

// --- disposeTracked ----------------------------------------------------------------------------

describe('disposeTracked', () => {
  it('deletes every tracked handle via allSettled — one rejection never stops or masks the rest', async () => {
    const deletedOk: number[] = [];
    const ok1 = fakeImposterHandle(1, {
      deleteMock: async () => {
        deletedOk.push(1);
      },
    });
    const failing = fakeImposterHandle(2, {
      deleteMock: async () => {
        throw new Error('boom');
      },
    });
    const ok2 = fakeImposterHandle(3, {
      deleteMock: async () => {
        deletedOk.push(3);
      },
    });
    const created = [ok1, failing, ok2];

    await expect(disposeTracked(created)).resolves.toBeUndefined();

    expect(deletedOk.sort()).toEqual([1, 3]);
    expect(created).toEqual([]); // cleared afterward
  });
});

// --- acquireEngine -------------------------------------------------------------------------------

describe('acquireEngine', () => {
  it('auto-detect: embedded-available invokes the embedded factory, not spawn', async () => {
    const embeddedEngine = new FakeEngine('embedded');
    const deps: AcquireEngineDeps = {
      embedded: jest.fn(async () => embeddedEngine),
      spawn: neverCalled('spawn'),
      connect: neverCalled('connect'),
      isEmbeddedAvailable: () => true,
    };

    const engine = await acquireEngine({}, deps);

    expect(engine).toBe(embeddedEngine);
    expect(deps.embedded).toHaveBeenCalledTimes(1);
  });

  it('auto-detect: embedded-unavailable falls back to spawn', async () => {
    const spawnEngine = new FakeEngine('spawn');
    const deps: AcquireEngineDeps = {
      embedded: neverCalled('embedded'),
      spawn: jest.fn(async () => spawnEngine),
      connect: neverCalled('connect'),
      isEmbeddedAvailable: () => false,
    };

    const engine = await acquireEngine({}, deps);

    expect(engine).toBe(spawnEngine);
    expect(deps.spawn).toHaveBeenCalledTimes(1);
  });

  it('an explicit transport bypasses auto-detect entirely', async () => {
    const connectEngine = new FakeEngine('remote');
    const connectMock = jest.fn(async (_url: string) => connectEngine);
    const deps: AcquireEngineDeps = {
      embedded: neverCalled('embedded'),
      spawn: neverCalled('spawn'),
      connect: connectMock,
      isEmbeddedAvailable: () => true, // would pick embedded if consulted
    };

    const engine = await acquireEngine({ transport: { connect: 'http://example.test' } }, deps);

    expect(engine).toBe(connectEngine);
    expect(connectMock).toHaveBeenCalledWith('http://example.test', undefined);
  });

  it('wraps a raw acquisition failure in a clear EngineUnavailable', async () => {
    const deps: AcquireEngineDeps = {
      embedded: jest.fn(async (): Promise<RiftEngine> => {
        throw new Error('cdylib missing');
      }),
      spawn: neverCalled('spawn'),
      connect: neverCalled('connect'),
      isEmbeddedAvailable: () => true,
    };

    let thrown: unknown;
    try {
      await acquireEngine({}, deps);
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(EngineUnavailable);
    expect((thrown as EngineUnavailable).message).toContain('cdylib missing');
    expect((thrown as EngineUnavailable).message).toContain('embedded');
  });

  it('lets an already-typed RiftError (e.g. EngineUnavailable) through unchanged', async () => {
    const original = new EngineUnavailable('the rift binary could not be resolved');
    const deps: AcquireEngineDeps = {
      embedded: neverCalled('embedded'),
      spawn: jest.fn(async (): Promise<RiftEngine> => {
        throw original;
      }),
      connect: neverCalled('connect'),
      isEmbeddedAvailable: () => false,
    };

    let thrown: unknown;
    try {
      await acquireEngine({}, deps);
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBe(original);
  });
});

// --- assertReceived ------------------------------------------------------------------------------

describe('assertReceived', () => {
  it('delegates to imposter.verify with the same args', async () => {
    const verifyMock = jest.fn(async (_match: RequestMatch, _count?: CountMatcher) => {});
    const handle = fakeImposterHandle(1, { verify: verifyMock });
    const match = onGet('/x');
    const count = times(2);

    await assertReceived(handle, match, count);

    expect(verifyMock).toHaveBeenCalledWith(match, count);
  });

  it('propagates the identical VerificationError imposter.verify throws', async () => {
    const err = new VerificationError('Verification failed for imposter (port 1)', {
      expected: [],
      count: { matched: 0, total: 0, matcher: times(1) },
      recorded: [],
    });
    const verifyMock = jest.fn(async (): Promise<void> => {
      throw err;
    });
    const handle = fakeImposterHandle(1, { verify: verifyMock });

    let thrown: unknown;
    try {
      await assertReceived(handle, onGet('/x'));
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBe(err);
  });
});

// --- setupRift (real jest lifecycle, injected fake acquire) --------------------------------------

describe('setupRift — engine getter guards access before setup ran', () => {
  let preSetupError: unknown;
  const rift = setupRift({ transport: 'spawn' }, {
    embedded: neverCalled('embedded'),
    spawn: jest.fn(async () => new FakeEngine('spawn')),
    connect: neverCalled('connect'),
    isEmbeddedAvailable: () => false,
  });
  // Synchronous, during describe-body collection — before jest has run the registered `beforeAll`.
  try {
    void rift.engine;
  } catch (e) {
    preSetupError = e;
  }

  it('throws when .engine is read before beforeAll has run', () => {
    expect(preSetupError).toBeInstanceOf(Error);
    expect((preSetupError as Error).message).toContain('access engine inside a test or hook');
  });
});

describe('setupRift — real jest beforeAll/afterEach/afterAll lifecycle', () => {
  const engine = new FakeEngine('spawn');
  const deps: AcquireEngineDeps = {
    embedded: neverCalled('embedded'),
    spawn: jest.fn(async () => engine),
    connect: neverCalled('connect'),
    isEmbeddedAvailable: () => false,
  };
  const rift = setupRift({ transport: 'spawn' }, deps);

  let created: ImposterHandle;
  let attached: ImposterHandle;

  it('creates and attaches imposters through the setup engine', async () => {
    created = await rift.engine.create(imposter('users').port(1));
    attached = await rift.engine.get(99999);
    expect(created.port).not.toBe(attached.port);
    expect(engine.deletedPorts).toEqual([]); // not torn down mid-test
  });

  it('afterEach deleted the previous test\'s created imposter, but not the attached one', () => {
    expect(engine.deletedPorts).toEqual([created.port]);
    expect(engine.deletedPorts).not.toContain(attached.port);
  });

  it('deps.spawn (the injected fake acquire) was used exactly once for the whole describe block', () => {
    expect(deps.spawn).toHaveBeenCalledTimes(1);
  });
});
