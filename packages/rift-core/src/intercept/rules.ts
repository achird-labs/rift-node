/**
 * Pure intercept rule builders (issue #11) — turn `InterceptHandle.serve`/`forward`/`redirectTo`'s
 * ergonomic arguments into the wire `wire.InterceptRule` shape. No I/O, no backend dependency;
 * `InterceptHandleImpl` (engine.ts) is the only caller.
 */

import type { InterceptRule, IsResponse, JsonValue, Predicate, ServeStub } from '../model/index.js';
import { foldAsciiHeaderName } from '../dsl/header-names.js';
import { InvalidDefinition } from '../errors.js';
import { makeJsonSafeReplacer } from '../model/serialize.js';
import { ResponseBuilder } from '../dsl/response.js';
import type { ImposterHandle } from '../engine.js';

/** The `is` fields the engine's serve action can actually carry. `_mode` is here because `'text'` is
 * the engine's only mode and dropping it changes nothing served; `'binary'` is refused separately by
 * {@link toServeStub}, which can say something far more useful about it. */
const DELIVERABLE_IS_KEYS = new Set(['statusCode', 'headers', 'body', '_mode']);

/** Wire key → the DSL method that sets it. The error names the caller's own spelling, not just the
 * wire shape, because `_behaviors.wait` is not what they typed — `latency(10)` is. */
const BEHAVIOR_METHODS: Record<string, string> = {
  wait: 'latency()',
  repeat: 'repeat()',
  decorate: 'decorate()',
  shellTransform: 'shellTransform()',
  copy: 'copy()',
  lookup: 'lookup()',
};

const RIFT_METHODS: Record<string, string> = {
  script: 'script()',
  templated: 'templated()',
};

const FAULT_METHODS: Record<string, string> = {
  latency: 'withFault(Fault.latency(…))',
  error: 'withFault(Fault.error(…))',
  tcp: 'withFault(Fault.tcp(…)) or fault()',
};

function named(key: string, method: string | undefined): string {
  return method === undefined ? `\`${key}\`` : `\`${key}\` (${method})`;
}

/** A `{...}` literal or a null-prototype object — the only shapes whose own keys describe their whole
 * content. Deliberately excludes arrays and class instances: `new Map([['wait', 10]])` enumerates to
 * NO own keys, so treating it as walkable would report nothing and wave it through. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

function entriesOf(value: unknown): Array<[string, unknown]> {
  return isPlainObject(value) ? Object.entries(value) : [];
}

/**
 * The own keys of a nested `_behaviors`/`_rift`/`_rift.fault` block, or `undefined` when the block is
 * not a plain object and so has to be reported whole.
 *
 * Walking a non-object is the trap this exists to avoid: `Object.keys(Object(5))`,
 * `Object.keys(Object(false))` and `Object.keys(new Map([['wait', 10]]))` are all `[]`, so a
 * malformed block would contribute NOTHING to the dropped list and be served silently — the exact
 * failure this guard exists to close, one level up. `_behaviors: cond && behaviours` degrading to
 * `false` is the ordinary way to write that bug.
 */
function blockKeys(value: unknown): string[] | undefined {
  return isPlainObject(value) ? Object.keys(value) : undefined;
}

/**
 * Everything in one response object the engine's serve action would drop, named as the caller wrote it.
 *
 * Runs over the built `StubResponse` (`top` = true, where `_behaviors`/`_rift` are siblings of `is`)
 * and over the `is` block itself (`top` = false, which is also the whole object on the raw-literal
 * path, since `IsResponse` has an open index signature and a caller can put either block there).
 *
 * Collects rather than throwing at the first hit: first-wins would send a caller round the loop once
 * per construct, each time reporting a rule they had already been told was unusable.
 */
function undeliverable(source: unknown, top: boolean): string[] {
  const dropped: string[] = [];
  for (const [key, value] of entriesOf(source)) {
    // An explicitly-undefined property is dropped by `JSON.stringify` anyway, so it loses nothing and
    // is treated as absent — reporting it would refuse an ordinary optional spread.
    if (value === undefined) continue;
    if (key === '_behaviors') {
      const behaviors = blockKeys(value);
      if (behaviors === undefined) dropped.push(named('_behaviors', undefined));
      else for (const b of behaviors) dropped.push(named(`_behaviors.${b}`, BEHAVIOR_METHODS[b]));
    } else if (key === '_rift') {
      const extensions = blockKeys(value);
      if (extensions === undefined) {
        dropped.push(named('_rift', undefined));
      } else {
        for (const [ext, extValue] of Object.entries(value as Record<string, unknown>)) {
          if (extValue === undefined) continue;
          if (ext !== 'fault') {
            dropped.push(named(`_rift.${ext}`, RIFT_METHODS[ext]));
            continue;
          }
          const kinds = blockKeys(extValue);
          if (kinds === undefined) dropped.push(named('_rift.fault', undefined));
          else for (const kind of kinds) dropped.push(named(`_rift.fault.${kind}`, FAULT_METHODS[kind]));
        }
      }
    } else if (top) {
      // `is` is the only top-level key the serve path reads. Anything else can only have arrived
      // through `raw()`, and `toServeStub` never looks at it. That includes a flat-form
      // `statusCode`/`headers`/`body` (issue #304) patched alongside an `is` block; a raw() patch
      // carrying ONLY the flat form builds no `is` at all and is refused earlier instead.
      if (key !== 'is') dropped.push(named(key, 'raw()'));
    } else if (!DELIVERABLE_IS_KEYS.has(key)) {
      dropped.push(named(key, undefined));
    }
  }
  return dropped;
}

/**
 * A `ResponseBuilder` is only valid here when it builds a plain `is` block — proxy/inject/native-fault
 * responses have no meaning as an intercept `serve` action — and only when nothing else on it would
 * be silently discarded (issue #131).
 *
 * The engine genuinely cannot carry these: `ServeStub` in `crates/rift-http-proxy/src/intercept_rules.rs`
 * is exactly `{status_code, headers, body}`, and none of its structs use `deny_unknown_fields`, so
 * posting the extra fields would be accepted-and-ignored engine-side too. Refusing here is the only
 * place the caller can still be told. The message matches rift-java's `InterceptImpl.requireDeliverable`
 * and rift-scala's `FacadeEncode.requireDeliverable` so the three SDKs read identically.
 */
function toIsResponse(response: ResponseBuilder | IsResponse): IsResponse {
  const dropped: string[] = [];
  let is: unknown;
  if (response instanceof ResponseBuilder) {
    const built = response.build();
    if (built.is === undefined) {
      throw new InvalidDefinition(
        'intercept serve() response must build an `is` block (status/headers/body). A proxy, inject or ' +
          'native-fault response is not a valid intercept action, and a raw() patch carrying only the ' +
          'flat statusCode/headers/body form does not build one either.'
      );
    }
    is = built.is;
    dropped.push(...undeliverable(built, true), ...undeliverable(built.is, false));
  } else {
    is = response;
    dropped.push(...undeliverable(response, false));
  }
  // Before the collected report, because a non-object carries no keys to have collected: without this
  // a string response registered an empty `serve: {}` and a `null` one escaped as a raw `TypeError`
  // from `toServeStub`, breaking serve()'s InvalidDefinition-only error contract (issue #101).
  if (!isPlainObject(is)) {
    throw new InvalidDefinition(
      `intercept serve() response must be an object with statusCode/headers/body, got ${
        is === null ? 'null' : typeof is
      }`
    );
  }
  if (dropped.length > 0) {
    throw new InvalidDefinition(
      `intercept serve cannot deliver ${dropped.join(', ')} — the engine's serve action carries only ` +
        `statusCode, headers and body, so the rule would be registered and then answer a response you ` +
        `did not ask for. Use redirectTo(imposter) for full stub fidelity.`
    );
  }
  return is;
}

function toForwardPort(to: ImposterHandle | number): number {
  return typeof to === 'number' ? to : to.port;
}

/**
 * Since engine 0.18.0 a code outside hyper's `StatusCode::from_u16` is served as a 500 with a log
 * line (`intercept.rs`); before, it yielded a malformed status line. Either way it is not the
 * response asked for and reaches the SDK caller as nothing — the same wrong-but-quiet failure this
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

/** Mirrors the engine's `is_hop_by_hop` exactly (rift `crates/rift-http-proxy/src/intercept.rs`),
 * which is deliberately narrower than RFC 7230's hop-by-hop set — `Keep-Alive`, `TE` and `Upgrade`
 * are *not* in it and do reach the SUT. Widening this to the RFC set would refuse headers the engine
 * serves happily, so it must track that function rather than the spec. */
const ENGINE_MANAGED_HEADERS = new Set(['host', 'connection', 'content-length', 'transfer-encoding']);

/** RFC 9110 `token` — what hyper's `HeaderName::try_from` accepts. */
const HEADER_NAME_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
/** Every control character except HTAB, plus DEL — what `HeaderValue::try_from` refuses. Spelled
 * as a code-point scan rather than a regex because a control-character class trips `no-control-regex`. */
function hasForbiddenHeaderValueChar(value: string): boolean {
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if ((code < 0x20 && code !== 0x09) || code === 0x7f) return true;
  }
  return false;
}

function toHeaderValue(name: string, value: unknown, inArray: boolean): string {
  if (typeof value !== 'string') {
    throw new InvalidDefinition(
      `intercept serve() ${inArray ? 'each value of header' : 'header'} "${name}" must be a string, got ${typeof value}`
    );
  }
  if (hasForbiddenHeaderValueChar(value)) {
    throw new InvalidDefinition(
      `intercept serve() header "${name}" contains a control character (CR, LF, NUL, DEL, ...): the engine drops that value with only a log line — for CR/LF that is also the response-splitting guard. Remove the control characters.`
    );
  }
  return value;
}

function toHeaders(headers: NonNullable<IsResponse['headers']>): Record<string, string | string[]> {
  // Null-prototype: on a plain object `out[name] = value` for the single name `__proto__` hits the
  // prototype setter instead of creating an own property, so that header would vanish here without
  // an error — reachable whenever the caller's headers came from `JSON.parse`.
  const out = Object.create(null) as Record<string, string | string[]>;
  const seen = new Map<string, string>();
  for (const [name, value] of Object.entries(headers)) {
    // Every class below is altered engine-side with at most a `tracing::warn!` the SDK caller never
    // sees — a malformed name skips the header, a malformed value drops that value, a managed name
    // is stripped outright, and a second spelling of a name is silently merged into the first
    // (rift#1039) so the header goes out twice when the caller meant once. Without these guards
    // serve() succeeds and the response is not the one asked for. forward() is no escape hatch:
    // the imposter path applies the same validation and fold, and is_hop_by_hop runs on the
    // request-forward and response-relay legs too.
    if (!HEADER_NAME_TOKEN.test(name)) {
      throw new InvalidDefinition(
        `intercept serve() header name ${JSON.stringify(name)} is not a valid HTTP header name (letters, digits and !#$%&'*+-.^_\`|~ only, no spaces): the engine skips the header with only a log line.`
      );
    }
    if (ENGINE_MANAGED_HEADERS.has(name.toLowerCase())) {
      throw new InvalidDefinition(
        `intercept serve() cannot send the header "${name}": the engine's intercept proxy manages Content-Length and the Connection header itself and silently drops this header. Remove it from the response.`
      );
    }
    const first = seen.get(foldAsciiHeaderName(name));
    if (first !== undefined) {
      throw new InvalidDefinition(
        `intercept serve() header \`${name}\` is already given as \`${first}\`: the engine merges the spellings into one multi-value header and serves it twice. Use one spelling, and an array for multiple values.`
      );
    }
    seen.set(foldAsciiHeaderName(name), name);
    if (Array.isArray(value)) {
      if (value.length === 0) {
        throw new InvalidDefinition(`intercept serve() header "${name}" is an empty array, which would send no header at all.`);
      }
      out[name] = value.map((v) => toHeaderValue(name, v, true));
    } else {
      out[name] = toHeaderValue(name, value, false);
    }
  }
  return out;
}

/** A string body is sent as-is; anything else becomes compact JSON here, on purpose. Since engine
 * 0.18.0 `serve.body` accepts any JSON value (rift#933), but the engine renders a non-string body
 * through `serde_json::Map` (a `BTreeMap`, since `preserve_order` is off) and so emits sorted keys;
 * pre-stringifying keeps the caller's key order, which a SUT that hashes or byte-asserts the body
 * will notice. The read path (`rules()`) returns whatever shape was posted.
 *
 * Serialized through the wire model's own {@link makeJsonSafeReplacer} so this path refuses exactly what
 * that one refuses (issue #106) — the thrown `WireValidationError` already names the offending key,
 * and the catch below re-wraps it as `InvalidDefinition` to keep `serve()`'s error contract uniform. */
function toBody(body: JsonValue): string {
  if (typeof body === 'string') return body;
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(body, makeJsonSafeReplacer());
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
 * The engine parses rules through an untagged enum, so a field out of contract (a `statusCode`
 * that is not a number or numeric string, a non-string header value, a body it cannot read)
 * surfaces as an opaque "did not match any variant of RuleOrRules" instead of naming the offending
 * field (issue #101); this normalizer names it first.
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
