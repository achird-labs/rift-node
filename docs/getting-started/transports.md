---
layout: default
title: Transports
parent: Getting Started
nav_order: 1
permalink: /getting-started/transports/
---

# Transports

Every transport hands back the same `RiftEngine` — `engine.create()`, `.get()`, `.list()`,
`.intercept()`, the full DSL surface. They differ in how the engine is reached, what's required to
use them, and what they cost.

| | `rift.embedded()` | `rift.spawn()` | `rift.connect(url)` |
|---|---|---|---|
| What it does | Loads `librift_ffi` in-process via FFI (`koffi`) | Launches the `rift` engine binary as a child process | Attaches to an admin endpoint that's already running |
| Requires | `@rift-vs/rift-embedded` installed | A resolvable `rift` binary (PATH, cache, or download) | A reachable Rift server; `--api-key` if it enforces one |
| Ports | OS-assigned, no network hop | OS-assigned, loopback HTTP | Whatever the remote server is listening on |
| Platform support | Linux/macOS stable; Windows experimental | Linux/macOS/Windows stable | Linux/macOS/Windows stable |
| Best for | Unit/integration tests, zero-Docker CI | Tests/CI that want a real process boundary | CI service containers, a shared dev/staging instance |
| Disposal | `await using` closes the in-process engine | `await using` closes the client and kills the child process | `await using` closes the client only (server keeps running) |

## `rift.embedded()` — in-process, zero-config

No Docker, no child process, OS-assigned ports. Requires the companion embedded package:

```
npm i -D @rift-vs/rift-embedded
```

If it isn't installed, `rift.embedded()` throws `EngineUnavailable` with an install hint (the
package is a dynamic, optional import — `rift.connect()`/`rift.spawn()` never load it or `koffi`):

```
embedded transport requires the optional @rift-vs/rift-embedded package — install it (e.g. npm i -D @rift-vs/rift-embedded) to use rift.embedded()
```

```ts
import { rift, imposter, onGet, okJson } from '@rift-vs/rift';

await using engine = await rift.embedded();

const users = await engine.create(
  imposter('users').stub(onGet('/api/users/1').willReturn(okJson({ id: 1, name: 'Alice' }))));

await fetch(`${users.url}/api/users/1`);
```

Choose this when you want the least ceremony: no binary to resolve, no port bookkeeping, and
(Linux/macOS) the fastest startup of the three. Running it as a standalone mock server rather than
inside a test runner? Pass `{ keepAlive: true }` so the process doesn't exit while the engine is
open — see the [`rift-core` package README](https://github.com/achird-labs/rift-node/tree/master/packages/rift-core#readme)
for that variant.

## `rift.spawn()` — managed binary

Launches the `rift` engine binary as a child process and talks to it over loopback HTTP. Requires a
resolvable `rift` binary — see [Engine binary resolution](binary-resolution.md) for the full
lookup order (PATH → local cache → checksummed download, never when air-gapped). Run
`npx rift-fetch` ahead of time to warm the cache (e.g. in CI) or prepare an air-gapped install.

```ts
import { rift, imposter, onGet, okJson } from '@rift-vs/rift';

await using engine = await rift.spawn(); // resolves/downloads the rift binary on first use

const users = await engine.create(
  imposter('users').stub(onGet('/api/users/1').willReturn(okJson({ id: 1, name: 'Alice' }))));

await fetch(`${users.url}/api/users/1`);
```

Choose this when you want a real process boundary (matches how Rift/Mountebank actually run in
production) without managing that process yourself. The trade-off versus `embedded()` is
resolution/startup cost on first use (or a cold cache) and one more OS process to reason about.

## `rift.connect(url)` — attach to a running engine

For an engine already running elsewhere: a CI service container, a shared dev instance. Nothing is
spawned or loaded — `connect()` only builds an HTTP client against `url`. `apiKey` is sent as
`Authorization: Bearer <apiKey>` when the server enforces one (started with `--api-key`).

> **A blank `apiKey` is rejected.** Passing an empty or whitespace-only string throws
> `InvalidDefinition`; omit the option entirely to run without admin auth. This matters most for the
> `process.env.RIFT_API_KEY` pattern below: an *unset* variable is `undefined` and is fine, but a
> variable set to the empty string is not. Engine v0.17.0 and later refuse to start with a blank
> `--api-key` (rift#862); on earlier engines a blank key switched the auth gate on and then
> authenticated every request, so the SDK rejects it on both. A key that merely *contains* spaces is
> valid and is never trimmed.

```ts
import { rift, imposter, onGet, okJson } from '@rift-vs/rift';

await using engine = await rift.connect(url, { apiKey: process.env.RIFT_API_KEY });

const users = await engine.create(
  imposter('users').stub(onGet('/api/users/1').willReturn(okJson({ id: 1, name: 'Alice' }))));

await fetch(`${users.url}/api/users/1`);
```

Choose this when the engine's lifecycle is someone else's problem — a shared instance your tests
shouldn't be creating/tearing down themselves. Because the engine is shared, per-test imposter
isolation doesn't come for free here the way it does with `embedded()`/`spawn()`; see the
[`rift-core` package README](https://github.com/achird-labs/rift-node/tree/master/packages/rift-core#readme)'s
"Isolation" section (the spaces pattern) if multiple tests share one imposter.

`connect()` also compares the connected engine's reported version against this SDK's
`minEngineVersion` by default (`versionCheck: 'fail'`) — pass `'warn'` or `'off'` to relax that.

## Disposal: `await using`

Every example above opens the engine with `await using` — explicit resource management
(`Symbol.asyncDispose`), stable in Node ≥ 20. It calls `engine.close()` at the end of the
enclosing scope, no `try`/`finally` required: for `spawn()` this also kills the child process, for
`embedded()` it unloads the in-process engine, and for `connect()` it only closes the local client
— the remote server keeps running. Without `await using` you're responsible for calling
`engine.close()` yourself (e.g. in a `finally` block or test-framework teardown hook).
