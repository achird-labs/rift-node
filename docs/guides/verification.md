---
layout: default
title: Verification
parent: Guides
nav_order: 2
permalink: /guides/verification/
---

# Verification

Mountebank has no first-class "did this happen N times" assertion — you fetch
`GET /imposters/{port}` and inspect `requests`/`numberOfRequests` yourself. The typed DSL turns
that into one call, `imposter.verify(match, count)`, on top of the recorded-request journal that
`imposter().record()` enables.

## `verify()` and count matchers

```ts
import { imposter, onGet, okJson, times, atLeast, atMost, between, never } from '@rift-vs/rift';

const users = await engine.create(
  imposter('users').record()
    .stub(onGet('/api/users/1').willReturn(okJson({ id: 1 }))));

await fetch(`${users.url}/api/users/1`);

await users.verify(onGet('/api/users/1'), times(1));   // exactly 1
await users.verify(onGet('/api/users/1'), atLeast(1));  // default when count is omitted
await users.verify(onGet('/api/other'), atMost(0));     // same as never()
await users.verify(onGet('/api/users/1'), between(1, 3));
await users.verify(onGet('/api/other'), never());       // times(0)
```

`match` accepts a `StubBuilder` (only its predicates are used — any `.willReturn(...)` on it is
ignored), a raw `wire.Predicate`, or a `wire.Predicate[]`. `count` defaults to `atLeast(1)`.
`verify()` throws `RiftError` up front, naming `.record()` as the fix, if the imposter wasn't
created with recording enabled — there's no journal to check against otherwise.

## `recorded()` and `clearRecorded()`

```ts
const all = await users.recorded();                       // RecordedRequest[]
const gets = await users.recorded({ match: onGet('/api/users/1') });
await users.clearRecorded();                               // DELETE savedRequests
```

Each `RecordedRequest` is the mapped, ergonomic shape (`method`, `path`, `query`, `headers`,
`body`, `from`, `timestamp`), plus `raw` — the untouched wire object — for anything not lifted
onto the typed fields. On engine ≥ 0.18.0 it also carries how the request was answered: `status`
and `latencyMs`. They are `undefined` when not recorded — a request still in flight when the
journal was read, one whose handling errored, or an older engine — and `latencyMs: 0` is a real
reading, so test for `undefined`, not falsiness. `node` names the answering node and is set only
by a clustered journal; against a single engine, including one the SDK spawns, it is always
`undefined`.

## Live iteration: `requests()`

```ts
const controller = new AbortController();
for await (const req of users.requests({ signal: controller.signal, match: onGet('/api/users/1') })) {
  console.log(req.method, req.path);
}
```

An `AsyncIterableIterator<RecordedRequest>` that polls the journal (default every 250ms) and
yields each newly-recorded request exactly once, in journal order. It completes cleanly (no
throw) when `opts.signal` aborts or the imposter is deleted mid-poll; like `verify()`, it throws
up front — before the first poll — if recording isn't enabled.

## Client-side predicate evaluation — what's supported

There is no server-side verify endpoint in the engine yet, so `verify()`/`recorded(filter)`
evaluate predicates **in the SDK**, against the recorded requests: `equals`, `deepEquals`,
`contains`, `startsWith`, `endsWith`, `matches`, `exists`, `and`, `or`, `not`, honoring
`caseSensitive` (default insensitive), `keyCaseSensitive`, `except`, plus a built-in `jsonpath`
subset (dot + bracket + numeric index, e.g. `$.a.b[0].c`; filters/wildcards are unsupported).

**`xpath` and `inject` predicates are not evaluable client-side.** Rather than silently treating
every request as a non-match (or, worse, a match), a `verify()`/`recorded()` call whose match
includes either operator throws `UnsupportedPredicateError`, naming the unsupported operator. If
you need to assert on XML bodies or a custom `inject` predicate, express the check some other way
(e.g. assert on the raw body string from `recorded()` yourself).

## Failure diagnostics: `VerificationError`

A `verify()` miss throws a `VerificationError` with a WireMock-style near-miss diff: which
recorded request came closest (the one satisfying the highest fraction of leaf predicate clauses;
ties go to the most recent), and which of its fields matched or didn't.

```
Verification failed for imposter "users" (port 55123)

Expected  GET /api/users/1        times(1)
Actual    0 of 3 recorded requests matched

Closest non-match — request #2 at 2026-07-09T10:12:03Z from 127.0.0.1:52114:
  method  GET                       ✓
  path    /api/users/2              ✗  expected equals "/api/users/1"
  header  accept: application/json  ✓
```

The error carries machine-readable fields too: `error.expected` (the predicates), `error.count`
(`{ matched, total, matcher }`), `error.recorded` (everything on the journal), and
`error.closest`. The testkit's `assertReceived` reuses this same renderer.

See [Migrating from Mountebank §Verification](../mountebank/migration.md#verification) for the
Mountebank-side comparison, and the [API reference §6](../reference/sdk-api.md#6-verification) for
the exact types.
