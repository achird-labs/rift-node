/**
 * `EmbeddedAdmin` (issue #10) — the embedded transport's `AdminApi` implementation, backed by
 * `librift_ffi` calls (`NativeEngineLike`) plus a local `Map<port, Imposter>` registry, and a
 * lazily-started loopback admin plane (`AdminBridge`, over `rift_serve_admin`) for the handful of
 * operations with no FFI symbol.
 *
 * Routing is deliberately FFI-first and never conditional on flags: `createImposter` always goes
 * through `rift_create_imposter`, never the admin plane, so `inject`/scripted stubs work with no
 * `allowInjection` flag — that flag only gates the HTTP admin surface the plane's bridge methods hit,
 * and FFI calls never pass through it. The registry exists because several FFI calls (`rift_recorded`,
 * `rift_replace_stubs`, ...) are scoped to a port with no "list all imposters" or "get one imposter"
 * symbol — those are reconstructed locally from what this instance has created/observed.
 */

import { randomUUID } from 'crypto';
import type {
  Imposter,
  ImpostersConfig,
  Predicate,
  RecordedRequest as WireRecordedRequest,
  Stub,
} from '@rift-vs/rift/internal';
import type { AdminApi, BuildInfo } from '@rift-vs/rift/internal';
import type { FlowScopedOptions } from '@rift-vs/rift/internal';
import { ImposterNotFound, InvalidDefinition, RiftError } from '@rift-vs/rift';
import { toRecordedRequest, stringifyJsonSafe } from '@rift-vs/rift/internal';
import { evalPredicates } from '@rift-vs/rift/internal';
import { AdminBridge } from './bridge.js';

/** The subset of `NativeEngine`'s facade `EmbeddedAdmin` depends on — small enough that tests
 * inject a FAKE returning canned FFI results, and the real `NativeEngine` satisfies it structurally
 * as-is (see `create.ts`'s default `loadNativeEngine`). */
export interface NativeEngineLike {
  readonly buildInfo: string;
  createImposter(json: string): Promise<number>;
  replaceStubs(port: number, json: string): Promise<number>;
  deleteImposter(port: number): Promise<number>;
  deleteAll(): Promise<number>;
  applyConfig(json: string): Promise<string>;
  recorded(port: number): Promise<string>;
  flowStateGet(port: number, flowId: string, key: string): Promise<{ found: boolean; value?: unknown }>;
  flowStatePut(port: number, flowId: string, key: string, valueJson: string): Promise<number>;
  flowStateDelete(port: number, flowId: string, key: string): Promise<number>;
  spaceAddStub(port: number, flowId: string, json: string): Promise<number>;
  spaceListStubs(port: number, flowId: string): Promise<string>;
  spaceDelete(port: number, flowId: string): Promise<number>;
  spaceRecorded(port: number, flowId: string): Promise<string>;
  /** Intercept (TLS-MITM, issue #11) — adapted by `EmbeddedInterceptBackend`, not routed through
   * this class (there's no imposter/registry state involved). */
  startIntercept(optionsJson: string): Promise<Record<string, unknown>>;
  interceptAddRules(json: string): Promise<number>;
  interceptClearRules(): Promise<number>;
  interceptListRules(): Promise<string>;
  interceptCaPem(): Promise<string>;
  interceptExportTruststore(format: string, password: string, outPath: string): Promise<number>;
  serveAdmin(optionsJson: string): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}

/** Starts the loopback admin plane and reports where it landed. Injectable so bridge behavior
 * (auth, routing, "starts exactly once") is testable against a fake HTTP server instead of a real
 * `rift_serve_admin` call. */
export type StartAdminPlane = (
  native: NativeEngineLike,
  opts: { apiKey: string }
) => Promise<{ adminUrl: string }>;

async function defaultStartAdminPlane(
  native: NativeEngineLike,
  opts: { apiKey: string }
): Promise<{ adminUrl: string }> {
  const result = await native.serveAdmin(JSON.stringify({ host: '127.0.0.1', port: 0, apiKey: opts.apiKey }));
  const adminUrl = result['adminUrl'];
  if (typeof adminUrl !== 'string') {
    throw new RiftError('embedded admin plane (rift_serve_admin) did not report an adminUrl');
  }
  return { adminUrl };
}

export interface EmbeddedAdminOptions {
  native: NativeEngineLike;
  buildInfo: BuildInfo;
  startAdminPlane?: StartAdminPlane;
}

interface Plane {
  bridge: AdminBridge;
  adminUrl: string;
}

const FLOW_ID_PREFIX = 'flow_id=';

/** Converts a `match=` filter string (`field=value` or `field:key=value`, e.g. `header:X-Y=z`) into
 * an `equals` predicate, reusing the #6 evaluator (`evalPredicates`) instead of a bespoke matcher —
 * there is no server-side `match=` filtering for the embedded transport to delegate to. */
function matchToPredicate(entry: string): Predicate {
  const eq = entry.indexOf('=');
  if (eq === -1) {
    throw new InvalidDefinition(`malformed match entry (expected "field=value"): ${entry}`);
  }
  const left = entry.slice(0, eq);
  const value = entry.slice(eq + 1);
  const colon = left.indexOf(':');
  if (colon === -1) {
    return { equals: { [left]: value } } as Predicate;
  }
  const field = left.slice(0, colon);
  const key = left.slice(colon + 1);
  return { equals: { [field]: { [key]: value } } } as Predicate;
}

function stripProxyStubs(stubs: Stub[]): Stub[] {
  return stubs.filter((s) => !(s.responses ?? []).some((r) => r.proxy !== undefined));
}

export class EmbeddedAdmin implements AdminApi {
  readonly url: string | undefined = undefined;

  #native: NativeEngineLike;
  readonly buildInfo: BuildInfo;
  #startAdminPlane: StartAdminPlane;
  #registry = new Map<number, Imposter>();
  #planePromise: Promise<Plane> | undefined;
  #closed = false;

  constructor(opts: EmbeddedAdminOptions) {
    this.#native = opts.native;
    this.buildInfo = opts.buildInfo;
    this.#startAdminPlane = opts.startAdminPlane ?? defaultStartAdminPlane;
  }

  /** Starts the loopback admin plane on first use (idempotent — see `#ensurePlane`) and returns its
   * URL. Not part of `AdminApi`; called by the `Engine.adminUrl()` hook `create.ts` wires up. */
  async adminUrl(): Promise<string> {
    const plane = await this.#ensurePlane();
    return plane.adminUrl;
  }

  // --- imposters ---------------------------------------------------------------------------------

  /** Always FFI — never the admin plane, so `inject`/scripted stubs work unconditionally (the
   * plane's `allowInjection` gate only applies to bridge-routed HTTP calls, never to this path). */
  async createImposter(imposter: Imposter): Promise<Imposter> {
    const port = await this.#native.createImposter(stringifyJsonSafe(imposter));
    const stored: Imposter = { ...imposter, port };
    this.#registry.set(port, stored);
    return stored;
  }

  async listImposters(opts?: { replayable?: boolean }): Promise<ImpostersConfig> {
    const imposters = await Promise.all([...this.#registry.values()].map((imp) => this.#project(imp, opts)));
    return { imposters };
  }

  async getImposter(
    port: number,
    opts?: { replayable?: boolean; removeProxies?: boolean }
  ): Promise<Imposter> {
    return this.#project(this.#requireImposter(port), opts);
  }

  async deleteImposter(port: number): Promise<Imposter> {
    const imp = this.#requireImposter(port);
    await this.#native.deleteImposter(port);
    this.#registry.delete(port);
    return imp;
  }

  async deleteAllImposters(): Promise<void> {
    await this.#native.deleteAll();
    this.#registry.clear();
  }

  async replaceImposters(config: ImpostersConfig): Promise<ImpostersConfig> {
    const raw = await this.#native.applyConfig(stringifyJsonSafe(config));
    const report = JSON.parse(raw) as {
      imposters: Imposter[];
      failed?: Array<{ port?: number; error: string }>;
    };
    // applyConfig has ALREADY mutated native state (partial-apply is possible — that's what `failed[]`
    // reports), so reconcile the registry with whatever natively succeeded BEFORE surfacing failures.
    // Build the replacement map fully first, then swap it in atomically — never clear-then-repopulate
    // in place, which would leave the registry half-updated if a later entry is malformed.
    const next = new Map<number, Imposter>();
    for (const imp of report.imposters) {
      if (imp.port === undefined) throw new RiftError('applyConfig returned an imposter without a port');
      next.set(imp.port, imp);
    }
    this.#registry = next;
    if (report.failed !== undefined && report.failed.length > 0) {
      const detail = report.failed
        .map((f) => (f.port !== undefined ? `port ${f.port}: ${f.error}` : f.error))
        .join('; ');
      throw new InvalidDefinition(`applyConfig rejected ${report.failed.length} imposter(s): ${detail}`);
    }
    return { imposters: report.imposters };
  }

  // --- stubs (read-modify-write over the registry, then a single native.replaceStubs) ------------

  async addStub(port: number, stub: Stub, index?: number): Promise<void> {
    const imp = this.#requireImposter(port);
    const stubs = [...(imp.stubs ?? [])];
    if (index !== undefined) stubs.splice(index, 0, stub);
    else stubs.push(stub);
    await this.#native.replaceStubs(port, stringifyJsonSafe(stubs));
    imp.stubs = stubs;
  }

  async replaceStubs(port: number, stubs: Stub[]): Promise<void> {
    const imp = this.#requireImposter(port);
    await this.#native.replaceStubs(port, stringifyJsonSafe(stubs));
    imp.stubs = [...stubs]; // copy so later caller-side mutation of `stubs` can't leak into the registry
  }

  async getStub(port: number, ref: number | { id: string }): Promise<Stub> {
    const imp = this.#requireImposter(port);
    const stubs = imp.stubs ?? [];
    const stub = stubs[this.#stubIndex(stubs, ref)];
    if (stub === undefined) throw new ImposterNotFound('no such stub');
    return stub;
  }

  async updateStub(port: number, ref: number | { id: string }, stub: Stub): Promise<void> {
    const imp = this.#requireImposter(port);
    const stubs = [...(imp.stubs ?? [])];
    stubs[this.#stubIndex(stubs, ref)] = stub;
    await this.#native.replaceStubs(port, stringifyJsonSafe(stubs));
    imp.stubs = stubs;
  }

  async deleteStub(port: number, ref: number | { id: string }): Promise<void> {
    const imp = this.#requireImposter(port);
    const stubs = [...(imp.stubs ?? [])];
    stubs.splice(this.#stubIndex(stubs, ref), 1);
    await this.#native.replaceStubs(port, stringifyJsonSafe(stubs));
    imp.stubs = stubs;
  }

  // --- saved requests ------------------------------------------------------------------------------

  /** `flow_id=<id>` (the only `match` entry `engine.ts`'s `fetchRecorded` ever sends) routes to
   * `rift_space_recorded` — the FFI's own flow-scoped journal — instead of a generic filter; any
   * OTHER `match` entries (`field=value` / `field:key=value`) are evaluated client-side via the #6
   * evaluator, since there is no server-side `match=` filtering to delegate to here. */
  async getSavedRequests(port: number, match?: string[]): Promise<WireRecordedRequest[]> {
    this.#requireImposter(port);
    const flowEntry = match?.find((m) => m.startsWith(FLOW_ID_PREFIX));
    const rest = (match ?? []).filter((m) => m !== flowEntry);
    const raw =
      flowEntry !== undefined
        ? await this.#native.spaceRecorded(port, flowEntry.slice(FLOW_ID_PREFIX.length))
        : await this.#native.recorded(port);
    const records = JSON.parse(raw) as WireRecordedRequest[];
    if (rest.length === 0) return records;
    const predicates = rest.map(matchToPredicate);
    return records.filter((r) => evalPredicates(predicates, toRecordedRequest(r)));
  }

  async deleteSavedRequests(port: number, match?: string[]): Promise<void> {
    const { bridge } = await this.#ensurePlane();
    await bridge.deleteSavedRequests(port, match);
  }

  async deleteSavedProxyResponses(port: number): Promise<void> {
    const { bridge } = await this.#ensurePlane();
    await bridge.deleteSavedProxyResponses(port);
  }

  // --- enable/disable (bridge — no FFI symbol) -----------------------------------------------------

  async enableImposter(port: number): Promise<void> {
    const { bridge } = await this.#ensurePlane();
    await bridge.enableImposter(port);
  }

  async disableImposter(port: number): Promise<void> {
    const { bridge } = await this.#ensurePlane();
    await bridge.disableImposter(port);
  }

  // --- scenarios (bridge — no FFI symbol) ------------------------------------------------------------

  async getScenarios(
    port: number,
    opts?: FlowScopedOptions
  ): Promise<{ flowId: string; scenarios: Array<{ name: string; state: string }> }> {
    const { bridge } = await this.#ensurePlane();
    return bridge.getScenarios(port, opts);
  }

  async setScenarioState(port: number, name: string, state: string, opts?: FlowScopedOptions): Promise<void> {
    const { bridge } = await this.#ensurePlane();
    await bridge.setScenarioState(port, name, state, opts);
  }

  async resetScenarios(port: number, opts?: FlowScopedOptions): Promise<void> {
    const { bridge } = await this.#ensurePlane();
    await bridge.resetScenarios(port, opts);
  }

  // --- spaces ---------------------------------------------------------------------------------------

  async addSpaceStub(port: number, flowId: string, stub: Stub): Promise<void> {
    await this.#native.spaceAddStub(port, flowId, stringifyJsonSafe(stub));
  }

  async listSpaceStubs(port: number, flowId: string): Promise<{ space: string; stubs: Stub[] }> {
    const raw = await this.#native.spaceListStubs(port, flowId);
    return JSON.parse(raw) as { space: string; stubs: Stub[] };
  }

  /** No `rift_space_*` symbol returns the full space object — bridged (see `bridge.ts`). */
  async getSpace<T = unknown>(port: number, flowId: string): Promise<T> {
    const { bridge } = await this.#ensurePlane();
    return bridge.getSpace<T>(port, flowId);
  }

  async deleteSpace(port: number, flowId: string): Promise<void> {
    await this.#native.spaceDelete(port, flowId);
  }

  // --- flow state -------------------------------------------------------------------------------------

  async getFlowState<T = unknown>(port: number, flowId: string, key: string): Promise<T | undefined> {
    const result = await this.#native.flowStateGet(port, flowId, key);
    return result.found ? (result.value as T) : undefined;
  }

  async setFlowState(port: number, flowId: string, key: string, value: unknown): Promise<void> {
    await this.#native.flowStatePut(port, flowId, key, stringifyJsonSafe(value));
  }

  async deleteFlowState(port: number, flowId: string, key: string): Promise<void> {
    await this.#native.flowStateDelete(port, flowId, key);
  }

  // --- admin ------------------------------------------------------------------------------------------

  /** Synthesized from the parsed build info + no live plane — never starts one just to answer this. */
  async config(): Promise<Record<string, unknown>> {
    return {
      options: {
        version: this.buildInfo.version,
        commit: this.buildInfo.commit,
        builtAt: this.buildInfo.builtAt,
      },
      features: this.buildInfo.features,
    };
  }

  async logs(opts?: { startIndex?: number; endIndex?: number }): Promise<unknown[]> {
    const { bridge } = await this.#ensurePlane();
    return bridge.logs(opts);
  }

  async reload(): Promise<unknown> {
    const { bridge } = await this.#ensurePlane();
    return bridge.reload();
  }

  // --- disposal -----------------------------------------------------------------------------------------

  get closed(): boolean {
    return this.#closed;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    // native.close() MUST run even if the plane failed to start or its teardown throws — otherwise
    // the FFI handle / worker thread leaks and, since #closed is already set, can never be retried.
    try {
      if (this.#planePromise !== undefined) {
        const plane = await this.#planePromise.catch(() => undefined);
        await plane?.bridge.close();
      }
    } finally {
      await this.#native.close();
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  // --- internals -------------------------------------------------------------------------------------------

  #requireImposter(port: number): Imposter {
    const imp = this.#registry.get(port);
    if (imp === undefined) throw new ImposterNotFound(`no imposter on port ${port}`);
    return imp;
  }

  #stubIndex(stubs: Stub[], ref: number | { id: string }): number {
    const index = typeof ref === 'number' ? ref : stubs.findIndex((s) => s.id === ref.id);
    if (index < 0 || index >= stubs.length) throw new ImposterNotFound('no such stub');
    return index;
  }

  async #project(
    imp: Imposter,
    opts?: { replayable?: boolean; removeProxies?: boolean }
  ): Promise<Imposter> {
    const stubs =
      opts?.removeProxies === true && imp.stubs !== undefined ? stripProxyStubs(imp.stubs) : imp.stubs;
    const base: Imposter = { ...imp, stubs };
    if (opts?.replayable === true) return base;
    const raw = await this.#native.recorded(imp.port as number);
    const numberOfRequests = (JSON.parse(raw) as unknown[]).length;
    return { ...base, numberOfRequests };
  }

  /** Starts the loopback admin plane at most once: the promise is assigned synchronously (before
   * any `await`), so concurrent first-uses — even two bridge calls issued without an `await`
   * between them — observe the same in-flight promise instead of racing two `rift_serve_admin`
   * calls. An `EmbeddedAdmin` that never calls a bridge method never starts the plane at all. */
  #ensurePlane(): Promise<Plane> {
    if (this.#planePromise === undefined) {
      this.#planePromise = this.#startPlane();
    }
    return this.#planePromise;
  }

  async #startPlane(): Promise<Plane> {
    const apiKey = randomUUID();
    const { adminUrl } = await this.#startAdminPlane(this.#native, { apiKey });
    return { bridge: new AdminBridge({ adminUrl, apiKey }), adminUrl };
  }
}
