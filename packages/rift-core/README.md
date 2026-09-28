# rift-node

Official Node.js / TypeScript SDK for [Rift](https://github.com/achird-labs/rift) — a
high-performance, Mountebank-compatible HTTP/HTTPS mock server written in Rust. The SDK now ships
from this repo (`@rift-vs/rift`, same package name, version line ≥ 0.12.0) — see
[`docs/monorepo-migration.md`](https://achird-labs.github.io/rift-node/monorepo-migration/) if you're coming from
`rift/packages/rift-node`.

A typed, fluent DSL builds imposters/stubs/predicates/responses; three transports
(`rift.embedded()`, `rift.spawn()`, `rift.connect(url)`) hand back the same `RiftEngine` client;
the Mountebank-compatible `create()` stays available as a permanent drop-in. Full feature surface
on every transport: stubs/predicates/responses, response cycling, behaviors, proxy record/replay,
fault injection, stateful scenarios, spaces/flow-state, request verification, and TLS-MITM
intercept.

Already on Mountebank or the pre-monorepo `@rift-vs/rift`? See
[`docs/migration.md`](https://achird-labs.github.io/rift-node/mountebank/migration/) — `create()` compat is permanent, so adoption of the
typed DSL is incremental, not a forced rewrite.

## Quick start

<!-- docs:embed hero -->
```ts
import { rift, imposter, onGet, onPost, okJson, created, status, times } from '@rift-vs/rift';

await using engine = await rift.embedded(); // or rift.connect(url) / rift.spawn()

const users = await engine.create(
  imposter('users')
    .record()
    .stub(onGet('/api/users/1').willReturn(okJson({ id: 1, name: 'Alice' })))
    .stub(onPost('/api/users').willReturn(created().latency(50), status(503)))); // cycling

await fetch(`${users.url}/api/users/1`);

await users.verify(onGet('/api/users/1'), times(1)); // throws VerificationError with a diff
```

Every snippet on this page is generated from a compiled, self-tested source file under
[`examples/`](examples) — see "Docs that don't rot" below.

## Requirements

- **Node ≥ 20.** The SDK uses the global `fetch`, `worker_threads`, and `await using`
  (`Symbol.asyncDispose`).
- **ESM-only.** The package ships as ES modules with no CommonJS build. Import it with `import`
  (or dynamic `import()` from a CommonJS module); `require('@rift-vs/rift')` is not supported.
- **Zero runtime dependencies.** The embedded transport is the separate
  [`@rift-vs/rift-embedded`](../rift-embedded) package (which carries `koffi`); `undici`
  (in-process intercept) and `vitest` (Vitest testkit) are *optional* peers — each pulled in only
  if you use that feature.

| Transport | Support |
|---|---|
| `rift.spawn()` / `rift.connect()` — Linux, macOS, Windows | stable |
| `rift.embedded()` — Linux, macOS | stable |
| `rift.embedded()` — Windows | **experimental** (unvalidated; tracked by a non-blocking CI lane) |

## Per-transport quick starts

Each of these is a complete, compiling, self-skipping script — see the linked `examples/` file.

### `rift.embedded()` — in-process, zero-config

No Docker, no child process, OS-assigned ports. Requires the companion embedded package:
`npm i -D @rift-vs/rift-embedded` (it brings `koffi` with it). See
[`examples/quickstart-embedded.ts`](examples/quickstart-embedded.ts).

Running as a **standalone mock server** (a Mountebank-style long-lived process rather than inside
a test runner)? Pass `keepAlive: true` so the process stays alive while the engine is open:

```ts
const engine = await rift.embedded({ keepAlive: true });
await engine.create(fromJson(imposterJson)); // e.g. a Mountebank imposter file, verbatim
// main returns; the process keeps serving until killed (or engine.close()).
```

Without the flag an idle engine never blocks process exit — awaited calls always complete either
way (#70).

<!-- docs:embed quickstart-embedded -->
```ts
import { rift, imposter, onGet, okJson } from '@rift-vs/rift';

await using engine = await rift.embedded();

const users = await engine.create(
  imposter('users').stub(onGet('/api/users/1').willReturn(okJson({ id: 1, name: 'Alice' }))));

await fetch(`${users.url}/api/users/1`);
```

### `rift.spawn()` — managed binary

Launches the `rift` engine binary as a child process, resolving it via `RIFT_BINARY_PATH` → PATH →
local cache → checksummed download. Run `npx rift-fetch` ahead of time to warm the cache (e.g. in
CI) or prepare an air-gapped install. See [`examples/quickstart-spawn.ts`](examples/quickstart-spawn.ts).

<!-- docs:embed quickstart-spawn -->
```ts
import { rift, imposter, onGet, okJson } from '@rift-vs/rift';

await using engine = await rift.spawn(); // resolves/downloads the rift binary on first use

const users = await engine.create(
  imposter('users').stub(onGet('/api/users/1').willReturn(okJson({ id: 1, name: 'Alice' }))));

await fetch(`${users.url}/api/users/1`);
```

### `rift.connect(url)` — attach to a running engine

For an engine already running elsewhere (a CI service container, a shared dev instance). `apiKey`
is sent as `Authorization: Bearer <apiKey>` when the server enforces one (`--api-key`). See
[`examples/quickstart-connect.ts`](examples/quickstart-connect.ts).

<!-- docs:embed quickstart-connect -->
```ts
import { rift, imposter, onGet, okJson } from '@rift-vs/rift';

await using engine = await rift.connect(url, { apiKey: process.env.RIFT_API_KEY });

const users = await engine.create(
  imposter('users').stub(onGet('/api/users/1').willReturn(okJson({ id: 1, name: 'Alice' }))));

await fetch(`${users.url}/api/users/1`);
```

### Mountebank-compat `create()` — unchanged drop-in

Existing `@rift-vs/rift`/Mountebank code (raw `POST /imposters`, the `mb` CLI, ...) keeps working
verbatim. Permanent, not deprecated — see [`docs/migration.md`](https://achird-labs.github.io/rift-node/mountebank/migration/). See
[`examples/quickstart-compat.ts`](examples/quickstart-compat.ts). `create({ datadir })` gives
Mountebank `--datadir` persistence parity — imposters survive a restart; see
[migration §persistence](https://achird-labs.github.io/rift-node/mountebank/migration/#persistence--distributed-state).

<!-- docs:embed quickstart-compat -->
```ts
import { create } from '@rift-vs/rift';

const server = await create({ port: 2525 });

// existing Mountebank-style REST calls / mb client code works unchanged against server.port

await server.close();
```

## Feature tour

| Feature | What it does | Reference |
|---|---|---|
| Stubs & predicates | `onGet`/`onPost`/.../`stub()` + `req.*`/`equals`/`contains`/`matches`/... matchers, `and`/`or`/`not` | [migration §predicates](https://achird-labs.github.io/rift-node/mountebank/migration/#predicates) |
| Response cycling | `willReturn(a, b, c)` cycles responses across successive matching calls | [migration §responses](https://achird-labs.github.io/rift-node/mountebank/migration/#responses) |
| Behaviors | `.latency()`, `.repeat()`, `.decorate()`, `.copy()`, `.lookup()`, `.shellTransform()` | [migration §behaviors](https://achird-labs.github.io/rift-node/mountebank/migration/#behaviors) |
| Faults | `Fault.latency/error/tcp` (probabilistic, `.withFault()`) + native `fault()` responses | [migration §faults](https://achird-labs.github.io/rift-node/mountebank/migration/#faults) |
| Scenarios | `scenario().startingAt().when().respond().goTo()` stateful FSM stubs | [migration §scenarios](https://achird-labs.github.io/rift-node/mountebank/migration/#scenarios) |
| Spaces / flow state | Per-flow-id stub/verification scoping over one shared imposter | [Isolation](#isolation) below |
| Proxy record/replay | `proxyTo(url).proxyOnce()/.proxyAlways()`, `generatePredicates()`, `pathRewrite()` | [migration §proxy](https://achird-labs.github.io/rift-node/mountebank/migration/#proxy) |
| Intercept (TLS-MITM) | `engine.intercept()` — `serve`/`forward`/`redirectTo`, CA + trust helpers | [`docs/design/sdk-api.md` §7](https://achird-labs.github.io/rift-node/reference/sdk-api/#7-intercept-tls-mitm) |
| Engine warnings | `handle.warnings()` + the `stubWarnings: 'warn' \| 'fail' \| 'ignore'` option — inert config keys, shadowed and duplicate stubs, as the engine reports them | [`docs/design/sdk-api.md` §3.3](https://achird-labs.github.io/rift-node/reference/sdk-api/#33-imposterhandle) |
| Verification | `imposter.verify(match, times(n))` — WireMock-style near-miss diffs | [migration §verification](https://achird-labs.github.io/rift-node/mountebank/migration/#verification) |
| Testkit | `@rift-vs/rift/testkit/vitest` fixtures, `@rift-vs/rift/testkit/jest` helpers | [Testkit](#testkit) below |

## Native resolution: engine binary + cdylib

The spawn transport resolves the `rift` engine binary, and the embedded transport resolves the
`librift_ffi` cdylib, the same way: an explicit override, then a local sidecar-verified cache, then
an on-demand, checksummed download — never a network call when air-gapped. Run `npx rift-fetch`
(or `rift-fetch --bin` / `rift-fetch --lib`) to resolve either or both ahead of time, e.g. to warm a
CI cache or prepare an air-gapped install (`--classifier <c>` cross-fetches a cdylib for a platform
other than the host's). The cdylib's checksum check has no opt-out — a corrupt library is loaded
in-process (`dlopen`), unlike a corrupt binary, which merely fails to exec.

| Variable | Applies to | Purpose |
|---|---|---|
| `RIFT_BINARY_PATH` | engine binary | explicit binary path override; skips PATH/cache/download |
| `RIFT_FFI_LIB` | cdylib | explicit cdylib path override; skips cache/download, **no checksum** (you own the file) |
| `RIFT_CACHE_DIR` | cdylib | overrides the cache root (defaults to `XDG_CACHE_HOME`, then `%LOCALAPPDATA%` on Windows, else `~/.cache`) |
| `RIFT_DOWNLOAD_URL` | both | alternate release mirror base (also the FFI manifest base for the cdylib) |
| `RIFT_MIRROR_URL` | engine binary | alternate release mirror base (binary only; `RIFT_DOWNLOAD_URL` wins if both are set) |
| `RIFT_OFFLINE` / `RIFT_SKIP_BINARY_DOWNLOAD` | both | air-gapped mode: never reach the network; resolution throws with manual-install instructions (file name, release URL, and the exact cache path to place it at) if nothing local is found |
| `RIFT_SKIP_CHECKSUM` | engine binary only | opt out of a missing (not mismatched) checksum sidecar — **not available for the cdylib** |

## Isolation

By default, both the Vitest fixtures (`riftTest`) and the Jest helpers (`setupRift`) give each test
its own imposters: one engine is shared per worker (acquired once, closed when the worker tears
down), but every imposter a test `.create()`s is deleted automatically once that test ends — a
`.get()`-attached handle is left alone, since attaching to an already-existing imposter isn't
ownership. That's enough isolation for most suites without ever sharing state across tests.

For a shared, already-running engine (`rift.connect(url)`, e.g. one Rift instance shared by an
entire CI job) imposters generally can't be created/deleted per test without breaking other tests
still running against them. Use the **spaces** pattern instead: build the shared imposter with
`.flowIdFromHeader(...)` so Rift derives a per-request flow id from a header, then scope stub setup
and verification to a fresh id per test via `.space(flowId)` — no imposter create/delete, and no
cross-test bleed even though every test talks to the same imposter. See
[`examples/spaces.ts`](examples/spaces.ts).

<!-- docs:embed spaces -->
```ts
import { randomUUID } from 'crypto';

const users = await engine.get(sharedUsersPort); // a shared imposter, not created by this test
const flowId = randomUUID();
const space = users.space(flowId);

await space.addStub(onGet('/api/users/1').willReturn(okJson({ id: 1 })));
await fetch(`${users.url}/api/users/1`, { headers: { 'X-Flow-Id': flowId } });
await space.verify(onGet('/api/users/1'), times(1));
await space.delete(); // cleans up this test's slice only — the shared imposter itself lives on
```

(The imposter itself only needs `.flowIdFromHeader('X-Flow-Id')` and `.record()` set once,
wherever it's created.)

## Testkit

`@rift-vs/rift/testkit/vitest` gives you a worker-scoped `riftTest` fixture; every imposter a test
creates is deleted automatically when the test ends. See
[`examples/testkit-vitest.ts`](examples/testkit-vitest.ts) (compiles against the ambient `vitest`
shim; `vitest` itself is an optional peer dependency).

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

`@rift-vs/rift/testkit/jest` gives the same auto-teardown via `setupRift()` registering
`beforeAll`/`afterEach`/`afterAll` — no custom Jest environment (ESM-hostile). Both re-export
`assertReceived(imposter, match, count?)`, a thin delegate to `imposter.verify(...)` sharing the
same renderer.

## Docs that don't rot

Every fenced `ts` code block above that's preceded by `<!-- docs:embed <anchor> -->` is generated
FROM a compiled, checked source file in [`examples/`](examples), never hand-copied:
`scripts/check-docs-embeds.mjs` extracts the marked region of the matching `examples/<anchor>.ts`
(the code between its `// docs:embed <anchor>` and `// docs:embed-end <anchor>` comments, or to end
of file if there's no closer), normalizes both sides (drop import lines, trim trailing whitespace,
trim blank edges, dedent), and fails — naming the anchor and both files — on any mismatch. Every
example also `tsc`-compiles against the real, current API (`tsconfig.examples.json`) and, where it
needs a live engine, self-skips at runtime with a `console.log` rather than failing when no
binary/koffi/admin URL is available (same convention this repo's own integration tests use).

```
npm run typecheck:examples   # examples/*.ts compiles against the real exported API
npm run docs:check           # README.md / docs/*.md embeds match examples/*.ts, byte for byte
```

Both run in CI (see `.github/workflows/ci.yml`'s `docs` job) — a snippet that drifts from its
example, or an example that stops compiling, fails the build.

## Design

- [`docs/design/sdk-api.md`](https://achird-labs.github.io/rift-node/reference/sdk-api/) — the canonical API design reference (full
  grammar, transport internals, issue map)
- [`docs/migration.md`](https://achird-labs.github.io/rift-node/mountebank/migration/) — Mountebank → typed-DSL, side by side
- [`docs/monorepo-migration.md`](https://achird-labs.github.io/rift-node/monorepo-migration/) — moving from `rift/packages/rift-node`
- RFC-003 — Rift Language SDKs, §12 Node/TS amendment (design vault)
- Sibling SDKs: [rift-java](https://github.com/achird-labs/rift-java) ·
  [rift-scala](https://github.com/achird-labs/rift-scala) ·
  [rift-go](https://github.com/achird-labs/rift-go)

## License

MIT
