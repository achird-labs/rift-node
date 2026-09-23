---
layout: default
title: Scenarios & state
parent: Guides
nav_order: 3
permalink: /guides/scenarios/
---

# Scenarios & state

A scenario is a small finite-state machine expressed as a chain of stubs: each state gates on a
request matcher, responds, and (optionally) transitions to the next state. Under the hood it's
still just stubs — `scenarioName`/`required_scenario_state`/`new_scenario_state` on the wire — the
`scenario()` builder just spares you writing that out by hand.

## Building a scenario

```ts
import { imposter, scenario, onPost, onGet, created, ok, status } from '@rift-vs/rift';

const checkout = scenario('checkout')
  .startingAt('empty')
  .when('empty', onPost('/cart')).respond(created()).goTo('has-items')
  .when('has-items', onPost('/checkout')).respond(ok('done')).goTo('done')
  .when('done', onGet('/receipt')).respond(status(200)); // terminal: no goTo

const users = await engine.create(imposter('checkout-flow').record().scenario(checkout));
```

- **`.startingAt(state)`** documents the FSM's initial state; `.build()` checks it against the
  first `.when()`'s state and throws if they disagree.
- **`.when(state, stub)`** snapshots (`build()`s) the passed stub's predicates immediately —
  mutating the builder you passed in afterward never rewrites the already-committed step.
- **`.respond(...)`** sets the response cycle for the currently open step; multiple responses
  cycle within that state, same as `.willReturn()` on a plain stub.
- **`.goTo(next)`** sets the transition; omitting it (as in the terminal `'done'` step above) gates
  the step without ever transitioning further.
- **`.build()`** flattens the whole chain to a `wire.Stub[]`. Calling `.respond()`/`.goTo()` with
  no open `.when()` throws rather than silently dropping the call.

## Attaching a scenario to an imposter

`imposter().scenario(builder)` appends `builder.build()`'s stubs onto the *same* ordered stub list
that `.stub()` pushes onto — at the time `.scenario()` is called, not at `imposter().build()` time.
Interleaved `.stub()`/`.scenario()` calls preserve call order rather than batching all scenario
stubs after all plain stubs:

```ts
imposter('mixed')
  .stub(onGet('/health').willReturn(ok()))   // stub #1
  .scenario(checkout)                         // scenario steps land next, in order
  .stub(onGet('/version').willReturn(ok('1.0'))); // then this
```

## Grouping without an FSM

A bare `scenarioName` tag with no state machine — just for grouping/filtering stubs — doesn't need
the `scenario()` builder at all:

```ts
onGet('/x').inScenario('smoke-tests')
```

Use `scenario()` only when you actually need `required_scenario_state`/`new_scenario_state`
transitions.

## Runtime scenario controls

Once an imposter is running, you can inspect and drive scenario state directly through the
handle — useful for setting up a test at a specific state without replaying every transition:

```ts
await users.scenarios();                             // [{ name: 'checkout', state: 'has-items' }, ...]
await users.setScenarioState('checkout', 'has-items'); // jump straight to a state
await users.resetScenarios();                          // back to each scenario's initial state
```

All three take an optional trailing `flowId` — `scenarios(flowId?)`, `setScenarioState(name,
state, flowId?)`, `resetScenarios(flowId?)` — to scope the call to one flow when the imposter uses
per-flow state (below). Equivalent Mountebank admin routes: `GET .../scenarios`, `PUT
.../scenarios/{name}`, `DELETE .../scenarios`.

## Flow state

By default, scenario state (and response cycling, and the recorded-request journal) is scoped to
the whole imposter. `flowState(...)` lets you scope it per logical flow instead — one test run,
one session, one tenant — sharing a single imposter across many independent callers:

```ts
imposter('users')
  .flowState({ backend: 'inmemory', ttlSeconds: 600, flowIdSource: 'header:X-Flow-Id' })
  // sugar for the flowIdSource line above:
  .flowIdFromHeader('X-Flow-Id')
```

`flowState(cfg)` shallow-merges into a single `_rift.flowState` block across repeated calls (later
calls add/override individual keys, earlier keys survive), so `flowState(...)` and
`flowIdFromHeader(...)` compose freely regardless of call order. `flowIdSource` is either
`'imposter_port'` — one flow for the whole imposter — or `` `header:${name}` `` — deriving the
flow id from a request header, so each caller that sends a distinct `X-Flow-Id` gets its own
scenario state, verification journal, and response-cycle position on the same running imposter.
`redis: { url, poolSize?, keyPrefix? }` moves the backend to Redis for state shared across
multiple Rift processes (see
[Migrating from Mountebank §Persistence](../mountebank/migration.md#persistence--distributed-state)
for when you'd reach for that over a sticky load balancer).

### Writing flow state declaratively

Reading flow state is declarative (`{{ state.<key> }}` under `.templated()`); since engine 0.18.0
writing it is too. `_rift.stateOps` on an `is` response runs after the response is rendered, in
order, against the request's flow — no `inject`, no script engine on the request path:

```ts
onGet('/hit').willReturn(ok('{{ state.hits }}').templated().incrementState('hits'))
onPost('/login').willReturn(ok().setState('user', '{{ request.body.name }}').deleteState('pending'))
onPost('/logout').willReturn(noContent().clearFlowState())
```

- `setState(key, value)` renders `value` as a template (`previousValue` is in scope) and stores a
  canonical integer (`'40'`) as a number, so a later `incrementState` continues from it.
- `incrementState(key, by?)` adds `by` (default 1, may be negative), creating the key at 0; a key
  holding a non-numeric string restarts at 0, which is why `setState` stores canonical integers as
  numbers.
- A body reading `{{ state.hits }}` in the same response sees the value *before* that response's
  ops — "show the count, then bump it".
- An imposter with state ops but no `flowState(...)` gets an in-memory store scoped to the imposter.
- The engine runs them only on `is` responses; `build()` refuses them on a proxy, inject, fault or
  script response, where the engine never runs them and says so only as an analysis warning.
- Engines ≤ 0.17.0 drop the whole block on parse, so `create()`/`replaceAll()` refuse to send it to
  one (`EngineVersionError`, the same fail-closed gate as client-certificate auth; `versionCheck:
  'off'` sends it anyway) — upgrade the engine, or write the state from `script()`.

See the [API reference §5.9](../reference/sdk-api.md#59-imposter-builder) for the exact
`flowState` config shape, and [§Scenarios](../mountebank/migration.md#scenarios) in the migration
guide for the Mountebank-JSON equivalents of each concept here.
