/**
 * Gate for issue #21 (AdminApi arm) — the RemoteClient implements the full admin route table.
 * Pins request method/path/body for every NEW method via a mocked global fetch (no live engine),
 * including savedRequests `match=` query encoding and the getFlowState 404 → undefined contract.
 */

import { jest } from '@jest/globals';
import { RemoteClient } from '../../src/remote/index.js';

function ok(body: unknown, status = 200): Response {
  return new Response(body === undefined ? '' : JSON.stringify(body), { status });
}

function mockFetch(...responses: Response[]): jest.Mock {
  const fn = jest.fn(async () => responses.shift() ?? ok({}));
  // @ts-expect-error override global for the test
  globalThis.fetch = fn;
  return fn as unknown as jest.Mock;
}

function call(fn: jest.Mock, i = 0): { url: string; method: string; body: unknown } {
  const [url, init] = fn.mock.calls[i] as [string, RequestInit];
  return {
    url,
    method: (init?.method ?? 'GET').toUpperCase(),
    body: init?.body !== undefined ? JSON.parse(init.body as string) : undefined,
  };
}

const BASE = 'http://localhost:2525';
const client = () => new RemoteClient(BASE);

describe('issue #21 — AdminApi total surface (mocked fetch)', () => {
  it('addStub POSTs { stub, index? } to /imposters/{port}/stubs', async () => {
    const fn = mockFetch(ok(undefined));
    await client().addStub(2525, { responses: [] }, 3);
    expect(call(fn)).toMatchObject({
      url: `${BASE}/imposters/2525/stubs`,
      method: 'POST',
      body: { stub: { responses: [] }, index: 3 },
    });
  });

  it('getStub/updateStub/deleteStub by numeric index hit /stubs/{index}', async () => {
    const fnGet = mockFetch(ok({ responses: [] }));
    await client().getStub(2525, 1);
    expect(call(fnGet)).toMatchObject({ url: `${BASE}/imposters/2525/stubs/1`, method: 'GET' });

    const fnPut = mockFetch(ok(undefined));
    await client().updateStub(2525, 1, { responses: [] });
    expect(call(fnPut)).toMatchObject({ url: `${BASE}/imposters/2525/stubs/1`, method: 'PUT' });

    const fnDel = mockFetch(ok(undefined));
    await client().deleteStub(2525, 1);
    expect(call(fnDel)).toMatchObject({ url: `${BASE}/imposters/2525/stubs/1`, method: 'DELETE' });
  });

  it('stub surgery by id hits /stubs/by-id/{id}', async () => {
    const fn = mockFetch(ok(undefined));
    await client().deleteStub(2525, { id: 'abc-123' });
    expect(call(fn)).toMatchObject({
      url: `${BASE}/imposters/2525/stubs/by-id/abc-123`,
      method: 'DELETE',
    });
  });

  it('getSavedRequests GETs savedRequests and encodes repeated match= filters', async () => {
    const fn = mockFetch(ok([]));
    await client().getSavedRequests(2525, ['flow_id=abc', 'header:X-Y=z']);
    const { url, method } = call(fn);
    expect(method).toBe('GET');
    expect(url.startsWith(`${BASE}/imposters/2525/savedRequests?`)).toBe(true);
    const qs = new URL(url).searchParams.getAll('match');
    expect(qs).toEqual(['flow_id=abc', 'header:X-Y=z']);
  });

  it('deleteSavedRequests and deleteSavedProxyResponses', async () => {
    const fn1 = mockFetch(ok(undefined));
    await client().deleteSavedRequests(2525);
    expect(call(fn1)).toMatchObject({ url: `${BASE}/imposters/2525/savedRequests`, method: 'DELETE' });

    const fn2 = mockFetch(ok(undefined));
    await client().deleteSavedProxyResponses(2525);
    expect(call(fn2)).toMatchObject({
      url: `${BASE}/imposters/2525/savedProxyResponses`,
      method: 'DELETE',
    });
  });

  it('enable/disable POST to /imposters/{port}/enable|disable', async () => {
    const fnE = mockFetch(ok(undefined));
    await client().enableImposter(2525);
    expect(call(fnE)).toMatchObject({ url: `${BASE}/imposters/2525/enable`, method: 'POST' });

    const fnD = mockFetch(ok(undefined));
    await client().disableImposter(2525);
    expect(call(fnD)).toMatchObject({ url: `${BASE}/imposters/2525/disable`, method: 'POST' });
  });

  it('config() GETs /config and logs() GETs /logs', async () => {
    const fnC = mockFetch(ok({ options: { version: '0.12.0' } }));
    const cfg = await client().config();
    expect(call(fnC)).toMatchObject({ url: `${BASE}/config`, method: 'GET' });
    expect(cfg).toMatchObject({ options: { version: '0.12.0' } });

    const fnL = mockFetch(ok([]));
    await client().logs({ startIndex: 2, endIndex: 5 });
    const { url } = call(fnL);
    expect(url.startsWith(`${BASE}/logs`)).toBe(true);
  });

  it('listImposters passes ?replayable and getImposter passes ?replayable&removeProxies', async () => {
    const fnL = mockFetch(ok({ imposters: [] }));
    await client().listImposters({ replayable: true });
    expect(new URL(call(fnL).url).searchParams.get('replayable')).toBe('true');

    const fnG = mockFetch(ok({ port: 2525, protocol: 'http' }));
    await client().getImposter(2525, { replayable: true, removeProxies: true });
    const params = new URL(call(fnG).url).searchParams;
    expect(params.get('replayable')).toBe('true');
    expect(params.get('removeProxies')).toBe('true');
  });

  it('replaceStubs PUTs { stubs } to /imposters/{port}/stubs', async () => {
    const fn = mockFetch(ok(undefined));
    await client().replaceStubs(2525, [{ responses: [] }]);
    expect(call(fn)).toMatchObject({
      url: `${BASE}/imposters/2525/stubs`,
      method: 'PUT',
      body: { stubs: [{ responses: [] }] },
    });
  });

  it('getStub/updateStub by id hit /stubs/by-id/{id}', async () => {
    const fnGet = mockFetch(ok({ responses: [] }));
    await client().getStub(2525, { id: 'x1' });
    expect(call(fnGet)).toMatchObject({ url: `${BASE}/imposters/2525/stubs/by-id/x1`, method: 'GET' });

    const fnPut = mockFetch(ok(undefined));
    await client().updateStub(2525, { id: 'x1' }, { responses: [] });
    expect(call(fnPut)).toMatchObject({ url: `${BASE}/imposters/2525/stubs/by-id/x1`, method: 'PUT' });
  });

  it('addSpaceStub POSTs the stub bare — no {stub} envelope (issue #142)', async () => {
    // The space route takes the stub object directly; `{ stub }` is the envelope of the
    // non-space `POST /imposters/{port}/stubs` route. Engine 0.18.0 refuses the envelope here with
    // a 400, and older engines deserialized it as an EMPTY stub that matched everything in that space.
    const fn = mockFetch(ok(undefined));
    await client().addSpaceStub(2525, 'flow-1', {
      id: 's1',
      predicates: [{ equals: { path: '/data' } }],
      responses: [{ is: { statusCode: 200, body: 'hi' } }],
    });
    expect(call(fn).body).toEqual({
      id: 's1',
      predicates: [{ equals: { path: '/data' } }],
      responses: [{ is: { statusCode: 200, body: 'hi' } }],
    });
  });

  it('addSpaceStub POSTs to spaces/{flowId}/stubs and listSpaceStubs GETs it', async () => {
    const fnAdd = mockFetch(ok(undefined));
    await client().addSpaceStub(2525, 'flow-1', { responses: [] });
    expect(call(fnAdd)).toMatchObject({
      url: `${BASE}/imposters/2525/spaces/flow-1/stubs`,
      method: 'POST',
    });

    const fnList = mockFetch(ok({ space: 'flow-1', stubs: [] }));
    await client().listSpaceStubs(2525, 'flow-1');
    expect(call(fnList)).toMatchObject({
      url: `${BASE}/imposters/2525/spaces/flow-1/stubs`,
      method: 'GET',
    });
  });

  it('logs() encodes startIndex and endIndex in the query string', async () => {
    const fn = mockFetch(ok([]));
    await client().logs({ startIndex: 2, endIndex: 5 });
    const params = new URL(call(fn).url).searchParams;
    expect(params.get('startIndex')).toBe('2');
    expect(params.get('endIndex')).toBe('5');
  });

  it('getFlowState returns undefined (not null) when the key is absent (404)', async () => {
    mockFetch(ok(undefined, 404));
    await expect(client().getFlowState(2525, 'flow', 'k')).resolves.toBeUndefined();
  });

  it('getFlowState returns the parsed value when present', async () => {
    mockFetch(ok({ n: 1 }));
    await expect(client().getFlowState(2525, 'flow', 'k')).resolves.toEqual({ n: 1 });
  });
});
