/**
 * Serialize a typed wire model to the exact JSON the engine speaks.
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

/** Serialize a wire model to the exact JSON string the engine accepts. */
export function toWireString(model: WireModel, space?: number): string {
  try {
    return JSON.stringify(model, jsonSafeReplacer, space);
  } catch (err) {
    if (err instanceof WireValidationError) throw err;
    // e.g. circular reference — JSON.stringify throws a bare TypeError.
    throw new WireValidationError(
      `model is not JSON-serializable: ${(err as Error).message}`,
      '$'
    );
  }
}

/** Project a wire model to a plain JSON-safe object (undefined optionals stripped). */
export function toWireJson(model: WireModel): unknown {
  return JSON.parse(toWireString(model));
}
