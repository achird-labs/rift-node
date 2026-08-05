---
layout: default
title: API reference
parent: Reference
nav_order: 1
permalink: /reference/sdk-api/
---

# rift-node SDK — API Reference

Status: **canonical reference** · matches the shipped surface of `@rift-vs/rift` 0.12.1
(`minEngineVersion` 0.12.0) · elaborates RFC-003 §12 (Node/TS amendment) · reconciled 2026-07-16

This document is the single source of truth for the `@rift-vs/rift` public API: the cross-cutting
decisions and the full grammar reference. It began as the 2026-07-09 design, produced from a full
survey of the Rift engine wire grammar and admin API (`rift-core`, `rift-http-proxy`, `docs/`),
the `librift_ffi` C-ABI v2 (26 symbols, `crates/rift-ffi`), RFC-003 and its §12 amendment, the
sibling SDKs (rift-java merged DSL, rift-scala design), and prior art (WireMock, MSW, nock,
Testcontainers, Playwright/Vitest fixtures). Every slice of that design has since shipped — §12
holds the delivered ledger — and the text below describes what the SDK does. Deviations from the
original design are called out inline with their tracking issue. README and `docs/*.md` are
task-shaped quick starts; this file is the reference.

Runnable snippets in this file are embed-checked against `examples/*.ts` by `npm run docs:check`
(the `<!-- docs:embed -->` convention from #14); fences showing type signatures or elided sketches
are reference material and carry no marker.

## 0. Reading example (the shipped DX)

<!-- docs:embed sdk-api-hero -->
```ts
import { rift, imposter, onGet, onPost, okJson, created, status, contains, times, Fault } from '@rift-vs/rift';

await using engine = await rift.embedded(); // or rift.connect(url) / rift.spawn()

const users = await engine.create(
  imposter('users').record()
    .stub(onGet('/api/users/1').willReturn(okJson({ id: 1, name: 'Alice' })))
    .stub(onPost('/api/users')
      .withHeader('content-type', contains('json'))
      .willReturn(created().latency(50), status(503))) // two responses = cycling
    .stub(onGet('/api/health').willReturn(okJson({ ok: true }).withFault(
      Fault.latency({ min: 100, max: 500 }, { probability: 0.3 })))));

await fetch(`${users.url}/api/users/1`);

await users.verify(onGet('/api/users/1'), times(1)); // throws VerificationError with a diff
```

## 1. Principles

1. **`when(request) → respond(responses…)`** — the RFC-003 shared mental model. Builders are
   synchronous and pure; `await` appears at exactly two places: engine acquisition and
   `engine.create(...)` (the Testcontainers pattern).
2. **The API is total** — every engine feature is reachable from the typed layer on every
   transport. Where a transport lacks a native path (FFI gaps), the SDK bridges internally;
   the user never sees a difference.
3. **Wire model is the escape hatch, never the fight** — `fromJson` / `.raw()` accept raw JSON
   verbatim (explicit ports respected); every builder `build()`s to plain wire types.
4. **Cross-SDK consistent, Node-idiomatic** — grammar verbs match rift-java (`onGet`,
   `willReturn`, `scenario().startingAt().when().respond().goTo()`, `verify(match, times(1))`);
   spelling is Node-idiomatic (`okJson(object)`, `.latency(ms)`, `handle.url`,
   `await using`).
5. **Failures are self-diagnosing** — verification failures render a WireMock-style near-miss
   diff; startup failures carry engine stderr; native-library failures name the exact file,
   version, and fix.

## 2. Packaging and module format

- **ESM-only**, Node ≥ 20. No CJS build. Rationale: zero-dep core + global `fetch` +
  `worker_threads` + `await using` all target modern Node; both testkit targets are ESM-native.
  CJS consumers use dynamic `import()`.
- **Two packages, one repo** (npm workspaces, **#39** — realizing the original design): core
  `@rift-vs/rift` lives in `packages/rift-core` and has **no dependencies at all**; the embedded
  transport is the separate `@rift-vs/rift-embedded` package (`packages/rift-embedded`, versioned
  in lockstep) carrying `koffi` as a **real** dependency. Core reaches it only through the dynamic
  `import('@rift-vs/rift-embedded')` inside `rift.embedded()` — `connect`/`spawn` users never load
  it, and installing the embedded package is what opts a project in. The embedded package consumes
  core's non-public machinery via the `./internal` subpath (no semver guarantees — it exists for
  same-version embedded backends), keeping the public root surface curated. The former
  `./embedded` subpath is retired; its surface is the embedded package's root export.
- `package.json` exports as shipped (`types` first in each condition block — the types-second
  ordering the original design flagged was fixed by #25):

```jsonc
{
  "name": "@rift-vs/rift",
  "type": "module",
  "exports": {
    ".":                  { "types": "./dist/index.d.ts",             "import": "./dist/index.js" },
    "./compat":           { "types": "./dist/compat/index.d.ts",      "import": "./dist/compat/index.js" },
    "./testkit/vitest":   { "types": "./dist/testkit/vitest.d.ts",    "import": "./dist/testkit/vitest.js" },
    "./testkit/jest":     { "types": "./dist/testkit/jest.d.ts",      "import": "./dist/testkit/jest.js" },
    "./intercept-undici": { "types": "./dist/intercept-undici.d.ts",  "import": "./dist/intercept-undici.js" },
    "./internal":         { "types": "./dist/internal.d.ts",          "import": "./dist/internal.js" }
  },
  "peerDependencies": { "undici": ">=6", "vitest": ">=1", "@rift-vs/rift-embedded": "*" },
  "peerDependenciesMeta": {
    "undici": { "optional": true }, "vitest": { "optional": true },
    "@rift-vs/rift-embedded": { "optional": true }  // the embedded transport opt-in (#39)
  }
}
```

- **Root export hygiene** (shipped in #25, breaking but pre-publish): the legacy weak types
  (`Predicate`/`Response`/`Stub`/`Imposter`/`ImposterConfig`/`ServerInfo` from `src/types.ts`)
  left the root — root names belong to the DSL + wire model. The Mountebank-compat surface
  (`create`, `CreateOptions`, `RiftServer`, default export `{ create }`) stays at the root (it is
  a permanent product surface) and is also importable from `./compat`.

## 3. Client API — engine facade and handles

### 3.1 Entry points

```ts
export const rift: {
  connect(url: string, options?: ConnectOptions): Promise<RiftEngine>;
  spawn(options?: SpawnOptions): Promise<RiftEngine>;
  embedded(options?: EmbeddedOptions): Promise<RiftEngine>;  // dynamic import of @rift-vs/rift-embedded
};

interface ConnectOptions {
  apiKey?: string;                    // Authorization header for the admin plane; blank (empty
                                      // or whitespace-only) throws InvalidDefinition — omit instead
  headers?: Record<string, string>;
  timeoutMs?: number;                 // per-request; default 30_000
  versionCheck?: 'fail' | 'warn' | 'off';  // default 'fail'; compares GET /config to minEngineVersion
}
```

`connect` is async (it performs the version preflight). All three return the same
`RiftEngine` interface — transports differ only in acquisition options.

### 3.2 `RiftEngine`

```ts
interface RiftEngine extends AsyncDisposable {
  readonly transport: 'remote' | 'spawn' | 'embedded';

  create(def: ImposterBuilder | wire.Imposter): Promise<ImposterHandle>;
  get(port: number): Promise<ImposterHandle>;               // attach to an existing imposter
  list(): Promise<ImposterSummary[]>;                       // { port, protocol, name?, numberOfRequests }
  deleteAll(): Promise<void>;
  replaceAll(defs: Array<ImposterBuilder | wire.Imposter>): Promise<ImposterHandle[]>;

  buildInfo(): Promise<BuildInfo>;   // { version, commit?, builtAt?, features: string[] }
  adminUrl(): Promise<string>;       // embedded: lazily starts the in-process admin plane

  intercept(options?: InterceptOptions): Promise<InterceptHandle>;   // §7

  readonly admin: AdminApi;          // typed low-level admin surface (escape hatch), §3.5
  close(): Promise<void>;            // idempotent
  readonly closed: boolean;
}
```

### 3.3 `ImposterHandle`

Returned by `create`/`get`. All mutators are `Promise<void>` unless noted.

```ts
interface ImposterHandle extends AsyncDisposable {
  readonly port: number;
  readonly url: string;              // `${protocol}://${reachableHost}:${port}` — 0.0.0.0 → 127.0.0.1
  readonly name?: string;
  readonly protocol: 'http' | 'https';

  // stub surgery
  addStub(stub: StubBuilder | wire.Stub, opts?: { index?: number }): Promise<void>;
  replaceStubs(...stubs: Array<StubBuilder | wire.Stub>): Promise<void>;
  updateStub(ref: number | { id: string }, stub: StubBuilder | wire.Stub): Promise<void>;
  deleteStub(ref: number | { id: string }): Promise<void>;
  stubs(): Promise<wire.Stub[]>;

  // verification (§6)
  recorded(filter?: RecordedFilter): Promise<RecordedRequest[]>;
  clearRecorded(): Promise<void>;
  verify(match: RequestMatch, count?: CountMatcher): Promise<void>;  // default atLeast(1)
  requests(opts?: { pollIntervalMs?: number; signal?: AbortSignal; match?: RequestMatch }):
    AsyncIterableIterator<RecordedRequest>;  // live iteration, polling-based (#26; SSE when rift#461 lands)

  // scenarios (§5.8)
  scenarios(flowId?: string): Promise<Array<{ name: string; state: string }>>;
  setScenarioState(name: string, state: string, flowId?: string): Promise<void>;
  resetScenarios(flowId?: string): Promise<void>;

  // spaces & flow state (§5.9)
  space(flowId: string): SpaceHandle;
  flowState(flowId: string): FlowStateHandle;

  // lifecycle & export
  enable(): Promise<void>;
  disable(): Promise<void>;
  clearProxyRecordings(): Promise<void>;   // DELETE savedProxyResponses
  toJson(opts?: { replayable?: boolean; removeProxies?: boolean }): Promise<wire.Imposter>;
  delete(): Promise<void>;                 // [Symbol.asyncDispose] delegates here (idempotent)
}
```

`SpaceHandle` scopes the same verbs to one flow id; `delete()` is the one-call teardown:

```ts
interface SpaceHandle {
  readonly flowId: string;
  addStub(stub: StubBuilder | wire.Stub): Promise<void>;   // POST spaces/{flowId}/stubs
  stubs(): Promise<wire.Stub[]>;
  recorded(match?: RequestMatch): Promise<RecordedRequest[]>;
  verify(match: RequestMatch, count?: CountMatcher): Promise<void>;
  scenarios(): Promise<Array<{ name: string; state: string }>>;
  setScenarioState(name: string, state: string): Promise<void>;
  resetScenarios(): Promise<void>;
  state: FlowStateHandle;
  delete(): Promise<void>;                 // stubs + recorded + scenario state, never global
}

interface FlowStateHandle {
  get<T = unknown>(key: string): Promise<T | undefined>;   // undefined = absent (not an error)
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}
```

### 3.4 Layering

```
testkit (vitest/jest)                 — fixtures over the client API
client API: RiftEngine + handles      — transport-agnostic sugar, one implementation
AdminApi (typed, total)               — per-transport: HTTP (remote/spawn) | FFI+loopback (embedded)
wire model + DSL                      — pure data
```

`RiftEngine`/handles are implemented **once** over the `AdminApi` interface; transports provide
`AdminApi` implementations. This replaced the pre-M7 split where spawn returned `{url, port,
client}` and remote returned a bare client (#21).

### 3.5 `AdminApi` (escape hatch, total wire-level surface)

`RemoteClient` covers the full admin route table, and `AdminApi` is the interface every
transport implements: imposter CRUD (`?replayable`/`removeProxies`), stub CRUD by index and by id,
`savedRequests` get/delete with `match=` filters, `savedProxyResponses` delete, enable/disable,
scenarios get/put/reset, spaces, flow-state KV, `config`/`logs`/`metrics`, `reload`. Exact
signatures are in issue #15 (client API).

## 4. Error model

```ts
class RiftError extends Error                    // base
class InvalidDefinition extends RiftError        // client-side validation or engine 400
class ImposterNotFound extends RiftError         // 404
class EngineError extends RiftError              // other engine failure; .code
class EngineUnavailable extends RiftError        // spawn/connect/load failure; .cause
class CommunicationError extends RiftError       // transport-level (HTTP/FFI)
class WireValidationError extends RiftError      // wire codec, in and out; .path
class VerificationError extends RiftError        // verify() miss; .expected .count .recorded .closest
class UnsupportedPredicateError extends RiftError// client-side verify hit xpath/inject
class EngineVersionError extends RiftError       // preflight: engine < minEngineVersion; .found .required
class NativeLibraryError extends RiftError       // cdylib resolution/ABI failure; .path? .classifier?
class InterceptUnavailable extends RiftError     // intercept not started/startable on this transport
```

All SDK-thrown errors are `RiftError` subclasses (the compat `create()` keeps its historical plain
`Error`s). `WireValidationError` sits under `RiftError` like the rest (re-parented in #25).

`WireValidationError` guards both directions. Inbound it reports a malformed shape from `fromJson`;
outbound (issue #112) every admin payload — imposters, stubs, flow-state values, `intercept()`
options — is refused before it is sent if JSON cannot represent it honestly: a non-finite number
(`JSON.stringify` would emit `null`), a `bigint`, a function or a symbol. `.path` names the offending
key. The request is never sent, so a refusal leaves no partial state on the engine. Intercept *rules*
are the one exception to the type: `serve()`/`forward()`/`addRule()` report the same failure as
`InvalidDefinition`, because issue #101 fixed that surface to a single error type.

## 5. DSL — full grammar

### 5.1 Stub openers

```ts
stub(): StubBuilder                                   // bare (catch-all until refined)
on(method: string, path?: string | PathOpts): StubBuilder
onGet/onPost/onPut/onDelete/onPatch/onHead/onOptions(path?: string, opts?: PathOpts): StubBuilder
onAny(path: string, opts?: PathOpts): StubBuilder     // any method
```

**Path params**: a path containing `:name` segments (e.g. `/users/:id`) compiles to BOTH the
stub-level `routePattern` (param extraction for templates/scripts — Rift's `routePattern` is
extraction-only, it never matches) AND a derived anchored regex path predicate
(`{ matches: { path: "^/users/[^/]+$" } }`). Opt out with `{ params: false }` to treat `:` as a
literal. Param names are captured at the type level (`StubBuilder<{ id: string }>`) for editor
hints; purely compile-time. A param-typed builder composes into every consuming position —
`imposter().stub()`, `scenario().when()`, the `ImposterHandle` stub-surgery methods, and
`verify()` — because those accept the `AnyStubBuilder` upper bound rather than the bare
`StubBuilder` (#47). The wire output (`routePattern` + derived regex predicate) is unaffected.

<!-- docs:embed sdk-api-path-params -->
```ts
// A `:name` segment makes the opener return a param-typed builder — and it composes everywhere.
await using engine = await rift.embedded();

const users = await engine.create(
  imposter('users').record()
    // ...into imposter().stub()
    .stub(onGet('/api/users/:id').willReturn(okJson({ id: 1, name: 'Alice' })))
    // ...into scenario().when()
    .scenario(
      scenario('activation')
        .when('start', onPut('/api/users/:id')).respond(status(202)).goTo('active')));

// ...into the ImposterHandle stub-surgery methods
await users.addStub(onGet('/api/users/:id/posts').willReturn(okJson([])));
await users.replaceStubs(onGet('/api/users/:id').willReturn(okJson({ id: 2, name: 'Bob' })));
await users.updateStub({ id: 'u' }, onGet('/api/users/:id').willReturn(okJson({ id: 3 })));

await fetch(`${users.url}/api/users/1`);

// ...into verify() (a param-typed builder is a valid RequestMatch)
await users.verify(onGet('/api/users/:id'), times(1));
```

### 5.2 Matchers (field-agnostic, bind via `with*` or field binders)

```ts
equals(v: JsonValue): Matcher          deepEquals(v: JsonValue): Matcher
contains(v: string): Matcher           startsWith(v: string): Matcher
endsWith(v: string): Matcher           matches(re: string | RegExp): Matcher
exists(): Matcher                      notExists(): Matcher      // exists: false

interface Matcher {
  caseSensitive(): Matcher;            // wire: caseSensitive: true
  keyCaseSensitive(): Matcher;         // wire: keyCaseSensitive: true
  except(re: string | RegExp): Matcher;// wire: except
  jsonpath(selector: string): Matcher; // wire: jsonpath: { selector }
  xpath(selector: string, ns?: Record<string, string>): Matcher; // wire: xpath: { selector, ns }
}
```

This replaced the pre-M7 field-first free functions (`equals('path', v)`) — breaking but
pre-publish (#22). A bare `string`/`object` anywhere a `Matcher` is accepted means `equals`.

### 5.3 Predicates (composition) and stub refinement

```ts
// field binders — grouped under `req` to avoid clashing with node:path etc.
export const req: {
  method(m: string | Matcher): wire.Predicate;
  path(m: string | Matcher): wire.Predicate;
  body(m: string | object | Matcher): wire.Predicate;
  header(name: string, m: string | Matcher): wire.Predicate;
  query(name: string, m: string | number | Matcher): wire.Predicate;
};
and(...ps: wire.Predicate[]): wire.Predicate
or(...ps: wire.Predicate[]): wire.Predicate
not(p: wire.Predicate): wire.Predicate
injectPredicate(jsFn: string): wire.Predicate         // { inject: "function (config) {...}" }

// StubBuilder refiners (each ANDs one predicate; mirrors rift-java)
interface StubBuilder<P = {}> {
  withMethod(m: string | Matcher): this;
  withPath(m: string | Matcher): this;
  withBody(m: string | object | Matcher): this;
  withHeader(name: string, m: string | Matcher): this;
  withQuery(name: string, m: string | number | Matcher): this;
  when(p: wire.Predicate): this;                      // raw-predicate escape (kept)
  // stub-level fields
  id(id: string): this;                               // wire: id
  inSpace(flowId: string): this;                      // wire: space
  inScenario(name: string): this;                     // wire: scenarioName (grouping only, no FSM)
  routePattern(pattern: string): this;                // explicit override
  // responses
  willReturn(...rs: Array<ResponseBuilder | wire.StubResponse>): this;  // APPENDS (cycling)
  raw(patch: Partial<wire.Stub>): this;               // shallow-merged last
  build(): wire.Stub;
}
```

**Semantics**: `willReturn` **appends** on repeated calls (rift-java parity; shipped in #22).
`respond` is an alias. Nothing is named `then` (builders must not be thenables).

### 5.4 Response builders

```ts
// constructors
ok(body?): R            okJson(body: JsonValue): R      created(body?): R
noContent(): R          notFound(body?): R              badRequest(body?): R
status(code: number, body?): R                          json(code, body): R    text(code, body): R
fault(kind: TcpFaultKind): R                            // bare top-level fault response
proxyTo(to: string): ProxyBuilder                        // §5.6
inject(jsFn: string): R                                  // Mountebank JS inject
script(spec: ScriptSpec): R                              // _rift.script-only response, §5.7

interface ResponseBuilder /* R */ {
  status(code: number): this;
  header(name: string, value: string | string[]): this;  // string[] = multi-value (Set-Cookie)
  headers(h: Record<string, string | string[]>): this;
  body(v: JsonValue): this;
  binaryBody(data: Uint8Array | string): this;           // base64-encodes; wire: _mode: "binary"
  templated(): this;                                     // wire: _rift.templated: true

  // behaviors (_behaviors) — execution order in-engine: copy → lookup → decorate → wait
  latency(ms: number | { min: number; max: number } | string): this;
      // number → wait: N; range → wait: {min,max}; string = JS fn source → wait: "function() {...}"
      // NEVER emit {"inject": ...} — docs show it but the engine's WaitBehavior parser rejects it
  repeat(n: number): this;
  decorate(jsFn: string): this;
  shellTransform(...commands: string[]): this;           // string per command; array = chained
  copy(spec: CopySpec | CopySpec[]): this;
  lookup(spec: LookupSpec | LookupSpec[]): this;
  behavior(raw: wire.Behaviors): this;                   // merge escape hatch

  withFault(f: RiftFault): this;                         // _rift.fault, §5.5
  raw(patch: Partial<wire.StubResponse>): this;
  build(): wire.StubResponse;
}

interface CopySpec {
  from: 'path' | 'method' | 'body' | { query: string } | { headers: string };
  into: string;                                          // "${TOKEN}"
  using: { method: 'regex' | 'jsonpath' | 'xpath'; selector: string;
           options?: { ignoreCase?: boolean; multiline?: boolean } };
}
interface LookupSpec {
  key: { from: CopySpec['from']; using: CopySpec['using'] };
  fromDataSource: { csv: { path: string; keyColumn: string; delimiter?: string } };
  into: string;
}
```

`latency()` deliberately never emits the Mountebank-documented `wait: { inject: ... }` random-delay
form — the engine's `WaitBehavior` parser rejects it (#23 design decision). Random delay in a range
uses `{ min, max }`; full JS control uses the fn-source string. `wait: { inject }` stays
`fromJson`-only (see `latency-testing.json` in the conformance corpus).

### 5.5 Faults

```ts
type TcpFaultKind = 'CONNECTION_RESET_BY_PEER' | 'EMPTY_RESPONSE'
                  | 'RANDOM_DATA_THEN_CLOSE' | 'MALFORMED_RESPONSE_CHUNK';

export const Fault: {
  CONNECTION_RESET: 'CONNECTION_RESET_BY_PEER';
  EMPTY_RESPONSE: 'EMPTY_RESPONSE';
  RANDOM_DATA: 'RANDOM_DATA_THEN_CLOSE';
  MALFORMED_CHUNK: 'MALFORMED_RESPONSE_CHUNK';
  // _rift.fault builders (probabilistic, composable on any is-response)
  latency(ms: number | { min: number; max: number }, opts?: { probability?: number }): RiftFault;
  error(spec: { status?: number; body?: string; headers?: Record<string, string> },
        opts?: { probability?: number }): RiftFault;
  tcp(kind: TcpFaultKind, opts?: { probability?: number }): RiftFault;
};
```

`fault(Fault.CONNECTION_RESET)` → top-level `{ fault: "CONNECTION_RESET_BY_PEER" }` response.
`ok().withFault(Fault.latency(1000))` → `_rift.fault.latency`. Multiple `withFault` calls merge
into one `_rift.fault` block (latency + error + tcp coexist; engine precedence latency → tcp → error).

### 5.6 Proxy

```ts
interface ProxyBuilder {
  proxyOnce(): this; proxyAlways(): this; proxyTransparent(): this;   // wire: mode
  generatePredicates(...gens: PredicateGenerator[]): this;            // wire: predicateGenerators
  addWaitBehavior(on?: boolean): this;
  addDecorateBehavior(jsFn: string): this;
  injectHeader(name: string, value: string): this;                    // wire: injectHeaders
  rewritePath(from: string, to: string): this;                        // wire: pathRewrite (Rift ext)
  clientCert(pem: { key: string; cert: string }): this;               // mTLS to upstream
  latency(...) / repeat(...) / decorate(...) etc.                     // _behaviors now legal on proxy
  raw(patch: Partial<wire.StubResponse>): this;
  build(): wire.StubResponse;
}
interface PredicateGenerator {
  matches: { method?: true; path?: true; query?: true; body?: true; headers?: Record<string, true> };
  caseSensitive?: boolean; except?: string;
}
```

`ProxyBuilder` extends `ResponseBuilder`, so behavior chainers stay legal on a proxy response and
are emitted — the pre-M7 silent drop of `proxyTo(...).latency(500)` is gone (#23).

### 5.7 Scripts

```ts
export const Script: {
  rhai(code: string): ScriptSpec;          js(code: string): ScriptSpec;
  rhaiFile(path: string): ScriptSpec;      jsFile(path: string): ScriptSpec;
  ref(name: string): ScriptSpec;           // named registry (_rift.scripts)
};
// wire: _rift.script: { engine?, code | file | ref }
```

Used by `script(spec)` (response generator), `imposter().registerScript(name, spec)` (registry).

### 5.8 Scenarios

```ts
scenario(name: string): ScenarioBuilder
interface ScenarioBuilder {
  startingAt(state: string): this;                       // must equal first step's state (checked)
  when(state: string, stub: StubBuilder): this;          // SNAPSHOTS the stub at call time
  respond(...rs: Array<ResponseBuilder | wire.StubResponse>): this;  // variadic → cycling in-state
  goTo(next: string): this;                              // omit = gate without transition
  build(): wire.Stub[];
}
// sugar so users don't spread:
imposter('x').scenario(scenario('checkout').startingAt('Started')...)
```

`when` snapshots (`build()`s) the stub immediately — later mutation of the passed builder never
rewrites committed steps. `respond` is variadic (cycling in-state). Both shipped in #24.

**Grouping without an FSM**: a bare `scenarioName` on a stub (no required/new state — pure
grouping/tagging) is set with `StubBuilder.inScenario(name)` (#36). The FSM-with-transitions path
stays `scenario()`.

### 5.9 Imposter builder

```ts
imposter(name?: string): ImposterBuilder
interface ImposterBuilder {
  port(n: number): this;                    // explicit ports ALWAYS respected
  host(h: string): this;
  protocol(p: 'http' | 'https'): this;
  https(tls?: { cert?: string; key?: string; mutualAuth?: boolean }): this;  // protocol + PEM
  record(): this;  recordMatches(): this;  allowCORS(): this;
  strictBehaviors(): this;
  defaultResponse(r: ResponseBuilder | wire.IsResponse): this;
  defaultForward(url: string): this;        // Rift: transparent forward for unmatched
  serviceName(s: string): this;  serviceInfo(v: JsonValue): this;
  stub(...stubs: Array<StubBuilder | wire.Stub>): this;
  scenario(s: ScenarioBuilder): this;       // appends s.build() stubs
  // _rift config
  flowState(cfg: { backend?: 'inmemory' | 'redis'; ttlSeconds?: number;
                   flowIdSource?: 'imposter_port' | `header:${string}`;
                   redis?: { url: string; poolSize?: number; keyPrefix?: string } }): this;
  flowIdFromHeader(name: string): this;     // sugar: flowIdSource: `header:${name}`
  metrics(port?: number): this;
  scriptEngine(cfg: { defaultEngine?: 'rhai' | 'javascript'; timeoutMs?: number }): this;
  registerScript(name: string, spec: ScriptSpec): this;
  raw(patch: Partial<wire.Imposter>): this;
  build(): wire.Imposter;
}
```

`defaultResponse` throws `InvalidDefinition` on non-`is` builders at call time and accepts a raw
`wire.IsResponse` (#24).

## 6. Verification

### 6.1 Types

```ts
interface RecordedRequest {
  method: string;
  path: string;
  query: Record<string, string | string[]>;
  headers: Record<string, string | string[]>;
  body?: unknown;                 // string, or parsed JSON when the engine recorded it as such
  from: string;                   // wire: request_from (client addr)
  timestamp: string;              // RFC3339
  raw: wire.RecordedRequest;      // untouched wire object
}
type RequestMatch = StubBuilder | wire.Predicate | wire.Predicate[];
interface CountMatcher { readonly min: number; readonly max: number; describe(): string }
times(n): CountMatcher   atLeast(n): CountMatcher   atMost(n): CountMatcher
between(min, max): CountMatcher                     never(): CountMatcher  // times(0)
```

A `StubBuilder` used as a match contributes only its predicates (responses ignored).

### 6.2 Client-side predicate evaluation

Rift has no server-side verify endpoint yet (upstream: **rift#494**), so `verify`/`recorded(filter)`
evaluate predicates in the SDK against recorded requests: `equals`, `deepEquals`, `contains`,
`startsWith`, `endsWith`, `matches`, `exists`, `and`, `or`, `not`, honoring `caseSensitive`
(default insensitive), `keyCaseSensitive`, `except`, plus a built-in `jsonpath` subset
(dot + bracket + numeric index: `$.a.b[0].c`; filters/wildcards unsupported). `xpath` and `inject`
predicates throw `UnsupportedPredicateError` naming the operator. Semantics mirror the engine
(string coercion for query/header scalars, object-containment for `equals` on JSON bodies).
Evaluator ergonomics follow-ups — field-name validation, typed regex errors, non-JSON-body
diagnostics — are tracked in **#33**.

### 6.3 Failure rendering (`VerificationError`)

"Closest" = the recorded request satisfying the highest fraction of leaf predicate clauses; ties →
most recent. Message format (snapshot-tested):

```
Verification failed for imposter "users" (port 55123)

Expected  GET /api/users/1        times(1)
Actual    0 of 3 recorded requests matched

Closest non-match — request #2 at 2026-07-09T10:12:03Z from 127.0.0.1:52114:
  method  GET                       ✓
  path    /api/users/2              ✗  expected equals "/api/users/1"
  header  accept: application/json  ✓
```

`error.expected` (predicates), `error.count` (`{ matched, total, matcher }`), `error.recorded`,
`error.closest` are machine-readable. The testkit's `assertReceived` reuses this renderer.

## 7. Intercept (TLS-MITM)

```ts
interface InterceptOptions { host?: string; port?: number; caCertPath?: string; caKeyPath?: string }
interface InterceptHandle {
  readonly url: string;             // http://host:port — set as the SUT's HTTPS proxy
  readonly port: number;
  serve(match: string | wire.Predicate[], response: ResponseBuilder | wire.IsResponse): Promise<void>;
      // string = host shorthand → { host, action: { serve } }
      // response is normalized to the engine's narrower wire.ServeStub (see below)
  forward(match: string | wire.Predicate[], to: ImposterHandle | number): Promise<void>;
  redirectTo(imposter: ImposterHandle): Promise<void>;    // catch-all forward rule
  rules(): Promise<wire.InterceptRule[]>;
  addRule(rule: wire.InterceptRule | wire.InterceptRule[]): Promise<void>;
  clearRules(): Promise<void>;
  caPem(): Promise<string>;
  caFile(dir?: string): Promise<string>;                  // writes PEM, returns path (for NODE_EXTRA_CA_CERTS)
  exportTruststore(opts: { format: 'pkcs12' | 'jks'; path: string; password?: string }): Promise<void>;
  env(): Promise<Record<string, string>>;                 // { HTTPS_PROXY, HTTP_PROXY, NODE_EXTRA_CA_CERTS }
}
```

`serve()` normalization (issue #101). The engine's serve action is a `ServeStub`
(`statusCode: u16`, `headers: String -> String`, `body: Option<String>`), which is narrower than the
Mountebank-shaped `IsResponse` the DSL builds — so `serve()` converts rather than passing it through:

| Input | Result |
|---|---|
| `body` object/array/number/boolean | compact JSON string — `okJson({ok:true})` sends `'{"ok":true}'` |
| `body` string | sent verbatim, never double-encoded |
| `body` absent or `null` | omitted |
| `statusCode` numeric string (`'404'`) | coerced to a number |
| `_mode: 'text'`, unknown keys | dropped |
| multi-value header (`string[]`) | **throws `InvalidDefinition`** — joining would corrupt `Set-Cookie` |
| `_mode: 'binary'` or unrecognized | **throws `InvalidDefinition`** — the base64 would be served as literal text |
| `statusCode` outside `100..999` | **throws `InvalidDefinition`** — the engine cannot render it as a status line |
| `body` containing `NaN`/`Infinity`/`-Infinity` | **throws `InvalidDefinition`** locating the offending value — `JSON.stringify` would silently emit `null` |
| `Host`, `Connection`, `Content-Length`, `Transfer-Encoding` (any case) | **throws `InvalidDefinition`** — the engine's proxy manages connection framing and drops these |
| header name or value containing CR/LF | **throws `InvalidDefinition`** — the engine drops these to prevent response splitting |

Use `forward()` to an imposter when you need a multi-value header, a binary body, or a status code
outside `100..999`, or `addRule()` to send a rule verbatim. A non-finite number has no JSON form at
all, so no escape hatch applies there — send it as a string if the SUT expects one. Body key order
follows your object; the imposter path re-serializes through Rust and emits sorted keys, so the two
differ byte-wise (equivalent JSON) if a SUT hashes the body.

The last two rows have no escape hatch: the engine strips those same four names on the `forward()`
request and response legs as well, and a CR/LF-bearing header is unsendable in valid HTTP on any
path. `addRule()` is not a way around them either — it skips the normalization above, so the engine
drops the header silently just as it did before. What `addRule()` does *not* skip is JSON
representability: a rule carrying a non-finite number, a `bigint`, a function or a symbol —
anywhere, including `statusCode` and `predicates` — throws `InvalidDefinition` rather than reaching
the engine as a `null` you never wrote (a `null` the transport could not catch afterwards, since it
re-parses the serialized rule). It still does not range-check a finite `statusCode`. Note the four
names above are exactly what the engine manages — `Keep-Alive`, `TE` and `Upgrade` are RFC 7230
hop-by-hop but are **not** stripped, so
`serve()` sends them and the SUT receives them. The engine still appends its own `Content-Length`
and `Connection: close` to every served response.

Per-transport availability (documented, typed):
- **embedded** — `engine.intercept(opts)` calls `rift_start_intercept` (idempotent handle reuse).
- **spawn** — must be requested at spawn: `rift.spawn({ intercept: true | InterceptOptions })`
  maps to `--intercept-port` (+ CA flags). `engine.intercept()` without it throws
  `InterceptUnavailable` with the fix in the message.
- **remote** — attach-only: probes `GET /intercept/rules`; 404 → `InterceptUnavailable`
  ("start the server with --intercept-port"). Runtime start/status parity is upstream
  **rift#493**.

Trust helpers: `handle.env()` covers child-process SUTs; for in-process undici/fetch, the optional
subpath `@rift-vs/rift/intercept-undici` (peer-dep `undici`) exports
`interceptDispatcher(handle): Promise<ProxyAgent>` wired with proxy URL + CA.

## 8. Transports

### 8.1 Remote / spawn

Spawn exposes the engine's CLI flags as first-class options:

```ts
interface SpawnOptions {
  port?: number; host?: string; loglevel?: 'debug'|'info'|'warn'|'error'; logfile?: string;
  version?: string; binaryPath?: string; env?: Record<string, string>; mirror?: string;
  startupTimeoutMs?: number; shutdownTimeoutMs?: number;
  allowInjection?: boolean;                       // --allow-injection
  apiKey?: string;                                // --api-key (also used by the client); blank
                                                  // throws InvalidDefinition before the binary
                                                  // is resolved — omit to run without admin auth
  localOnly?: boolean; ipWhitelist?: string[]; origin?: string;
  datadir?: string; configfile?: string;
  defaultTls?: { cert: string; key: string };     // --default-tls-cert/key
  metricsPort?: number;
  intercept?: boolean | InterceptOptions;         // --intercept-port (+ CA paths)
}
```

`SpawnedEngine.close()` also closes its `AdminApi` client, so no usable client outlives a dead
process.

### 8.2 Embedded

- **Separate package** (§2, #39): the worker, koffi binding, and FFI plumbing are
  `@rift-vs/rift-embedded` (`packages/rift-embedded`), reached from core only via the dynamic
  import inside `rift.embedded()`; koffi is a real dependency of that package, not of core.
- One dedicated `worker_threads` Worker owns the koffi handle, binding the 26-symbol C-ABI v2
  (shipped in #8). Every native call runs synchronously on the worker and is atomically
  paired with `rift_last_error()` on that thread (the ABI's error slot is per-OS-thread).
- **FFI-first with lazy loopback bridge**: operations with FFI symbols use them; the admin
  long-tail (scenario get/set/reset, `savedRequests`/`savedProxyResponses` clear, enable/disable)
  routes through a lazily started in-process admin plane (`rift_serve_admin` on `127.0.0.1:0`,
  random `apiKey`), started at most once. Imposter **creation always goes through FFI** — this
  bypasses the admin plane's `allowInjection: false` default, so script/inject stubs work embedded
  with no flag. `list()`/`get()` are served from a local registry (port → submitted config) merged
  with `rift_recorded` counts. Upstream: **rift#491** (FFI admin long-tail symbols — retires the
  bridge) and **rift#492** (`allowInjection` option on `rift_serve_admin`).
- Preflight: `rift_build_info` missing symbol → `NativeLibraryError` ("ABI v1 library, need v2");
  version < `minEngineVersion` → `EngineVersionError` (or `console.warn` with
  `versionCheck: 'warn'`). `requireFeatures: ['javascript']` asserts compiled-in features.
- CI: the embedded conformance lane runs against the built `dist/` (the worker resolves
  `./worker.js` relative to the compiled module; `jest.embedded.config.js` remaps `src/` imports
  to `dist/`, #44). It is the **required M8 gate** on ubuntu + macos: it genuinely exercises the
  FFI and passes now that the #53 segfault (and the #62/#63/#65 follow-ons it unmasked) are fixed.
  A cdylib-fetch 404 self-skips the embedded describes rather than failing, so only a genuine
  embedded-test failure blocks merges. The Windows lane stays experimental.

```ts
interface EmbeddedOptions {
  libPath?: string;                 // wins over everything; also RIFT_FFI_LIB
  version?: string;                 // natives version pin; default = package minEngineVersion
  cacheDir?: string;
  download?: boolean;               // default true; false = resolve offline or throw
  versionCheck?: 'fail' | 'warn' | 'off';
  requireFeatures?: string[];
  keepAlive?: boolean;              // #70: hold the process alive while the engine is open —
                                    // the standalone mock-server shape. Default false: an idle
                                    // engine never blocks exit (awaited calls always complete).
}
```

### 8.3 Natives resolution (cdylib + spawn binary)

Order: `libPath`/`RIFT_FFI_LIB` → cache
(`${RIFT_CACHE_DIR ?? $XDG_CACHE_HOME ?? ~/.cache}/rift-node/ffi/<version>/librift_ffi-<classifier>.<ext>`)
→ download via `ffi-manifest.json` from the release (mirror base: `RIFT_DOWNLOAD_URL`), SHA-256
from the manifest **mandatory** (no skip). Air-gap: `RIFT_OFFLINE=1` → no network, error lists the
exact file+URL+destination to place manually. Classifiers: `linux-x86_64[-musl]`, `linux-aarch64`,
`darwin-{x86_64,aarch64}`, `windows-x86_64`; musl detected via `process.report` glibc absence.
`npx rift-fetch [--bin] [--lib] [--version <v>]` prefetches (default: both artifacts).

## 9. Testkit

### Vitest (`@rift-vs/rift/testkit/vitest`)

```ts
export const riftTest = createRiftTest();          // default: embedded if installed, else spawn
export function createRiftTest(opts?: {
  transport?: 'embedded' | 'spawn' | { connect: string };
  engine?: EmbeddedOptions | SpawnOptions | ConnectOptions;
}): TestAPI<{ engine: RiftEngine }>;
```

- `engine` is a **worker-scoped** fixture (one engine per Vitest worker — cheap for embedded and
  spawn). This is the isolation decision as shipped: **per-worker engine + per-test imposter
  auto-teardown**, not spaces; spaces-isolation for a shared `connect` engine remains a documented
  pattern, not automated.
- The test-scoped `engine` the test receives is a proxy that records every `create()` and
  `replaceAll()`; those imposters are disposed after each test (auto-teardown). `get()`
  attachments are not auto-deleted.
- Transport auto-detect: embedded when `koffi` (or `@rift-vs/rift-embedded`, #39) resolves,
  else spawn.
- `assertReceived(imposter, match, count?)` re-exported = `imposter.verify` (shared renderer).

Usage (runnable, embed-checked):

<!-- docs:embed testkit-vitest -->
```ts
import { riftTest } from '@rift-vs/rift/testkit/vitest';
import { imposter, onGet, okJson, times } from '@rift-vs/rift';

riftTest('looks up user', async ({ engine }) => {
  const users = await engine.create(imposter('users').record()
    .stub(onGet('/api/users/1').willReturn(okJson({ id: 1 }))));  // auto-teardown
  await fetch(`${users.url}/api/users/1`);
  await users.verify(onGet('/api/users/1'), times(1));
});
```

### Jest (`@rift-vs/rift/testkit/jest`)

Jest has no fixture system; explicit helpers instead (no custom environment — ESM-hostile).
Illustrative sketch (not runnable; the quick start in `docs/` has the full form):

```ts
const rift = setupRift({ transport: 'spawn' });    // registers beforeAll/afterAll/afterEach
test('looks up user', async () => {
  const users = await rift.engine.create(imposter('users')...);   // auto-teardown afterEach
  ...
});
```

## 10. Mountebank compat (permanent)

`create(options)` / default export `{ create }` keep their exact contract (including
accepted-but-ignored `redis`/`impostersRepository`, any-HTTP-response readiness poll, EventEmitter
events, SIGTERM→SIGKILL close). Internals migrated to `fetch` + `spawn/resolve.ts` in #25: axios
and the duplicate `binary.ts` stack retired; `findBinary`/`downloadBinary`/`getBinaryVersion`
remain as deprecated delegating wrappers. Known follow-up: `create()`'s child-process `'error'`
listener throws inside the emitter, crashing the host on spawn failure instead of rejecting —
tracked as **#28**.

## 11. Conformance

Corpus replay harness (the corpus is published — rift v0.14.0 ships `sdk-conformance-*.tar.gz`,
resolving the original rift#460 blocker): for each fixture, `fromJson` → create over each
transport → replay recorded interactions → byte-compare responses. **Expressibility gate**: every
fixture name must have an entry in `test/conformance/dsl-coverage.ts` mapping it to a DSL
reconstruction whose `build()` output deep-equals the fixture (modulo defaults); a missing/failing
entry fails CI naming the gap. Details in issues #7/#13. Remote + spawn lanes are required; the
embedded lane runs against the built `dist/` (**#44**) and is now **required** on ubuntu + macos
(the FFI segfault **#53** and its follow-ons are fixed). The Windows lane stays experimental.

## 12. Issue map — delivered ledger

Every slice of the original design has shipped:

| Issue | Delivered | PR |
|---|---|---|
| #21 | §3 engine facade + handles + AdminApi completion (M7) | #29 |
| #22 | §5.1–5.3 matcher/predicate grammar (M7) | #30 |
| #23 | §5.4–5.7 responses/behaviors/faults/scripts/proxy (M7) | #31 |
| #24 | §5.8–5.9 imposter/stub/scenario completion (M7) | #32 |
| #25 | §2/§10 export hygiene + legacy retirement (M7) | #27 |
| #6 | §6 verification (M7) | #34 |
| #26 | §3.3/§6 recorded-request async iteration (polling; SSE when rift#461 lands) | #35 |
| #7 | §11 conformance harness, remote + spawn lanes (M7) | #37 |
| #9 | §8.3 natives resolution (M8) | #38 |
| #8 | §8.2 koffi worker binding (M8) | #40 |
| #10 | §8.2 `rift.embedded()` wiring + preflight (M8) | #41 |
| #11 | §7 intercept (M8) | #42 |
| #13 | §11 corpus green over embedded (M8) | #43 |
| #12 | §9 testkit (M8) | #45 |
| #14 | docs quick starts + migration guide (M8) | #46 |

Historical implementation order: #25 → #21 → #22/#23/#24 → #6 → #7 ‖ #8/#9 → #10 → #11/#12 →
#13 → #14.

Open follow-ups (this repo):

| Issue | Tracks |
|---|---|
| #28 | §10 — compat `create()` spawn-failure `'error'` listener crashes the host |
| #33 | §6.2 — evaluator ergonomics (field-name validation, typed regex errors, body diagnostics) |
| #39 | §2 — `@rift-vs/rift-embedded` package split (deferred; trigger conditions in the issue) |
| #53 | §8.2 — cross-platform segfault running the full librift_ffi/koffi binding |

Open upstream (rift engine):

| Issue | Tracks |
|---|---|
| rift#461 | SSE recorded-request stream (upgrades #26's polling `requests()`) |
| rift#473 | docs redirect for the relocated quick starts |
| rift#491 | FFI admin long-tail symbols (retires §8.2's loopback bridge) |
| rift#492 | `allowInjection` option on `rift_serve_admin` |
| rift#493 | runtime intercept lifecycle endpoints (§7 remote parity) |
| rift#494 | server-side verification endpoint (full-fidelity §6 `verify`) |
