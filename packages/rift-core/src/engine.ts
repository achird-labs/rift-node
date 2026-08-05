/**
 * RiftEngine facade + imposter/space/flow-state handles (issue #21).
 *
 * `RiftEngine` and its handles are implemented exactly once, over the `AdminApi` interface below;
 * each transport (remote / spawn / embedded) only has to produce an `AdminApi` implementation.
 * This replaces the old split where spawn returned `{ url, port, client }` and remote returned a
 * bare client with no shared ergonomic surface.
 */

import { randomUUID } from 'crypto';
import { writeFile } from 'fs/promises';
import { readFileSync } from 'fs';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import type {
  Imposter,
  ImpostersConfig,
  InterceptRule,
  IsResponse,
  Predicate,
  RecordedRequest as WireRecordedRequest,
  Stub,
} from './model/index.js';
import { ImposterBuilder } from './dsl/imposter.js';
import { StubBuilder, type AnyStubBuilder } from './dsl/stub.js';
import type { ResponseBuilder } from './dsl/response.js';
import { RemoteClient, normalizeUrl, type FlowScopedOptions } from './remote/client.js';
import { spawn as spawnProcess, type SpawnOptions } from './spawn/spawn.js';
import {
  EngineUnavailable,
  EngineVersionError,
  ImposterNotFound,
  InterceptUnavailable,
  InvalidDefinition,
  RiftError,
  VerificationError,
} from './errors.js';
import {
  atLeast,
  predicatesOf,
  toRecordedRequest,
  type CountMatcher,
  type RecordedFilter,
  type RecordedRequest,
  type RequestMatch,
} from './verify/index.js';
import { computeClosest, evalPredicates } from './verify/eval.js';
import type { InterceptBackend, InterceptOptions } from './intercept/types.js';
import { RemoteInterceptBackend } from './intercept/remote-backend.js';
import { forwardRule, redirectRule, serveRule } from './intercept/rules.js';
import { jsonSafeReplacer, stringifyJsonSafe } from './model/serialize.js';

// --- shared small types ----------------------------------------------------------------------

export type Transport = 'remote' | 'spawn' | 'embedded';

export interface ImposterSummary {
  port: number;
  protocol: string;
  name?: string;
  numberOfRequests: number;
}

export interface BuildInfo {
  version: string;
  commit?: string;
  builtAt?: string;
  features: string[];
}

// --- AdminApi: the total, typed admin surface every transport implements ----------------------

export interface AdminApi extends AsyncDisposable {
  createImposter(imposter: Imposter): Promise<Imposter>;
  listImposters(opts?: { replayable?: boolean }): Promise<ImpostersConfig>;
  getImposter(
    port: number,
    opts?: { replayable?: boolean; removeProxies?: boolean }
  ): Promise<Imposter>;
  deleteImposter(port: number): Promise<Imposter>;
  deleteAllImposters(): Promise<void>;
  replaceImposters(config: ImpostersConfig): Promise<ImpostersConfig>;

  addStub(port: number, stub: Stub, index?: number): Promise<void>;
  replaceStubs(port: number, stubs: Stub[]): Promise<void>;
  getStub(port: number, ref: number | { id: string }): Promise<Stub>;
  updateStub(port: number, ref: number | { id: string }, stub: Stub): Promise<void>;
  deleteStub(port: number, ref: number | { id: string }): Promise<void>;

  getSavedRequests(port: number, match?: string[]): Promise<WireRecordedRequest[]>;
  deleteSavedRequests(port: number, match?: string[]): Promise<void>;
  deleteSavedProxyResponses(port: number): Promise<void>;

  enableImposter(port: number): Promise<void>;
  disableImposter(port: number): Promise<void>;

  getScenarios(
    port: number,
    opts?: FlowScopedOptions
  ): Promise<{ flowId: string; scenarios: Array<{ name: string; state: string }> }>;
  setScenarioState(port: number, name: string, state: string, opts?: FlowScopedOptions): Promise<void>;
  resetScenarios(port: number, opts?: FlowScopedOptions): Promise<void>;

  addSpaceStub(port: number, flowId: string, stub: Stub): Promise<void>;
  listSpaceStubs(port: number, flowId: string): Promise<{ space: string; stubs: Stub[] }>;
  getSpace<T = unknown>(port: number, flowId: string): Promise<T>;
  deleteSpace(port: number, flowId: string): Promise<void>;

  getFlowState<T = unknown>(port: number, flowId: string, key: string): Promise<T | undefined>;
  setFlowState(port: number, flowId: string, key: string, value: unknown): Promise<void>;
  deleteFlowState(port: number, flowId: string, key: string): Promise<void>;

  config(): Promise<Record<string, unknown>>;
  logs(opts?: { startIndex?: number; endIndex?: number }): Promise<unknown[]>;
  reload(): Promise<unknown>;

  /** The admin base URL when the transport is URL-backed (remote/spawn); absent for embedded. */
  readonly url?: string;
  readonly closed: boolean;
  close(): Promise<void>;
}

// --- handles -----------------------------------------------------------------------------------

export interface FlowStateHandle {
  get<T = unknown>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface SpaceHandle {
  readonly flowId: string;
  addStub(stub: AnyStubBuilder | Stub): Promise<void>;
  stubs(): Promise<{ space: string; stubs: Stub[] }>;
  delete(): Promise<void>;

  // verification (issue #6), scoped to this flow id via `match=flow_id=<id>`
  recorded(match?: RequestMatch): Promise<RecordedRequest[]>;
  verify(match: RequestMatch, count?: CountMatcher): Promise<void>;

  scenarios(): Promise<Array<{ name: string; state: string }>>;
  setScenarioState(name: string, state: string): Promise<void>;
  resetScenarios(): Promise<void>;
  readonly state: FlowStateHandle;
}

export interface ImposterHandle extends AsyncDisposable {
  readonly port: number;
  /** `${protocol}://${reachableHost}:${port}` — a `0.0.0.0`/`::`/empty bind host maps to 127.0.0.1. */
  readonly url: string;
  readonly name?: string;
  readonly protocol: 'http' | 'https';

  // stub surgery
  addStub(stub: AnyStubBuilder | Stub, opts?: { index?: number }): Promise<void>;
  replaceStubs(...stubs: Array<AnyStubBuilder | Stub>): Promise<void>;
  updateStub(ref: number | { id: string }, stub: AnyStubBuilder | Stub): Promise<void>;
  deleteStub(ref: number | { id: string }): Promise<void>;
  stubs(): Promise<Stub[]>;

  // verification (issue #6)
  recorded(filter?: RecordedFilter): Promise<RecordedRequest[]>;
  clearRecorded(): Promise<void>;
  /** Throws `VerificationError` when the count isn't satisfied; default `count` is `atLeast(1)`.
   * Throws `RiftError` (naming `.record()`) if the imposter wasn't created with recording enabled. */
  verify(match: RequestMatch, count?: CountMatcher): Promise<void>;
  /** Polls the recorded-request journal (default every 250ms) and yields each newly-recorded
   * request exactly once, in journal order. Completes cleanly (no throw) when `opts.signal` aborts
   * or the imposter is deleted mid-poll; throws `RiftError` (naming `.record()`) up front — before
   * the first poll — if the imposter wasn't created with recording enabled; any other polling
   * error propagates. */
  requests(opts?: {
    pollIntervalMs?: number;
    signal?: AbortSignal;
    match?: RequestMatch;
  }): AsyncIterableIterator<RecordedRequest>;

  // scenarios
  scenarios(flowId?: string): Promise<Array<{ name: string; state: string }>>;
  setScenarioState(name: string, state: string, flowId?: string): Promise<void>;
  resetScenarios(flowId?: string): Promise<void>;

  // spaces & flow state
  space(flowId: string): SpaceHandle;
  flowState(flowId: string): FlowStateHandle;

  // lifecycle & export
  enable(): Promise<void>;
  disable(): Promise<void>;
  clearProxyRecordings(): Promise<void>;
  toJson(opts?: { replayable?: boolean; removeProxies?: boolean }): Promise<Imposter>;
  delete(): Promise<void>;
}

export type { InterceptOptions } from './intercept/types.js';

/** TLS-MITM intercept surface (issue #11): point the SUT's HTTPS(+HTTP) proxy at `.url`, decrypt via
 * a minted (or supplied) CA, and match/serve/forward the decrypted requests. */
export interface InterceptHandle {
  /** `"http://127.0.0.1:<port>"` — set as the SUT's HTTPS(+HTTP) proxy. */
  readonly url: string;
  readonly port: number;

  /** `string` match = host shorthand (`{host, action:{serve}}`); a `Predicate[]` match is AND-ed
   * over the decrypted request (`{predicates, action:{serve}}`).
   *
   * The response is normalized to the engine's narrower `ServeStub` (issue #101): a non-string body
   * becomes compact JSON (`okJson({a:1})` sends `'{"a":1}'`), a numeric-string `statusCode` is
   * coerced to a number, and `_mode: 'text'` plus unknown keys are dropped. What the engine cannot
   * represent is refused rather than silently mangled — a multi-value header (joining would corrupt
   * `Set-Cookie`), a binary body (the base64 would be served as literal text), and a `statusCode`
   * outside the 100..999 the engine can render as a status line. Use `forward()` to an imposter when
   * you need any of those, or `addRule()` to send a rule verbatim.
   *
   * Body key order follows your object; the imposter path re-serializes through Rust and emits
   * sorted keys, so the two differ byte-wise for a SUT that hashes or byte-asserts the body. */
  serve(match: string | Predicate[], response: ResponseBuilder | IsResponse): Promise<void>;
  /** `to` is either a real imposter (its `.port` is used) or a raw port number. */
  forward(match: string | Predicate[], to: ImposterHandle | number): Promise<void>;
  /** A catch-all forward rule — no `host`/`predicates` — routing whatever no more specific rule did. */
  redirectTo(imposter: ImposterHandle): Promise<void>;
  /** Raw escape hatch: add one or more rules verbatim — no normalization, unlike `serve()`.
   *
   * "Verbatim" stops at what JSON can represent: a value `JSON.stringify` cannot encode honestly is
   * refused with `InvalidDefinition` rather than sent (issue #111). A non-finite `statusCode` or
   * predicate value would otherwise reach the engine as a `null` you never wrote. A finite but
   * nonsensical `statusCode` is still your business — this hatch does not range-check. */
  addRule(rule: InterceptRule | InterceptRule[]): Promise<void>;
  rules(): Promise<InterceptRule[]>;
  clearRules(): Promise<void>;

  caPem(): Promise<string>;
  /** Writes the CA PEM to `dir` (default `os.tmpdir()`) under a fresh filename and returns the path. */
  caFile(dir?: string): Promise<string>;
  /** `password` defaults to `'changeit'` (the conventional Java truststore default). */
  exportTruststore(opts: { format: 'pkcs12' | 'jks'; path: string; password?: string }): Promise<void>;
  /** `{ HTTPS_PROXY, HTTP_PROXY, NODE_EXTRA_CA_CERTS }` — spread into a child process's env so
   * Node ≥ 20 (and most HTTP clients that honor these) trust and route through the intercept. */
  env(): Promise<Record<string, string>>;
}

export interface RiftEngine extends AsyncDisposable {
  readonly transport: Transport;

  create(def: ImposterBuilder | Imposter): Promise<ImposterHandle>;
  get(port: number): Promise<ImposterHandle>;
  list(): Promise<ImposterSummary[]>;
  deleteAll(): Promise<void>;
  replaceAll(defs: Array<ImposterBuilder | Imposter>): Promise<ImposterHandle[]>;

  buildInfo(): Promise<BuildInfo>;
  adminUrl(): Promise<string>;

  intercept(options?: InterceptOptions): Promise<InterceptHandle>;

  readonly admin: AdminApi;
  close(): Promise<void>;
  readonly closed: boolean;
}

// --- helpers -------------------------------------------------------------------------------

function toWireImposter(def: ImposterBuilder | Imposter): Imposter {
  const wire = def instanceof ImposterBuilder ? def.build() : def;
  // Protocol is required by Mountebank; default to 'http' if not specified
  return wire.protocol === undefined ? { ...wire, protocol: 'http' } : wire;
}

function toWireStub(def: AnyStubBuilder | Stub): Stub {
  return def instanceof StubBuilder ? def.build() : def;
}

function normalizeProtocol(protocol: unknown): 'http' | 'https' {
  return protocol === 'https' ? 'https' : 'http';
}

/** Normalizes a host to a dialable one: strips IPv6 brackets, and maps an any-interface bind
 * (`0.0.0.0`/`::`/empty/absent) to loopback. A concrete hostname/IP is returned unchanged. */
function normalizeHost(host: string | undefined): string {
  if (host === undefined || host === '') return '127.0.0.1';
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  if (bare === '0.0.0.0' || bare === '::') return '127.0.0.1';
  return bare;
}

/** `hostHint` (the admin URL's host, set by the remote/spawn transports) wins over the imposter's
 * own bind host; either way the any-interface normalization applies so `.url` is always dialable. */
function reachableHost(hostHint: string | undefined, bindHost: string | undefined): string {
  return normalizeHost(hostHint ?? bindHost);
}

class FlowStateHandleImpl implements FlowStateHandle {
  constructor(
    private readonly admin: AdminApi,
    private readonly port: number,
    private readonly flowId: string
  ) {}

  async get<T = unknown>(key: string): Promise<T | undefined> {
    return this.admin.getFlowState<T>(this.port, this.flowId, key);
  }

  async set(key: string, value: unknown): Promise<void> {
    await this.admin.setFlowState(this.port, this.flowId, key, value);
  }

  async delete(key: string): Promise<void> {
    await this.admin.deleteFlowState(this.port, this.flowId, key);
  }
}

class SpaceHandleImpl implements SpaceHandle {
  readonly state: FlowStateHandle;

  constructor(
    private readonly admin: AdminApi,
    private readonly port: number,
    readonly flowId: string,
    private readonly imposterLabel: string,
    private readonly recordingEnabled: boolean
  ) {
    this.state = new FlowStateHandleImpl(admin, port, flowId);
  }

  async addStub(stub: AnyStubBuilder | Stub): Promise<void> {
    await this.admin.addSpaceStub(this.port, this.flowId, toWireStub(stub));
  }

  async stubs(): Promise<{ space: string; stubs: Stub[] }> {
    return this.admin.listSpaceStubs(this.port, this.flowId);
  }

  async delete(): Promise<void> {
    await this.admin.deleteSpace(this.port, this.flowId);
  }

  async recorded(match?: RequestMatch): Promise<RecordedRequest[]> {
    requireRecording(this.imposterLabel, this.recordingEnabled);
    return fetchRecorded(this.admin, this.port, { match, flowId: this.flowId });
  }

  async verify(match: RequestMatch, count: CountMatcher = atLeast(1)): Promise<void> {
    await runVerify(this.admin, this.port, this.imposterLabel, this.recordingEnabled, match, count, {
      flowId: this.flowId,
    });
  }

  async scenarios(): Promise<Array<{ name: string; state: string }>> {
    const result = await this.admin.getScenarios(this.port, { flowId: this.flowId });
    return result.scenarios;
  }

  async setScenarioState(name: string, state: string): Promise<void> {
    await this.admin.setScenarioState(this.port, name, state, { flowId: this.flowId });
  }

  async resetScenarios(): Promise<void> {
    await this.admin.resetScenarios(this.port, { flowId: this.flowId });
  }
}

/** `imposter "users" (port 55123)` / `imposter (port 55123)` — the shared prefix for verification
 * messages, matching the design's rendered `VerificationError` header exactly. */
function imposterLabel(name: string | undefined, port: number): string {
  return name !== undefined ? `imposter "${name}" (port ${port})` : `imposter (port ${port})`;
}

/** A non-recording imposter has no journal at all, so `verify()`/`recorded()` both fail loudly
 * with a `RiftError` naming the `.record()` fix rather than silently reporting an empty result. */
function requireRecording(label: string, recordingEnabled: boolean): void {
  if (!recordingEnabled) {
    throw new RiftError(
      `${label} was created without recording enabled — add .record() when building the imposter to use verify()/recorded()`
    );
  }
}

/** Fetches recorded requests: `flowId` filters server-side (`match=flow_id=<id>`); `match`
 * (predicates) is evaluated client-side against the (possibly flow-filtered) fetch. */
async function fetchRecorded(
  admin: AdminApi,
  port: number,
  filter: { match?: RequestMatch; flowId?: string }
): Promise<RecordedRequest[]> {
  const serverMatch = filter.flowId !== undefined ? [`flow_id=${filter.flowId}`] : undefined;
  const mapped = (await admin.getSavedRequests(port, serverMatch)).map(toRecordedRequest);
  if (filter.match === undefined) return mapped;
  const predicates = predicatesOf(filter.match);
  return mapped.filter((r) => evalPredicates(predicates, r));
}

/** Shared `verify()` body for both `ImposterHandle` and `SpaceHandle`: resolves once `count` is
 * satisfied, otherwise throws an enriched `VerificationError` (or, when recording was never
 * enabled, a plain `RiftError` naming the `.record()` fix — there's no journal to check at all). */
async function runVerify(
  admin: AdminApi,
  port: number,
  label: string,
  recordingEnabled: boolean,
  match: RequestMatch,
  count: CountMatcher,
  scope: { flowId?: string }
): Promise<void> {
  requireRecording(label, recordingEnabled);
  const predicates = predicatesOf(match);
  const recorded = await fetchRecorded(admin, port, scope);
  const matched = recorded.filter((r) => evalPredicates(predicates, r)).length;
  if (matched >= count.min && matched <= count.max) return;
  const closest = matched === 0 ? computeClosest(predicates, recorded) : undefined;
  throw new VerificationError(`Verification failed for ${label}`, {
    expected: predicates,
    count: { matched, total: recorded.length, matcher: count },
    recorded,
    closest,
  });
}

/** A plain function call (rather than a repeated `signal?.aborted` property read) so TS's control
 * flow analysis never narrows it as constant across an `await` — `AbortSignal.aborted` is
 * `readonly`, which TS otherwise treats as unable to change within a block. */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/** `setTimeout`-based sleep that also resolves early when `signal` aborts; the timer is cleared and
 * the abort listener removed in a `finally` on every exit path, so an aborted `requests()` iterator
 * never leaves a dangling timer behind. */
async function abortableSleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (isAborted(signal)) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    await new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
      onAbort = resolve;
      signal?.addEventListener('abort', onAbort, { once: true });
      // An abort that lands between the isAborted() check above and addEventListener would attach
      // to an already-dispatched signal and never fire — re-check so the sleep resolves at once.
      if (isAborted(signal)) resolve();
    });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort);
  }
}

/** Polls `getSavedRequests` for the RAW (unfiltered) journal — never passing a server-side `match`,
 * since `cursor` is a plain index into the raw appended array and a server-side filter would shift
 * it, breaking de-dup. `opts.match` (if given) is applied client-side to each newly-seen slice only;
 * the cursor still advances over the full raw list even when the filter discards most of it. A
 * shrunk list (`list.length < cursor`) means the journal was cleared, so the cursor resets to 0
 * instead of stalling forever. SSE-based push delivery is a future capability-probe upgrade
 * (rift#461) — this only polls. */
async function* pollRecordedRequests(
  admin: AdminApi,
  port: number,
  opts: { pollIntervalMs?: number; signal?: AbortSignal; match?: RequestMatch }
): AsyncGenerator<RecordedRequest> {
  const pollIntervalMs = opts.pollIntervalMs ?? 250;
  const predicates = opts.match !== undefined ? predicatesOf(opts.match) : undefined;
  let cursor = 0;
  while (!isAborted(opts.signal)) {
    let list: WireRecordedRequest[];
    try {
      list = await admin.getSavedRequests(port);
    } catch (error) {
      if (error instanceof ImposterNotFound) return;
      throw error;
    }
    // Length-only clear detection: a journal cleared and refilled to >= the old cursor within a
    // single poll interval isn't observed as a shrink (those entries are skipped). Unavoidable
    // without server-side request identity — the SSE push path (rift#461) closes this gap.
    if (list.length < cursor) cursor = 0;
    const fresh = list.slice(cursor).map(toRecordedRequest);
    cursor = list.length;
    for (const request of fresh) {
      if (predicates === undefined || evalPredicates(predicates, request)) yield request;
    }
    if (isAborted(opts.signal)) return;
    await abortableSleep(pollIntervalMs, opts.signal);
  }
}

class ImposterHandleImpl implements ImposterHandle {
  readonly port: number;
  readonly url: string;
  readonly name: string | undefined;
  readonly protocol: 'http' | 'https';
  private readonly recordingEnabled: boolean;

  constructor(
    private readonly admin: AdminApi,
    imp: Imposter,
    hostHint: string | undefined
  ) {
    if (imp.port === undefined) {
      throw new RiftError('engine returned an imposter without a port');
    }
    this.port = imp.port;
    this.protocol = normalizeProtocol(imp.protocol);
    this.name = imp.name;
    this.recordingEnabled = imp.recordRequests === true;
    this.url = `${this.protocol}://${reachableHost(hostHint, imp.host)}:${this.port}`;
  }

  async addStub(stub: AnyStubBuilder | Stub, opts?: { index?: number }): Promise<void> {
    await this.admin.addStub(this.port, toWireStub(stub), opts?.index);
  }

  async replaceStubs(...stubs: Array<AnyStubBuilder | Stub>): Promise<void> {
    await this.admin.replaceStubs(this.port, stubs.map(toWireStub));
  }

  async updateStub(ref: number | { id: string }, stub: AnyStubBuilder | Stub): Promise<void> {
    await this.admin.updateStub(this.port, ref, toWireStub(stub));
  }

  async deleteStub(ref: number | { id: string }): Promise<void> {
    await this.admin.deleteStub(this.port, ref);
  }

  async stubs(): Promise<Stub[]> {
    const imp = await this.admin.getImposter(this.port);
    return imp.stubs ?? [];
  }

  async recorded(filter?: RecordedFilter): Promise<RecordedRequest[]> {
    requireRecording(imposterLabel(this.name, this.port), this.recordingEnabled);
    return fetchRecorded(this.admin, this.port, { match: filter?.match, flowId: filter?.flowId });
  }

  async clearRecorded(): Promise<void> {
    await this.admin.deleteSavedRequests(this.port);
  }

  async verify(match: RequestMatch, count: CountMatcher = atLeast(1)): Promise<void> {
    await runVerify(
      this.admin,
      this.port,
      imposterLabel(this.name, this.port),
      this.recordingEnabled,
      match,
      count,
      {}
    );
  }

  async *requests(
    opts: { pollIntervalMs?: number; signal?: AbortSignal; match?: RequestMatch } = {}
  ): AsyncIterableIterator<RecordedRequest> {
    requireRecording(imposterLabel(this.name, this.port), this.recordingEnabled);
    yield* pollRecordedRequests(this.admin, this.port, opts);
  }

  async scenarios(flowId?: string): Promise<Array<{ name: string; state: string }>> {
    const result = await this.admin.getScenarios(this.port, flowId !== undefined ? { flowId } : undefined);
    return result.scenarios;
  }

  async setScenarioState(name: string, state: string, flowId?: string): Promise<void> {
    await this.admin.setScenarioState(
      this.port,
      name,
      state,
      flowId !== undefined ? { flowId } : undefined
    );
  }

  async resetScenarios(flowId?: string): Promise<void> {
    await this.admin.resetScenarios(this.port, flowId !== undefined ? { flowId } : undefined);
  }

  space(flowId: string): SpaceHandle {
    return new SpaceHandleImpl(
      this.admin,
      this.port,
      flowId,
      imposterLabel(this.name, this.port),
      this.recordingEnabled
    );
  }

  flowState(flowId: string): FlowStateHandle {
    return new FlowStateHandleImpl(this.admin, this.port, flowId);
  }

  async enable(): Promise<void> {
    await this.admin.enableImposter(this.port);
  }

  async disable(): Promise<void> {
    await this.admin.disableImposter(this.port);
  }

  async clearProxyRecordings(): Promise<void> {
    await this.admin.deleteSavedProxyResponses(this.port);
  }

  async toJson(opts?: { replayable?: boolean; removeProxies?: boolean }): Promise<Imposter> {
    return this.admin.getImposter(this.port, opts);
  }

  /** Idempotent: a second `delete()` (or dispose after an explicit delete) swallows only
   * `ImposterNotFound` — every other failure still propagates. */
  async delete(): Promise<void> {
    try {
      await this.admin.deleteImposter(this.port);
    } catch (error) {
      if (error instanceof ImposterNotFound) return;
      throw error;
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.delete();
  }
}

const DEFAULT_TRUSTSTORE_PASSWORD = 'changeit';

/** Implemented exactly once over an {@link InterceptBackend} — embedded (FFI), spawn, and remote
 * (both HTTP) each only have to produce one, so this class never branches on transport. */
class InterceptHandleImpl implements InterceptHandle {
  readonly port: number;
  readonly url: string;

  constructor(
    private readonly backend: InterceptBackend,
    info: { port: number; url: string }
  ) {
    this.port = info.port;
    this.url = info.url;
  }

  async serve(match: string | Predicate[], response: ResponseBuilder | IsResponse): Promise<void> {
    await this.addRule(serveRule(match, response));
  }

  async forward(match: string | Predicate[], to: ImposterHandle | number): Promise<void> {
    await this.addRule(forwardRule(match, to));
  }

  async redirectTo(imposter: ImposterHandle): Promise<void> {
    await this.addRule(redirectRule(imposter));
  }

  /** Serialized through the wire model's own {@link jsonSafeReplacer} (issue #111) so a rule is
   * refused here rather than arriving at the engine with a `null` the caller never wrote — a
   * non-finite `statusCode` or predicate value is otherwise nulled silently by `JSON.stringify`,
   * and the transport cannot catch it because `interceptAddRules` re-parses this string after the
   * damage is done. Re-wrapped as `InvalidDefinition` (as `toBody()` does) because `serve()`,
   * `forward()` and `redirectTo()` all funnel through here and issue #101 fixed their refusals to
   * that one type. */
  async addRule(rule: InterceptRule | InterceptRule[]): Promise<void> {
    const rules = Array.isArray(rule) ? rule : [rule];
    let json: string;
    try {
      json = JSON.stringify(rules, jsonSafeReplacer);
    } catch (cause) {
      throw new InvalidDefinition(
        `intercept rule could not be serialized to JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
        { cause }
      );
    }
    await this.backend.addRules(json);
  }

  async rules(): Promise<InterceptRule[]> {
    return JSON.parse(await this.backend.listRules()) as InterceptRule[];
  }

  async clearRules(): Promise<void> {
    await this.backend.clearRules();
  }

  async caPem(): Promise<string> {
    return this.backend.caPem();
  }

  async caFile(dir?: string): Promise<string> {
    const pem = await this.caPem();
    const target = join(dir ?? tmpdir(), `rift-intercept-ca-${randomUUID()}.pem`);
    await writeFile(target, pem, 'utf8');
    return target;
  }

  async exportTruststore(opts: { format: 'pkcs12' | 'jks'; path: string; password?: string }): Promise<void> {
    await this.backend.exportTruststore(opts.format, opts.password ?? DEFAULT_TRUSTSTORE_PASSWORD, opts.path);
  }

  async env(): Promise<Record<string, string>> {
    const caFile = await this.caFile();
    return { HTTPS_PROXY: this.url, HTTP_PROXY: this.url, NODE_EXTRA_CA_CERTS: caFile };
  }
}

/** Both-or-neither: a lone `caCertPath`/`caKeyPath` is almost certainly a typo (the other half
 * silently falls back to a generated CA), so it's rejected loudly rather than guessed at. */
function validateInterceptOptions(options: InterceptOptions | undefined): void {
  if (options === undefined) return;
  const hasCert = options.caCertPath !== undefined;
  const hasKey = options.caKeyPath !== undefined;
  if (hasCert !== hasKey) {
    throw new InvalidDefinition('intercept caCertPath and caKeyPath must be provided together (both or neither)');
  }
}

/** Shared by every transport's "first call" path: asks the backend to start/attach, then wraps the
 * result in the one `InterceptHandleImpl`. */
async function startInterceptWithBackend(
  backend: InterceptBackend,
  options: InterceptOptions | undefined
): Promise<InterceptHandle> {
  // Guarded like every other outbound payload (issue #112): `InterceptOptions.port` is a
  // caller-supplied number, so a non-finite one reached the embedded FFI as `null` and left the
  // remote/spawn backend building the URL `http://host:null` — a handle that looks started and is
  // not.
  const { interceptPort, interceptUrl } = await backend.startIntercept(stringifyJsonSafe(options ?? {}));
  return new InterceptHandleImpl(backend, { port: interceptPort, url: interceptUrl });
}

interface EngineOptions {
  hostHint?: string;
  onClose?: () => Promise<void>;
  /** Overrides `buildInfo()`'s default `admin.config()` round-trip — the embedded transport already
   * has its parsed `BuildInfo` in hand (from `librift_ffi`'s build-info payload) and never needs a
   * live plane just to answer this. */
  buildInfo?: () => Promise<BuildInfo>;
  /** Overrides `adminUrl()`'s default `adminClient.url` read — the embedded transport has no URL
   * until its loopback admin plane is started, which this hook does lazily, on first call. */
  adminUrl?: () => Promise<string>;
  /** Embedded transport's intercept backend, wired eagerly by `embedded/create.ts` (which already
   * has the native engine in scope). Absent for remote/spawn, which build a `RemoteInterceptBackend`
   * lazily inside `Engine.intercept()` itself — there's no eager native handle to adapt there. */
  interceptBackend?: InterceptBackend;
  /** Spawn transport's pre-resolved intercept attach point — set only when `rift.spawn({intercept})`
   * requested it. The port is always concrete by the time this is set (`spawn.ts`'s
   * `resolveInterceptPort`), never the engine-ephemeral `0` the CLI flag itself may carry. */
  interceptSpawn?: { host: string; port: number };
}

export class Engine implements RiftEngine {
  #closed = false;
  #interceptHandle: InterceptHandle | undefined;

  constructor(
    private readonly adminClient: AdminApi,
    readonly transport: Transport,
    private readonly opts: EngineOptions = {}
  ) {}

  get admin(): AdminApi {
    return this.adminClient;
  }

  async create(def: ImposterBuilder | Imposter): Promise<ImposterHandle> {
    const created = await this.adminClient.createImposter(toWireImposter(def));
    return this.handleFrom(created);
  }

  async get(port: number): Promise<ImposterHandle> {
    const imp = await this.adminClient.getImposter(port);
    return this.handleFrom(imp);
  }

  async list(): Promise<ImposterSummary[]> {
    const cfg = await this.adminClient.listImposters();
    return cfg.imposters.map((imp) => this.summaryOf(imp));
  }

  async deleteAll(): Promise<void> {
    await this.adminClient.deleteAllImposters();
  }

  async replaceAll(defs: Array<ImposterBuilder | Imposter>): Promise<ImposterHandle[]> {
    const result = await this.adminClient.replaceImposters({ imposters: defs.map(toWireImposter) });
    return result.imposters.map((imp) => this.handleFrom(imp));
  }

  async buildInfo(): Promise<BuildInfo> {
    if (this.opts.buildInfo !== undefined) return this.opts.buildInfo();
    const cfg = await this.adminClient.config();
    return buildInfoFromConfig(cfg);
  }

  async adminUrl(): Promise<string> {
    if (this.opts.adminUrl !== undefined) return this.opts.adminUrl();
    if (typeof this.adminClient.url === 'string') return this.adminClient.url;
    throw new EngineUnavailable('adminUrl() has no wired admin URL on this transport');
  }

  /** Idempotent-ish: the handle is memoized after the first successful call. A later call WITH
   * options on top of an already-started intercept is rejected (options would be silently ignored
   * otherwise); a later call with no options just returns the existing handle. */
  async intercept(options?: InterceptOptions): Promise<InterceptHandle> {
    if (this.#interceptHandle !== undefined) {
      if (options !== undefined) {
        throw new InterceptUnavailable('intercept already started');
      }
      return this.#interceptHandle;
    }
    validateInterceptOptions(options);
    const handle = await this.#startIntercept(options);
    this.#interceptHandle = handle;
    return handle;
  }

  async #startIntercept(options: InterceptOptions | undefined): Promise<InterceptHandle> {
    if (this.transport === 'embedded') return this.#startEmbeddedIntercept(options);
    if (this.transport === 'spawn') return this.#startSpawnIntercept(options);
    return this.#startRemoteIntercept(options);
  }

  async #startEmbeddedIntercept(options: InterceptOptions | undefined): Promise<InterceptHandle> {
    const backend = this.opts.interceptBackend;
    if (backend === undefined) {
      throw new InterceptUnavailable('embedded transport has no intercept backend wired');
    }
    return startInterceptWithBackend(backend, options);
  }

  async #startSpawnIntercept(options: InterceptOptions | undefined): Promise<InterceptHandle> {
    const known = this.opts.interceptSpawn;
    if (known === undefined) {
      throw new InterceptUnavailable('pass intercept: true to rift.spawn(...)');
    }
    // `RemoteClient` is the only `AdminApi` the spawn transport ever constructs (`spawnEngine`).
    const backend = new RemoteInterceptBackend(this.adminClient as RemoteClient);
    try {
      return await startInterceptWithBackend(backend, { host: known.host, port: known.port, ...options });
    } catch (error) {
      // The flag WAS passed, so a 404 here means the spawned engine didn't actually bring up an
      // intercept listener — surface that as an actionable InterceptUnavailable, not a raw 404.
      if (error instanceof ImposterNotFound) {
        throw new InterceptUnavailable(
          'the spawned Rift engine did not start an intercept listener (its version may not support --intercept-port)'
        );
      }
      throw error;
    }
  }

  async #startRemoteIntercept(options: InterceptOptions | undefined): Promise<InterceptHandle> {
    const adminUrl = this.adminClient.url;
    if (adminUrl === undefined) {
      throw new InterceptUnavailable('remote transport has no admin URL to attach intercept to');
    }
    const parsed = new URL(adminUrl);
    // No documented endpoint reports an already-running remote engine's intercept listener port
    // (rift#493 tracks a runtime start/status endpoint upstream); until it lands, attach defaults to
    // the admin port unless the caller passes one explicitly.
    const basePort = parsed.port !== '' ? Number(parsed.port) : undefined;
    const port = options?.port ?? basePort;
    if (port === undefined) {
      // A URL like `https://host` (no explicit port) leaves nothing to point the SUT's proxy at —
      // `Number('')` would silently yield 0. Require an explicit port instead of a wrong `:0`.
      throw new InterceptUnavailable(
        'remote intercept needs an explicit port — the admin URL has none; pass intercept({ port })'
      );
    }
    const resolved: InterceptOptions = { host: parsed.hostname, ...options, port };
    // `RemoteClient` is the only `AdminApi` the remote transport ever constructs (`connectEngine`).
    const backend = new RemoteInterceptBackend(this.adminClient as RemoteClient);
    try {
      return await startInterceptWithBackend(backend, resolved);
    } catch (error) {
      if (error instanceof ImposterNotFound) {
        throw new InterceptUnavailable('the Rift server must be started with --intercept-port');
      }
      throw error;
    }
  }

  /** Idempotent. Closes the admin client even if `onClose` (e.g. killing a spawned process) throws,
   * so a failed teardown never leaks the client; `closed` only flips once cleanup has run. */
  async close(): Promise<void> {
    if (this.#closed) return;
    try {
      await this.opts.onClose?.();
    } finally {
      await this.adminClient.close();
      this.#closed = true;
    }
  }

  get closed(): boolean {
    return this.#closed;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  private handleFrom(imp: Imposter): ImposterHandle {
    return new ImposterHandleImpl(this.adminClient, imp, this.opts.hostHint);
  }

  private summaryOf(imp: Imposter): ImposterSummary {
    if (imp.port === undefined) {
      throw new RiftError('engine returned an imposter without a port');
    }
    const numberOfRequests = imp.numberOfRequests;
    return {
      port: imp.port,
      protocol: normalizeProtocol(imp.protocol),
      name: imp.name,
      numberOfRequests: typeof numberOfRequests === 'number' ? numberOfRequests : 0,
    };
  }
}

// --- config -> BuildInfo / version preflight ------------------------------------------------

interface EngineConfigOptions {
  version?: unknown;
  commit?: unknown;
  builtAt?: unknown;
}

function configOptions(cfg: Record<string, unknown>): EngineConfigOptions {
  const options = cfg['options'];
  return options !== null && typeof options === 'object' ? (options as EngineConfigOptions) : {};
}

function extractVersion(cfg: Record<string, unknown>): string | undefined {
  const { version } = configOptions(cfg);
  return typeof version === 'string' ? version : undefined;
}

function buildInfoFromConfig(cfg: Record<string, unknown>): BuildInfo {
  const { version, commit, builtAt } = configOptions(cfg);
  return {
    version: typeof version === 'string' ? version : 'unknown',
    commit: typeof commit === 'string' ? commit : undefined,
    builtAt: typeof builtAt === 'string' ? builtAt : undefined,
    features: [],
  };
}

function parseSemver(version: string): [number, number, number] | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (match === null) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** True when `found` is strictly below `required` (major, then minor, then patch). */
function isBelowVersion(found: [number, number, number], required: [number, number, number]): boolean {
  const [fMajor, fMinor, fPatch] = found;
  const [rMajor, rMinor, rPatch] = required;
  if (fMajor !== rMajor) return fMajor < rMajor;
  if (fMinor !== rMinor) return fMinor < rMinor;
  return fPatch < rPatch;
}

/** Returns a human-readable problem string when the engine version fails the compatibility gate,
 * or `undefined` when it's fine. Distinguishes "couldn't determine" and "unrecognizable" from a
 * genuine downgrade so the caller's fail/warn policy governs every case (never a raw parse throw).
 * Exported for reuse by the embedded transport's preflight (`embedded/create.ts`, issue #10), which
 * runs the identical fail/warn/off gate against the cdylib's reported version instead of `/config`. */
export function versionIssue(found: string | undefined): string | undefined {
  if (found === undefined) {
    return `could not determine the connected engine version (its /config reported none)`;
  }
  const parsed = parseSemver(found);
  const required = parseSemver(MIN_ENGINE_VERSION);
  if (parsed === undefined || required === undefined) {
    return `connected engine version "${found}" is not a recognizable version`;
  }
  if (isBelowVersion(parsed, required)) {
    return `connected engine ${found} is older than this SDK's minimum supported version ${MIN_ENGINE_VERSION}`;
  }
  return undefined;
}

const here = dirname(fileURLToPath(import.meta.url));
const packageJson = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')) as {
  minEngineVersion?: string;
};
export const MIN_ENGINE_VERSION = packageJson.minEngineVersion ?? '0.0.0';

// --- entry points: rift.connect / rift.spawn / rift.embedded --------------------------------

export interface ConnectOptions {
  /** Sent as `Authorization: Bearer <apiKey>` on every admin request. A blank (empty or
   * whitespace-only) value throws {@link InvalidDefinition} — omit it to connect without auth. */
  apiKey?: string;
  headers?: Record<string, string>;
  /** Per-request timeout; default 30_000ms. */
  timeoutMs?: number;
  /** Compares the connected engine's `GET /config` version against `minEngineVersion`. Default `'fail'`. */
  versionCheck?: 'fail' | 'warn' | 'off';
}

async function connectEngine(url: string, opts: ConnectOptions = {}): Promise<Engine> {
  const normalized = normalizeUrl(url);
  const client = new RemoteClient(normalized, {
    apiKey: opts.apiKey,
    headers: opts.headers,
    timeoutMs: opts.timeoutMs,
  });

  const versionCheck = opts.versionCheck ?? 'fail';
  if (versionCheck !== 'off') {
    const found = extractVersion(await client.config());
    const issue = versionIssue(found);
    if (issue !== undefined) {
      if (versionCheck === 'fail') {
        throw new EngineVersionError(found ?? 'unknown', MIN_ENGINE_VERSION, issue);
      }
      console.warn(`rift: ${issue}; skipping compatibility gate`);
    }
  }

  return new Engine(client, 'remote', { hostHint: new URL(normalized).hostname });
}

async function spawnEngine(opts: SpawnOptions = {}): Promise<Engine> {
  const spawned = await spawnProcess(opts);
  const host = new URL(spawned.url).hostname;
  return new Engine(spawned.client, 'spawn', {
    hostHint: host,
    onClose: () => spawned.close(),
    interceptSpawn: spawned.interceptPort !== undefined ? { host, port: spawned.interceptPort } : undefined,
  });
}

// Defined HERE (not in the embedded package) since the #39 split: core must type `rift.embedded()`
// without referencing `@rift-vs/rift-embedded` — a type-import of the package would cycle the build
// order (embedded compiles against core's d.ts, so core builds first). The embedded package
// re-exports this type from its root, and its `createEmbeddedEngine` is typed structurally below.
export interface EmbeddedOptions {
  /** Explicit cdylib path; beats `RIFT_FFI_LIB`. Passed straight through to `resolveCdylib`. */
  libPath?: string;
  /** Cdylib version to resolve when not pinned via `libPath`. Defaults to `resolveCdylib`'s own default. */
  version?: string;
  /** Overrides the resolver's cache root (`RIFT_CACHE_DIR`) for this call only. */
  cacheDir?: string;
  /** `false` disables the download step outright, like air-gapped mode but explicit. */
  download?: false;
  /** Compares the loaded cdylib's reported version against `minEngineVersion`. Default `'fail'`. */
  versionCheck?: 'fail' | 'warn' | 'off';
  /** Build-variant features (e.g. `'javascript'`) the loaded cdylib must report; missing ones fail
   * preflight regardless of `versionCheck` — this is a build-variant property, not a version gate. */
  requireFeatures?: string[];
  /** Keep the process alive while the engine is open — the standalone mock-server shape (#70):
   * load imposters, then let main return; the process serves until killed or `close()`d. Default
   * false: an idle engine never blocks process exit (awaited calls always complete either way). */
  keepAlive?: boolean;
}

// The specifier lives in a const so tsc does NOT type-resolve the import: core must compile before
// `@rift-vs/rift-embedded` exists (embedded compiles against core's d.ts — the build order is
// core-first), and the package is an optional peer that may legitimately be absent at runtime.
const EMBEDDED_PACKAGE = '@rift-vs/rift-embedded';

async function embeddedEngine(opts?: EmbeddedOptions): Promise<Engine> {
  // Dynamic import so `rift.connect`/`rift.spawn` never load the embedded package (or koffi): the
  // package is an optional peer, resolved only at the moment a caller invokes `rift.embedded()`.
  let mod: { createEmbeddedEngine: (opts?: EmbeddedOptions) => Promise<Engine> };
  try {
    mod = (await import(EMBEDDED_PACKAGE)) as typeof mod;
  } catch (error) {
    throw new EngineUnavailable(
      'embedded transport requires the optional @rift-vs/rift-embedded package — install it (e.g. npm i -D @rift-vs/rift-embedded) to use rift.embedded()',
      { cause: error }
    );
  }
  return mod.createEmbeddedEngine(opts);
}

export const rift: {
  connect(url: string, opts?: ConnectOptions): Promise<Engine>;
  spawn(opts?: SpawnOptions): Promise<Engine>;
  embedded(opts?: EmbeddedOptions): Promise<Engine>;
} = {
  connect: connectEngine,
  spawn: spawnEngine,
  embedded: embeddedEngine,
};
