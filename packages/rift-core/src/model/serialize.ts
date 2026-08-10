/**
 * Serialize outbound payloads to the exact JSON the engine speaks.
 *
 * {@link stringifyJsonSafe} is the choke point every transport serializes through; {@link
 * toWireString} is its typed, wire-model-shaped face.
 *
 * Because the model already carries wire keys, serialization is a faithful, transformation-free
 * projection: it drops `undefined` optional *properties* (so omitted options never reach the wire)
 * and yields a JSON-safe object. A model produced by {@link fromJson} therefore round-trips to a
 * value-identical object — including an explicit `port`. An undefined ARRAY ELEMENT is the one
 * exception and throws: `JSON.stringify` nulls it rather than dropping it, so it is a value the
 * caller never wrote (issue #119).
 *
 * The model must be JSON-safe. A value JSON cannot represent — a function, `bigint`, `symbol`,
 * non-finite number or circular reference — is a caller error, so it throws a typed
 * {@link WireValidationError} rather than being silently dropped, nulled, or leaked as a raw
 * `TypeError`. Its `path` locates the offending node as a JSONPath-like `$[2].action.serve.statusCode`,
 * so an element of a posted array does not have to be found by bisection (issue #118).
 * The scalar check is `typeof`-based and so does not see through a boxed
 * wrapper (`new Number(NaN)`) or a `Date`, both of which `WireModel` already excludes by type.
 *
 * The same applies to the CONTAINERS that keep their payload in internal slots `JSON.stringify`
 * cannot reach — `Map`, `Set`, `WeakMap`, `WeakSet`, `RegExp`, `Promise`, `ArrayBuffer`,
 * `SharedArrayBuffer` and `DataView` — which lose every value rather than one and so are refused
 * too (issue #126). Two neighbours are deliberately NOT in that set, because they lose nothing or
 * lose it visibly: an `Error`'s enumerable own properties do serialize (only the non-enumerable
 * `message` and `stack` are lost), and a typed-array VIEW such as `Uint8Array` serializes as an
 * index-keyed object. Note the set is an explicit list rather than the rule "renders as `{}`" —
 * an ordinary class instance whose state is private fields or getters renders that way too, and
 * refusing those would reject plain domain objects.
 */

import { WireValidationError } from './fromJson.js';
import type { WireModel } from './types.js';

/** Spellable as `.key`; anything else needs `["…"]`. Header names (`Content-Type`) are the common
 * case for the second branch. */
const BARE_IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * The name of the built-in `value` is an instance of, for the containers that keep their payload in
 * internal slots `JSON.stringify` cannot reach — otherwise `undefined`.
 *
 * Membership is this explicit list of ECMAScript built-ins, and deliberately NOT the rule "anything
 * that stringifies to `{}`". An ordinary class instance whose state is private fields or getters
 * renders as `{}` too, so that rule would refuse the plain domain objects callers legitimately send.
 * Web/host objects of the same shape (`Headers`, `URLSearchParams`) are left out for the converse
 * reason: including them makes the set depend on which globals the runtime happens to provide.
 *
 * The name is the matched built-in's, not `value.constructor.name`: a subclass is refused for the
 * same reason its base is, so it should read the same in the error, and `constructor` is not
 * guaranteed to be present on a hand-built prototype chain.
 *
 * `instanceof` does not see across realms (a `Map` from a `vm` context), which is acceptable for a
 * single-realm Node SDK — the alternative, `Object.prototype.toString`, is spoofable through
 * `Symbol.toStringTag` and so trades a rare miss for a forgeable check.
 */
function slotBackedBuiltinName(value: object): string | undefined {
  if (value instanceof Map) return 'Map';
  if (value instanceof Set) return 'Set';
  if (value instanceof WeakMap) return 'WeakMap';
  if (value instanceof WeakSet) return 'WeakSet';
  if (value instanceof RegExp) return 'RegExp';
  if (value instanceof Promise) return 'Promise';
  // Binary buffers. A typed-array VIEW (`Uint8Array`) is not here: it serializes as an index-keyed
  // object, which is lossy but not empty, and is left to the caller to convert deliberately.
  if (value instanceof ArrayBuffer) return 'ArrayBuffer';
  if (value instanceof SharedArrayBuffer) return 'SharedArrayBuffer';
  if (value instanceof DataView) return 'DataView';
  return undefined;
}

/**
 * @internal Builds the replacer shared with the intercept `serve()` body path
 * (`intercept/rules.ts`) and `addRule()` (`engine.ts`), so every serializer refuses the same values
 * and locates them the same way; exported for reuse, not as public API.
 *
 * A fresh replacer per serialization rather than one shared function, because it closes over the
 * path table below: a value's own `toJSON()` may reentrantly serialize something else, and shared
 * state would let the two walks overwrite each other's ancestry.
 *
 * The returned function is therefore **single-use** — it latches its root call — and must be handed
 * to exactly one `JSON.stringify`. Hoisting one across two serializations reports the second's
 * root-level error against a stale ancestry instead of `$`.
 */
export function makeJsonSafeReplacer(): (this: unknown, key: string, value: unknown) => unknown {
  // Container → its JSONPath. The replacer API hands out only the immediate key, so ancestry has to
  // be accumulated on the way down; `JSON.stringify` visits a parent before its children, which is
  // what makes a holder's entry always present by the time a child needs it. Serialization is also
  // depth-first, so a node reachable by two routes is re-recorded before each occurrence is walked
  // and the locator describes the occurrence being serialized rather than a stale first sighting.
  const paths = new WeakMap<object, string>();
  // `JSON.stringify` invokes the replacer for the whole document first, with its internal
  // `{'': value}` wrapper as the holder. That call's key is `''` — but `''` is also a legal object
  // property name, so the key cannot identify the root and position is the only exact
  // discriminator: the root call is always the first one.
  let atRoot = true;

  const pathTo = (holder: unknown, key: string, isRoot: boolean): string => {
    if (isRoot) return '$';
    const base = (typeof holder === 'object' && holder !== null ? paths.get(holder) : undefined) ?? '$';
    if (Array.isArray(holder)) return `${base}[${key}]`;
    return BARE_IDENTIFIER.test(key) ? `${base}.${key}` : `${base}[${JSON.stringify(key)}]`;
  };

  return function (this: unknown, key: string, value: unknown): unknown {
    const isRoot = atRoot;
    atRoot = false;
    // Objects and arrays are never themselves a refused shape, so recording ancestry is all they
    // need. Returning here also keeps path building off the leaf path: it runs once per container
    // and once per throw, never for every scalar in the model.
    if (typeof value === 'object' && value !== null) {
      // Checked before the ancestry record, because this container never gets walked: `JSON.stringify`
      // enumerates own properties, and these types keep their contents somewhere it cannot see, so
      // the whole collection would reach the engine as `{}`. That is the same wrong-but-quiet shape
      // as the leaf guards below, one level up and losing every value rather than one (issue #126).
      // `JSON.stringify` applies `toJSON` first, so what is judged here is always the value that will
      // actually be serialized: a caller who declared how their type serializes is never pre-empted,
      // and a `toJSON()` that itself RETURNS one of these is still caught.
      const slotBacked = slotBackedBuiltinName(value);
      if (slotBacked !== undefined) {
        // "drop its contents" rather than "emit {}": a subclass carrying its own enumerable
        // properties serializes them and loses only the slot-backed payload, so `{}` would be a
        // literal claim that is false for exactly the values most likely to confuse a caller.
        throw new WireValidationError(
          `value of type ${slotBacked} is not JSON-serializable (JSON.stringify would silently drop its contents)`,
          pathTo(this, key, isRoot)
        );
      }
      paths.set(value, pathTo(this, key, isRoot));
      return value;
    }
    const t = typeof value;
    if (t === 'function' || t === 'bigint' || t === 'symbol') {
      throw new WireValidationError(`value of type ${t} is not JSON-serializable`, pathTo(this, key, isRoot));
    }
    // `JSON.stringify` renders NaN/Infinity/-Infinity as `null`, so the key arrives at the SUT
    // holding a value the caller never wrote, with nothing on this side to correlate against.
    // `String(value)` names which of the three it was.
    if (t === 'number' && !Number.isFinite(value)) {
      throw new WireValidationError(
        `non-finite number ${String(value)} is not JSON-serializable (JSON.stringify would silently emit null)`,
        pathTo(this, key, isRoot)
      );
    }
    // The same silent-null shape one level up: `JSON.stringify` renders an undefined ARRAY ELEMENT as
    // null, where an undefined object PROPERTY is dropped — and that drop is the contract this module
    // documents for omitted optionals, so the two must not be treated alike. A replacer is called with
    // the holder of the current key as `this`, which separates them exactly. The root value's holder is
    // the internal `{'': value}` wrapper rather than an array, so a top-level `undefined` still falls
    // through to the whole-value check in `stringifyJsonSafe`. Sparse holes and an element whose
    // `toJSON()` returned undefined arrive here as undefined too, and are the same bug.
    if (value === undefined && Array.isArray(this)) {
      throw new WireValidationError(
        'undefined array element is not JSON-serializable (JSON.stringify would silently emit null)',
        pathTo(this, key, isRoot)
      );
    }
    return value;
  };
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
    encoded = JSON.stringify(value, makeJsonSafeReplacer(), space);
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
