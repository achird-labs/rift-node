/**
 * Fluent imposter builder.
 *
 * `build()` emits every field only when it actually carries content — the same "absent ≠
 * empty" discipline as {@link ResponseBuilder}: no stray `_rift: {}`, no `redis: undefined`.
 * `_rift.flowState` is a single accumulating block — `flowState()` and `flowIdFromHeader()`
 * shallow-merge into it across calls, so config built up over several chained calls still
 * lands as one object on the wire. `scenario()` flattens the {@link ScenarioBuilder}'s stubs
 * into the same ordered stub list `stub()` pushes onto, at call time — interleaved
 * `stub()`/`scenario()` calls preserve call order, not a stub-then-scenario batching.
 */

import type { Imposter, IsResponse, JsonValue, RiftImposterConfig, Stub } from '../model/index.js';
import { InvalidDefinition } from '../errors.js';
import { ResponseBuilder } from './response.js';
import type { ScriptSpec } from './script.js';
import { StubBuilder, type AnyStubBuilder } from './stub.js';
import type { ScenarioBuilder } from './scenario.js';

export interface FlowStateConfig {
  backend?: 'inmemory' | 'redis';
  ttlSeconds?: number;
  flowIdSource?: 'imposter_port' | `header:${string}`;
  redis?: { url: string; poolSize?: number; keyPrefix?: string };
}

export interface ScriptEngineConfig {
  defaultEngine?: 'rhai' | 'javascript';
  timeoutMs?: number;
}

/** Shallow-copies `obj`, dropping any key whose value is `undefined`. */
function omitUndefined<T extends object>(obj: T): { [key: string]: JsonValue } {
  const out: { [key: string]: JsonValue } = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v as JsonValue;
  }
  return out;
}

export class ImposterBuilder {
  private nameValue: string | undefined;
  private portValue: number | undefined;
  private protocolValue: string | undefined;
  private hostValue: string | undefined;
  private readonly stubList: Stub[] = [];
  private recordRequestsValue: boolean | undefined;
  private recordMatchesValue: boolean | undefined;
  private allowCORSValue: boolean | undefined;
  private defaultResponseValue: IsResponse | undefined;
  private certValue: string | undefined;
  private keyValue: string | undefined;
  private mutualAuthValue: boolean | undefined;
  private rejectUnauthorizedValue: boolean | undefined;
  private caValue: string | string[] | undefined;
  private strictBehaviorsValue: boolean | undefined;
  private defaultForwardValue: string | undefined;
  private serviceNameValue: string | undefined;
  private serviceInfoValue: JsonValue | undefined;
  private riftFlowState: { [key: string]: JsonValue } | undefined;
  private riftMetrics: { enabled: true; port?: number } | undefined;
  private riftScriptEngine: { [key: string]: JsonValue } | undefined;
  private riftScripts: { [name: string]: ScriptSpec } | undefined;
  private rawPatch: Partial<Imposter> | undefined;

  constructor(name?: string) {
    if (name !== undefined) this.nameValue = name;
  }

  port(value: number): this {
    this.portValue = value;
    return this;
  }

  protocol(value: string): this {
    this.protocolValue = value;
    return this;
  }

  host(value: string): this {
    this.hostValue = value;
    return this;
  }

  /**
   * Sets `protocol: 'https'` and, when given, the inline PEM `cert`/`key` and `mutualAuth`
   * flag. No args → protocol only (the engine falls back to a self-signed cert).
   */
  https(tls?: { cert?: string; key?: string; mutualAuth?: boolean }): this {
    this.protocolValue = 'https';
    if (tls?.cert !== undefined) this.certValue = tls.cert;
    if (tls?.key !== undefined) this.keyValue = tls.key;
    if (tls?.mutualAuth !== undefined) this.mutualAuthValue = tls.mutualAuth;
    return this;
  }

  /**
   * Requires a client certificate on this HTTPS imposter (engine >= 0.18.0; older engines silently
   * accepted every client). With no anchors, any certificate is accepted (`mutualAuth: true`); with
   * anchors, the certificate must chain to one of them (`rejectUnauthorized: true`, `ca`). One
   * anchor is written as a bare string and several as an array — the spelling the engine echoes
   * back, so `toJson()` round-trips byte-equal. A later call replaces. Sets `protocol: 'https'`.
   */
  requireClientCertificate(caPems?: readonly string[]): this {
    if (caPems !== undefined) {
      // `[]` would read as "validate against nothing" — accept any certificate — which is the
      // no-anchor overload's job, said out loud.
      if (caPems.length === 0) {
        throw new InvalidDefinition('requireClientCertificate([]) has no trust anchor; pass at least one PEM, or call it with no argument to accept any client certificate');
      }
      // Deliberately shallow: enough to catch a key or a path passed where a certificate belongs.
      // The engine parses the PEM for real and 400s anything it cannot load.
      for (const pem of caPems) {
        if (typeof pem !== 'string' || !pem.includes('-----BEGIN CERTIFICATE-----')) {
          throw new InvalidDefinition('requireClientCertificate: every trust anchor must contain a -----BEGIN CERTIFICATE----- block');
        }
      }
    }
    this.protocolValue = 'https';
    this.mutualAuthValue = true;
    this.rejectUnauthorizedValue = caPems === undefined ? undefined : true;
    this.caValue = caPems === undefined ? undefined : caPems.length === 1 ? caPems[0] : [...caPems];
    return this;
  }

  /** Enables `recordRequests` (mock-verification mode). */
  record(): this {
    this.recordRequestsValue = true;
    return this;
  }

  /** Enables `recordMatches` (predicate-match diagnostics). */
  recordMatches(): this {
    this.recordMatchesValue = true;
    return this;
  }

  allowCORS(): this {
    this.allowCORSValue = true;
    return this;
  }

  /** Sets top-level `strictBehaviors`. */
  strictBehaviors(): this {
    this.strictBehaviorsValue = true;
    return this;
  }

  /** Sets top-level `defaultForward`. */
  defaultForward(url: string): this {
    this.defaultForwardValue = url;
    return this;
  }

  serviceName(name: string): this {
    this.serviceNameValue = name;
    return this;
  }

  serviceInfo(value: JsonValue): this {
    this.serviceInfoValue = value;
    return this;
  }

  /** Shallow-merges into the single `_rift.flowState` block (undefined keys omitted). */
  flowState(cfg: FlowStateConfig): this {
    this.riftFlowState = { ...this.riftFlowState, ...omitUndefined(cfg) };
    return this;
  }

  /** Sugar merging `flowIdSource: 'header:<name>'` into `_rift.flowState`. */
  flowIdFromHeader(name: string): this {
    this.riftFlowState = { ...this.riftFlowState, flowIdSource: `header:${name}` };
    return this;
  }

  /** Sets `_rift.metrics = { enabled: true }`, plus `port` when given. */
  metrics(port?: number): this {
    this.riftMetrics = port !== undefined ? { enabled: true, port } : { enabled: true };
    return this;
  }

  /** Shallow-merges into `_rift.scriptEngine` across calls (undefined keys omitted). */
  scriptEngine(cfg: ScriptEngineConfig): this {
    this.riftScriptEngine = { ...this.riftScriptEngine, ...omitUndefined(cfg) };
    return this;
  }

  /** Accumulates into `_rift.scripts[name]`. */
  registerScript(name: string, spec: ScriptSpec): this {
    this.riftScripts = { ...this.riftScripts, [name]: spec };
    return this;
  }

  stub(...stubs: Array<AnyStubBuilder | Stub>): this {
    for (const s of stubs) this.stubList.push(s instanceof StubBuilder ? s.build() : s);
    return this;
  }

  /**
   * Appends the scenario's FSM stubs onto the same ordered stub list `stub()` pushes onto —
   * called at invocation time, so interleaved `stub()`/`scenario()` calls preserve call order.
   */
  scenario(s: ScenarioBuilder): this {
    this.stubList.push(...s.build());
    return this;
  }

  defaultResponse(response: ResponseBuilder | IsResponse): this {
    if (response instanceof ResponseBuilder) {
      const built = response.build();
      if (built.is === undefined) {
        throw new InvalidDefinition(
          'defaultResponse requires an `is` response; proxy/inject/fault responses cannot be a default'
        );
      }
      this.defaultResponseValue = built.is;
    } else {
      // A raw IsResponse bypasses ResponseBuilder's guard, so validate it here too: an empty
      // object (or one carrying only non-`is` keys like `proxy`) would otherwise ship a
      // stray/malformed `defaultResponse` to the wire silently.
      const isKeys = ['statusCode', 'headers', 'body', '_mode'];
      if (!isKeys.some((k) => k in response)) {
        throw new InvalidDefinition(
          'defaultResponse requires an `is` response with at least one of statusCode/headers/body'
        );
      }
      this.defaultResponseValue = response;
    }
    return this;
  }

  /** Last-wins shallow merge applied at the TOP level of the built imposter, after everything else. */
  raw(patch: Partial<Imposter>): this {
    this.rawPatch = { ...this.rawPatch, ...patch };
    return this;
  }

  build(): Imposter {
    const out: Imposter = {};
    if (this.nameValue !== undefined) out.name = this.nameValue;
    if (this.portValue !== undefined) out.port = this.portValue;
    // Protocol is emitted only when set explicitly — no silent default, so a TCP/HTTPS
    // imposter is never mislabeled `http`.
    if (this.protocolValue !== undefined) out.protocol = this.protocolValue;
    if (this.hostValue !== undefined) out.host = this.hostValue;
    if (this.certValue !== undefined) out.cert = this.certValue;
    if (this.keyValue !== undefined) out.key = this.keyValue;
    if (this.mutualAuthValue !== undefined) out.mutualAuth = this.mutualAuthValue;
    if (this.rejectUnauthorizedValue !== undefined) out.rejectUnauthorized = this.rejectUnauthorizedValue;
    if (this.caValue !== undefined) out.ca = this.caValue;
    // The engine refuses these on any protocol but https with a 400; `.protocol('http')` can follow
    // `.requireClientCertificate()`, so the check has to sit here rather than in the setter.
    const clientAuth = this.mutualAuthValue === true || this.rejectUnauthorizedValue !== undefined || this.caValue !== undefined;
    // `.https({ mutualAuth: false })` after `.requireClientCertificate([...])` leaves the anchors
    // without the requirement — a combination the engine refuses with a 400.
    if (this.rejectUnauthorizedValue === true && this.mutualAuthValue !== true) {
      throw new InvalidDefinition(
        'rejectUnauthorized / ca need mutualAuth: true — https({ mutualAuth: false }) cleared what requireClientCertificate(...) set'
      );
    }
    if (clientAuth && this.protocolValue !== 'https') {
      throw new InvalidDefinition(
        `client-certificate authentication (mutualAuth / rejectUnauthorized / ca) needs protocol 'https', got ${JSON.stringify(this.protocolValue ?? 'http')}`
      );
    }
    if (this.strictBehaviorsValue !== undefined) out.strictBehaviors = this.strictBehaviorsValue;
    if (this.defaultForwardValue !== undefined) out.defaultForward = this.defaultForwardValue;
    if (this.serviceNameValue !== undefined) out.serviceName = this.serviceNameValue;
    if (this.serviceInfoValue !== undefined) out.serviceInfo = this.serviceInfoValue;
    if (this.recordRequestsValue !== undefined) out.recordRequests = this.recordRequestsValue;
    if (this.recordMatchesValue !== undefined) out.recordMatches = this.recordMatchesValue;
    if (this.allowCORSValue !== undefined) out.allowCORS = this.allowCORSValue;
    if (this.defaultResponseValue !== undefined) out.defaultResponse = this.defaultResponseValue;

    const rift: RiftImposterConfig = {};
    if (this.riftFlowState !== undefined) rift.flowState = this.riftFlowState;
    if (this.riftMetrics !== undefined) rift.metrics = this.riftMetrics;
    if (this.riftScriptEngine !== undefined) rift.scriptEngine = this.riftScriptEngine;
    if (this.riftScripts !== undefined) rift.scripts = this.riftScripts;
    if (Object.keys(rift).length > 0) out._rift = rift;

    if (this.stubList.length > 0) out.stubs = this.stubList;

    return this.rawPatch !== undefined ? { ...out, ...this.rawPatch } : out;
  }
}

export function imposter(name?: string): ImposterBuilder {
  return new ImposterBuilder(name);
}
