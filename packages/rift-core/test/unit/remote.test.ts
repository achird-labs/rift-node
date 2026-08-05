/**
 * Remote transport gate (issue #4)
 *
 * A `fetch`-based admin API client (`rift.connect(url)`) with a typed RiftError hierarchy.
 * The gate pins: request method/path/body for every operation, the full error-mapping table
 * (400 → InvalidDefinition, connection-refused → EngineUnavailable, 404 → ImposterNotFound,
 * other non-2xx → EngineError, malformed response → CommunicationError), and the
 * `await using` / close() disposal contract. All via a mocked global fetch — no live engine.
 */

import { jest } from '@jest/globals';
import {
  connect,
  RemoteClient,
  RiftError,
  InvalidDefinition,
  EngineUnavailable,
  CommunicationError,
  ImposterNotFound,
  EngineError,
} from '../../src/remote/index.js';
import { WireValidationError } from '../../src/errors.js';

type FetchArgs = { url: string; method: string; body: unknown };

function mockFetch(response: Response | Error): jest.Mock {
  const fn = jest.fn(async () => {
    if (response instanceof Error) throw response;
    return response;
  });
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

const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

const BASE = 'http://localhost:2525';

describe('remote — connect', () => {
  // The async, version-preflighting `rift.connect` facade (issue #21) now lives at the package
  // root (../../src/engine.js) and returns an `Engine`, not a bare client — see engine.test.ts.
  it('connect returns a client bound to the admin url', () => {
    const c = connect(BASE);
    expect(c.url).toBe(BASE);
  });

  it('normalizes a trailing slash', () => {
    expect(connect('http://localhost:2525/').url).toBe(BASE);
  });
});

describe('remote — imposter operations map to the right request', () => {
  it('createImposter → POST /imposters with the wire body', async () => {
    const fn = mockFetch(json({ port: 4545, protocol: 'http' }, 201));
    const c = connect(BASE);
    const result = await c.createImposter({ port: 4545, protocol: 'http', stubs: [] });
    const call = lastCall(fn);
    expect(call.method).toBe('POST');
    expect(call.url).toBe(`${BASE}/imposters`);
    expect(call.body).toEqual({ port: 4545, protocol: 'http', stubs: [] });
    expect(result).toEqual({ port: 4545, protocol: 'http' });
  });

  it('getImposter / listImposters / deleteImposter / deleteAllImposters', async () => {
    const fn = mockFetch(json({ imposters: [] }));
    const c = connect(BASE);
    await c.getImposter(4545);
    expect(lastCall(fn)).toMatchObject({ method: 'GET', url: `${BASE}/imposters/4545` });
    await c.listImposters();
    expect(lastCall(fn)).toMatchObject({ method: 'GET', url: `${BASE}/imposters` });
    await c.deleteImposter(4545);
    expect(lastCall(fn)).toMatchObject({ method: 'DELETE', url: `${BASE}/imposters/4545` });
    await c.deleteAllImposters();
    expect(lastCall(fn)).toMatchObject({ method: 'DELETE', url: `${BASE}/imposters` });
  });

  it('replaceImposters → PUT /imposters with the envelope', async () => {
    const fn = mockFetch(json({ imposters: [] }));
    await connect(BASE).replaceImposters({ imposters: [{ port: 1, protocol: 'http' }] });
    const call = lastCall(fn);
    expect(call.method).toBe('PUT');
    expect(call.url).toBe(`${BASE}/imposters`);
    expect(call.body).toEqual({ imposters: [{ port: 1, protocol: 'http' }] });
  });
});

describe('remote — scenario / space / flow-state / reload', () => {
  it('scenario state operations', async () => {
    const fn = mockFetch(json({ ok: true }));
    const c = connect(BASE);
    await c.getScenarios(4545);
    expect(lastCall(fn)).toMatchObject({ method: 'GET', url: `${BASE}/imposters/4545/scenarios` });
    await c.setScenarioState(4545, 'checkout', 'done', { flowId: 'f1' });
    expect(lastCall(fn)).toMatchObject({
      method: 'PUT',
      url: `${BASE}/imposters/4545/scenarios/checkout/state`,
      body: { state: 'done', flowId: 'f1' },
    });
    await c.resetScenarios(4545);
    expect(lastCall(fn)).toMatchObject({
      method: 'POST',
      url: `${BASE}/imposters/4545/scenarios/reset`,
    });
  });

  it('space operations', async () => {
    const fn = mockFetch(json({ ok: true }));
    const c = connect(BASE);
    await c.getSpace(4545, 'flow-1');
    expect(lastCall(fn)).toMatchObject({ method: 'GET', url: `${BASE}/imposters/4545/spaces/flow-1` });
    await c.deleteSpace(4545, 'flow-1');
    expect(lastCall(fn)).toMatchObject({
      method: 'DELETE',
      url: `${BASE}/imposters/4545/spaces/flow-1`,
    });
  });

  it('flow-state operations (admin-prefixed); getFlowState returns undefined on 404', async () => {
    const fn = mockFetch(json({ flowId: 'f', key: 'k', value: 42 }));
    const c = connect(BASE);
    await c.setFlowState(4545, 'f', 'k', 42);
    expect(lastCall(fn)).toMatchObject({
      method: 'PUT',
      url: `${BASE}/admin/imposters/4545/flow-state/f/k`,
      body: { value: 42 },
    });
    const got = await c.getFlowState(4545, 'f', 'k');
    expect(got).toEqual({ flowId: 'f', key: 'k', value: 42 });
    expect(lastCall(fn)).toMatchObject({
      method: 'GET',
      url: `${BASE}/admin/imposters/4545/flow-state/f/k`,
    });
    mockFetch(new Response('', { status: 404 }));
    expect(await c.getFlowState(4545, 'f', 'missing')).toBeUndefined();
  });

  it('reload → POST /admin/reload', async () => {
    const fn = mockFetch(json({ reloaded: true }));
    await connect(BASE).reload();
    expect(lastCall(fn)).toMatchObject({ method: 'POST', url: `${BASE}/admin/reload` });
  });
});

describe('remote — error mapping (the whole typed hierarchy)', () => {
  const errBody = (message: string, code = 'invalid') => ({ errors: [{ code, message }] });

  it('400 → InvalidDefinition (with engine message)', async () => {
    mockFetch(json(errBody('bad imposter'), 400));
    const c = connect(BASE);
    await expect(c.createImposter({ protocol: 'http' })).rejects.toBeInstanceOf(InvalidDefinition);
    mockFetch(json(errBody('bad imposter'), 400));
    await expect(c.createImposter({ protocol: 'http' })).rejects.toThrow(/bad imposter/);
  });

  it('connection refused (fetch rejects) → EngineUnavailable', async () => {
    mockFetch(new TypeError('fetch failed'));
    await expect(connect(BASE).listImposters()).rejects.toBeInstanceOf(EngineUnavailable);
  });

  it('404 → ImposterNotFound', async () => {
    mockFetch(json(errBody('no such imposter', 'no-imposter'), 404));
    await expect(connect(BASE).getImposter(9999)).rejects.toBeInstanceOf(ImposterNotFound);
  });

  it('other non-2xx → EngineError carrying the status code + message', async () => {
    mockFetch(json(errBody('boom', 'internal'), 500));
    try {
      await connect(BASE).listImposters();
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(EngineError);
      expect((e as EngineError).code).toBe(500);
      expect((e as Error).message).toMatch(/boom/);
    }
  });

  it('malformed success body → CommunicationError', async () => {
    mockFetch(new Response('not json', { status: 200, headers: { 'content-type': 'application/json' } }));
    await expect(connect(BASE).listImposters()).rejects.toBeInstanceOf(CommunicationError);
  });

  it('every error is a RiftError', async () => {
    for (const [resp, ] of [
      [json({ errors: [{ message: 'x' }] }, 400)],
      [json({ errors: [{ message: 'x' }] }, 404)],
      [json({ errors: [{ message: 'x' }] }, 503)],
    ] as [Response][]) {
      mockFetch(resp);
      await expect(connect(BASE).listImposters()).rejects.toBeInstanceOf(RiftError);
    }
  });
});

describe('remote — disposal contract', () => {
  it('supports await using via Symbol.asyncDispose and idempotent close()', async () => {
    mockFetch(json({ imposters: [] }));
    const c = connect(BASE);
    expect(typeof (c as unknown as Record<symbol, unknown>)[Symbol.asyncDispose]).toBe('function');
    await c.close();
    await c.close(); // idempotent
    await expect(
      (c as unknown as { [Symbol.asyncDispose](): Promise<void> })[Symbol.asyncDispose]()
    ).resolves.toBeUndefined();
  });
});

describe('remote — empty-body handling by endpoint kind', () => {
  it('reload tolerates an empty body', async () => {
    mockFetch(new Response('', { status: 200 }));
    await expect(connect(BASE).reload()).resolves.toBeUndefined();
  });

  // issue #21: deleteImposter now returns the deleted imposter (the engine echoes it back), so
  // it is no longer an "empty body tolerated" endpoint — an empty body here is a communication
  // failure, same as any other data endpoint.
  it('deleteImposter returns the parsed deleted imposter', async () => {
    mockFetch(json({ port: 4545, protocol: 'http' }));
    await expect(connect(BASE).deleteImposter(4545)).resolves.toEqual({ port: 4545, protocol: 'http' });
  });

  it('data endpoints reject an empty body as CommunicationError', async () => {
    mockFetch(new Response('', { status: 200 }));
    await expect(connect(BASE).getImposter(4545)).rejects.toBeInstanceOf(CommunicationError);
    mockFetch(new Response('', { status: 200 }));
    await expect(connect(BASE).listImposters()).rejects.toBeInstanceOf(CommunicationError);
  });
});

describe('remote — error message falls back to statusText for non-JSON bodies', () => {
  it('non-JSON 400 body → InvalidDefinition with statusText', async () => {
    mockFetch(new Response('<html>nope</html>', { status: 400, statusText: 'Bad Request' }));
    await expect(connect(BASE).createImposter({ protocol: 'http' })).rejects.toThrow(/Bad Request/);
  });
});

describe('remote — additional operation coverage', () => {
  it('deleteFlowState → DELETE /admin/.../flow-state/...', async () => {
    const fn = mockFetch(new Response('', { status: 200 }));
    await connect(BASE).deleteFlowState(4545, 'f', 'k');
    expect(lastCall(fn)).toMatchObject({
      method: 'DELETE',
      url: `${BASE}/admin/imposters/4545/flow-state/f/k`,
    });
  });

  it('getFlowState non-404 error maps through the hierarchy (500 → EngineError)', async () => {
    mockFetch(json({ errors: [{ message: 'kaboom' }] }, 500));
    await expect(connect(BASE).getFlowState(4545, 'f', 'k')).rejects.toBeInstanceOf(EngineError);
  });

  it('getScenarios with flowId appends the query param', async () => {
    const fn = mockFetch(json({ scenarios: [] }));
    await connect(BASE).getScenarios(4545, { flowId: 'f 1' });
    expect(lastCall(fn)).toMatchObject({
      method: 'GET',
      url: `${BASE}/imposters/4545/scenarios?flowId=f%201`,
    });
  });

  it('resetScenarios with flowId sends it in the body; without sends no body', async () => {
    const fn = mockFetch(json({ ok: true }));
    await connect(BASE).resetScenarios(4545, { flowId: 'f1' });
    expect(lastCall(fn).body).toEqual({ flowId: 'f1' });
    await connect(BASE).resetScenarios(4545);
    expect(lastCall(fn).body).toBeUndefined();
  });

  it('setScenarioState without flowId sends only { state }', async () => {
    const fn = mockFetch(json({ ok: true }));
    await connect(BASE).setScenarioState(4545, 'checkout', 'done');
    expect(lastCall(fn).body).toEqual({ state: 'done' });
  });
});

describe('remote — use-after-close is a loud error', () => {
  it('operations after close() throw RiftError; closed getter is true', async () => {
    mockFetch(json({ imposters: [] }));
    const c = connect(BASE);
    await c.close();
    expect(c.closed).toBe(true);
    await expect(c.listImposters()).rejects.toBeInstanceOf(RiftError);
    await expect(c.getFlowState(1, 'f', 'k')).rejects.toBeInstanceOf(RiftError);
  });
});

// --- blank admin api key (issue #96, engine rift#862) -----------------------------------------
//
// A blank key is never a meaningful credential: it produces `Authorization: Bearer ` and, against
// an engine older than 0.17.0, matches a blank configured key — authenticating anonymously. The
// common way to reach here is an unset env var (`apiKey: process.env.KEY ?? ''`), which is exactly
// the case that must fail loudly rather than quietly build an unauthenticated client.

describe('remote — blank apiKey is rejected (issue #96)', () => {
  it('rejects an empty apiKey', () => {
    expect(() => new RemoteClient('http://localhost:2525', { apiKey: '' })).toThrow(
      InvalidDefinition
    );
  });

  it('rejects a whitespace-only apiKey', () => {
    expect(() => new RemoteClient('http://localhost:2525', { apiKey: '   ' })).toThrow(
      InvalidDefinition
    );
    expect(() => new RemoteClient('http://localhost:2525', { apiKey: '\t\n' })).toThrow(
      InvalidDefinition
    );
  });

  it('accepts a key containing spaces and sends it untrimmed', async () => {
    const fetchMock = mockFetch(new Response(JSON.stringify({}), { status: 200 }));
    const client = new RemoteClient('http://localhost:2525', { apiKey: ' my key ' });
    await client.config();
    const headers = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1]
      .headers as Record<string, string>;
    expect(headers['authorization']).toBe('Bearer  my key ');
  });

  it('omitting apiKey stays unchanged — no authorization header, no throw', async () => {
    const fetchMock = mockFetch(new Response(JSON.stringify({}), { status: 200 }));
    const client = new RemoteClient('http://localhost:2525', {});
    await client.config();
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    const headers = (init.headers ?? {}) as Record<string, string>;
    expect(headers['authorization']).toBeUndefined();
  });
});

describe('issue #112 — outbound wire bodies are JSON-safe on every admin route', () => {
  /** Every assertion here checks the request was NEVER SENT. A rejection that still put the body on
   * the wire would leave the engine holding the `null` this guard exists to prevent. */
  async function rejectsWithoutSending(call: (c: RemoteClient) => Promise<unknown>): Promise<void> {
    const fn = mockFetch(json({}));
    const c = connect(BASE);
    await expect(call(c)).rejects.toThrow(WireValidationError);
    expect(fn).not.toHaveBeenCalled();
  }

  it('createImposter refuses a non-finite number nested in a stub body', async () => {
    await rejectsWithoutSending((c) =>
      c.createImposter({
        port: 4545,
        protocol: 'http',
        stubs: [{ responses: [{ is: { body: { temperature: NaN } } } as never] }],
      })
    );
  });

  it('replaceImposters refuses a non-finite number', async () => {
    await rejectsWithoutSending((c) =>
      c.replaceImposters({
        imposters: [{ port: 1, protocol: 'http', stubs: [{ responses: [{ is: { body: { n: Infinity } } } as never] }] }],
      })
    );
  });

  it('addStub and updateStub refuse a non-finite number', async () => {
    await rejectsWithoutSending((c) =>
      c.addStub(4545, { responses: [{ is: { body: { n: -Infinity } } } as never] })
    );
    await rejectsWithoutSending((c) =>
      c.updateStub(4545, 0, { responses: [{ is: { body: { n: NaN } } } as never] })
    );
  });

  it('setFlowState refuses a non-finite value — flow state is caller data too', async () => {
    await rejectsWithoutSending((c) => c.setFlowState(4545, 'flow', 'key', NaN));
  });

  it('refuses a bigint with a typed error rather than a raw TypeError', async () => {
    const fn = mockFetch(json({}));
    const c = connect(BASE);
    const thrown = await c
      .createImposter({ port: 1, protocol: 'http', meta: 1n } as never)
      .catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(WireValidationError);
    expect(thrown).not.toBeInstanceOf(TypeError);
    expect(fn).not.toHaveBeenCalled();
  });

  it('reports a circular reference as WireValidationError, not a bare TypeError', async () => {
    const circular: Record<string, unknown> = { port: 1, protocol: 'http' };
    circular.self = circular;
    const fn = mockFetch(json({}));
    const c = connect(BASE);
    const thrown = await c.createImposter(circular as never).catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(WireValidationError);
    expect(fn).not.toHaveBeenCalled();
  });

  it('names the offending key so the caller can locate it', async () => {
    const c = connect(BASE);
    mockFetch(json({}));
    await expect(
      c.createImposter({ port: 1, protocol: 'http', stubs: [{ responses: [{ is: { body: { temperature: NaN } } } as never] }] })
    ).rejects.toThrow(/temperature/);
  });

  it('leaves a valid body byte-identical to the unguarded serialization', async () => {
    const fn = mockFetch(json({ port: 4545, protocol: 'http' }, 201));
    const def = { port: 4545, protocol: 'http', stubs: [] };
    await connect(BASE).createImposter(def);
    const [, init] = fn.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.body).toBe(JSON.stringify(def));
  });
});
