/**
 * Gate for issue #26 — `ImposterHandle.requests()`: async-iterable polling over the recorded-request
 * journal. Mirrors the `FakeAdminApi` pattern from `test/unit/verify.test.ts`/`engine.test.ts`, with
 * a controllable `getSavedRequests` (a queue of raw arrays, or a scripted error) so each poll cycle
 * is deterministic.
 */

import { Engine, type AdminApi } from '../../src/engine.js';
import { imposter, onGet } from '../../src/dsl/index.js';
import { ImposterNotFound, RiftError } from '../../src/errors.js';
import type { RecordedRequest } from '../../src/verify/index.js';
import type { EngineWarning, Imposter, ImpostersConfig, Stub, RecordedRequest as WireRecordedRequest } from '../../src/model/index.js';

/** Same shape as `verify.test.ts`'s `FakeAdminApi`, plus a scripted `getSavedRequests`: a queue of
 * raw-array snapshots (successive calls advance through the queue, holding on the last entry), and
 * an optional error hook to simulate deletion (or any other failure) mid-poll. */
class FakeAdminApi implements AdminApi {
  imposters = new Map<number, Imposter>();
  #closed = false;
  #nextPort = 9000;
  #queueIdx = 0;
  savedRequestsQueue: WireRecordedRequest[][] = [[]];
  getSavedRequestsCalls = 0;
  /** When set, called before returning the next queue entry; throwing from it simulates a
   * `getSavedRequests` rejection (e.g. `ImposterNotFound` after deletion). */
  failOnCall?: (callNumber: number) => void;

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
    const imp = await this.getImposter(port);
    this.imposters.delete(port);
    return imp;
  }
  async stubWarnings(): Promise<EngineWarning[]> {
    return [];
  }
  async deleteAllImposters(): Promise<void> {
    this.imposters.clear();
  }
  async replaceImposters(config: ImpostersConfig): Promise<ImpostersConfig> {
    this.imposters.clear();
    for (const imp of config.imposters) await this.createImposter(imp);
    return { imposters: [...this.imposters.values()] };
  }
  async addStub(port: number, stub: Stub): Promise<void> {
    const imp = await this.getImposter(port);
    imp.stubs = [...(imp.stubs ?? []), stub];
  }
  async replaceStubs(port: number, stubs: Stub[]): Promise<void> {
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
  async getSavedRequests(_port: number, match?: string[]): Promise<WireRecordedRequest[]> {
    this.getSavedRequestsCalls++;
    // `requests()` must poll the RAW list — a server-side match filter would shift the cursor.
    if (match !== undefined) {
      throw new Error('getSavedRequests must not be called with a server-side match from requests()');
    }
    this.failOnCall?.(this.getSavedRequestsCalls);
    // `mutableList` mode: a live array the test (and a real clearRecorded()) can mutate between
    // polls, so the delete → cursor-reset workflow is exercised through the real admin call.
    if (this.mutableList !== undefined) return [...this.mutableList];
    const list = this.savedRequestsQueue[Math.min(this.#queueIdx, this.savedRequestsQueue.length - 1)]!;
    if (this.#queueIdx < this.savedRequestsQueue.length - 1) this.#queueIdx++;
    return list;
  }
  mutableList: WireRecordedRequest[] | undefined;
  async deleteSavedRequests(): Promise<void> {
    if (this.mutableList !== undefined) this.mutableList.length = 0;
  }
  async deleteSavedProxyResponses(): Promise<void> {}
  async enableImposter(): Promise<void> {}
  async disableImposter(): Promise<void> {}
  async getScenarios(): Promise<{ flowId: string; scenarios: Array<{ name: string; state: string }> }> {
    return { flowId: 'default', scenarios: [] };
  }
  async setScenarioState(): Promise<void> {}
  async resetScenarios(): Promise<void> {}
  async addSpaceStub(): Promise<void> {}
  async listSpaceStubs(): Promise<{ space: string; stubs: Stub[] }> {
    return { space: '', stubs: [] };
  }
  async getSpace<T>(): Promise<T> {
    return {} as T;
  }
  async deleteSpace(): Promise<void> {}
  async getFlowState<T>(): Promise<T | undefined> {
    return undefined;
  }
  async setFlowState(): Promise<void> {}
  async deleteFlowState(): Promise<void> {}
  async config(): Promise<Record<string, unknown>> {
    return { options: { version: '0.99.0' } };
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

function wireRecorded(overrides: Partial<WireRecordedRequest>): WireRecordedRequest {
  return { method: 'GET', path: '/x', request_from: '127.0.0.1:1', timestamp: '2026-01-01T00:00:00Z', ...overrides };
}

/** Drains a `requests()` iterator up to `limit` items, then aborts and waits for the loop to exit —
 * every test that doesn't rely on natural completion (abort / `ImposterNotFound`) goes through this
 * so no test can leave a poll timer running past its own lifetime. */
async function collectUpTo(
  iter: AsyncIterableIterator<RecordedRequest>,
  limit: number,
  controller: AbortController
): Promise<RecordedRequest[]> {
  const items: RecordedRequest[] = [];
  for await (const r of iter) {
    items.push(r);
    if (items.length >= limit) {
      controller.abort();
      break;
    }
  }
  return items;
}

describe('ImposterHandle.requests()', () => {
  it('yields each newly-recorded request exactly once across growing polls (no duplicates)', async () => {
    const admin = new FakeAdminApi();
    admin.savedRequestsQueue = [
      [wireRecorded({ path: '/a' })],
      [wireRecorded({ path: '/a' }), wireRecorded({ path: '/b' })],
      [wireRecorded({ path: '/a' }), wireRecorded({ path: '/b' }), wireRecorded({ path: '/c' })],
    ];
    const h = await engineOf(admin).create(imposter('s').port(9300).record());
    const controller = new AbortController();

    const items = await collectUpTo(
      h.requests({ pollIntervalMs: 5, signal: controller.signal }),
      3,
      controller
    );

    expect(items.map((r) => r.path)).toEqual(['/a', '/b', '/c']);
  });

  it('resets the cursor when the journal shrinks (cleared), and resumes yielding without stalling', async () => {
    const admin = new FakeAdminApi();
    admin.savedRequestsQueue = [
      [wireRecorded({ path: '/a' })],
      [], // cleared
      [wireRecorded({ path: '/c' })],
    ];
    const h = await engineOf(admin).create(imposter('s').port(9310).record());
    const controller = new AbortController();

    const items = await collectUpTo(
      h.requests({ pollIntervalMs: 5, signal: controller.signal }),
      2,
      controller
    );

    expect(items.map((r) => r.path)).toEqual(['/a', '/c']);
  });

  it('a real clearRecorded() during iteration resets the cursor (end-to-end workflow)', async () => {
    const admin = new FakeAdminApi();
    admin.mutableList = [wireRecorded({ path: '/a' }), wireRecorded({ path: '/b' })];
    const h = await engineOf(admin).create(imposter('s').port(9315).record());
    const controller = new AbortController();

    const seen: string[] = [];
    for await (const req of h.requests({ pollIntervalMs: 5, signal: controller.signal })) {
      seen.push(req.path);
      if (req.path === '/b') {
        await h.clearRecorded(); // truncates the live journal via the real admin call
        admin.mutableList!.push(wireRecorded({ path: '/c' })); // one post-clear request (len 1 < cursor 2)
      }
      if (req.path === '/c') {
        controller.abort();
        break;
      }
    }
    // '/a','/b' seen once, the shrink (len 1 < cursor 2) resets the cursor, '/c' yielded once — no dupes.
    expect(seen).toEqual(['/a', '/b', '/c']);
  });

  it('aborting the signal ends the `for await` loop cleanly with no dangling timers', async () => {
    const admin = new FakeAdminApi();
    admin.savedRequestsQueue = [
      [wireRecorded({ path: '/a' })],
      [wireRecorded({ path: '/a' }), wireRecorded({ path: '/b' })],
      [wireRecorded({ path: '/a' }), wireRecorded({ path: '/b' }), wireRecorded({ path: '/c' })],
    ];
    const h = await engineOf(admin).create(imposter('s').port(9320).record());
    const controller = new AbortController();
    const items: RecordedRequest[] = [];

    for await (const r of h.requests({ pollIntervalMs: 5, signal: controller.signal })) {
      items.push(r);
      if (items.length === 2) controller.abort();
    }

    // The loop above must have returned (not hung) — proven simply by reaching this line — and
    // yielded exactly the 2 items collected before abort, no more.
    expect(items.map((r) => r.path)).toEqual(['/a', '/b']);
  });

  it('applies the optional client-side match filter while the cursor still advances over the raw list', async () => {
    const admin = new FakeAdminApi();
    admin.savedRequestsQueue = [
      [wireRecorded({ method: 'POST', path: '/skip' })],
      [wireRecorded({ method: 'POST', path: '/skip' }), wireRecorded({ method: 'GET', path: '/match' })],
    ];
    const h = await engineOf(admin).create(imposter('s').port(9330).record());
    const controller = new AbortController();

    const items = await collectUpTo(
      h.requests({ pollIntervalMs: 5, signal: controller.signal, match: onGet('/match') }),
      1,
      controller
    );

    expect(items.map((r) => r.path)).toEqual(['/match']);
    // Both raw entries were fetched (2 polls consumed the queue) even though only 1 survived the filter.
    expect(admin.getSavedRequestsCalls).toBeGreaterThanOrEqual(2);
  });

  it('throws RiftError naming .record() immediately when the imposter was not created with recording', async () => {
    const admin = new FakeAdminApi();
    const h = await engineOf(admin).create(imposter('s').port(9340)); // no .record()

    let thrown: unknown;
    try {
      await h.requests({ pollIntervalMs: 5 }).next();
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(RiftError);
    expect((thrown as RiftError).message).toContain('.record()');
    // Must throw before ever polling.
    expect(admin.getSavedRequestsCalls).toBe(0);
  });

  it('completes (does not throw) when getSavedRequests rejects with ImposterNotFound mid-iteration', async () => {
    const admin = new FakeAdminApi();
    admin.savedRequestsQueue = [
      [wireRecorded({ path: '/a' })],
      [wireRecorded({ path: '/a' }), wireRecorded({ path: '/b' })],
    ];
    admin.failOnCall = (callNumber) => {
      if (callNumber > 2) throw new ImposterNotFound('imposter deleted');
    };
    const h = await engineOf(admin).create(imposter('s').port(9350).record());

    const items: RecordedRequest[] = [];
    await expect(
      (async () => {
        for await (const r of h.requests({ pollIntervalMs: 5 })) {
          items.push(r);
        }
      })()
    ).resolves.toBeUndefined();

    expect(items.map((r) => r.path)).toEqual(['/a', '/b']);
  });

  it('propagates any other polling error (not ImposterNotFound)', async () => {
    const admin = new FakeAdminApi();
    admin.failOnCall = () => {
      throw new Error('boom');
    };
    const h = await engineOf(admin).create(imposter('s').port(9360).record());

    await expect(h.requests({ pollIntervalMs: 5 }).next()).rejects.toThrow('boom');
  });
});
