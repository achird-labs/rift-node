/**
 * Embedded-vs-remote differential test (issue #13).
 *
 * Pins #10's local-registry PROJECTION SHAPE: the same imposter, created through BOTH an
 * `EmbeddedAdmin` (over a fake `NativeEngineLike` — no koffi, no cdylib) and a `RemoteClient`
 * (over a mocked admin server that stores-and-echoes the def), must produce the SAME
 * `getImposter(port, { replayable: true })` shape. Because the remote fake echoes the def, the
 * oracle here is "the canonical projection shape" (the def the DSL built, minus the engine-assigned
 * port and `numberOfRequests`), NOT what a live Mountebank-compatible admin actually returns — that
 * needs a real engine (the binary-gated conformance corpus lane). What this DOES catch without a
 * live engine: the embedded registry dropping/renaming a field, emitting `numberOfRequests` under
 * `replayable`, or otherwise diverging from the canonical shape both transports must agree on.
 *
 * Normalization: `port` is stripped before comparing — it's assigned independently by each fake
 * (the embedded `FakeNativeEngine`'s own counter vs. the remote fake's own counter), so the two
 * numbers differing is expected and not a projection bug. `numberOfRequests` is also stripped
 * defensively, though with `replayable: true` neither side emits it at all (that omission is
 * itself part of what's being pinned) — everything else (name, protocol, stubs, recordRequests,
 * ...) is compared verbatim.
 */

import { jest } from '@jest/globals';
import { createEmbeddedEngine } from '../src/create.js';
import type { NativeEngineLike } from '../src/admin.js';
import { RemoteClient } from '@rift-vs/rift/internal';
import { MIN_ENGINE_VERSION } from '@rift-vs/rift/internal';
import { imposter, onGet, onPost, okJson, status } from '@rift-vs/rift';
import type { Imposter } from '@rift-vs/rift/internal';

// -------------------------------------------------------------------------------------------
// Fake NativeEngineLike — same shape as embedded-admin.test.ts's fake, trimmed to what this
// differential test actually exercises (createImposter/getImposter never touch the rest).
// -------------------------------------------------------------------------------------------

class FakeNativeEngine implements NativeEngineLike {
  readonly buildInfo: string;
  calls: Array<{ fn: string; args: unknown[] }> = [];
  #imposters = new Map<number, unknown>();
  #nextPort = 6000;

  constructor(startPort = 6000) {
    this.buildInfo = JSON.stringify({
      version: MIN_ENGINE_VERSION,
      commit: 'differential-fake',
      builtAt: '2026-01-01T00:00:00Z',
      features: [],
    });
    this.#nextPort = startPort;
  }

  async createImposter(json: string): Promise<number> {
    this.calls.push({ fn: 'createImposter', args: [json] });
    const parsed = JSON.parse(json) as { port?: number };
    const port = typeof parsed.port === 'number' && parsed.port !== 0 ? parsed.port : this.#nextPort++;
    this.#imposters.set(port, json);
    return port;
  }

  async replaceStubs(port: number, json: string): Promise<number> {
    this.calls.push({ fn: 'replaceStubs', args: [port, json] });
    return (JSON.parse(json) as unknown[]).length;
  }

  async deleteImposter(port: number): Promise<number> {
    this.calls.push({ fn: 'deleteImposter', args: [port] });
    this.#imposters.delete(port);
    return 0;
  }

  async deleteAll(): Promise<number> {
    this.calls.push({ fn: 'deleteAll', args: [] });
    const n = this.#imposters.size;
    this.#imposters.clear();
    return n;
  }

  async applyConfig(json: string): Promise<string> {
    this.calls.push({ fn: 'applyConfig', args: [json] });
    return json;
  }

  async recorded(port: number): Promise<string> {
    this.calls.push({ fn: 'recorded', args: [port] });
    return '[]';
  }

  async flowStateGet(): Promise<{ found: boolean; value?: unknown }> {
    return { found: false };
  }

  async flowStatePut(): Promise<number> {
    return 0;
  }

  async flowStateDelete(): Promise<number> {
    return 0;
  }

  async spaceAddStub(): Promise<number> {
    return 0;
  }

  async spaceListStubs(): Promise<string> {
    return JSON.stringify({ space: '', stubs: [] });
  }

  async spaceDelete(): Promise<number> {
    return 0;
  }

  async spaceRecorded(): Promise<string> {
    return '[]';
  }

  async startIntercept(): Promise<Record<string, unknown>> {
    return { interceptPort: 0, interceptUrl: 'http://unused.invalid' };
  }

  async interceptAddRules(): Promise<number> {
    return 0;
  }

  async interceptClearRules(): Promise<number> {
    return 0;
  }

  async interceptListRules(): Promise<string> {
    return '[]';
  }

  async interceptCaPem(): Promise<string> {
    return '';
  }

  async interceptExportTruststore(): Promise<number> {
    return 0;
  }

  async serveAdmin(): Promise<Record<string, unknown>> {
    return { adminUrl: 'http://unused-plane.invalid' };
  }

  async close(): Promise<void> {
    this.calls.push({ fn: 'close', args: [] });
  }
}

// -------------------------------------------------------------------------------------------
// Fake remote admin server — the minimum route table `RemoteClient` needs for create + get, over
// a mocked global `fetch`. Deliberately separate port-numbering from `FakeNativeEngine` (starts
// at 3000, not 6000) so a passing comparison can't be an accident of both sides agreeing by luck.
// -------------------------------------------------------------------------------------------

class FakeRemoteAdminServer {
  #imposters = new Map<number, Imposter>();
  #nextPort = 3000;

  respond(url: string, init: RequestInit): Response {
    const parsed = new URL(url);
    const method = (init.method ?? 'GET').toUpperCase();
    const segments = parsed.pathname.split('/').filter((s) => s.length > 0);

    if (method === 'POST' && segments.length === 1 && segments[0] === 'imposters') {
      const body = JSON.parse(String(init.body)) as Imposter;
      const port = typeof body.port === 'number' && body.port !== 0 ? body.port : this.#nextPort++;
      const stored: Imposter = { ...body, port };
      this.#imposters.set(port, stored);
      return this.json(stored, 201);
    }

    if (method === 'GET' && segments.length === 2 && segments[0] === 'imposters') {
      const port = Number(segments[1]);
      const imp = this.#imposters.get(port);
      if (imp === undefined) return this.json({ errors: [{ message: 'no such imposter' }] }, 404);
      const replayable = parsed.searchParams.get('replayable') === 'true';
      const removeProxies = parsed.searchParams.get('removeProxies') === 'true';
      const stubs =
        removeProxies && imp.stubs !== undefined
          ? imp.stubs.filter((s) => !(s.responses ?? []).some((r) => r.proxy !== undefined))
          : imp.stubs;
      const base: Imposter = { ...imp, stubs };
      // Real Mountebank-compatible admin APIs omit `numberOfRequests` for a `?replayable=true`
      // fetch (it's a snapshot meant to be replayed, not a live-request-count report) — the same
      // contract `EmbeddedAdmin#project` implements locally; this fake mirrors it so the
      // differential actually pins that behavior instead of trivially agreeing on an unset field.
      return this.json(replayable ? base : { ...base, numberOfRequests: 0 });
    }

    return this.json({ errors: [{ message: `unhandled ${method} ${parsed.pathname}` }] }, 404);
  }

  private json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }
}

function mockRemoteFetch(server: FakeRemoteAdminServer): void {
  const fn = jest.fn(async (url: unknown, init?: RequestInit) => server.respond(String(url), init ?? {}));
  globalThis.fetch = fn as unknown as typeof fetch;
}

// -------------------------------------------------------------------------------------------
// The three representative imposters (built once each — the SAME object is fed to both
// transports, so any structural difference in the assertions below is a projection bug, never a
// difference in what was asked to be created).
// -------------------------------------------------------------------------------------------

function plainStubImposter(): Imposter {
  return imposter('plain-stub')
    .protocol('http')
    .stub(onGet('/health').willReturn(okJson({ status: 'ok' })))
    .build();
}

function multiStubImposter(): Imposter {
  return imposter('multi-stub')
    .protocol('http')
    .stub(onGet('/a').willReturn(okJson({ which: 'a' })))
    .stub(onGet('/b').willReturn(okJson({ which: 'b' })))
    .stub(onPost('/c').willReturn(status(201, { created: true })))
    .build();
}

function recordingImposter(): Imposter {
  return imposter('recording')
    .protocol('http')
    .record()
    .stub(onGet('/tracked').willReturn(okJson({ tracked: true })))
    .build();
}

/** Strips the two fields legitimately allowed to differ (see the module doc comment); everything
 * else is compared verbatim. */
function normalizeProjection(imp: Imposter): Record<string, unknown> {
  const rest: Record<string, unknown> = { ...imp };
  delete rest.port;
  delete rest.numberOfRequests;
  return rest;
}

describe('embedded vs remote — replayable projection shape (issue #13)', () => {
  it.each<[string, () => Imposter]>([
    ['a plain single-stub imposter', plainStubImposter],
    ['an imposter with multiple stubs', multiStubImposter],
    ['a recordRequests imposter', recordingImposter],
  ])('%s: embedded getImposter(replayable) matches the remote admin API projection', async (_label, build) => {
    const def = build();

    const native = new FakeNativeEngine();
    const embeddedEngine = await createEmbeddedEngine({}, { loadNativeEngine: async () => native });
    // Give each transport its OWN copy so an in-place mutation by one can't make the other's echo
    // agree by luck — the agreement must come from the projection shape, not a shared object.
    const embeddedCreated = await embeddedEngine.admin.createImposter(structuredClone(def));
    const embeddedProjection = await embeddedEngine.admin.getImposter(embeddedCreated.port as number, {
      replayable: true,
    });

    const server = new FakeRemoteAdminServer();
    mockRemoteFetch(server);
    const remoteClient = new RemoteClient('http://localhost:9999');
    const remoteCreated = await remoteClient.createImposter(structuredClone(def));
    const remoteProjection = await remoteClient.getImposter(remoteCreated.port as number, { replayable: true });

    expect(typeof embeddedProjection.port).toBe('number');
    expect(typeof remoteProjection.port).toBe('number');
    expect('numberOfRequests' in embeddedProjection).toBe(false);
    expect('numberOfRequests' in remoteProjection).toBe(false);
    expect(normalizeProjection(embeddedProjection)).toEqual(normalizeProjection(remoteProjection));

    await embeddedEngine.close();
    await remoteClient.close();
  });
});

// -------------------------------------------------------------------------------------------
// Injection parity (reuses #10's approach): an inject/script stub imposter created embedded must
// route through native.createImposter (FFI) with the inject body intact and NO `allowInjection`
// anywhere — that flag only gates the admin-plane's HTTP surface, which FFI calls never pass
// through, so `allowInjection` should not appear in the payload at all.
// -------------------------------------------------------------------------------------------

describe('embedded inject stub — FFI-routed, no allowInjection anywhere (issue #13)', () => {
  it('native.createImposter receives the inject stub verbatim, with no allowInjection key', async () => {
    const native = new FakeNativeEngine();
    const engine = await createEmbeddedEngine({}, { loadNativeEngine: async () => native });

    const def: Imposter = {
      port: 0,
      protocol: 'http',
      stubs: [{ responses: [{ inject: 'function(config) { return { statusCode: 200 }; }' }] }],
    };
    await engine.admin.createImposter(def);

    const call = native.calls.find((c) => c.fn === 'createImposter');
    expect(call).toBeDefined();
    const sentJson = String(call?.args[0]);
    expect(sentJson).toContain('inject');
    expect(sentJson).not.toContain('allowInjection');

    await engine.close();
  });
});
