/**
 * Canonical, SDK-wide error hierarchy.
 *
 * Every failure the SDK produces is a distinct {@link RiftError} subclass so callers discriminate
 * with `instanceof` instead of parsing messages or status codes. These types are transport-agnostic
 * (shared by the remote, spawn, and embedded transports, the wire codec, verification, and the
 * native loader), which is why they live at the package root rather than under any one transport.
 *
 * The Mountebank-compat `create()` layer validates its options up front with
 * {@link UnsupportedCreateOptionError}, but its runtime/spawn path still throws plain `Error`s to
 * preserve its historical contract; everything else in the SDK throws one of the classes below.
 */

import type { Predicate } from './model/index.js';
import type { CountMatcher, RecordedRequest } from './verify/index.js';

/**
 * Base class for every error the SDK throws.
 *
 * The base constructor restores the prototype chain against `new.target` (the actually-invoked
 * constructor), so subclasses do not repeat it and `instanceof` holds for every subclass even when
 * the output is down-compiled below ES2022.
 */
export class RiftError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'RiftError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Client-side validation failure, or the engine rejected the definition as malformed (HTTP 400). */
export class InvalidDefinition extends RiftError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'InvalidDefinition';
  }
}

/** The requested imposter does not exist (HTTP 404). */
export class ImposterNotFound extends RiftError {
  constructor(message: string) {
    super(message);
    this.name = 'ImposterNotFound';
  }
}

/** Any other non-2xx response from the engine; carries the original HTTP status as `code`. */
export class EngineError extends RiftError {
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.name = 'EngineError';
    this.code = code;
  }
}

/** The engine could not be reached at all — load/spawn/connect failed (e.g. `fetch` rejected). */
export class EngineUnavailable extends RiftError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'EngineUnavailable';
  }
}

/** A transport-level failure: a response was received but its body could not be parsed as expected. */
export class CommunicationError extends RiftError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CommunicationError';
  }
}

/** The wire codec rejected input as malformed; `path` is a JSONPath-ish locator of the offending node. */
export class WireValidationError extends RiftError {
  readonly path: string;

  constructor(message: string, path: string, options?: ErrorOptions) {
    super(`${message} (at ${path})`, options);
    this.name = 'WireValidationError';
    this.path = path;
  }
}

/** Detail fields for a `VerificationError` — everything needed to render or programmatically
 * inspect a `verify(...)` miss without re-running the evaluator. */
export interface VerificationErrorFields {
  expected: Predicate[];
  count: { matched: number; total: number; matcher: CountMatcher };
  recorded: RecordedRequest[];
  /** The non-matching request satisfying the highest fraction of leaf predicate clauses (ties →
   * most recent); `undefined` when nothing was recorded, or when everything recorded matched but
   * the count was still wrong. */
  closest?: { request: RecordedRequest; failures: Array<{ predicate: Predicate; actual: unknown }> };
}

/** A `verify(...)` expectation was not satisfied. `render.ts`'s `renderVerificationFailure` turns
 * these fields into the multi-line failure report; this class only carries the data. */
export class VerificationError extends RiftError {
  readonly expected: Predicate[];
  readonly count: { matched: number; total: number; matcher: CountMatcher };
  readonly recorded: RecordedRequest[];
  readonly closest?: { request: RecordedRequest; failures: Array<{ predicate: Predicate; actual: unknown }> };

  constructor(message: string, fields: VerificationErrorFields) {
    super(message);
    this.name = 'VerificationError';
    this.expected = fields.expected;
    this.count = fields.count;
    this.recorded = fields.recorded;
    this.closest = fields.closest;
  }
}

/** A predicate operator that the SDK cannot evaluate client-side (e.g. `xpath`, `inject`); carries the operator name. */
export class UnsupportedPredicateError extends RiftError {
  readonly operator: string;

  constructor(operator: string, message: string) {
    super(message);
    this.name = 'UnsupportedPredicateError';
    this.operator = operator;
  }
}

/**
 * Thrown by {@link create} when a {@link CreateOptions} field cannot be honored by Rift's engine
 * and honoring it silently would misrepresent the server's behavior — e.g. `impostersRepository`
 * (a Node in-process module the native engine cannot load) or `redis` (meaningful only to such a
 * module). Failing loud beats a silent in-memory fallback: the message names the option and the
 * supported alternative (`datadir`, per-imposter `flowState`).
 */
export class UnsupportedCreateOptionError extends RiftError {
  readonly option: string;

  constructor(option: string, message: string) {
    super(message);
    this.name = 'UnsupportedCreateOptionError';
    this.option = option;
  }
}

/** The engine's version is below the SDK's `minEngineVersion`; carries the observed and required versions. */
export class EngineVersionError extends RiftError {
  readonly found: string;
  readonly required: string;

  constructor(found: string, required: string, message?: string) {
    super(message ?? `engine version ${found} is below the required minimum ${required}`);
    this.name = 'EngineVersionError';
    this.found = found;
    this.required = required;
  }
}

/** The native library (cdylib) could not be resolved or loaded; may carry the attempted path and platform classifier. */
export class NativeLibraryError extends RiftError {
  readonly path?: string;
  readonly classifier?: string;

  constructor(message: string, detail?: { path?: string; classifier?: string; cause?: unknown }) {
    super(message, detail?.cause !== undefined ? { cause: detail.cause } : undefined);
    this.name = 'NativeLibraryError';
    this.path = detail?.path;
    this.classifier = detail?.classifier;
  }
}

/** Intercept (TLS-MITM) is not available on this transport, or has not been started. */
export class InterceptUnavailable extends RiftError {
  constructor(message: string) {
    super(message);
    this.name = 'InterceptUnavailable';
  }
}
