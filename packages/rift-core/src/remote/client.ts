/**
 * Fetch-based remote admin API client for a running Rift engine.
 *
 * Zero runtime dependencies: uses the global `fetch` (Node 20+) rather than axios/node-fetch.
 * All request/response mapping (paths, bodies, error classification) funnels through the
 * private `request`/`rawFetch` helpers so the mapping table lives in exactly one place.
 */

import { writeFile } from 'fs/promises';
import type { Imposter, ImpostersConfig, RecordedRequest, Stub } from '../model/index.js';
import { stringifyJsonSafe } from '../model/serialize.js';
import {
  CommunicationError,
  EngineError,
  EngineUnavailable,
  ImposterNotFound,
  InvalidDefinition,
  RiftError,
} from './errors.js';
// Type-only: erased at compile time (isolatedModules), so this does not create a runtime import
// cycle even though ../engine.js imports `RemoteClient` (below) as its remote AdminApi impl.
import type { AdminApi } from '../engine.js';
import { assertApiKeyNotBlank } from '../apikey.js';

/** Shape of the engine's JSON error envelope: `{ "errors": [{ "code": "...", "message": "..." }] }`. */
interface EngineErrorBody {
  errors?: Array<{ code?: string; message?: string }>;
}

/** Optional flow-scoping shared by the scenario endpoints. */
export interface FlowScopedOptions {
  flowId?: string;
}

/** Construction options for {@link RemoteClient}. */
export interface RemoteClientOptions {
  /** Sent as `Authorization: Bearer <apiKey>` on every request. A blank (empty or whitespace-only)
   * value throws {@link InvalidDefinition} — omit it to send no `Authorization` header at all. */
  apiKey?: string;
  /** Base headers for every request. The API-key `authorization` (if any) and the per-request
   * `content-type` are applied on top, so they take precedence over a same-named entry here. */
  headers?: Record<string, string>;
  /** Per-request timeout; a request that exceeds this is aborted and surfaces as `EngineUnavailable`. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export class RemoteClient implements AdminApi {
  /** Base admin URL, trailing slash stripped. */
  readonly url: string;

  #closed = false;
  readonly #headers: Record<string, string>;
  readonly #timeoutMs: number;

  constructor(url: string, opts: RemoteClientOptions = {}) {
    assertApiKeyNotBlank(opts.apiKey);
    this.url = url;
    this.#timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#headers = { ...opts.headers };
    if (opts.apiKey !== undefined) {
      this.#headers['authorization'] = `Bearer ${opts.apiKey}`;
    }
  }

  // --- imposters ---

  async createImposter(imposter: Imposter): Promise<Imposter> {
    return this.request<Imposter>('/imposters', { method: 'POST', body: imposter });
  }

  async listImposters(opts?: { replayable?: boolean }): Promise<ImpostersConfig> {
    const qs = this.toQuery({ replayable: opts?.replayable });
    return this.request<ImpostersConfig>(`/imposters${qs}`, { method: 'GET' });
  }

  async getImposter(
    port: number,
    opts?: { replayable?: boolean; removeProxies?: boolean }
  ): Promise<Imposter> {
    const qs = this.toQuery({ replayable: opts?.replayable, removeProxies: opts?.removeProxies });
    return this.request<Imposter>(`/imposters/${port}${qs}`, { method: 'GET' });
  }

  /** Returns the deleted imposter, as the engine echoes it back in the response body. */
  async deleteImposter(port: number): Promise<Imposter> {
    return this.request<Imposter>(`/imposters/${port}`, { method: 'DELETE' });
  }

  async deleteAllImposters(): Promise<void> {
    await this.request('/imposters', { method: 'DELETE', allowEmpty: true });
  }

  async replaceImposters(config: ImpostersConfig): Promise<ImpostersConfig> {
    return this.request<ImpostersConfig>('/imposters', { method: 'PUT', body: config });
  }

  // --- stubs ---

  async addStub(port: number, stub: Stub, index?: number): Promise<void> {
    const body = index !== undefined ? { stub, index } : { stub };
    await this.request(`/imposters/${port}/stubs`, { method: 'POST', body, allowEmpty: true });
  }

  async replaceStubs(port: number, stubs: Stub[]): Promise<void> {
    await this.request(`/imposters/${port}/stubs`, {
      method: 'PUT',
      body: { stubs },
      allowEmpty: true,
    });
  }

  async getStub(port: number, ref: number | { id: string }): Promise<Stub> {
    return this.request<Stub>(this.stubPath(port, ref), { method: 'GET' });
  }

  async updateStub(port: number, ref: number | { id: string }, stub: Stub): Promise<void> {
    await this.request(this.stubPath(port, ref), { method: 'PUT', body: stub, allowEmpty: true });
  }

  async deleteStub(port: number, ref: number | { id: string }): Promise<void> {
    await this.request(this.stubPath(port, ref), { method: 'DELETE', allowEmpty: true });
  }

  // --- saved requests / proxy responses ---

  async getSavedRequests(port: number, match?: string[]): Promise<RecordedRequest[]> {
    return this.request<RecordedRequest[]>(`/imposters/${port}/savedRequests${this.matchQuery(match)}`, {
      method: 'GET',
    });
  }

  async deleteSavedRequests(port: number, match?: string[]): Promise<void> {
    await this.request(`/imposters/${port}/savedRequests${this.matchQuery(match)}`, {
      method: 'DELETE',
      allowEmpty: true,
    });
  }

  async deleteSavedProxyResponses(port: number): Promise<void> {
    await this.request(`/imposters/${port}/savedProxyResponses`, {
      method: 'DELETE',
      allowEmpty: true,
    });
  }

  // --- enable/disable ---

  async enableImposter(port: number): Promise<void> {
    await this.request(`/imposters/${port}/enable`, { method: 'POST', allowEmpty: true });
  }

  async disableImposter(port: number): Promise<void> {
    await this.request(`/imposters/${port}/disable`, { method: 'POST', allowEmpty: true });
  }

  // --- scenarios ---

  async getScenarios(
    port: number,
    opts?: FlowScopedOptions
  ): Promise<{ flowId: string; scenarios: Array<{ name: string; state: string }> }> {
    return this.request(`/imposters/${port}/scenarios${this.flowQuery(opts)}`, {
      method: 'GET',
    });
  }

  async setScenarioState(
    port: number,
    name: string,
    state: string,
    opts?: FlowScopedOptions
  ): Promise<void> {
    await this.request(`/imposters/${port}/scenarios/${encodeURIComponent(name)}/state`, {
      method: 'PUT',
      body: { state, ...(opts?.flowId !== undefined ? { flowId: opts.flowId } : {}) },
      allowEmpty: true,
    });
  }

  async resetScenarios(port: number, opts?: FlowScopedOptions): Promise<void> {
    await this.request(`/imposters/${port}/scenarios/reset`, {
      method: 'POST',
      body: opts?.flowId !== undefined ? { flowId: opts.flowId } : undefined,
      allowEmpty: true,
    });
  }

  // --- spaces ---

  async addSpaceStub(port: number, flowId: string, stub: Stub): Promise<void> {
    await this.request(`/imposters/${port}/spaces/${encodeURIComponent(flowId)}/stubs`, {
      method: 'POST',
      body: { stub },
      allowEmpty: true,
    });
  }

  async listSpaceStubs(port: number, flowId: string): Promise<{ space: string; stubs: Stub[] }> {
    return this.request<{ space: string; stubs: Stub[] }>(
      `/imposters/${port}/spaces/${encodeURIComponent(flowId)}/stubs`,
      { method: 'GET' }
    );
  }

  async getSpace<T = unknown>(port: number, flowId: string): Promise<T> {
    return this.request<T>(`/imposters/${port}/spaces/${encodeURIComponent(flowId)}`, {
      method: 'GET',
    });
  }

  async deleteSpace(port: number, flowId: string): Promise<void> {
    await this.request(`/imposters/${port}/spaces/${encodeURIComponent(flowId)}`, {
      method: 'DELETE',
      allowEmpty: true,
    });
  }

  // --- flow state (admin-prefixed) ---

  /** Returns the parsed value, or `undefined` if the key is absent (engine responds 404). */
  async getFlowState<T = unknown>(port: number, flowId: string, key: string): Promise<T | undefined> {
    const response = await this.rawFetch(this.flowStateUrl(port, flowId, key), { method: 'GET' });
    if (response.status === 404) return undefined;
    if (!response.ok) return this.throwForStatus(response);
    return this.parseJsonBody<T>(response, false);
  }

  async setFlowState(port: number, flowId: string, key: string, value: unknown): Promise<void> {
    await this.request(this.flowStatePath(port, flowId, key), {
      method: 'PUT',
      body: { value },
      allowEmpty: true,
    });
  }

  async deleteFlowState(port: number, flowId: string, key: string): Promise<void> {
    await this.request(this.flowStatePath(port, flowId, key), {
      method: 'DELETE',
      allowEmpty: true,
    });
  }

  // --- admin ---

  async config(): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>('/config', { method: 'GET' });
  }

  async logs(opts?: { startIndex?: number; endIndex?: number }): Promise<unknown[]> {
    const params = new URLSearchParams();
    if (opts?.startIndex !== undefined) params.set('startIndex', String(opts.startIndex));
    if (opts?.endIndex !== undefined) params.set('endIndex', String(opts.endIndex));
    const qs = params.toString();
    return this.request<unknown[]>(`/logs${qs ? `?${qs}` : ''}`, { method: 'GET' });
  }

  async reload(): Promise<unknown> {
    return this.request<unknown>('/admin/reload', { method: 'POST', allowEmpty: true });
  }

  // --- intercept (issue #11; attach-only — the engine must be started with --intercept-port) ---

  /** Posts the rules as-is (already-JSON) — bare array in, bare array out, symmetric with
   * {@link interceptListRules}. */
  async interceptAddRules(rulesJson: string): Promise<void> {
    const rules = JSON.parse(rulesJson) as unknown;
    await this.request('/intercept/rules', { method: 'POST', body: rules, allowEmpty: true });
  }

  /** A 404 here (no `--intercept-port` on the connected engine) surfaces as `ImposterNotFound` via
   * the generic 404 mapping below — `engine.ts`'s per-transport dispatch re-maps that into the
   * documented `InterceptUnavailable` guidance string; this client stays a plain HTTP mapper. */
  async interceptListRules(): Promise<string> {
    const rules = await this.request<unknown>('/intercept/rules', { method: 'GET' });
    return JSON.stringify(rules);
  }

  async interceptClearRules(): Promise<void> {
    await this.request('/intercept/rules', { method: 'DELETE', allowEmpty: true });
  }

  async interceptCaPem(): Promise<string> {
    const response = await this.rawFetch(`${this.url}/intercept/ca.pem`, { method: 'GET' });
    if (!response.ok) return this.throwForStatus(response);
    return response.text();
  }

  /** `format` is the route's file extension (`p12`/`jks` — the intercept backend maps the public
   * `'pkcs12'|'jks'` option to it). Writes the fetched bytes straight to `outPath`. */
  async interceptExportTruststore(format: string, password: string, outPath: string): Promise<void> {
    const qs = new URLSearchParams({ password }).toString();
    const response = await this.rawFetch(`${this.url}/intercept/truststore.${format}?${qs}`, {
      method: 'GET',
    });
    if (!response.ok) return this.throwForStatus(response);
    const bytes = Buffer.from(await response.arrayBuffer());
    await writeFile(outPath, bytes);
  }

  // --- disposal ---

  /** Idempotent: `fetch` holds no persistent connection, so this only flips the closed flag. */
  async close(): Promise<void> {
    this.#closed = true;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  get closed(): boolean {
    return this.#closed;
  }

  // --- internals ---

  private stubPath(port: number, ref: number | { id: string }): string {
    return typeof ref === 'number'
      ? `/imposters/${port}/stubs/${ref}`
      : `/imposters/${port}/stubs/by-id/${encodeURIComponent(ref.id)}`;
  }

  /** Builds `?flag=true` query strings, only including flags that are actually set. */
  private toQuery(flags: Record<string, boolean | undefined>): string {
    const params = new URLSearchParams();
    for (const [name, value] of Object.entries(flags)) {
      if (value === true) params.set(name, 'true');
    }
    const qs = params.toString();
    return qs ? `?${qs}` : '';
  }

  /** Encodes zero or more `match=` filters as repeated query params (savedRequests get/delete). */
  private matchQuery(match?: string[]): string {
    if (match === undefined || match.length === 0) return '';
    const params = new URLSearchParams();
    for (const m of match) params.append('match', m);
    return `?${params.toString()}`;
  }

  private flowQuery(opts?: FlowScopedOptions): string {
    return opts?.flowId !== undefined ? `?flowId=${encodeURIComponent(opts.flowId)}` : '';
  }

  private flowStatePath(port: number, flowId: string, key: string): string {
    return `/admin/imposters/${port}/flow-state/${encodeURIComponent(flowId)}/${encodeURIComponent(key)}`;
  }

  private flowStateUrl(port: number, flowId: string, key: string): string {
    return `${this.url}${this.flowStatePath(port, flowId, key)}`;
  }

  /** Central request helper: every public method funnels through here (except `getFlowState`,
   * which needs to intercept 404 before the generic error mapping applies). */
  private async request<T = unknown>(
    path: string,
    init: { method: string; body?: unknown; allowEmpty?: boolean }
  ): Promise<T> {
    const response = await this.rawFetch(`${this.url}${path}`, this.toRequestInit(init));
    if (!response.ok) return this.throwForStatus(response);
    return this.parseJsonBody<T>(response, init.allowEmpty ?? false);
  }

  /** Every outbound body goes through the wire model's JSON-safety guard (issue #112), so the
   * guarantee holds for the whole admin surface rather than only where a caller remembered to ask
   * for it. Applied to all bodies, not a list of imposter-ish routes: a route list is a thing a new
   * method silently falls off, and flow-state values are caller data too. Serialization throws
   * before `fetch` is reached, so a refused payload is never half-sent. */
  private toRequestInit(init: { method: string; body?: unknown }): RequestInit {
    const headers = { ...this.#headers, ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}) };
    return {
      method: init.method,
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
      ...(init.body !== undefined ? { body: stringifyJsonSafe(init.body) } : {}),
    };
  }

  /** Wraps `fetch` so a rejected fetch (connection refused, DNS failure, timeout, ...) becomes a
   * typed `EngineUnavailable` instead of an opaque `TypeError`/`AbortError`. */
  private async rawFetch(url: string, init: RequestInit): Promise<Response> {
    if (this.#closed) {
      throw new RiftError('client is closed');
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      throw new EngineUnavailable(`could not reach engine at ${url}: ${message}`, { cause });
    } finally {
      clearTimeout(timeout);
    }
  }

  private async throwForStatus(response: Response): Promise<never> {
    const message = await this.parseErrorMessage(response);
    switch (response.status) {
      case 400:
        throw new InvalidDefinition(message);
      case 404:
        throw new ImposterNotFound(message);
      default:
        throw new EngineError(response.status, message);
    }
  }

  private async parseErrorMessage(response: Response): Promise<string> {
    // Read from a clone so the original response's body stream is left untouched — some test
    // doubles (and callers holding onto the response) reuse the same instance across calls.
    const text = await response
      .clone()
      .text()
      .catch(() => '');
    if (text !== '') {
      try {
        const parsed = JSON.parse(text) as EngineErrorBody;
        const message = parsed.errors?.[0]?.message;
        if (message !== undefined) return message;
      } catch {
        // Body wasn't the expected JSON error envelope — fall back to statusText below.
      }
    }
    return response.statusText || `HTTP ${response.status}`;
  }

  /** Parses a JSON response body. An empty body is only accepted for endpoints that declare
   * `allowEmpty` (DELETE/reload/PUT-state, which legitimately return no content); a data
   * endpoint that returns an empty or non-JSON body is a communication failure, not `undefined`. */
  private async parseJsonBody<T>(response: Response, allowEmpty: boolean): Promise<T> {
    const text = await response.clone().text();
    if (text === '') {
      if (allowEmpty) return undefined as T;
      throw new CommunicationError('engine returned an empty body where data was expected');
    }
    try {
      return JSON.parse(text) as T;
    } catch (cause) {
      throw new CommunicationError('could not parse response body as JSON', { cause });
    }
  }
}

/** Strips a single trailing slash from the admin URL. Exported for reuse by the engine facade. */
export function normalizeUrl(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

/** Connects to a Rift admin API at `url`, returning a client bound to that base URL. This is the
 * low-level, synchronous escape hatch; `rift.connect` (../engine.js) is the async facade that
 * wraps this in an `Engine` after a version preflight. */
export function connect(url: string): RemoteClient {
  return new RemoteClient(normalizeUrl(url));
}
