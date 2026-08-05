/**
 * Typed wire model for the Rift / Mountebank imposter grammar.
 *
 * These types describe the JSON the engine speaks, using the EXACT wire keys (mostly
 * camelCase — `statusCode`, `caseSensitive`, `recordRequests` — with a few snake_case keys
 * the engine keeps, e.g. `required_scenario_state`). They are structural (compile-time only):
 * an object typed as `Imposter` already carries wire keys, so serialization is a faithful
 * pass-through — no runtime key mapping, and therefore no casing drift.
 *
 * Every open structure carries an index signature so unknown-but-valid fields (future engine
 * additions, `_rift` sub-features) survive a `fromJson` round-trip untouched — the escape-hatch
 * contract. Source of truth: rift-core `imposter/types.rs`, rift-types `predicate.rs`,
 * `docs/mountebank/*`.
 */

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** The config-file / bulk envelope: `{ "imposters": [ ... ] }`. */
export interface ImpostersConfig {
  imposters: Imposter[];
  [key: string]: unknown;
}

export interface Imposter {
  /** Explicit listening port. Respected verbatim; omit for an engine-assigned port. */
  port?: number;
  protocol?: 'http' | 'https' | 'h2c' | string;
  host?: string;
  name?: string;
  stubs?: Stub[];
  recordRequests?: boolean;
  recordMatches?: boolean;
  defaultResponse?: IsResponse;
  defaultForward?: string;
  allowCORS?: boolean;
  mutualAuth?: boolean;
  strictBehaviors?: boolean;
  /** Inline PEM for HTTPS. */
  cert?: string;
  key?: string;
  /** Rift extension namespace (flow state, scripting, faults, metrics, proxy). */
  _rift?: RiftImposterConfig;
  [key: string]: unknown;
}

export interface Stub {
  predicates?: Predicate[];
  responses?: StubResponse[];
  id?: string;
  scenarioName?: string;
  /** FSM gate/transition (WireMock-compatible wire keys are snake_case). */
  required_scenario_state?: string;
  new_scenario_state?: string;
  route_pattern?: string;
  space?: string;
  recorded_from?: string;
  /** Engine-ignored verification annotation, preserved across round-trip. */
  _verify?: JsonValue;
  [key: string]: unknown;
}

/** A field → matcher map, e.g. `{ method: 'GET', path: '/x' }`. */
export type FieldMatch = { [field: string]: JsonValue };

export interface Predicate {
  equals?: FieldMatch;
  deepEquals?: FieldMatch;
  contains?: FieldMatch;
  startsWith?: FieldMatch;
  endsWith?: FieldMatch;
  matches?: FieldMatch;
  exists?: { [field: string]: boolean };
  not?: Predicate;
  and?: Predicate[];
  or?: Predicate[];
  inject?: string;
  // matcher parameters (flat, alongside the operator)
  caseSensitive?: boolean;
  keyCaseSensitive?: boolean;
  except?: string;
  // selectors
  xpath?: { selector: string; ns?: { [prefix: string]: string } };
  jsonpath?: { selector: string };
  [key: string]: unknown;
}

export interface IsResponse {
  /** Mountebank serializes this as a string but accepts a number; both round-trip. */
  statusCode?: number | string;
  headers?: { [name: string]: string | string[] };
  body?: JsonValue;
  _mode?: 'text' | 'binary';
  [key: string]: unknown;
}

/**
 * The engine's inline `serve` stub — deliberately narrower than {@link IsResponse}.
 *
 * `crates/rift-http-proxy/src/intercept_rules.rs` declares `status_code: u16`,
 * `headers: HashMap<String, String>` and `body: Option<String>`, so an object body or a multi-value
 * header is a serde error rather than a richer response. `InterceptHandle.serve()` normalizes an
 * `IsResponse` into this shape; `addRule()` takes it verbatim.
 */
export interface ServeStub {
  statusCode?: number;
  headers?: { [name: string]: string };
  /** `null` on the read path only: the engine's `body` is an `Option<String>` with no
   * `skip_serializing_if`, so `GET /intercept/rules` reports an absent body as an explicit `null`. */
  body?: string | null;
  [key: string]: unknown;
}

export interface ProxyResponse {
  to: string;
  mode?: 'proxyAlways' | 'proxyOnce' | 'proxyTransparent' | string;
  predicateGenerators?: JsonValue[];
  addWaitBehavior?: boolean;
  addDecorateBehavior?: string;
  injectHeaders?: { [name: string]: string };
  pathRewrite?: { from: string; to: string };
  key?: string;
  cert?: string;
  [key: string]: unknown;
}

export interface StubResponse {
  is?: IsResponse;
  proxy?: ProxyResponse;
  inject?: string;
  fault?: string;
  _behaviors?: Behaviors;
  _rift?: RiftResponseExtension;
  // flat form (issue #304): statusCode/headers/body at the top level, no `is` wrapper
  statusCode?: number | string;
  headers?: { [name: string]: string | string[] };
  body?: JsonValue;
  [key: string]: unknown;
}

export interface Behaviors {
  wait?: number | string | { min: number; max: number };
  repeat?: number;
  decorate?: string;
  shellTransform?: string | string[];
  copy?: JsonValue;
  lookup?: JsonValue;
  [key: string]: unknown;
}

// --- _rift extensions (open shapes; preserved verbatim) ---

export interface RiftImposterConfig {
  flowState?: JsonValue;
  metrics?: JsonValue;
  proxy?: JsonValue;
  scriptEngine?: JsonValue;
  scripts?: { [name: string]: JsonValue };
  [key: string]: unknown;
}

export interface RiftResponseExtension {
  fault?: JsonValue;
  script?: JsonValue;
  templated?: boolean;
  [key: string]: unknown;
}

/** Either the bulk envelope or a single imposter (the POST /imposters body). */
export type WireModel = ImpostersConfig | Imposter;

/** A single request recorded by an imposter (`GET /imposters/{port}/savedRequests`). */
export interface RecordedRequest {
  request_from?: string;
  method: string;
  path: string;
  query?: Record<string, string | string[]>;
  headers?: Record<string, string | string[]>;
  body?: JsonValue;
  /** `'binary'` when the engine base64-encoded a non-UTF-8 body (engine ≥ 0.13.6); absent for text. */
  _mode?: 'binary';
  timestamp?: string;
  [key: string]: unknown;
}

/**
 * A TLS-MITM intercept rule (issue #11): `host` (exact match) or `predicates` (standard predicates
 * over the decrypted request, AND-ed) select which requests `action` applies to. `serve` returns a
 * canned response; `forward` re-proxies (in plaintext) to an imposter listening on `action.forward.port`.
 * A rule with neither `host` nor `predicates` is a catch-all (see `InterceptHandle.redirectTo`).
 */
export interface InterceptRule {
  /** `null` on the read path only, for the same reason as {@link ServeStub.body}: the engine's
   * `host` is an `Option<String>` with no `skip_serializing_if`. */
  host?: string | null;
  predicates?: Predicate[];
  action: { serve: ServeStub } | { forward: { port: number } };
  [key: string]: unknown;
}
