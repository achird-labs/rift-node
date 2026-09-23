# Changelog

All notable changes to `@rift-vs/rift` are documented here. This project adheres to
[Semantic Versioning](https://semver.org/).

## Unreleased

### Added

- **Declarative flow-state writes: `setState()`, `incrementState()`, `deleteState()`,
  `clearFlowState()` and `stateOps(...)` on every response builder** (issue #149). Engine 0.18.0
  runs `_rift.stateOps` after an `is` response is rendered, in order, against the request's flow
  (rift#969) — reading state was already declarative via `{{ state.<key> }}`, writing it needed an
  `inject`. The `StateOp` union types the four ops on `RiftResponseExtension.stateOps`;
  `incrementState(key)` omits `by` (the engine's default of 1) and writes it when given. Each op is
  validated at the call (non-empty string key, string `value`, integer `by`), and `build()` refuses
  the block on a proxy, inject, fault or script response, where the engine never runs it and says
  so only as an analysis warning. The intercept `serve()` guard now names `stateOps()` for the
  extension it cannot deliver. Engines <= 0.17.0 drop the block on parse, so `create()` and
  `replaceAll()` refuse to send it to one through the same fail-closed version gate as
  client-certificate auth (`EngineVersionError`; `versionCheck: 'off'` sends it anyway).

- **`imposter().requireClientCertificate(caPems?)` — mutual TLS on HTTPS imposters** (issue #137).
  Engine 0.18.0 honours `mutualAuth`, `rejectUnauthorized` and `ca` (rift#977); before, the keys
  were dropped on parse and a listener documented as requiring client certificates accepted
  everyone. With no anchors the builder emits `mutualAuth: true` (any client certificate); with
  anchors it adds `rejectUnauthorized: true` and `ca` — one anchor as a bare string, several as an
  array, the spelling the engine echoes back. Both set `protocol: 'https'`, and `build()` refuses
  the keys on any other protocol (the engine 400s them). `Imposter` types `rejectUnauthorized`/`ca`.

  Fail closed on older engines: these are imposter keys, not serve options, so `create()` and
  `replaceAll()` gate on the engine version — a version below 0.18.0, or one that cannot be read,
  throws `EngineVersionError` naming the feature and the remedies, since that engine would ignore
  the keys and accept every client. `connect()` and `embedded()` record the version their startup
  check found; spawn resolves it once from `/config` on first need (a failed lookup is retried, not
  cached). `versionCheck: 'off'` (connect / embedded) skips the gate and `'warn'` lets an unreadable
  version through, as it did at startup; `engine.admin` is the raw surface and is never gated. The replayable list export echoes the three keys with `cert`/`key`; the per-imposter
  GET is a runtime view and omits all five. The existing `https({ mutualAuth: true })` now really requires a client certificate on
  0.18.0, and the docs say so. No conformance fixture, per the cross-SDK issue.

- **`upstreamTrust` — the engine's outbound TLS trust, on `rift.spawn()` and `rift.embedded()`**
  (issue #136). Recording against an origin issued by a private CA failed with
  `invalid peer certificate: UnknownIssuer` and nothing in the SDK could change that; since engine
  0.18.0 (rift#974) the trust is a per-engine option. One union, one policy: `{ caFile }` (PEM,
  *appended* to the OS store; the path is resolved when the option is read), `{ caPem }` (inline;
  embedded only — the CLI has no inline flag, spawn throws `InvalidDefinition` naming `caFile`), or
  `{ skipVerify: true }` (development only; the SDK emits a process warning, since the engine's own
  goes nowhere an SDK caller looks). The same trust governs `https:` config sources and the
  intercept relay. `connect()` takes none: a connected engine's trust belongs to whoever started it.

  Older engines are refused, never ignored. Spawn probes the resolved binary's version, like
  `intercept.auth`; below 0.18.0 or unrecognisable → `EngineVersionError`. Embedded gates on
  *presence* — a cdylib before 0.17.0 has no list and ignores an unknown serve key rather than
  refusing it; from 0.17.0 on the list is authoritative — so the exact key must be in
  `rift_build_info().serveOptions` (now `BuildInfo.serveOptions` on the embedded transport, `[]`
  when the cdylib predates the list) → `EngineUnavailable` otherwise. Setting it also starts the embedded
  loopback admin plane eagerly: the engine installs the trust inside `rift_serve_admin`, and an
  imposter or intercept listener created before that call would silently keep the default trust
  (rift-java hit exactly this). Without `upstreamTrust` nothing changes: the plane stays lazy and
  the spawn command line is byte-identical.

- **`rift.spawn({ configfile, noParse: true })`** (issue #138) maps to the engine's `--no-parse`: the
  config file is loaded verbatim, with no EJS preprocessing, and so is the `POST /admin/reload` that
  re-reads it. Since engine 0.18.0 a config file holding a tag the loader does not evaluate — a
  literal `<%` in a response body included — fails the spawn, with the engine's own pointer at
  `--no-parse` in the stderr `spawn()` reports; until now the SDK user could not follow it.
  `noParse` without `configfile` throws `InvalidDefinition` before any binary is resolved — the
  engine's CLI accepts that combination and silently does nothing with it. No version gate: the
  flag predates this package's 0.12.0 floor (engine 0.2.0). The SDK's embedded transport does not
  expose a config file (it applies already-parsed JSON), so nothing changes there.

- **The wire model names the 0.18.0 read-path shapes** (issue #150). `GET /imposters`,
  `handle.toJson()` and `getImposter()` write a response's behaviors as an ordered `behaviors` array
  (one element per step, a multi-item `copy`/`lookup`/`shellTransform` split one per item) and lift
  `repeat` to the response (rift#1191, rift#1199, rift#1188); the SDK preserved both through its
  index signatures but typed only `_behaviors`. `StubResponse.behaviors` and `StubResponse.repeat`
  are now declared, as are the carrier fields the engine round-trips but does not act on standalone:
  `_rift.dataset` (`DatasetBinding`, rift#973) on a response and `_rift.sequencing` on an imposter
  (rift#978). The DSL still emits the object form; the engine accepts either, and when both are
  present it uses `_behaviors` and ignores the `behaviors` array — a response-level `repeat`,
  though, wins over `_behaviors.repeat`.

- **`RecordedRequest.status`, `.latencyMs` and `.node`** (issue #148). Since engine 0.18.0 a
  journal entry records how it was answered (rift#364); the SDK already received the fields but
  only through `raw` with a cast. They are lifted onto the typed shape and documented: `undefined`
  means not recorded (a request still in flight when the journal was read, one whose handling
  errored, or an engine < 0.18.0), and `latencyMs: 0` is a real reading. `node` is stamped only by
  a clustered journal and is always `undefined` against a single engine. No version gate —
  optional fields.

- **`latency()`, `repeat()` and `binaryBody(string)` validate their arguments** (issue #146). Engine
  0.18.0 refuses at the config door what these builders used to pass through: a fractional or
  negative `wait` (rift#1162), a `{min, max}` range with `min > max` (rift#1148 — older engines
  created the imposter and then dropped every connection), and a negative, fractional or
  over-`u32` `repeat`; a `binaryBody` string the engine's `base64::STANDARD` cannot decode (bad
  alphabet, padding, whitespace, or non-zero trailing bits) is served with
  `x-rift-binary-error: true` or a 500 under `strictBehaviors` (rift#1151). Each now throws
  `InvalidDefinition` at the call,
  naming the builder, so the mistake is caught before any engine is involved and regardless of its
  version. `repeat(0)` is refused as well: the engine accepts it but silently serves it as `1`. The
  function-string `latency()` form, `Fault.latency()`, and the `.behavior()`/`.raw()` escape
  hatches are unchanged.

- **`InterceptOptions.auth` — a per-call intercept credential** (issue #124). The engine's intercept
  proxy takes a credential, but the SDK exposed no way to set one: the only channel was an ambient
  `RIFT_INTERCEPT_AUTH`, which is process-wide. Two engines in one process could not use different
  credentials, and tests had to mutate `process.env`, which is order-dependent and leaks across
  cases. This was also asymmetric with the admin key, where `apiKey` has long been a first-class
  option that beats `MB_APIKEY`.

  `auth` is `{ username, password }` — the shape the engine's own `InterceptStartOptions.auth` takes,
  so it needs no transformation. It is honoured by the doors that actually START a listener:
  `rift.spawn({ intercept: { auth } })`, and `engine.intercept({ auth })` on the **embedded**
  transport. On spawn/remote, `engine.intercept()` only *attaches* to a listener the engine's
  operator already brought up — so `auth` there throws `InterceptUnavailable` naming `rift.spawn()`
  instead of being accepted and silently discarded, which would hand back a handle to an
  unauthenticated proxy. (The reason given at the time, "no runtime endpoint (rift#493)", was
  stale; issue #129 below states the real one and extends the guard to the CA paths.)

  An explicit option beats the ambient variable, mirroring `apiKey` / `MB_APIKEY`; when it is set the
  ambient value is never passed to the child, so a malformed ambient value no longer fails a spawn
  that overrides it.

  On the spawn door the credential travels on the **child's environment, not argv** — argv is
  world-readable via `/proc/<pid>/cmdline` and is captured by `ps`/auditd, and unlike `apiKey` this
  option has no historical command-line contract to keep. `buildSpawnArgs` is typed
  `Omit<InterceptOptions, 'auth'>` so a credential silently dropped from the command line is
  unrepresentable rather than merely undocumented. That door also rejects a username containing a
  colon, because it colon-joins the halves into one variable and the engine splits on the first
  colon; the runtime door carries them separately and accepts one.

  A spawn passing `auth` now probes the resolved binary's `--version` **before launching it** and
  fails with `EngineVersionError` below **0.17.0**, or when the binary reports no recognizable
  version. Below that the `--intercept-auth` flag does not exist, so clap never reads the variable
  and the listener would come up unauthenticated while the caller believed it was guarded — a silent
  downgrade the engine cannot report, because from its side nothing happened. A gate that cannot
  confirm the credential will be enforced must not assume that it will.

  The check deliberately runs *before* the child starts rather than asking the running engine's
  `/config`: the engine binds its intercept listener before its admin plane, so a post-startup check
  could only shorten the window in which an unauthenticated MITM proxy was already accepting
  connections, not prevent it. A spawn without `auth` never probes and is unchanged.

  Blank halves are refused on both doors under the same both-trim-dialect rule as the admin key.

### Changed

- **`intercept.serve()` refuses a response it cannot deliver, instead of quietly serving a different
  one** (issue #131). The serve action was built from the response's `is` block alone, so the
  `_behaviors` and `_rift` blocks beside it were discarded without a word: every behavior (`latency`,
  `repeat`, `decorate`, `shellTransform`, `copy`, `lookup`) and every `_rift` extension (`templated`,
  `script`, and the `latency`/`error`/`tcp` faults). Registration returned success either way, so a
  fault-injection test could look green while asserting against a plain success response — certifying
  resilience the system under test does not have.

  The engine genuinely cannot carry these: its `ServeStub` is exactly `{status_code, headers, body}`,
  and none of its structs use `deny_unknown_fields`, so sending the extra fields anyway would be
  accepted-and-ignored engine-side with nothing to correlate against. Rejecting in the SDK is the
  only place the caller can still be told. Unknown keys — at the top level, or inside `is` — are
  refused for the same reason rather than dropped.

  One error names **every** offending construct at once, with the DSL method that produced each one
  (`` `_behaviors.wait` (latency()) ``), so a caller fixes them in a single pass instead of
  discovering them one run at a time. Use `redirectTo(imposter)` or `forward()` when you need
  behaviors, templating, scripts or faults: those reach a real imposter and so have full stub
  fidelity. rift-java and rift-scala already refuse the same set with the same message.

  **This is a behavior change**: `serve(host, ok('x').latency(10))` used to resolve and now throws
  `InvalidDefinition`. Any call it now rejects was already not doing what it appeared to do.

### Fixed

- **`rift.connect()` failed against every real engine under the default `versionCheck: 'fail'`**
  (issue #167): the SDK read the version from `options.version`, but the engine's `GET /config`
  has always written it at the top level, so connect threw "could not determine the connected
  engine version" unless the check was `'warn'` or `'off'`. The top-level `version` is read first;
  `options.version` stays as a fallback.

- **`engine.intercept({ caCertPath, caKeyPath })` on the spawn and remote transports is refused
  instead of silently dropped** (issue #129, absorbing #134). Those transports attach to a listener
  the engine's operator already started; the backend read only `host`/`port` and discarded the CA
  paths, handing back a handle as if the caller's CA were in use while traffic was signed by
  whatever CA the listener had. The #124 guard for `auth` now covers every startup-only option and
  throws one `InterceptUnavailable` naming all of them, with the real reason — attach-only is the
  SDK's design (the engine has had `POST /intercept` since v0.13.0, with `auth` since v0.17.0;
  starting a TLS-intercepting
  listener on an engine the SDK did not start is the operator's call, and on spawn the spawn-time
  flags configure the listener before it accepts a byte) — rather than the stale "no runtime
  endpoint (rift#493)".

- **The remote transport attaches to the real intercept listener** (issue #129). With no `port`,
  `engine.intercept()` used to default to the *admin* port, which the listener can never share, so
  the handle always pointed at the wrong door. It now asks `GET /intercept` (engine >= 0.13.0) for
  the listener's port and attaches there on the admin hostname (the engine's own `interceptUrl` is
  its bind address, e.g. `0.0.0.0`); a 404 is the usual "start the server with --intercept-port". An
  explicit `intercept({ port })` still attaches through the `GET /intercept/rules` probe every
  engine answers, so nothing changes at the 0.12.0 floor — on such an engine the port-less call gets
  the `--intercept-port` message with a hint to pass `intercept({ port })`. The "needs an explicit
  port" error for a port-less admin URL is gone — the engine answers the port.

- **Intercept `serve()` follows the engine 0.18.0 serve contract** (issue #144). The engine's serve
  stub now takes a string *or an array* per header (one line per value, rift#936) and any JSON
  body (rift#933); the normalizer still enforced the 0.17 shape, so
  `serve(host, { headers: { 'Set-Cookie': ['a=1', 'b=2'] } })` was refused and the caller sent to
  `forward()`. Arrays now reach the wire as arrays, `ServeStub.headers` is typed
  `string | string[]`, and `ServeStub.body` is `JsonValue | null` on the read path (`rules()`
  already returned those shapes; the type lied). A non-string body is still pre-stringified on the
  way out, deliberately: the engine renders an object body with sorted keys, and the caller's key
  order is what a SUT that hashes the body expects. Multi-value headers need engine >= 0.18.0; an
  older engine answers the array form with an opaque serde error.

  Three things the engine drops (with a log line) or merges (silently) are refused instead: a second
  spelling of a header name — `okJson().header('content-type', …)` used to pass and the engine
  served `Content-Type` twice, the very multi-value outcome the SDK refused to allow explicitly
  (rift#1039; the same bug was fixed in rift-scala#152) — a header name that is not an HTTP token,
  and a value carrying any control character other than HTAB (previously only CR/LF; the engine
  drops just that value). The stale
  "always computes Content-Length and Connection: close" wording is gone: tunnels are keep-alive
  since rift#993, though `Connection` is still stripped.

- **A second spelling of a header name in `injectHeader()` or `Fault.error({ headers })` is refused
  locally** (issue #145). Both fields are single-valued on the wire, and engine 0.18.0 refuses a
  case-variant repeat (`x-trace` beside `X-Trace`) with a 400 naming both spellings (rift#1050); older
  engines sent both as two header lines in hash order. The builders now throw `InvalidDefinition`
  naming both spellings and the call, before anything is sent. The same spelling twice still
  replaces, and multi-valued `is.headers` is untouched — the engine merges case variants there,
  which is how a stub sends two `Set-Cookie` lines.

- **`Headers`, `URLSearchParams`, `FormData`, `Blob`, `Request`, `Response`, `AbortController`,
  `AbortSignal` and `WeakRef` are refused instead of reaching the engine as `{}`** (issue #132).
  #126 guarded the ECMAScript slot-backed containers (`Map`, `Set`, …) and left out the host objects
  with the same always-`{}` serialization. Every one of these is a global from Node 20, this
  package's `engines` floor, and `headers: new Headers({...})` on a stub response, or a `Request`
  stashed in flow state, is exactly the slip an HTTP-mocking SDK invites. Same
  `WireValidationError` and JSONPath locator as the #126 guard, through every serializer (admin
  payloads, `addRule()`, intercept `serve()` bodies). `URL` (has `toJSON`) and typed-array views
  (index-keyed, lossy but not empty) still pass.

- **An IPv6 host no longer builds an invalid URL** (issue #143). Engine 0.18.0 accepts a bare IPv6
  literal on every door (`--host ::1`, an imposter's `host`, the intercept listener — rift#1137),
  but the SDK built its URLs by concatenation, so `spawn({ host: '::1' })` produced
  `http://::1:<port>`, which `fetch` rejects as `Invalid URL`: the readiness poll retried until the
  startup timeout and the child was killed, with nothing naming the cause. `connect('http://[::1]:2525')`
  went wrong more quietly — the admin URL parsed, but every imposter handle's `.url` came out
  bracket-less because `normalizeHost` strips them. The intercept handle URL had the same defect when
  the caller passed a bare IPv6 `host`, as did the compat readiness poll.

  Every URL built from a host now goes through one helper that brackets an IPv6 literal (and leaves
  IPv4 and already-bracketed input alone). The any-interface `::` maps to `[::1]` in a handle URL,
  as `0.0.0.0` maps to `127.0.0.1`. A zone id (`fe80::1%2`) is kept inside the brackets; note that
  Node's WHATWG `URL` refuses a zoned host regardless, so such a bind is not dialable by `fetch`.
  An IPv6 `--host` starts only on engine >= 0.18.0; older engines refuse it before the SDK is involved.

- **`space(flowId).addStub()` sends the stub the caller built** (issue #142). `RemoteClient.addSpaceStub`
  wrapped the stub in the `{ stub }` envelope that belongs to `POST /imposters/{port}/stubs`; the
  space route takes the stub object bare. Engine 0.18.0 refuses the envelope with a 400 naming it,
  so every `addStub()` on a space failed after the engine bump. On engines before 0.18.0 the
  failure was silent and worse: the envelope deserialized as an **empty** stub — no predicates, no
  responses — that matched every request in the space. Over HTTP (the spawn and remote transports)
  the method had never delivered the stub it was given until now; the embedded transport sends the
  stub bare through its native call and was unaffected. No version gate: the bare shape is what
  every engine reads correctly.

- **A `Map`, `Set` or other slot-backed container is refused instead of reaching the engine as `{}`**
  (issue #126). `JSON.stringify` renders these as `{}` however much they hold, and the replacer only
  inspected scalars, so the entire contents vanished onto the wire with nothing thrown SDK-side.
  `new Set(hosts)` — a natural way to dedupe a predicate list — was the common way to hit it, and
  `setFlowState`, which takes `unknown`, was the untyped path in.

  Now refused with the usual typed `WireValidationError` and its JSONPath locator: `Map`, `Set`,
  `WeakMap`, `WeakSet`, `RegExp`, `Promise`, `ArrayBuffer`, `SharedArrayBuffer` and `DataView`.

  Deliberately still accepted, because they lose nothing or lose it visibly: an `Error` (its
  enumerable own properties serialize), a typed-array view such as `Uint8Array` (an index-keyed
  object), and an ordinary class instance whose state is private fields or getters. That last one is
  why membership is an explicit list of built-ins rather than the rule "renders as `{}`" — such an
  instance renders that way too, and refusing it would reject plain domain objects.

  Same wrong-but-quiet class as issues #106/#118/#119, but losing every value rather than one.

- **A refused value is located by a full JSONPath, not just its key** (issue #118).
  `WireValidationError.path` was already documented as "a JSONPath-ish locator of the offending
  node", but the replacer could only see the key it was handed, so a bad value inside a posted array
  reported `…statusCode` and left the caller to bisect the array by hand to find which element
  carried it. It now reports `$[2].action.serve.statusCode`.

  Array indices are spelled `[2]`, identifier-safe keys `.name`, and anything else is quoted —
  `$.headers["Content-Type"]`, which matters because header names are not identifiers. This applies
  at every serializing call site, including `intercept.serve()` bodies and `addRule()`.

  Only the locator text changed — exactly the same inputs are refused as before, and the error type
  is unchanged. Note the path is interpolated into the message (`… (at $[2].action…)`), so a caller
  asserting on message *text* is affected just as one asserting on `.path` is; matching on the error
  type, or on the part of the message before the locator, is not.

- **An `undefined` array element is refused instead of reaching the engine as `null`** (issue #119).
  `JSON.stringify` treats the two `undefined` positions differently: an object *property* is dropped,
  but an array *element* is rendered as `null`. `jsonSafeReplacer` checked neither, so
  `addRule([rule, undefined])` — or any array-valued field with a hole, reachable from an untyped or
  `JSON.parse`-derived caller — put a value on the wire that the caller never wrote, with nothing
  SDK-side to correlate against. The same wrong-but-quiet class already fixed for non-finite numbers
  in issues #106/#110/#111.

  An undefined array element now throws `WireValidationError`. A replacer receives the holder of the
  current key as `this`, which separates the two cases exactly: undefined *properties* are still
  dropped (the omitted-optional contract is unchanged), and a top-level `undefined` still reports
  `value has no JSON representation`, since its holder is `JSON.stringify`'s internal wrapper rather
  than an array. Sparse holes and an element whose `toJSON()` returned `undefined` are the same bug
  and are caught too.

  Because the guard lives in the shared replacer, it applies at every serializing call site:
  `toWireString()`/`toWireJson()`, `intercept.serve()`'s body, `addRule()`, and every payload routed
  through `stringifyJsonSafe` — including `flowState.put()`, where a caller-supplied
  `[1, undefined]` now throws rather than being stored as `[1, null]`.

- **A wrapped serialization failure keeps the original error as `cause`** (issue #121).
  `stringifyJsonSafe()` is the choke point every outbound admin payload serializes through, and when
  `JSON.stringify` threw something the SDK had not raised itself — a bare `TypeError` from a circular
  reference, or whatever a value's own `toJSON()` threw — it kept only the message *text*. The error
  object, its type and its stack were discarded, which is the information you actually want when the
  failure came from outside the SDK's own checks.

  `WireValidationError` now accepts `ErrorOptions` like its siblings (`InvalidDefinition`,
  `EngineUnavailable`, `CommunicationError`) and `stringifyJsonSafe()` attaches `{ cause }`. The
  inconsistency was forced by the constructor's signature rather than chosen: the intercept path's
  `toBody()` and `addRule()` already preserved the cause this way.

  Purely additive — the third parameter is optional, every existing call site is unchanged, and the
  message text is byte-identical. `.cause` is `undefined` on the refusals the SDK detects itself (a
  non-finite number, a `bigint`, a function, a symbol), which still pass through with their precise
  `.path` and are never re-wrapped.

- **An ambient `RIFT_INTERCEPT_AUTH` is validated before a binary is resolved** (issue #115). The
  engine declares `--intercept-auth <USER:PASS>` with `env = "RIFT_INTERCEPT_AUTH"`, and both
  transports that spawn a child inherit `process.env` wholesale — so the variable is engine
  configuration whether the caller meant it that way or not, the same door `MB_APIKEY` came through
  in issue #103. The SDK referenced it nowhere.

  Since rift#885 (engine v0.17.0) three shapes make the engine refuse to start, and each surfaced
  through the SDK as an opaque `Rift process exited with code N`, after binary resolution that may
  include a download: a value with no `:`, a value with a blank username or password, and — the one
  most likely to bite — a **perfectly valid** credential when no intercept listener was requested,
  because a credential with nothing to guard reads as a protection that is not in force. That last
  case means any ambient value at all was fatal to `rift.spawn()` without `intercept`, and to every
  compat `create()`, which never passes intercept flags.

  All three are now refused up front with `InvalidDefinition` naming `RIFT_INTERCEPT_AUTH` and the
  remedy. A valid credential *with* a listener is passed through untouched — an ambient variable is
  currently the only way to give a spawned engine an intercept credential. Blank halves are judged
  with the same both-dialect rule as the admin key (issue #116), since the engine trims them with the
  same Rust `str::trim`.

  Note this closes no security hole: below v0.17.0 the CLI flag does not exist, so clap never reads
  the variable and it is inert; at or above it, the engine already fails closed on its own. The fix
  is about failing loudly and early, in the SDK's own vocabulary.

- **The blank-admin-key guard now agrees with the engine on U+0085, and `create()` re-checks after
  binary resolution** (issue #116). Two gaps left over from issues #103/#108:

  The guard called a key blank using JavaScript's `String.prototype.trim`, but the engine uses Rust's
  `str::trim`, whose `White_Space` set includes U+0085 (NEL) where JavaScript's does not. A key
  holding only a NEL therefore passed the SDK and was then refused by the engine itself — an opaque
  `Rift process exited with code N` in place of the friendly `InvalidDefinition` that issue #108
  exists to produce. "Blank" is now the union of both dialects, so the SDK refuses everything either
  side would. The one remaining divergence runs the safe way: a key of only U+FEFF is refused here
  though the engine would accept it, which costs a respelling rather than an open admin plane. A key
  that merely *contains* either code point is still a real key and is passed through untouched.

  Separately, compat `create()` validated the ambient `MB_APIKEY` at entry and then awaited binary
  resolution — which can run a real download — before spawning, while the child re-reads the variable
  at exec. A value blanked inside that window reached the engine unchecked, after `create()` had
  already told the caller the key was good. It is re-checked after resolution now. Deliberately not
  `spawn()`'s stricter exact-value comparison: that exists to keep the engine and the SDK-built admin
  client on one key and `create()` builds no admin client, so a key that merely changed or was unset
  mid-flight still proceeds. Only a blanked one is refused — and it matters because `findBinary()`
  can surface a pre-0.17 engine, which opens its admin plane rather than refusing to start.

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
