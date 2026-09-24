---
layout: default
title: Migrating from Mountebank
parent: Mountebank compatibility
nav_order: 1
permalink: /mountebank/migration/
---

# Migrating from Mountebank

`@rift-vs/rift` ships two coexisting APIs in the same process, permanently:

- **Mountebank compat** — `create()` (also at `@rift-vs/rift/compat`) spawns the engine and speaks
  the exact Mountebank wire protocol: raw JSON imposters over `POST /imposters`, the `mb` CLI,
  existing REST tooling. Nothing about this contract is deprecated or scheduled for removal.
- **Typed DSL** — `imposter()`/`stub()`/`onGet()`/... builders, `rift.embedded()`/`rift.spawn()`/
  `rift.connect()`, and `imposter.verify(...)`.

You do not have to migrate. `create()` and the typed DSL can be adopted incrementally, stub by
stub, in the same codebase — a raw Mountebank imposter JSON round-trips through `fromJson` and can
be mixed with DSL-built imposters on the same engine. This document is a reference for translating
concepts when (and only as fast as) you want to.

Every operator, behavior, fault, and response type below maps to a real, exported DSL symbol —
this table is checked against [`docs/design/sdk-api.md`](../reference/sdk-api.md) §5 (the full grammar
reference) for completeness.

## Imposter creation

| Mountebank (raw JSON / REST) | Typed DSL |
|---|---|
| `POST /imposters` with `{ port, protocol: 'http', stubs: [...] }` | `engine.create(imposter().port(n).stub(...))` |
| `mb.create({ port, ... })` (or `@rift-vs/rift`'s old `create()`) | `create({ port, ... })` — unchanged, see the [per-transport quick starts](../getting-started/transports.md) |
| `{ protocol: 'https', cert, key, mutualAuth: true }` | `imposter().https({ cert, key }).requireClientCertificate()` — requires a client certificate on engine ≥ 0.18.0 (older engines accepted everyone; `create()` refuses below 0.18.0) |
| `{ protocol: 'https', mutualAuth: true, rejectUnauthorized: true, ca }` | `imposter().https(...).requireClientCertificate([caPem])` — one anchor emits `ca` as a string, several as an array; `listImposters({ replayable: true })` carries the CA material; the per-imposter `toJson()` omits it like `cert`/`key` |
| `{ recordRequests: true }` | `imposter().record()` |
| `{ recordMatches: true }` | `imposter().recordMatches()` — **deprecated**: no Rift engine records per-stub matches (engine ≥ 0.18.0 reports `config_key_ignored`); use `record()` and `recorded()` |
| `{ allowCORS: true }` | `imposter().allowCORS()` |
| `{ defaultResponse: { statusCode: 404 } }` | `imposter().defaultResponse(status(404))` |
| `{ name: 'users' }` | `imposter('users')` |
| Raw imposter JSON you already have | `fromJson(json)` — see [Escape hatches](#escape-hatches) |

## Predicates

Every Mountebank predicate operator, params, and selector is covered:

| Mountebank JSON | Typed DSL |
|---|---|
| `{ equals: { path: '/x' } }` | `req.path(equals('/x'))`, or bare `req.path('/x')` (a bare value means `equals`) |
| `{ deepEquals: { body: {...} } }` | `req.body(deepEquals({...}))` |
| `{ contains: { headers: { Accept: 'json' } } }` | `req.header('Accept', contains('json'))` |
| `{ startsWith: { path: '/api' } }` | `req.path(startsWith('/api'))` |
| `{ endsWith: { path: '.json' } }` | `req.path(endsWith('.json'))` |
| `{ matches: { path: '^/users/\\d+$' } }` | `req.path(matches('^/users/\\d+$'))` (or a `RegExp`) |
| `{ exists: { query: { debug: true } } }` | `req.query('debug', exists())` |
| `{ exists: { query: { debug: false } } }` | `req.query('debug', notExists())` |
| `{ and: [p1, p2] }` | `and(p1, p2)` |
| `{ or: [p1, p2] }` | `or(p1, p2)` |
| `{ not: p }` | `not(p)` |
| `{ inject: 'function(config){...}' }` | `injectPredicate('function(config){...}')` |
| `{ ..., jsonpath: { selector: '$.a.b' } }` | `req.body(equals(v).jsonpath('$.a.b'))` |
| `{ ..., xpath: { selector: '//a', ns: {...} } }` | `req.body(equals(v).xpath('//a', ns))` |
| `{ ..., caseSensitive: true }` | `contains(v).caseSensitive()` |
| `{ ..., keyCaseSensitive: true }` | `contains(v).keyCaseSensitive()` |
| `{ ..., except: '\\s' }` | `contains(v).except('\\s')` |
| `{ equals: { method: 'GET', path: '/x' } }` | `onGet('/x')` — combined method+path openers exist for every verb (`onPost`/`onPut`/`onDelete`/`onPatch`/`onHead`/`onOptions`/`onAny`/`on(method, path)`) |
| Params (`:id`) needing extraction | `onGet('/users/:id')` seeds both an anchored regex path predicate AND `route_pattern` for template/script extraction |

`req.method`/`req.path`/`req.body`/`req.header(name, ...)`/`req.query(name, ...)` bind a matcher to
a field; `stub().withMethod(...)`/`.withPath(...)`/`.withBody(...)`/`.withHeader(...)`/
`.withQuery(...)` do the same, ANDed onto the stub in call order. `stub().when(predicate)` accepts a
raw `wire.Predicate` as an escape hatch.

## Responses

| Mountebank JSON | Typed DSL |
|---|---|
| `{ is: { statusCode: 200, body: {...} } }` | `okJson({...})` (sets `Content-Type: application/json` too), or `ok({...})`/`status(200, {...})` |
| `{ is: { statusCode: 201 } }` | `created()` |
| `{ is: { statusCode: 204 } }` | `noContent()` |
| `{ is: { statusCode: 400, body } }` | `badRequest(body)` |
| `{ is: { statusCode: 404, body } }` | `notFound(body)` |
| `{ is: { headers: { 'Set-Cookie': ['a', 'b'] } } }` | `.header('Set-Cookie', ['a', 'b'])` (multi-value) |
| `{ is: { body: '<base64>', _mode: 'binary' } }` | `.binaryBody(uint8ArrayOrBase64String)` |
| `{ is: {...}, _rift: { templated: true } }` | `.templated()` |
| `{ is: {...}, _rift: { stateOps: [{ op: 'increment', key: 'hits' }] } }` (no Mountebank equivalent — an `inject` that mutates `state`) | `.incrementState('hits')`, `.setState()`, `.deleteState()`, `.clearFlowState()`, `.stateOps(...)` (engine ≥ 0.18.0) |
| `stubs[0].responses` with N entries (Mountebank cycles them per matching call) | `.willReturn(r1, r2, r3)` — repeated `.willReturn()` calls **append** to the same cycle |
| `{ inject: 'function(config){...}' }` | `inject('function(config){...}')` |

## Behaviors

| Mountebank JSON | Typed DSL |
|---|---|
| `_behaviors: { wait: 500 }` | `.latency(500)` |
| `_behaviors: { wait: 'function(){ return 500; }' }` | `.latency('function(){ return 500; }')` — never emit `{ inject: ... }` here; the engine's `WaitBehavior` parser only accepts the fn-string form |
| Rift extension: latency range | `.latency({ min: 100, max: 500 })` |
| `_behaviors: { repeat: 3 }` | `.repeat(3)` |
| `{ is, repeat: 3 }` (response-level, what `GET /imposters` writes since engine 0.18.0) | accepted by `fromJson`/`create()` as-is; `.repeat(3)` emits `_behaviors.repeat`, and if a response-level `repeat` is also present the response-level one wins |
| `_behaviors: { decorate: 'function(req,res){...}' }` | `.decorate('function(req,res){...}')` |
| `_behaviors: { shellTransform: ['cmd1', 'cmd2'] }` | `.shellTransform('cmd1', 'cmd2')` |
| `_behaviors: { copy: [{ from, into, using }] }` | `.copy({ from, into, using })` (or an array) |
| `_behaviors: { lookup: [{ key, fromDataSource, into }] }` | `.lookup({ key, fromDataSource, into })` (or an array) |
| Any other `_behaviors` key | `.behavior({ ...raw })` — shallow-merge escape hatch |

Execution order in-engine (Rift ≥ 0.18.0, matching Mountebank): `wait` → `lookup` → `copy` →
`shellTransform` → `decorate`. Rift ≤ 0.17.0 ran `wait` → `copy` → `lookup` → `decorate` →
`shellTransform`. The SDK always emits the object form; a caller who needs a different order must
send the engine's `behaviors` array form **alone** — `.raw({ behaviors: [...] })` on a response
with no `_behaviors`, since the engine uses `_behaviors` and ignores the array when both are
present.

### Behavior changes in Rift 0.18.0

Two combinations the builder can express change behavior with the new order (rift#1202):

- `.decorate(...)` + `.shellTransform(...)` on one response: the shell transform now runs
  **before** the decorator, so the decorator sees the transformed response (it used to run last).
- `.copy(...)` + `.lookup(...)` on one response: the lookup now runs **before** the copy, so
  request text inserted by `copy` is no longer re-scanned for lookup tokens — which also closes a
  column-disclosure path.

If a `decorate` or `lookup` result changed after moving to engine 0.18.0, this is the cause; the
`behaviors` array form above restores an explicit order.

## Faults

Mountebank's native TCP fault kinds, plus Rift's probabilistic `_rift.fault` extension:

| Mountebank JSON | Typed DSL |
|---|---|
| `{ fault: 'CONNECTION_RESET_BY_PEER' }` | `fault(Fault.CONNECTION_RESET)` |
| `{ fault: 'EMPTY_RESPONSE' }` | `fault(Fault.EMPTY_RESPONSE)` |
| `{ fault: 'RANDOM_DATA_THEN_CLOSE' }` | `fault(Fault.RANDOM_DATA)` |
| `{ fault: 'MALFORMED_RESPONSE_CHUNK' }` | `fault(Fault.MALFORMED_CHUNK)` |
| Rift extension: `_rift.fault.latency` (probabilistic) | `ok(body).withFault(Fault.latency(ms, { probability: 0.3 }))` |
| Rift extension: `_rift.fault.error` (probabilistic) | `ok(body).withFault(Fault.error({ status: 500 }, { probability: 0.1 }))` |
| Rift extension: `_rift.fault.tcp` (a native kind composed onto an `is`/proxy/inject response, instead of replacing it) | `ok(body).withFault(Fault.tcp(Fault.CONNECTION_RESET))` |

`fault()` is a bare top-level response (no `is` block, mutually exclusive with one); `.withFault()`
composes on top of any `is`/proxy/inject response and merges by kind (latency + error + tcp can
coexist; a second fault of the *same* kind throws rather than silently overwriting).

## Proxy

| Mountebank JSON | Typed DSL |
|---|---|
| `{ proxy: { to: 'http://upstream', mode: 'proxyOnce' } }` | `proxyTo('http://upstream').proxyOnce()` |
| `{ proxy: { mode: 'proxyAlways' } }` | `.proxyAlways()` |
| Rift extension: `proxyTransparent` | `.proxyTransparent()` |
| `{ proxy: { predicateGenerators: [...] } }` | `.generatePredicates({ matches: { path: true, method: true } })` |
| `{ proxy: { addWaitBehavior: true } }` | `.addWaitBehavior()` |
| `{ proxy: { addDecorateBehavior: 'fn' } }` | `.addDecorateBehavior('fn')` |
| `{ proxy: { injectHeaders: { 'X-Foo': 'bar' } } }` | `.injectHeader('X-Foo', 'bar')` (one entry per name, case-insensitive; a second spelling throws) |
| Rift extension: `{ proxy: { pathRewrite: { from, to } } }` | `.rewritePath(from, to)` |
| `{ proxy: { key, cert } }` (mTLS to upstream) | `.clientCert({ key, cert })` — **deprecated**: Rift's proxy sends no client certificate; the keys are dropped on parse, no replacement |
| `proxyTo(...).latency(500)` | Same call — the builder emits the block; **engine ≥ 0.18.0 runs it** (rift#1189) on the upstream's response before recording, so the generated stub holds the transformed result and a `proxyOnce` replay is not transformed again; a `wait` is not counted in `addWaitBehavior`'s latency. Engine ≤ 0.17.0 accepted the block and ignored it. Scripted behaviors (`decorate`, `shellTransform`, a function `wait`) need `allowInjection` here too (rift#1181) |
| `{ inject: fn, _behaviors: {...} }` | `inject(fn).latency(...)` — engine ≥ 0.18.0 runs the block on what the function returned (rift#1188); create only syntax-checks the body since 0.18.0 (rift#1183) |
| `{ fault, _behaviors }` / `{ _rift: { script }, _behaviors }` | `fault(k).repeat(n)` / `script(spec).repeat(n)` — only `repeat` takes effect on these shapes; the rest is reported in `_rift.warnings` (`config_key_ignored`, engine ≥ 0.18.0) |

## Scripts (`inject` → `_rift.script`)

| Mountebank JSON | Typed DSL |
|---|---|
| `{ inject: 'function(config){ return {statusCode:202}; }' }` | `inject('function(config){ return {statusCode:202}; }')` (unchanged — still Mountebank `inject`) |
| Rift extension: `_rift.script: { engine: 'rhai', code }` | `script(Script.rhai(code))` |
| Rift extension: `_rift.script: { engine: 'js', code }` | `script(Script.js(code))` |
| Rift extension: `_rift.script: { file }` (rhai) | `script(Script.rhaiFile(path))` |
| Rift extension: `_rift.script: { file }` (js) | `script(Script.jsFile(path))` |
| Rift extension: `_rift.script: { ref: 'name' }` + `_rift.scripts.name` | `script(Script.ref('name'))` + `imposter().registerScript('name', Script.rhai(code))` |

## Scenarios

| Mountebank JSON | Typed DSL |
|---|---|
| A stub with `scenarioName`, `required_scenario_state`, `new_scenario_state`, `predicates`, `responses` | One `.when(state, stub).respond(...).goTo(next)` step |
| Several such stubs forming a state machine | `scenario('checkout').startingAt('Started').when('Started', onPost('/cart')).respond(ok()).goTo('InCart')...` |
| `GET /imposters/{port}/scenarios` | `imposter.scenarios(flowId?)` |
| `PUT .../scenarios/{name}` | `imposter.setScenarioState(name, state, flowId?)` |
| `DELETE .../scenarios` (reset) | `imposter.resetScenarios(flowId?)` |

`scenario().build()` flattens to a `wire.Stub[]`; `imposter().scenario(builder)` appends those stubs
in call order (interleaved with plain `.stub()` calls). `.when()` snapshots the stub immediately —
mutating the passed builder afterward never rewrites an already-committed step.

## Verification

Mountebank has no first-class "did this happen N times" assertion — you dig through
`GET /imposters/{port}` (or `?replayable`) and inspect `requests`/`numberOfRequests` yourself. The
typed DSL turns that into one call:

| Mountebank (manual) | Typed DSL |
|---|---|
| `GET /imposters/{port}` → filter `requests` yourself | `imposter.recorded(filter?)` — mapped, ergonomic `RecordedRequest[]` |
| Same, then count-check by hand | `imposter.verify(match, times(n))` — throws `VerificationError` with a WireMock-style near-miss diff on failure |
| — (no equivalent) | `atLeast(n)` / `atMost(n)` / `between(min,max)` / `never()` count matchers |
| `DELETE /imposters/{port}/savedRequests` | `imposter.clearRecorded()` |
| — (no equivalent) | `imposter.requests({ signal, match })` — an `AsyncIterableIterator` polling the journal (default 250ms) |

`verify`/`recorded` evaluate predicates client-side (no server-side verify endpoint exists yet
upstream): `equals`/`deepEquals`/`contains`/`startsWith`/`endsWith`/`matches`/`exists`/`and`/`or`/
`not`, `caseSensitive`/`keyCaseSensitive`/`except`, and a jsonpath subset (dot + bracket + numeric
index) are supported; `xpath` and `inject` predicates throw `UnsupportedPredicateError` naming the
operator, rather than silently matching nothing.

## Escape hatches

You never have to fight the typed layer:

- **`fromJson(json)`** — parse and validate a raw Mountebank/Rift imposter JSON (a single imposter
  or a `{ imposters: [...] }` envelope) with no rewriting: no key renaming, no field injection, no
  dropped unknown keys, and an explicit `port` is respected exactly. `engine.create(fromJson(json))`
  drops straight in.
- **`.raw(patch)`** — every builder (`imposter()`, `stub()`, response builders) has a `.raw(patch)`
  that shallow-merges a plain object patch at the top level, last-wins, after every other call —
  for wire fields with no dedicated method yet.
- **`wire.*` types** — `import { wire } from '@rift-vs/rift'` gives you the exact wire grammar
  (`wire.Imposter`, `wire.Stub`, `wire.Predicate`, `wire.StubResponse`, ...) for hand-building
  anything the DSL doesn't cover, or for typing a `fromJson` result.

## Persistence & distributed state

| Mountebank | Rift |
|---|---|
| `mb --datadir <dir>` / `mb.create({ datadir })` | `create({ datadir })` — or `rift.spawn({ datadir })` on the native transport |

`datadir` has **full parity**: imposters created or mutated through the admin API are persisted as
`{port}.json` under the directory and reloaded when a server starts against the same `datadir`, so
imposter state survives a restart.

`mb --configfile` maps to `rift.spawn({ configfile })`, and Mountebank's `--noParse` to
`rift.spawn({ configfile, noParse: true })` (`--no-parse`): the file is loaded verbatim, with no
EJS preprocessing — also for the `POST /admin/reload` that re-reads it. Since engine 0.18.0 a
config file holding a tag the loader does not evaluate, a literal `<%` in a body included, fails the
spawn (surfaced as the engine's stderr) instead of being blanked; `noParse` is the way through.
`noParse` without `configfile` throws `InvalidDefinition` (the engine's CLI would accept it and
silently do nothing). The SDK's embedded transport does not expose a config file — it applies
already-parsed JSON — so there is nothing to switch off there.

**Custom `impostersRepository` (+ its `redis` bag) has no direct equivalent.** Mountebank loads a
Node module in-process to back its imposter store; Rift's engine is a native binary and cannot load
one, so `create({ impostersRepository })` / `create({ redis })` **throws
`UnsupportedCreateOptionError`** rather than silently degrading to an in-memory, single-process
server. Migrate a repository-backed deployment as follows:

- **Restart persistence** (imposters survive a bounce) → `datadir`, as above.
- **Distributed scenario / flow state** (shared across instances) → per-imposter
  `_rift.flowState.backend: "redis"` with a `redis: { url }` block — via the DSL's
  `flowState({ backend: 'redis', redis: { url } })`. This is imposter-scoped state, not an imposter
  *store*.
- **Multi-instance without shared state** → run independent Rift nodes behind a **sticky/affinity
  load balancer keyed on the flow id** (`flowState({ flowIdSource: 'header:X-Flow-Id' })`, or the
  `flowIdFromHeader('X-Flow-Id')` sugar). When each logical flow — a test run, a session, a tenant —
  pins to one node, scenario state, response cycling, and request verification are all already
  correct per-node, with no shared infrastructure and no cluster code. This, rather than rebuilding
  a Redis imposter repository, is the recommended replacement for a Redis-synced Mountebank fleet;
  it stops working only when a single flow genuinely sprays across nodes.
- **Multi-instance imposter-CRUD sync** (one process's `POST /imposters` becoming visible on another
  — the pub/sub half of a custom Redis repository) is a **non-goal**: Rift provides no cross-instance
  imposter replication today. A deployment that needs it keeps that coordination layer *above* the
  admin API (it is plain REST and works unchanged). Engine-side config-sync is a possible future
  direction, not a commitment — don't plan a migration around it.

## Things Rift rejects that Mountebank allowed

- **Non-HTTP(S) protocols.** Rift serves HTTP/HTTPS (and h2c); Mountebank's `tcp`/`smtp` protocol
  imposters have no Rift equivalent.
- **Custom `impostersRepository` / `redis` on `create()`.** No in-process repository module; see
  [Persistence & distributed state](#persistence--distributed-state) for the migration path.
- **Numeric and boolean header values — engines ≤ v0.14.0 only.** Mountebank accepts
  `"Content-Length": 124` (a JSON number); engines up to v0.14.0 reject the **entire imposter POST**
  with a 400 ([rift#754](https://github.com/achird-labs/rift/issues/754)). Fixed in engine
  **v0.15.0** ([rift#757](https://github.com/achird-labs/rift/pull/757)) — so unlike the two entries
  above, this one is version-scoped rather than a standing restriction, and this SDK's default pin
  (`DEFAULT_ENGINE_VERSION`) already points at v0.15.0. You still hit it whenever binary resolution
  lands on an older engine: one installed on PATH, an explicit `binaryPath` / `RIFT_BINARY_PATH`, or
  a pinned `version:` — none of which are version-checked (the PATH probe confirms a candidate *is*
  Rift, not which version it is). Note the SDK does not stringify these values for you: the same 400
  occurs through `create()` and the typed DSL, and equally when you POST raw imposter JSON straight
  to an older engine's **admin port**. On an affected engine, stringify non-string header values
  (`"124"`) before POSTing; otherwise upgrade the engine.

## See also

- [`docs/design/sdk-api.md`](../reference/sdk-api.md) — the full API design reference (types, transport
  internals, the issue map this SDK was built from)
- [README.md](../index.md) — quick starts, feature tour, env var reference
- [`docs/monorepo-migration.md`](../monorepo-migration.md) — moving from `rift/packages/rift-node`
