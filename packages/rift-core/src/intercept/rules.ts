/**
 * Pure intercept rule builders (issue #11) — turn `InterceptHandle.serve`/`forward`/`redirectTo`'s
 * ergonomic arguments into the wire `wire.InterceptRule` shape. No I/O, no backend dependency;
 * `InterceptHandleImpl` (engine.ts) is the only caller.
 */

import type { InterceptRule, IsResponse, JsonValue, Predicate, ServeStub } from '../model/index.js';
import { InvalidDefinition } from '../errors.js';
import { jsonSafeReplacer } from '../model/serialize.js';
import { ResponseBuilder } from '../dsl/response.js';
import type { ImposterHandle } from '../engine.js';

/** A `ResponseBuilder` is only valid here when it builds a plain `is` block — proxy/inject/native-fault
 * responses have no meaning as an intercept `serve` action. */
function toIsResponse(response: ResponseBuilder | IsResponse): IsResponse {
  if (!(response instanceof ResponseBuilder)) return response;
  const built = response.build();
  if (built.is === undefined) {
    throw new InvalidDefinition(
      'intercept serve() response must build an `is` block (status/headers/body) — proxy/inject/fault responses are not valid intercept actions'
    );
  }
  return built.is;
}

function toForwardPort(to: ImposterHandle | number): number {
  return typeof to === 'number' ? to : to.port;
}

/**
 * The engine writes the status line as `format!("HTTP/1.1 {} {}")` with a reason phrase of `""` for
 * anything outside hyper's `StatusCode::from_u16` (`intercept.rs`), so a code it cannot render
 * yields a malformed HTTP response instead of a serde error — the same wrong-but-quiet failure this
 * normalizer exists to prevent, merely relocated to the SUT's parser. Hence the bound is what HTTP
 * can express, not what the `u16` field can hold.
 */
const MIN_STATUS_CODE = 100;
const MAX_STATUS_CODE = 999;

/** Deliberately stricter than `Number()`, which maps `''`, `null`, `[]` and `true` onto real status
 * codes (`0`/`1`) and silently accepts hex and exponent forms. */
function toStatusCode(statusCode: unknown): number {
  let code = NaN;
  if (typeof statusCode === 'number') {
    code = statusCode;
  } else if (typeof statusCode === 'string' && /^\d+$/.test(statusCode.trim())) {
    code = Number(statusCode.trim());
  }
  if (!Number.isInteger(code) || code < MIN_STATUS_CODE || code > MAX_STATUS_CODE) {
    throw new InvalidDefinition(
      `intercept serve() statusCode must be an integer in ${MIN_STATUS_CODE}..${MAX_STATUS_CODE}, got ${JSON.stringify(statusCode)}`
    );
  }
  return code;
}

function toHeaders(headers: NonNullable<IsResponse['headers']>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      throw new InvalidDefinition(
        `intercept serve() cannot send the multi-value header "${name}": the engine's serve stub holds one value per header, and joining them would corrupt headers like Set-Cookie. Send a single string, or forward() to an imposter.`
      );
    }
    if (typeof value !== 'string') {
      throw new InvalidDefinition(`intercept serve() header "${name}" must be a string, got ${typeof value}`);
    }
    out[name] = value;
  }
  return out;
}

/** A string body is the engine's own contract and is sent as-is; anything else becomes compact JSON.
 * Key order follows the object's own — the engine's imposter path re-serializes through
 * `serde_json::Map` (a `BTreeMap`, since `preserve_order` is off) and so emits sorted keys, which a
 * SUT that hashes or byte-asserts the body will notice.
 *
 * Serialized through the wire model's own {@link jsonSafeReplacer} so this path refuses exactly what
 * that one refuses (issue #106) — the thrown `WireValidationError` already names the offending key,
 * and the catch below re-wraps it as `InvalidDefinition` to keep `serve()`'s error contract uniform. */
function toBody(body: JsonValue): string {
  if (typeof body === 'string') return body;
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(body, jsonSafeReplacer);
  } catch (cause) {
    throw new InvalidDefinition(
      `intercept serve() body could not be serialized to JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause }
    );
  }
  if (encoded === undefined) {
    throw new InvalidDefinition('intercept serve() body could not be serialized to JSON: it has no JSON representation');
  }
  return encoded;
}

/**
 * Narrows a Mountebank-shaped {@link IsResponse} to the engine's {@link ServeStub}.
 *
 * The two shapes disagree on every field — `body` (`JsonValue` vs `Option<String>`), `statusCode`
 * (`number | string` vs `u16`) and `headers` (`string | string[]` values vs `String`) — and the
 * engine parses rules through an untagged enum, so any mismatch surfaces as an opaque "did not match
 * any variant of RuleOrRules" instead of naming the offending field (issue #101).
 *
 * Builds a fresh object, so `_mode: 'text'` and unknown keys are dropped rather than forwarded and
 * the caller's response is never mutated. `addRule()` remains the verbatim escape hatch.
 */
function toServeStub(is: IsResponse): ServeStub {
  if (is._mode === 'binary') {
    throw new InvalidDefinition(
      "intercept serve() cannot send a binary response: the engine's serve stub has no binary mode, so the base64 would be served as literal text. Use forward() to an imposter for binary bodies."
    );
  }
  // Fail closed: an unrecognized mode (a typo or a case variant of 'binary') must not fall through
  // to the text path, which is the very mis-serving the check above exists to prevent.
  if (is._mode !== undefined && is._mode !== 'text') {
    throw new InvalidDefinition(
      `intercept serve() does not recognize _mode: ${JSON.stringify(is._mode)} — the engine's serve stub only serves text.`
    );
  }
  const stub: ServeStub = {};
  // `null` is deliberately NOT waved through to the engine's default the way `body: null` is:
  // `body` is a `JsonValue`, which includes `null` as a first-class value, whereas `statusCode` is
  // `number | string`, so a `null` here is out of contract and silently answering 200 would be the
  // same wrong-but-quiet substitution this function exists to stop.
  if (is.statusCode !== undefined) stub.statusCode = toStatusCode(is.statusCode);
  if (is.headers !== undefined) stub.headers = toHeaders(is.headers);
  if (is.body !== undefined && is.body !== null) stub.body = toBody(is.body);
  return stub;
}

/** `string` match = host shorthand; a `Predicate[]` match is AND-ed over the decrypted request. */
export function serveRule(match: string | Predicate[], response: ResponseBuilder | IsResponse): InterceptRule {
  const serve = toServeStub(toIsResponse(response));
  return typeof match === 'string' ? { host: match, action: { serve } } : { predicates: match, action: { serve } };
}

export function forwardRule(match: string | Predicate[], to: ImposterHandle | number): InterceptRule {
  const port = toForwardPort(to);
  return typeof match === 'string'
    ? { host: match, action: { forward: { port } } }
    : { predicates: match, action: { forward: { port } } };
}

/** A catch-all forward rule: no `host`/`predicates`, so it matches whatever no more specific rule did. */
export function redirectRule(imposter: ImposterHandle): InterceptRule {
  return { action: { forward: { port: imposter.port } } };
}
