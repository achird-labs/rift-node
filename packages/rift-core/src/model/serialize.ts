/**
 * Serialize outbound payloads to the exact JSON the engine speaks.
 *
 * {@link stringifyJsonSafe} is the choke point every transport serializes through; {@link
 * toWireString} is its typed, wire-model-shaped face.
 *
 * Because the model already carries wire keys, serialization is a faithful, transformation-free
 * projection: it drops `undefined` optional fields (so omitted options never reach the wire) and
 * yields a JSON-safe object. A model produced by {@link fromJson} therefore round-trips to a
 * value-identical object — including an explicit `port`.
 *
 * The model must be JSON-safe. A value JSON cannot represent — a function, `bigint`, `symbol`,
 * non-finite number or circular reference — is a caller error, so it throws a typed
 * {@link WireValidationError} naming the offending key rather than being silently dropped, nulled,
 * or leaked as a raw `TypeError`. The check is `typeof`-based and so does not see through a boxed
 * wrapper (`new Number(NaN)`) or a `Date`, both of which `WireModel` already excludes by type.
 */

import { WireValidationError } from './fromJson.js';
import type { WireModel } from './types.js';

/** Computed only on the throw paths — the replacer runs for every value in the model. */
const pathOf = (key: string): string => (key === '' ? '$' : `…${key}`);

/**
 * @internal Shared with the intercept `serve()` body path (`intercept/rules.ts`) so both
 * serializers refuse the same values; exported for reuse, not as public API.
 */
export function jsonSafeReplacer(this: unknown, key: string, value: unknown): unknown {
  const t = typeof value;
  if (t === 'function' || t === 'bigint' || t === 'symbol') {
    throw new WireValidationError(`value of type ${t} is not JSON-serializable`, pathOf(key));
  }
  // `JSON.stringify` renders NaN/Infinity/-Infinity as `null`, so the key arrives at the SUT
  // holding a value the caller never wrote, with nothing on this side to correlate against.
  // `String(value)` names which of the three it was.
  if (t === 'number' && !Number.isFinite(value)) {
    throw new WireValidationError(
      `non-finite number ${String(value)} is not JSON-serializable (JSON.stringify would silently emit null)`,
      pathOf(key)
    );
  }
  return value;
}

/**
 * Serialize any outbound payload with the JSON-safety guarantee above.
 *
 * Untyped on purpose: the transports carry more than a {@link WireModel} — a stub, an imposters
 * envelope, a flow-state value — and before issue #112 each of them reached the engine through a
 * bare `JSON.stringify`, so the guarantee this module documents was enforced nowhere a caller
 * actually went. Every outbound body now routes through here.
 */
export function stringifyJsonSafe(value: unknown, space?: number): string {
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(value, jsonSafeReplacer, space);
  } catch (err) {
    if (err instanceof WireValidationError) throw err;
    // A circular reference (a bare TypeError from JSON.stringify), or anything a value's own
    // toJSON() threw — an invalid Date raises RangeError. The text is folded into the message
    // because a non-Error throw has no `.message` a reader could reach for; `cause` keeps the
    // thrown value itself, whose type and stack are the rest of the description.
    throw new WireValidationError(
      `value is not JSON-serializable: ${err instanceof Error ? err.message : String(err)}`,
      '$',
      { cause: err }
    );
  }
  // Only a top-level `undefined` gets here: a function, symbol or bigint in that position throws
  // inside the replacer first, because JSON.stringify runs it on the root value before serializing.
  // Returning `undefined` would put the literal string "undefined" on the wire, or drop the body
  // entirely and let the engine read it as an empty payload.
  if (encoded === undefined) {
    throw new WireValidationError('value has no JSON representation', '$');
  }
  return encoded;
}

/** Serialize a wire model to the exact JSON string the engine accepts. */
export function toWireString(model: WireModel, space?: number): string {
  return stringifyJsonSafe(model, space);
}

/** Project a wire model to a plain JSON-safe object (undefined optionals stripped). */
export function toWireJson(model: WireModel): unknown {
  return JSON.parse(toWireString(model));
}
