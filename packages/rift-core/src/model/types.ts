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
 * The engine's inline `serve` stub — narrower than {@link IsResponse}: no `_mode`, no `_behaviors`,
 * no `_rift`.
 *
 * `crates/rift-http-proxy/src/intercept_rules.rs` (engine >= 0.18.0) declares `status_code: u16`
 * (a numeric string is accepted), `headers: HashMap<String, Vec<String>>` (a string or an array —
 * one header line per value) and `body: Option<serde_json::Value>`. `InterceptHandle.serve()`
 * normalizes an `IsResponse` into this shape; `addRule()` takes it verbatim. An engine <= 0.17.0
 * holds one value per header and a string body, and answers the array form with an opaque serde
 * error.
 */
export interface ServeStub {
  statusCode?: number;
  headers?: { [name: string]: string | string[] };
  /** `serve()` sends a non-string body pre-stringified (key order preserved); the read path returns
   * whatever shape was posted, and an absent body as an explicit `null` (no `skip_serializing_if`). */
  body?: JsonValue | null;
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
  /** Mountebank's canonical spelling, and what `GET /imposters` writes since engine 0.18.0: one
   * element per step in execution order (a multi-item `copy`/`lookup`/`shellTransform` is split one
   * element per item), never a `{repeat}` element. Accepted on input too; when both spellings are
   * present the engine uses `_behaviors` and ignores this array. Engine <= 0.17.0 wrote `{repeat}`
   * inside the array. */
  behaviors?: Behaviors[];
  /** Response-level `repeat` — what `GET /imposters` writes since engine 0.18.0 (`0` is never
   * written). Accepted on input and wins over `_behaviors.repeat`. */
  repeat?: number;
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
  /** Carrier only (engine >= 0.18.0, rift#978): round-tripped through `GET /imposters`, inert on
   * standalone Rift, dropped on parse by engine <= 0.17.0. */
  sequencing?: { mode?: string; [key: string]: JsonValue | undefined };
  [key: string]: unknown;
}

/** A `lookup` named by dataset rather than by file path (engine >= 0.18.0, rift#973). `key` is the
 * engine's `LookupKey` — `from` a copy source, `using` an extraction method — left open here. */
export interface DatasetBinding {
  name: string;
  version?: number;
  key: { from: JsonValue; using: JsonValue };
  keyColumn: string;
  into: string;
  digest?: string;
  [key: string]: unknown;
}

export interface RiftResponseExtension {
  fault?: JsonValue;
  script?: JsonValue;
  templated?: boolean;
  /** Carrier only (engine >= 0.18.0, rift#973): round-tripped through `GET /imposters`, inert on
   * standalone Rift, dropped on parse by engine <= 0.17.0. */
  dataset?: DatasetBinding;
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
  /** How the request was answered (engine >= 0.18.0, rift#364): the status served and the latency
   * in ms. Absent when not recorded — a request still in flight when the journal was read, one
   * whose handling errored, or an older engine. `latencyMs: 0` is a real reading. */
  status?: number;
  latencyMs?: number;
  /** The node that answered. Stamped only by a clustered journal; a single engine — including one
   * the SDK spawns — never sets it. */
  node?: string;
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
