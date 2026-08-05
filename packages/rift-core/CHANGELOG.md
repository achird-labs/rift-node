# Changelog

All notable changes to `@rift-vs/rift` are documented here. This project adheres to
[Semantic Versioning](https://semver.org/).

## Unreleased

### Fixed

- **Every outbound admin payload is now JSON-safe, on both transports** (issue #112). The wire
  serializer documented a guarantee — a non-finite number is refused rather than silently emitted as
  `null`, a `bigint`/function/symbol raises a typed `WireValidationError` rather than a raw
  `TypeError` or a silent drop — and enforced it only in `toWireString()`/`toWireJson()`, which no
  production path called. Every real admin call went through a bare `JSON.stringify`, so
  `engine.create({ ..., body: { temperature: NaN } })` put `null` on the wire: the SUT received a
  value the caller never wrote, with nothing SDK-side to correlate against.

  Serialization now funnels through one `stringifyJsonSafe()`, applied at the transport boundary
  rather than per-method: `RemoteClient` serializes **every** outbound body through it (a route
  allow-list is something a new method silently falls off, and flow-state values are caller data
  too), and the embedded transport routes all eight of its FFI payloads through the same helper.
  `intercept()`'s own options are guarded as well — a non-finite `port` previously reached the
  embedded FFI as `null` and left the remote/spawn backend reporting a handle at `http://host:null`.
  A valid payload serializes byte-identically to before.

  Refusals surface as `WireValidationError`, whose `path` names the offending key. This differs from
  the intercept rule path (issue #111), which wraps the same failure as `InvalidDefinition` — issue
  #101 fixed that surface to a single error type and it stays that way.

- **`intercept.addRule()` now refuses values JSON cannot represent** (issue #111). Intercept rules
  were serialized with a bare `JSON.stringify`, so a non-finite number anywhere in a rule — a
  `predicates` value on the ergonomic `serve()`/`forward()` path, or a hand-built
  `action.serve.statusCode` on the `addRule()` escape hatch — reached the engine as `null`. The rule
  then matched, or answered, something the caller never wrote, with nothing on the SDK side to
  correlate against. A `bigint` threw a raw unwrapped `TypeError`, and a function or symbol was
  dropped silently.

  Serialization now runs through the wire model's `jsonSafeReplacer`, the same guard issue #106
  applied to `serve()` response bodies, and the refusal is re-wrapped as `InvalidDefinition` with the
  underlying `WireValidationError` as its `cause` — `serve()`, `forward()` and `redirectTo()` all
  funnel through `addRule()`, and issue #101 established that everything the intercept path refuses
  surfaces as that one type. A valid rule serializes byte-identically to before.

  This could not be fixed at the transport instead: `RemoteClient.interceptAddRules()` re-parses the
  serialized rule, by which point a `NaN` has already become an honest `null`. `addRule()` remains
  the verbatim escape hatch in every other respect — it still applies no `ServeStub` normalization
  and does **not** range-check a finite `statusCode`.

- **compat `create()` now validates the `MB_APIKEY` it hands the child** (issue #108). `create()`
  spawns the engine with no `env` of its own, so the child inherits `process.env` wholesale — which
  makes an ambient `MB_APIKEY` engine configuration whether or not the caller thought of it that way
  (the engine declares `--api-key` with `env = "MB_APIKEY"`). Nothing validated it on this path: a
  **blank** value switched the auth gate on and then matched every unauthenticated request on engines
  ≤ 0.16.x — a silently open admin plane — and on ≥ 0.17.0 it failed late as an opaque
  `Rift process exited with code N`, after binary resolution that may include a download.

  The ambient value is now checked at entry, before a binary is resolved, and a blank one throws
  `InvalidDefinition` naming `MB_APIKEY environment variable` — the same blank-value guard and remedy
  `rift.spawn()` has used since issue #103. An unset or genuinely non-blank `MB_APIKEY` is untouched
  and still inherited by the child, so legitimate configuration keeps working. `create()` does not
  mirror `spawn()`'s post-resolution re-check, which exists so the engine and the SDK-built admin
  client cannot end up on different keys; `create()` builds no admin client, so it has no such pair
  to keep in step.

  `create()` deliberately gains **no** `apiKey` option: Mountebank's `mb.create()` has none and this
  surface is a drop-in compat contract, so validating the ambient value is the whole fix. Callers who
  want to pass a key explicitly should use `rift.spawn()`.

- **`intercept.serve()` now refuses the headers the engine silently drops** (issue #107). The engine's
  proxy skips four connection-management headers — `Host`, `Connection`, `Content-Length` and
  `Transfer-Encoding`, matched case-insensitively — and skips any header whose **name or value**
  contains CR or LF. The four are dropped with no trace at all; only the CR/LF case logs a warning,
  and it logs it in the engine process where an SDK caller never sees it. Either way `serve()`
  accepted the header, serialized it into the rule and returned success, so it simply never reached
  the SUT with nothing on the SDK side to correlate against. Both now throw `InvalidDefinition`
  naming the header — so a call that used to pass while quietly losing a header now fails loudly.

  The guard mirrors the engine's own list rather than RFC 7230's: `Keep-Alive`, `TE` and `Upgrade` are
  hop-by-hop by the spec but the engine passes them through, so `serve()` still sends them — refusing
  them would have blocked headers the SUT would really have received. The errors do not offer
  `forward()` as an alternative, because the engine applies the same four-name filter on the
  forward-request and response-relay legs too; and a CR/LF-bearing header is unsendable in valid HTTP
  regardless of path.

  Also fixed here: a header literally named `__proto__` used to vanish inside the SDK itself, because
  assigning it to a plain object hits the prototype setter instead of creating an own property. It is
  now carried through (reachable whenever the caller's headers came from `JSON.parse`).

  With those, `serve()` itself has no silent-drop case left. The verbatim `addRule()` escape hatch
  still bypasses all of this validation by design — a hand-built rule can carry a header the engine
  will drop, exactly as before.

- **A non-finite number in a serialized body now throws instead of becoming `null`** (issue #106).
  `toWireString()`/`toWireJson()` documented that a non-serializable value is never silently
  dropped, but `jsonSafeReplacer` only inspected `function`/`bigint`/`symbol` — so `NaN`,
  `Infinity` and `-Infinity` slipped through to `JSON.stringify`, which renders each of them as
  `null`. The key still arrived at the SUT, holding a value you never wrote, and the failure
  surfaced in the SUT's decoder with nothing on the mock side to correlate it against.

  Both serialization paths now refuse it: the replacer throws `WireValidationError` naming the
  offending key and which value it was (`NaN` vs `Infinity` vs `-Infinity`), and
  `intercept.serve()`'s body — which called bare `JSON.stringify` and inherited the same gap —
  serializes through that same replacer, surfacing as `InvalidDefinition` to keep `serve()`'s
  error contract uniform. Finite numbers are unaffected, and the check costs nothing: the
  replacer already visits every value in the single stringify pass.

  Side effect of sharing the replacer: a function or symbol inside a `serve()` body now throws
  too, rather than being dropped or nulled by `JSON.stringify`. The body is typed `JsonValue`, so
  those were already out of contract.

  Scope: this covers the wire-model serializer and `serve()`'s body. A non-finite number reached
  through a different door is still nulled silently — inside an intercept **predicate**, inside a
  rule handed to the verbatim `addRule()` escape hatch, or anywhere in an imposter sent via the
  remote/spawn admin client, none of which serialize through this replacer. Those are separate
  pre-existing gaps, tracked on their own.

- **`intercept.serve()` now conforms to the engine's serve-stub wire contract** (issue #101).
  `serve()` used to embed a Mountebank-shaped response verbatim, so the everyday
  `serve(host, okJson({ ok: true }))` posted an **object** `body` where the engine's `ServeStub`
  declares `Option<String>`. The engine parses rules through an untagged enum, so this came back as
  `Invalid intercept rule JSON: data did not match any variant of untagged enum RuleOrRules` —
  a message that names neither the field nor the reason.

  The response is now normalized before it goes on the wire: a non-string `body` becomes compact
  JSON, a numeric-string `statusCode` is coerced to a number, and `_mode: 'text'` plus unknown keys
  are dropped. A string `body` is still sent verbatim and is never double-encoded. Body key order
  follows your object, whereas the imposter path re-serializes through Rust and emits sorted keys —
  the two are equivalent JSON but not identical bytes, which matters only to a SUT that hashes or
  byte-asserts the body.

  What the engine cannot represent is now refused with `InvalidDefinition` naming the field, rather
  than silently mangled: a **multi-value header** (joining would corrupt `Set-Cookie`), a **binary
  or unrecognized `_mode`** (the base64 would have been served as literal text), and a `statusCode`
  outside **100..999**. That bound is what the engine can render as a status line rather than the
  `u16` the field can hold: it writes the line with `format!` and an empty reason phrase for codes
  hyper rejects, so admitting the full `u16` *would* let `''`, `null` or `true` through as `0` and
  emit a literal `HTTP/1.1 0` that the SUT's own HTTP client cannot parse — trading this issue's
  opaque serde error for an equally opaque one downstream. Parsing is strict for the same reason:
  only a number or an all-digits string is accepted, where `Number()` would have read `'0x1F4'` as
  500 and `'1e3'` as 1000. Use `forward()` to an imposter when you need any of the refused cases, or
  `addRule()` to send a rule verbatim.

  (Those last two silent-drop cases are now refused as well — see the issue #107 entry above.)

  `InterceptRule['action']` is typed `{ serve: ServeStub }` (newly exported) instead of
  `{ serve: IsResponse }`, so the raw `addRule()` path catches the same mismatch at compile time.
  This is a type-level narrowing: code it now rejects was already failing at runtime.

  This affects the spawn and remote transports; CI never caught it because the spawn-lane integration
  specs self-skip without an engine binary. The new coverage is in the unit lane, which always runs.
  Widening the engine side for raw REST callers is tracked as achird-labs/rift#933 and is not needed
  for this fix.

### Security

- **A blank admin `apiKey` is now rejected** (issue #96). `rift.spawn({ apiKey })`,
  `rift.connect(url, { apiKey })`, and `new RemoteClient(...)` throw `InvalidDefinition` when
  `apiKey` is an empty or whitespace-only string; `spawn()` throws before it resolves or downloads
  a binary. Omit `apiKey` entirely to run without admin auth — that behaviour is unchanged, as is a
  key that merely *contains* spaces (it is compared byte for byte and never trimmed).

  This tracks engine rift#862, shipped in **rift v0.17.0**: a blank `--api-key` used to switch the
  admin auth gate *on* and then match every unauthenticated request, leaving the plane open while
  reporting as protected. Engines from v0.17.0 refuse to start; earlier engines still exhibit the
  bug, so guarding the `apiKey` **option** gives the same fail-closed answer on every engine version
  and names the offending option instead of surfacing an opaque child-process exit code. The most
  common way to hit this is an unset environment variable (`apiKey: process.env.KEY ?? ''`).

  The embedded transport is unaffected — its admin plane has always used a generated UUID key.

- **`rift.spawn()` now mirrors the engine's `MB_APIKEY` contract** (issue #103). The engine takes
  its admin key from `--api-key` **or** the `MB_APIKEY` environment variable, and the spawned child
  inherits this process's environment — so that variable was already engine configuration while the
  SDK behaved as though it did not exist. `spawn()` now resolves one effective key,
  `apiKey ?? process.env.MB_APIKEY`, with the same precedence clap applies (an explicit option
  always wins, so nothing changes for callers who pass one).

  That closes two holes. A **blank** inherited `MB_APIKEY` now throws `InvalidDefinition` naming
  `MB_APIKEY`, before a binary is resolved — previously it opened the auth gate on engines
  <= 0.16.x (rift#862) and produced an opaque child-process exit on v0.17.0+. A **non-blank** one is
  now used for the admin client's `Authorization` header: previously the engine enabled auth while
  the SDK's client was built without a credential, so `spawn()` appeared to succeed —
  `waitForAdmin` accepts any response, including a 401 — and then **every** admin call failed, on
  every engine version.

  A key inherited from `MB_APIKEY` is deliberately **not** echoed onto the child's command line; the
  child already inherits the variable, and `--api-key` would copy the secret into a materially more
  exposed channel (`/proc/<pid>/cmdline` is world-readable; argv is captured by `ps`, auditd and
  container runtimes) without removing it from the original. An explicitly-passed `apiKey` is still
  sent as `--api-key`, exactly as before.

  If `MB_APIKEY` is mutated *while* the engine binary is being resolved (a window a cold-cache
  download can hold open for seconds), `spawn()` now fails closed with `InvalidDefinition` instead of
  launching. Deleting it mid-flight was the worst case: the engine would have come up keyless with an
  open admin plane while the client kept sending the stale credential it ignores, so every call would
  have succeeded and the operator would have believed a key was in force.

  The blank-key error now names the door the key came through (`apiKey option` vs
  `MB_APIKEY environment variable`) instead of always saying `apiKey`.

  Scope: this covered the `rift.spawn()` transport only; the Mountebank-compat `create()` entry point
  was left unguarded and is closed by the issue #108 entry above.

## 0.15.0 — 2026-07-21

First release of `@rift-vs/rift` from the `achird-labs/rift-node` repository. Everything below had
accumulated as unreleased work in this repo; this entry is where it reaches npm.

> **Upgrading from 0.14.0 (published from the old `EtaCassiopeia/rift` repo).** That line is a
> different codebase; this one supersedes it. Both are ESM with the same entry points, so imports
> are unchanged, but note:
>
> - **Node ≥ 20** is now required (was ≥ 18).
> - **Zero runtime dependencies** — `axios` is gone.
> - **No `postinstall` download.** The engine binary is resolved *on demand* at first use
>   (`RIFT_BINARY_PATH` → PATH → version cache → download), never at install time, and never at all
>   when `RIFT_OFFLINE` / `RIFT_SKIP_BINARY_DOWNLOAD` is set.
> - The `./testkit/vitest`, `./testkit/jest`, and `./intercept-undici` subpaths are declared in the
>   exports map but remain placeholder modules until those features land.

### Documentation

- **The two Mountebank→Rift drop-in gaps** (issue #85): `docs/migration.md` now covers both gaps a
  real container drop-in hits. **Numeric and boolean header values** (`"Content-Length": 124`) are
  rejected with a 400 by engines ≤ v0.14.0 and fixed in v0.15.0 — documented as a *version-scoped*
  compat note rather than a temporary workaround, because binary resolution can still land on an
  older engine (a PATH install, `binaryPath`/`RIFT_BINARY_PATH`, or a pinned `version:` — none
  version-checked), and because the SDK does not stringify header values, so the same 400 reaches
  users through `create()`, the typed DSL, and raw admin-port POSTs alike. **Multi-instance
  deployments** gain the sanctioned replacement for a Redis-synced Mountebank fleet: independent
  nodes behind a sticky/affinity LB keyed on the flow id
  (`flowState({ flowIdSource: 'header:…' })`), alongside the existing `datadir` and per-imposter
  flow-state guidance. The imposter-CRUD-sync non-goal is now stated without implying engine-side
  config-sync is a committed roadmap item.

### Changed

- **`create()` fails loud on `impostersRepository` / `redis`** (issue #76): these options were
  previously *accepted-and-ignored*, so a Mountebank consumer that backed its imposter store with a
  custom repository would silently get an in-memory, single-process server — a wrong-but-quiet
  result surfacing only downstream. `create()` now throws the new `UnsupportedCreateOptionError`
  (exported) before spawning, naming the option and the supported alternatives (`datadir` for
  persistence, per-imposter `flowState()` for distributed scenario state). **Breaking** for any code
  that relied on these options being ignored; the fix is to remove them (Rift's engine cannot load
  an in-process Node repository module — see `docs/migration.md`).

### Added

- **`datadir` on the compat `create()`** (issue #77): `create({ datadir })` maps to the engine's
  `--datadir`, matching Mountebank's `mb.create({ datadir })` / `mb --datadir` — imposters created
  or mutated through the admin API are persisted as `{port}.json` and reloaded when a server starts
  against the same directory, so imposter state survives a restart (the compat path reaches parity
  with `rift.spawn({ datadir })`). New `docs/migration.md` **"Persistence & distributed state"**
  section documents the migration path for a custom Mountebank `impostersRepository` deployment:
  `datadir` for restart persistence, per-imposter `_rift.flowState` redis for distributed scenario
  state, and the explicit non-goal of multi-instance imposter-CRUD sync.

- **Docs that don't rot** (issue #14): the README is restructured around a hero quick-start +
  per-transport quick starts (`rift.embedded()`/`rift.spawn()`/`rift.connect()`/Mountebank-compat
  `create()`), a feature-tour table, and the real (grepped, not guessed) env var reference. New
  `docs/migration.md` is a complete Mountebank-JSON-to-typed-DSL side-by-side (every predicate
  operator, behavior, fault, proxy option, script kind, and scenario concept), plus escape hatches
  (`fromJson`, `.raw()`, `wire.*`) and what Rift intentionally doesn't support. New
  `docs/monorepo-migration.md` documents the package's move to this repo. The anti-rot mechanism:
  every fenced snippet tagged `<!-- docs:embed <anchor> -->` in README.md/docs/*.md is generated
  FROM a compiled `examples/*.ts` file (never hand-copied) — `scripts/check-docs-embeds.mjs`
  (`npm run docs:check`) extracts each marked region, normalizes both sides, and fails naming the
  anchor on any mismatch; `tsconfig.examples.json` (`npm run typecheck:examples`) keeps every
  example compiling against the real, current exported API. Both run in a new CI `docs` job.

- **Test-framework glue** (`@rift-vs/rift/testkit/vitest`, `@rift-vs/rift/testkit/jest`): a per-worker
  engine + per-test imposter auto-teardown. Vitest gets `riftTest`/`createRiftTest` fixtures; Jest gets
  `setupRift` (beforeAll/afterEach/afterAll helpers). Both re-export `assertReceived(imposter, match,
  count?)`, a thin assert-style delegate to `imposter.verify(...)` sharing the same `VerificationError`
  renderer. The engine is chosen automatically (embedded when `koffi` is available, else spawn) or via
  `transport`. `vitest` is an optional peer, imported only inside the vitest subpath. The README
  documents the spaces-isolation pattern for a shared `connect` engine.

- **TLS-MITM intercept surface** (`@rift-vs/rift`, issue #11): `engine.intercept(options?)` returns
  an `InterceptHandle` — `serve(match, response)`/`forward(match, to)`/`redirectTo(imposter)` build
  `wire.InterceptRule`s (host shorthand or AND-ed predicates), plus `addRule`/`rules`/`clearRules`,
  `caPem`/`caFile`/`exportTruststore`, and `env()` (`HTTPS_PROXY`/`HTTP_PROXY`/`NODE_EXTRA_CA_CERTS`)
  for pointing a SUT's proxy at Rift. Implemented once over an `InterceptBackend` seam (embedded
  adapts the issue #8 FFI calls; remote/spawn adapt new `RemoteClient` HTTP routes:
  `POST/GET/DELETE /intercept/rules`, `GET /intercept/ca.pem`, `GET /intercept/truststore.{p12,jks}`),
  so the whole handle is unit-testable against a fake backend with no cdylib/koffi/live engine.
  Per-transport availability is typed and documented: embedded starts via `rift_start_intercept`
  (idempotent handle reuse; a second call with options throws `InterceptUnavailable`); spawn requires
  `rift.spawn({ intercept: true | InterceptOptions })` (`--intercept-port` + optional
  `--intercept-ca-cert`/`--intercept-ca-key`), else `InterceptUnavailable` names the fix; remote
  attaches by probing `GET /intercept/rules`, surfacing a 404 as `InterceptUnavailable` naming
  `--intercept-port`. The optional `@rift-vs/rift/intercept-undici` subpath exports
  `interceptDispatcher(handle)`, dynamically importing the optional peer `undici` to build a
  `ProxyAgent` wired with the intercept CA — core stays undici-free.

- **`rift.embedded()` in-process transport** (`@rift-vs/rift`): returns the same `RiftEngine` as
  `connect`/`spawn`, backed by the embedded worker binding — no Docker, engine-assigned ports.
  Resolves the cdylib, runs a version + feature preflight (`versionCheck: 'fail'|'warn'|'off'`,
  `requireFeatures`), and drives an FFI-first `AdminApi`: imposters/stubs/recorded/flow-state/spaces
  go straight over FFI (so `inject`/scripted stubs work with no `allowInjection` flag), while the few
  operations lacking an FFI symbol (scenarios, enable/disable, saved-request/proxy-response deletion,
  logs) lazily start a loopback admin plane (started at most once, key-guarded). Multiple embedded
  engines per process are independent. The embedded module is dynamically imported, so core stays
  zero-dep for `connect`/`spawn` users.

- **Embedded transport FFI binding + worker** (`@rift-vs/rift/embedded`, issue #8): a koffi-backed
  `NativeEngine` facade over `librift_ffi` (C-ABI v2, all 26 symbols), split into a pure,
  koffi-free `handleCall` discipline (last-error read + decode + free, unit-tested against a fake
  `NativeBinding`) and a thin `worker_threads` wrapper that runs it. `koffi` is an
  `optionalDependency`, dynamically imported only when the embedded transport is actually loaded —
  its (or a cdylib's) absence surfaces as a rejected `NativeEngine.load()`, never at `import`. An
  ambient `koffi.d.ts` shim keeps `tsc --noEmit` green without koffi installed. Subpath-only
  (`@rift-vs/rift/embedded`); wiring it into `rift.embedded()` is issue #10.
- **cdylib (native library) resolution** (`@rift-vs/rift`, issue #9): `resolveCdylib`/`platformClassifier`
  (from `src/natives`, exported at the package root) resolve `librift_ffi` for the future
  `@rift-vs/rift-embedded` transport — explicit override (`RIFT_FFI_LIB`) → sidecar-verified local
  cache → manifest-driven, mandatorily-checksummed download (no skip flag, unlike the engine
  binary's `RIFT_SKIP_CHECKSUM`), guarded by a concurrent-download lock. Six platform classifiers
  (linux x86_64 glibc/musl, linux aarch64, darwin x86_64/aarch64, windows x86_64); linux
  aarch64+musl has no published artifact and fails with a clear gap error. `rift-fetch` gains
  `--bin`/`--lib`/`--version`/`--classifier` flags to prefetch either artifact (or cross-fetch a
  foreign classifier for CI cache warming / air-gapped installs).
- **Recorded-request async iteration** (`@rift-vs/rift`): `handle.requests({ pollIntervalMs, signal, match })`
  returns an `AsyncIterableIterator<RecordedRequest>` that polls the journal (default 250ms) and yields
  each newly-recorded request exactly once, de-duplicated via a raw-list cursor that resets on a
  cleared journal. Completes cleanly on `signal` abort or imposter deletion; requires `.record()` like
  `verify()`/`recorded()`. Push-based delivery over SSE is future work (rift#461).
- **Verification API** (`@rift-vs/rift`): `imposter.verify(match, times(n))` with WireMock-style
  near-miss diffs. Typed `RecordedRequest`, `handle.recorded(filter)` / `clearRecorded()`, and count
  matchers `times`/`atLeast`/`atMost`/`between`/`never` (exported from the package root). A zero-dep
  client-side predicate evaluator mirrors the engine's matcher semantics (all operators + params, a
  jsonpath subset); unsupported operators (`xpath`/`inject`/jsonpath wildcards) and operator-less
  predicates throw `UnsupportedPredicateError` rather than matching silently. `renderVerificationFailure`
  is a standalone renderer the testkits reuse. `SpaceHandle.recorded()/verify()` scope by flow id.
- **DSL response completion** (`@rift-vs/rift`): the response side of the fluent DSL now reaches
  every engine feature. New on `ResponseBuilder`: `badRequest()`, multi-value `header(name, string[])`,
  `binaryBody()` (base64 + `_mode: 'binary'`), `templated()`, full `_behaviors`
  (`latency(number | {min,max} | fn-string)`, `decorate()`, `shellTransform()`, `copy()`, `lookup()`,
  `behavior()` escape hatch), and `raw()` for last-wins patches. New `Fault` helper for typed chaos
  faults (`Fault.latency/error/tcp`, merged via `withFault()`); new `Script` builder
  (`Script.rhai/js/rhaiFile/jsFile/ref`) wrapped by `script()`; and a full `proxyTo()` `ProxyBuilder`
  (`proxyOnce/Always/Transparent`, `generatePredicates`, `addWaitBehavior`, `addDecorateBehavior`,
  `injectHeader`, `rewritePath`, `clientCert`).
- `willReturn(...)` now **appends** across calls (response cycling), matching the sibling SDKs;
  `respond(...)` stays an alias.
- **DSL imposter/stub/scenario completion** (`@rift-vs/rift`): `ImposterBuilder` now reaches every
  engine field — `https({cert,key,mutualAuth})` (HTTPS/mTLS), `strictBehaviors()`,
  `defaultForward()`, `serviceName()`/`serviceInfo()`, and the imposter-level `_rift` config
  (`flowState()`/`flowIdFromHeader()`, `metrics()`, `scriptEngine()`, `registerScript()` — merging
  across calls). `scenario(builder)` appends its FSM stubs in call order (interleaves with `stub()`).
  `StubBuilder` gains `id()`, `inSpace()`, and `routePattern()`. Scenario `respond(...)` is now
  variadic (response cycling within a state).

### Changed

- **Native-library cache directory on Windows** now defaults to `%LOCALAPPDATA%/rift-node` (was
  `~/.cache/rift-node`, which is not meaningful on Windows). `RIFT_CACHE_DIR` and `XDG_CACHE_HOME`
  still override on every platform; non-Windows behavior is unchanged. The conformance corpus now
  runs over the embedded transport as well (binary-gated), with an experimental Windows CI lane.

### Fixed

- **Scenario steps snapshot at `when()`.** A `when(state, stub)` step now builds the stub
  immediately, so mutating/reusing the same builder afterward no longer silently rewrites the
  committed step. `defaultResponse` rejects a proxy/inject/fault (or empty raw) response with
  `InvalidDefinition` instead of a plain `Error` or a stray empty default.
- **Proxy/inject responses no longer silently drop `_behaviors`/`_rift`.** `proxyTo(url).latency(500)`
  (and `inject(...).repeat(n)`) now emit their behaviors instead of discarding them. Invalid
  combinations fail loudly with `InvalidDefinition` rather than dropping data: an `is` body set
  alongside a proxy/inject/native fault, a `tcp` fault set via both `fault()` and `withFault()`, a
  case-variant near-miss of a native fault kind, or a script spec that isn't exactly one of
  code/file/ref.

### Changed

- **Default engine version is now v0.14.0** (`DEFAULT_ENGINE_VERSION`): the version the spawn
  transport downloads when the caller doesn't pin one. `minEngineVersion` stays at `0.12.0` —
  the SDK does not depend on any post-0.12 engine behavior.

### Fixed

- **Engine binary download actually works.** Release archives (v0.12.0+) nest their binaries
  under `rift-<version>-<target>/bin/`, and the engine binary inside is named `rift` — the
  extractor only probed for `rift-http-proxy` at the archive root or directly under the
  versioned directory, so every download failed with "archive did not contain the expected
  binary". Extraction now probes the real layout (preferring `bin/`, falling back to the
  legacy locations) and caches the binary under its canonical name as before.
- **`spawn()` no longer aborts the engine at startup.** The spawn transport defaulted `host` to
  `localhost` and always passed it as `--host` — but the engine parses `--host` into a socket
  address and rejects hostnames with "invalid socket address syntax" (all engine versions), so
  every default `spawn()` died at startup. The default is now `127.0.0.1`; an explicit `host`
  must be an IP literal.

### Changed (breaking)

- **Root exports are now the typed layer only.** The legacy weak types `Predicate`, `Response`,
  `Stub`, `ImposterConfig`, `Imposter`, and `ServerInfo` are no longer exported from the package
  root — they shadowed the real wire model. Use the `wire` namespace instead
  (`import { wire } from '@rift-vs/rift'` → `wire.Imposter`, `wire.Stub`, `wire.Predicate`, …), or
  the fluent DSL builders.
- **Error hierarchy moved to the package root.** All error classes now live in one module and are
  exported from the root (`RiftError` and subclasses). `./remote/errors.js` re-exports them for one
  release with a deprecation notice. `WireValidationError` now extends `RiftError` (previously
  extended `Error` directly).
- **`isBinaryInstalled()` removed** from `./binary.js` (it was buggy — it always returned `true`).
  `findBinary` / `downloadBinary` / `getBinaryVersion` remain as thin, deprecated wrappers over the
  reworked resolver (`resolveBinary`), which enforces SHA-256 verification.
- **`PLATFORM_MAP` and `getPlatformKey` removed** from `./binary.js` (part of the retired legacy
  download stack).

### Added

- **`@rift-vs/rift/compat` subpath** exposing the Mountebank-compatible `create()` surface
  (`create`, `CreateOptions`, `RedisOptions`, `RiftServer`, and the default export). `create()`
  remains available from the root as well and is a permanent, first-class compat surface.
- New error classes for upcoming milestones: `VerificationError`, `UnsupportedPredicateError`,
  `EngineVersionError`, `NativeLibraryError`, `InterceptUnavailable`.
- Package `exports` map for the planned subpaths `./testkit/vitest`, `./testkit/jest`, and
  `./intercept-undici` (placeholder modules until their features land).
- `wire.RecordedRequest` now names the `_mode?: 'binary'` marker the engine (≥ 0.13.6) sets on
  recorded requests whose non-UTF-8 body it base64-encoded. Additive — absent for text bodies,
  and unknown fields already round-tripped via the index signature.

### Removed

- **`axios` runtime dependency.** The compat `create()` readiness poll now uses the global `fetch`
  (same semantics: any HTTP response — including an error status — counts as ready). The package now
  has **zero runtime dependencies**. `undici`, `vitest`, and `@rift-vs/rift-embedded` are optional
  peer dependencies.

### Documentation

- README now documents the runtime contract explicitly: **ESM-only, Node ≥ 20**, zero runtime
  dependencies.
