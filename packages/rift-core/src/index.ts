/**
 * `@rift-vs/rift` — official Node.js / TypeScript SDK for Rift.
 *
 * The root surface is the typed layer: the fluent DSL, the wire model (namespaced as `wire`) with
 * its `fromJson` escape hatch, the transports (`rift.connect` / `rift.spawn` / `rift.embedded`), the
 * SDK-wide error hierarchy, and verification. The Mountebank-compatible `create()` is kept here as a
 * permanent drop-in (and is also available from `@rift-vs/rift/compat`).
 *
 * ESM-only, Node ≥ 20. See the README "Requirements" section.
 *
 * @example
 * ```ts
 * import { rift, imposter, onGet, okJson } from '@rift-vs/rift';
 * await using engine = await rift.spawn();
 * const users = await engine.create(imposter('users')
 *   .stub(onGet('/api/users/1').willReturn(okJson({ id: 1, name: 'Alice' }))));
 * ```
 */

// SDK-wide error hierarchy (canonical location).
export * from './errors.js';

// Typed wire model. Exposed under the `wire` namespace because the full Mountebank grammar types
// (Imposter, Stub, Predicate, Response) share names with the DSL's concepts; the escape-hatch
// helpers are lifted to the root. `WireValidationError` comes from the error hierarchy above.
export * as wire from './model/index.js';
export { fromJson, toWireJson, toWireString } from './model/index.js';

// Fluent DSL builders (imposter/stub/response/predicate/scenario) that produce the wire model.
export * from './dsl/index.js';

// Low-level escape hatch: a synchronous `connect(url) -> RemoteClient` (no version preflight).
export { connect } from './remote/client.js';
export type { RemoteClient, RemoteClientOptions, FlowScopedOptions } from './remote/client.js';

// Verification API (issue #6): count matchers + the ergonomic `RecordedRequest` at the root, so
// the quick-start's `import { times } from '@rift-vs/rift'` works. `wire.RecordedRequest` (the raw
// wire shape) stays namespaced — this is the mapped, ergonomic shape `recorded()`/`verify()` use.
export { times, atLeast, atMost, between, never } from './verify/index.js';
export type { RecordedRequest, RequestMatch, CountMatcher, RecordedFilter } from './verify/index.js';
export { renderVerificationFailure } from './verify/render.js';

// Spawn transport + reworked binary resolver.
export * from './spawn/index.js';

// Native library (cdylib) resolution for the future embedded transport (issue #9).
export * from './natives/index.js';

// The client API facade (issue #21): `RiftEngine` + handles implemented once over `AdminApi`.
// `rift.connect`/`rift.spawn`/`rift.embedded` are the async, Engine-returning entry points.
export { rift, Engine } from './engine.js';
export type {
  RiftEngine,
  ImposterHandle,
  SpaceHandle,
  FlowStateHandle,
  ImposterSummary,
  BuildInfo,
  Transport,
  AdminApi,
  ConnectOptions,
  EmbeddedOptions,
  InterceptHandle,
  InterceptOptions,
} from './engine.js';
export type { UpstreamTrust } from './upstream-trust.js';

// Binary discovery helpers (thin wrappers over the resolver; kept for compatibility).
export { findBinary, downloadBinary, getBinaryVersion } from './binary.js';

// Mountebank-compatible `create()` — permanent drop-in surface. Also at `@rift-vs/rift/compat`.
export { create } from './compat/index.js';
export type { CreateOptions, RedisOptions, RiftServer } from './types.js';

import { create } from './compat/index.js';
export default { create };
