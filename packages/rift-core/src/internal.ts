/**
 * Internal seam for `@rift-vs/rift-embedded` (#39) — exposed as the `./internal` subpath export.
 *
 * The embedded package implements core's `AdminApi`/`Engine` machinery over the FFI, which takes
 * more of core than the curated public root exports: the `Engine` facade itself, the version
 * preflight helpers, the wire model, the verify evaluators, and the `RemoteClient` class its
 * admin-plane bridge wraps. Those are implementation surface, not public API — so they cross the
 * package boundary HERE, keeping the root export hygienic (see `export-hygiene.test.ts`).
 *
 * Stability: this subpath exists for `@rift-vs/rift-embedded` (and future drop-in embedded
 * backends) at the SAME version — it carries no semver guarantees for anyone else.
 */

export { Engine, versionIssue, MIN_ENGINE_VERSION } from './engine.js';
export type { AdminApi, BuildInfo } from './engine.js';

export { RemoteClient } from './remote/client.js';
export type { FlowScopedOptions } from './remote/client.js';

export * from './model/index.js';

// The embedded transport serializes its own FFI payloads, so it needs the same JSON-safety guard
// the HTTP transports get inside `RemoteClient` (issue #112). Internal, not `wire.*`: it is how a
// backend must serialize, not something a user of the SDK composes with.
export { stringifyJsonSafe } from './model/serialize.js';

export { toRecordedRequest } from './verify/index.js';
export { evalPredicates } from './verify/eval.js';

export type { InterceptBackend, InterceptOptions } from './intercept/types.js';
