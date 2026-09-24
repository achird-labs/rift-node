---
layout: default
title: The typed DSL
parent: Guides
nav_order: 1
permalink: /guides/dsl/
---

# The typed DSL

An imposter is built from four kinds of pieces, assembled bottom-up: matchers bind to fields to
become predicates, predicates AND together onto a stub, a stub carries a response cycle, and
stubs collect onto an imposter. Every builder is synchronous and pure — `build()` produces a
plain wire object, and nothing talks to a server until `engine.create(...)`.

This guide covers the building blocks with examples. For the exhaustive Mountebank-JSON-to-DSL
mapping (every predicate operator, behavior, fault, proxy option, script kind) see
[Migrating from Mountebank](../mountebank/migration.md); for exact types see the
[API reference](../reference/sdk-api.md).

## Imposters

`imposter(name?)` returns an `ImposterBuilder`. The name is optional and purely descriptive
(`Imposter.name` on the wire); an explicit `.port(n)` is always respected, otherwise the engine
assigns one.

```ts
import { imposter } from '@rift-vs/rift';

imposter('users')
  .port(4545)
  .https({ cert, key })                   // sets protocol: 'https' + inline PEM
  .requireClientCertificate([caPem])      // mTLS: client cert must chain to caPem (engine >= 0.18.0);
                                          // no argument = any client cert; older engines accept everyone,
                                          // so create() refuses below 0.18.0
  .record()          // recordRequests — required for verify()/recorded() to see anything
  .allowCORS()
  .defaultResponse(status(404, { error: 'no matching stub' }));
```

- `.record()` turns on the request journal that [verification](verification.md) reads from —
  without it, `verify()`/`recorded()` throw naming `.record()` as the fix.
- `.recordMatches()` is **deprecated**: no Rift engine records per-stub matches. Engine ≥ 0.18.0
  reports the key as `config_key_ignored` in the imposter's `_rift.warnings` (and logs a WARN);
  older engines ignore it silently. `.record()` is the flag that does something.
- `.defaultResponse(...)` accepts a `ResponseBuilder` or a raw `IsResponse`; it must be an `is`
  response (no proxy/inject/fault) — `imposter().defaultResponse(...)` throws
  `InvalidDefinition` otherwise.

## Stubs and request matching

`stub()` is the bare, catch-all opener; the method-seeded openers combine an `equals(method)`
predicate with a path predicate in one call:

```ts
import { stub, onGet, onPost, onPut, onDelete, onPatch, onHead, onOptions, onAny, on } from '@rift-vs/rift';

onGet('/api/users/1')       // equivalent to on('GET', '/api/users/1')
onPost('/api/users')
onPut('/api/users/1')
onDelete('/api/users/1')
onPatch('/api/users/1')
onHead('/api/users/1')
onOptions('/api/users/1')
onAny('/api/health')        // any method, path must match
on('PROPFIND', '/webdav')   // explicit method, for verbs with no dedicated opener
stub()                       // no seeded predicate at all — refine with .withMethod()/.withPath()/...
```

**Path params.** A path containing `:name` segments — `onGet('/users/:id')` — seeds *both* the
stub's `route_pattern` (for template/script extraction; `route_pattern` never matches by itself)
*and* a derived anchored regex predicate on `path` (`^/users/[^/]+$`). Pass `{ params: false }` to
treat `:` as a literal instead. Param names are captured at the type level only
(`StubBuilder<{ id: string }>`) for editor hints — it has no runtime effect, and a param-typed
builder composes into every consuming position (`imposter().stub()`, `scenario().when()`, the
`ImposterHandle` stub-surgery methods, `verify()`).

## Predicates and matchers

A matcher (`equals`, `contains`, ...) is a field-agnostic value; it becomes a `Predicate` only once
bound to a field:

```ts
import { req, equals, deepEquals, contains, startsWith, endsWith, matches, exists, notExists, and, or, not } from '@rift-vs/rift';

req.path(equals('/x'))                 // or just req.path('/x') — a bare value means equals
req.body(deepEquals({ id: 1 }))
req.header('Accept', contains('json'))
req.path(startsWith('/api'))
req.path(endsWith('.json'))
req.path(matches('^/users/\\d+$'))     // string or RegExp
req.query('debug', exists())
req.query('debug', notExists())

and(req.method('GET'), req.path('/x'))
or(req.path('/a'), req.path('/b'))
not(req.header('X-Skip', exists()))
```

`req.method`/`req.path`/`req.body`/`req.header(name, ...)`/`req.query(name, ...)` are the field
binders. On a `StubBuilder`, `.withMethod(...)`/`.withPath(...)`/`.withBody(...)`/
`.withHeader(name, ...)`/`.withQuery(name, ...)` do the same thing, ANDed onto the stub in call
order — useful when refining a seeded opener:

```ts
onPost('/api/users').withHeader('content-type', contains('json'))
```

`.when(predicate)` accepts a raw `wire.Predicate` as an escape hatch when nothing else fits.

Every matcher takes modifiers, each returning a new (not mutated) `Matcher`:

```ts
contains('json').caseSensitive()
contains('json').keyCaseSensitive()   // for keyed fields (headers/query): match the key case-sensitively too
contains('\\s').except('\\s')          // strip a pattern from both sides before comparing
equals(v).jsonpath('$.a.b')            // select a JSON body subpath before matching
equals(v).xpath('//a', { ns: 'http://example.com' }) // select an XML body subpath
```

## Responses

```ts
import { ok, okJson, created, noContent, badRequest, notFound, status } from '@rift-vs/rift';

ok({ hello: 'world' })                 // 200, body as given
okJson({ id: 1 })                      // 200 + Content-Type: application/json
created({ id: 1 })                     // 201
noContent()                            // 204
badRequest({ error: 'bad' })           // 400
notFound({ error: 'missing' })         // 404
status(503)                            // any status code, optional body
```

Headers, binary bodies, and templating are chainable on any response builder:

```ts
ok().header('Set-Cookie', ['a', 'b'])  // a string[] value emits a multi-value header
ok().binaryBody(uint8ArrayOrBase64String) // base64-encodes a Uint8Array; a string is trusted as already-base64
ok(template).templated()               // marks the body for engine-side template rendering
```

**Flow-state writes** (engine ≥ 0.18.0) run after an `is` response, in order, without a script —
see [Scenarios §Writing flow state](scenarios.md#writing-flow-state-declaratively):

```ts
ok('{{ state.hits }}').templated().incrementState('hits')   // shows the count, then bumps it
ok().setState('user', '{{ request.query.u }}').deleteState('tmp').clearFlowState()
```

**Response cycling.** `.willReturn(r1, r2, ...)` sets the response cycle the engine advances
through on successive matching calls. `.respond(...)` is an alias. Repeated `.willReturn()` calls
on the same stub **append** to the same cycle rather than replacing it:

```ts
onPost('/api/users')
  .willReturn(created().latency(50))
  .willReturn(status(503))            // now cycles: created, then 503, then created, ...
```

## Behaviors

Behaviors chain on any response builder and compose:

```ts
ok().latency(500)                          // fixed delay, ms — a non-negative integer
ok().latency({ min: 100, max: 500 })       // random range (Rift extension) — 0 <= min <= max
ok().repeat(3)                              // repeat this response 3x before cycling on — a positive integer
ok().decorate('function(req,res){ ... }')
ok().shellTransform('cmd1', 'cmd2')        // one string per command; multiple = chained
ok().copy({ from: 'path', into: '${ID}', using: { method: 'regex', selector: '/users/(.+)' } })
ok().lookup({ key: { from: 'path', using: {...} }, fromDataSource: { csv: { path: 'x.csv', keyColumn: 'id' } }, into: '${ROW}' })
ok().behavior({ /* raw _behaviors escape hatch */ })
```

Where they run is a per-shape rule (engine ≥ 0.18.0; ≤ 0.17.0 ran them on `is` only): on an `is`
response, on the result of a `proxy` (before it is recorded) or an `inject` function, and on a
`fault(...)` or `script(...)` response only `repeat` — the rest is reported in `_rift.warnings`.
`decorate()`, `shellTransform()` and a function-string `latency()` are scripting surfaces: the
engine answers 400 `invalid injection` unless the spawn sets `allowInjection: true` (a remote
engine `--allow-injection`); imposters created over the embedded FFI are not gated.

Execution order in-engine (Rift ≥ 0.18.0, Mountebank's order): **wait → lookup → copy →
shellTransform → decorate**; Rift ≤ 0.17.0 ran wait → copy → lookup → decorate → shellTransform
(see [Migrating from Mountebank §Behavior changes in Rift 0.18.0](../mountebank/migration.md#behavior-changes-in-rift-0180)).
The builder always emits the object form, which the engine runs in that fixed order; a caller who
needs a different order sends the engine's `behaviors` array form alone —
`.raw({ behaviors: [{ decorate: 'function(req,res){...}' }, { shellTransform: 'cmd' }] })` on a response with no other behavior
calls, because the engine uses `_behaviors` and ignores the array when both are present.
`.latency()` never emits the
Mountebank `wait: { inject: ... }` random-delay form — the engine's `WaitBehavior` parser only
accepts a fixed number, a `{min,max}` range, or a JS function-source string; use the `{min,max}`
form for a random range. A fractional or negative delay, an inverted range, a negative or fractional
`repeat` and a `binaryBody` string that is not canonical base64 throw `InvalidDefinition` at the call
— the engine refuses them (or serves a binary-error marker) since 0.18.0, and older engines dropped
them silently. `repeat(0)` is refused too: the engine accepts it but silently serves it as `1`.

## Faults and proxying (brief)

```ts
import { fault, Fault } from '@rift-vs/rift';

fault(Fault.CONNECTION_RESET)                    // bare top-level fault response
ok(body).withFault(Fault.latency(500, { probability: 0.3 })) // probabilistic, composes onto an `is`
```

```ts
import { proxyTo } from '@rift-vs/rift';

proxyTo('http://upstream').proxyOnce()           // record once, replay thereafter
  .generatePredicates({ matches: { path: true, method: true } })
proxyTo('http://upstream').latency(500)          // engine >= 0.18.0 runs behaviors on the upstream's
                                                 // response before recording it; <= 0.17.0 ignored them
```

Both have a much larger surface (all four native TCP fault kinds, `proxyAlways`/
`proxyTransparent`, header injection, path rewriting, and how behaviors compose
onto a proxy response) — see [Migrating from Mountebank §Faults](../mountebank/migration.md#faults)
and [§Proxy](../mountebank/migration.md#proxy) for the complete mapping.

## Escape hatches

- **`fromJson(json)`** — parses and validates a raw Mountebank/Rift imposter JSON (single imposter
  or `{ imposters: [...] }`) verbatim: no key renaming, no field injection, no dropped unknown
  keys, and an explicit `port` is respected exactly. `engine.create(fromJson(json))` drops
  straight in — this is how a raw Mountebank imposter round-trips into the typed layer.
- **`.raw(patch)`** — every builder (`imposter()`, `stub()`, response builders) has a `.raw(patch)`
  that shallow-merges a plain object patch at the top level, applied last, for wire fields with no
  dedicated method yet.
- **`wire.*` types** — `import { wire } from '@rift-vs/rift'` gives the exact wire grammar
  (`wire.Imposter`, `wire.Stub`, `wire.Predicate`, `wire.StubResponse`, ...) for hand-building
  anything the DSL doesn't cover, or for typing a `fromJson` result.
