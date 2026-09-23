/**
 * Fluent response builders that produce a wire {@link StubResponse}.
 *
 * `.build()` only emits `is` / `headers` / `_behaviors` / `_rift` when they actually carry
 * content — the engine (and the gate's `toEqual`) treats a stray empty object as a different
 * value from an absent key, so we never inject one. `is` / `proxy` / `inject` / a native `fault`
 * are mutually exclusive "primary content" — set by construction (`ok()`, `proxyTo()`,
 * `inject()`, `fault()`) — but `_behaviors` and `_rift` accumulate on top of any of them, so a
 * proxy or inject response can still carry latency, repeat, a fault, etc.
 */

import type {
  Behaviors,
  IsResponse,
  JsonValue,
  ProxyResponse,
  RiftResponseExtension,
  StateOp,
  StubResponse,
} from '../model/index.js';
import { InvalidDefinition } from '../errors.js';
import type { RiftFault, TcpFaultKind } from './fault.js';
import type { ScriptSpec } from './script.js';

/** What the engine's `base64::STANDARD` decoder accepts: standard alphabet, `=` padding, no
 * whitespace, and zero trailing bits in the last symbol. `Buffer.from(s, 'base64')` is lenient on
 * every one of those, so the check is a round trip — a string is canonical iff re-encoding its
 * decode gives it back (`''`, an empty body, round-trips too). */
function isCanonicalBase64(s: string): boolean {
  return Buffer.from(s, 'base64').toString('base64') === s;
}

function isNonNegativeInteger(n: number): boolean {
  return Number.isInteger(n) && n >= 0;
}

/** The engine reads `repeat` as a `u32`. */
const MAX_REPEAT = 0xffff_ffff;

const JSON_CONTENT_TYPE = 'application/json';
const TEXT_CONTENT_TYPE = 'text/plain';

/** The four Mountebank-native TCP fault kinds `fault()` recognizes as top-level `fault`. */
const NATIVE_FAULT_KINDS: ReadonlySet<string> = new Set<TcpFaultKind>([
  'CONNECTION_RESET_BY_PEER',
  'EMPTY_RESPONSE',
  'RANDOM_DATA_THEN_CLOSE',
  'MALFORMED_RESPONSE_CHUNK',
]);

export interface CopySpec {
  from: 'path' | 'method' | 'body' | { query: string } | { headers: string };
  into: string;
  using: {
    method: 'regex' | 'jsonpath' | 'xpath';
    selector: string;
    options?: { ignoreCase?: boolean; multiline?: boolean };
  };
  [key: string]: JsonValue;
}

export interface LookupSpec {
  key: { from: CopySpec['from']; using: CopySpec['using'] };
  fromDataSource: { csv: { path: string; keyColumn: string; delimiter?: string } };
  into: string;
  [key: string]: JsonValue;
}

export class ResponseBuilder {
  private statusCodeValue: number | undefined;
  private headerMap: Record<string, string | string[]> | undefined;
  private bodyValue: JsonValue | undefined;
  private hasBody = false;
  private binaryMode = false;
  private behaviors: Behaviors = {};
  private riftFault: Record<string, JsonValue> = {};
  private legacyTcpFault: string | undefined;
  private scriptSpec: ScriptSpec | undefined;
  private templatedFlag = false;
  private stateOpsList: StateOp[] = [];
  private rawPatch: Partial<StubResponse> | undefined;
  /** Set by `ProxyBuilder`/`proxyTo()`; protected so the subclass can assign it directly. */
  protected proxyConfig: ProxyResponse | undefined;
  private injectFn: string | undefined;
  private nativeFaultType: string | undefined;

  /** Builds a response wrapping an `inject` script instead of `is`. */
  static injected(fn: string): ResponseBuilder {
    const builder = new ResponseBuilder();
    builder.injectFn = fn;
    return builder;
  }

  /** Builds a bare native-fault response (`fault: '<kind>'`), no `is` block. */
  static nativeFault(kind: string): ResponseBuilder {
    const builder = new ResponseBuilder();
    builder.nativeFaultType = kind;
    return builder;
  }

  /** Sets (or overrides) `is.statusCode`. */
  status(code: number): this {
    this.statusCodeValue = code;
    return this;
  }

  /** Merges a single header into `is.headers`. A string[] value emits a multi-value header. */
  header(name: string, value: string | string[]): this {
    this.headerMap = { ...this.headerMap, [name]: value };
    return this;
  }

  /** Merges multiple headers into `is.headers`. */
  headers(values: Record<string, string | string[]>): this {
    this.headerMap = { ...this.headerMap, ...values };
    return this;
  }

  /** Sets `is.body`. */
  body(value: JsonValue): this {
    this.bodyValue = value;
    this.hasBody = true;
    return this;
  }

  /**
   * Sets `is.body` to base64 and `is._mode = 'binary'`. A `Uint8Array` is encoded; a `string` must
   * already be canonical base64 (standard alphabet, `=` padding) — a body the engine cannot decode
   * is served with `x-rift-binary-error: true`, or a 500 under `strictBehaviors`, so it is refused
   * here instead.
   */
  binaryBody(data: Uint8Array | string): this {
    if (typeof data === 'string' && !isCanonicalBase64(data)) {
      throw new InvalidDefinition(
        `binaryBody(string) must be canonical base64 (standard alphabet, = padding, no whitespace), got ${JSON.stringify(data)}; pass a Uint8Array to have it encoded`
      );
    }
    this.bodyValue = typeof data === 'string' ? data : Buffer.from(data).toString('base64');
    this.hasBody = true;
    this.binaryMode = true;
    return this;
  }

  /** Sets `_behaviors.wait` — a fixed delay (ms), a `{min,max}` random range, or a bare fn-string.
   * A number must be a non-negative integer and a range must satisfy `0 <= min <= max`: the engine
   * refuses anything else at the config door (since 0.18.0; older engines dropped the block or, for
   * an inverted range, dropped every connection). The fn-string form is not inspected. */
  latency(ms: number | { min: number; max: number } | string): this {
    if (typeof ms === 'number' && !isNonNegativeInteger(ms)) {
      throw new InvalidDefinition(`latency(ms) must be a non-negative integer of milliseconds, got ${String(ms)}`);
    }
    if (typeof ms === 'object') {
      if (!isNonNegativeInteger(ms.min) || !isNonNegativeInteger(ms.max)) {
        throw new InvalidDefinition(
          `latency({min, max}) bounds must be non-negative integers of milliseconds, got {min: ${String(ms.min)}, max: ${String(ms.max)}}`
        );
      }
      if (ms.min > ms.max) {
        throw new InvalidDefinition(`latency({min, max}) has min ${ms.min} greater than max ${ms.max}`);
      }
    }
    this.behaviors = { ...this.behaviors, wait: ms };
    return this;
  }

  /** Sets `_behaviors.repeat` — a positive integer that fits a `u32`. The engine refuses a
   * negative or fractional value; it accepts `0` but silently serves it as `1`, so `0` is refused
   * here too — it can never mean what the author wrote. */
  repeat(n: number): this {
    if (!Number.isInteger(n) || n < 1 || n > MAX_REPEAT) {
      throw new InvalidDefinition(`repeat(n) must be a positive integer up to ${MAX_REPEAT}, got ${String(n)}`);
    }
    this.behaviors = { ...this.behaviors, repeat: n };
    return this;
  }

  /** Sets `_behaviors.decorate` to a JS decorator function body. */
  decorate(jsFn: string): this {
    this.behaviors = { ...this.behaviors, decorate: jsFn };
    return this;
  }

  /** Sets `_behaviors.shellTransform` — a single command (string) or several (array). No-op if none. */
  shellTransform(...cmds: string[]): this {
    if (cmds.length === 0) return this;
    const [only] = cmds;
    const value = cmds.length === 1 && only !== undefined ? only : cmds;
    this.behaviors = { ...this.behaviors, shellTransform: value };
    return this;
  }

  /** Sets `_behaviors.copy`, always an array even for a single spec. No-op if an empty array. */
  copy(spec: CopySpec | CopySpec[]): this {
    const specs = Array.isArray(spec) ? spec : [spec];
    if (specs.length === 0) return this;
    this.behaviors = { ...this.behaviors, copy: specs };
    return this;
  }

  /** Sets `_behaviors.lookup`, always an array even for a single spec. No-op if an empty array. */
  lookup(spec: LookupSpec | LookupSpec[]): this {
    const specs = Array.isArray(spec) ? spec : [spec];
    if (specs.length === 0) return this;
    this.behaviors = { ...this.behaviors, lookup: specs };
    return this;
  }

  /** Shallow-merges raw `_behaviors` keys — an escape hatch for behaviors with no dedicated method. */
  behavior(raw: Behaviors): this {
    this.behaviors = { ...this.behaviors, ...raw };
    return this;
  }

  /**
   * Merges a {@link RiftFault} into the single `_rift.fault` block, keyed by `fault.kind`.
   * Faults of different kinds (latency, error, tcp) coexist; a second fault of the SAME kind
   * throws — the caller almost certainly meant to replace the first, and silently overwriting
   * would hide that bug.
   */
  withFault(fault: RiftFault): this {
    if (fault.kind in this.riftFault) {
      throw new InvalidDefinition(
        `withFault: a '${fault.kind}' fault is already set on this response`
      );
    }
    this.riftFault = { ...this.riftFault, [fault.kind]: fault.value };
    return this;
  }

  /** Sets `_rift.fault.tcp` — the legacy Rift chaos extension, alongside any `is` already configured. */
  fault(type: string): this {
    this.legacyTcpFault = type;
    return this;
  }

  /** Wraps a {@link ScriptSpec} into `_rift.script`. Exactly one of code/file/ref must be present. */
  script(spec: ScriptSpec): this {
    const present = (['code', 'file', 'ref'] as const).filter((k) => k in spec);
    if (present.length !== 1) {
      throw new InvalidDefinition(
        `script spec must carry exactly one of code/file/ref, found: [${present.join(', ')}]`
      );
    }
    this.scriptSpec = spec;
    return this;
  }

  /** Sets `_rift.templated = true`. */
  templated(): this {
    this.templatedFlag = true;
    return this;
  }

  /**
   * Appends flow-state writes the engine runs after this `is` response is rendered, in order
   * (`_rift.stateOps`, engine >= 0.18.0 — an older engine drops the block on parse, which is why
   * `create()`/`replaceAll()` refuse to send it there). Each op is validated here rather than
   * trusted: the engine's parse error would name a stub index, not the call. `proxy` / `inject` /
   * `fault` / `script` responses never run them and are refused at `build()`.
   */
  stateOps(...ops: StateOp[]): this {
    for (const op of ops) this.pushStateOp(op, 'stateOps()');
    return this;
  }

  /** After this response, stores `value` (a `{{ }}` template; `previousValue` is in scope) under `key`. */
  setState(key: string, value: string): this {
    return this.pushStateOp({ op: 'set', key, value }, 'setState()');
  }

  /** After this response, adds `by` (default 1, may be negative) to the integer under `key`, creating it at 0. */
  incrementState(key: string, by?: number): this {
    return this.pushStateOp(by === undefined ? { op: 'increment', key } : { op: 'increment', key, by }, 'incrementState()');
  }

  /** After this response, removes `key` from the request's flow state. */
  deleteState(key: string): this {
    return this.pushStateOp({ op: 'delete', key }, 'deleteState()');
  }

  /** After this response, removes every key of the request's flow. */
  clearFlowState(): this {
    return this.pushStateOp({ op: 'clearFlow' }, 'clearFlowState()');
  }

  /** Validates and stores a fresh copy, so a caller's object mutated after the call cannot reach the wire unchecked. */
  private pushStateOp(op: unknown, method: string): this {
    this.stateOpsList.push(readStateOp(op, method));
    return this;
  }

  /** Last-wins shallow merge applied at the TOP level of the built response, after everything else. */
  raw(patch: Partial<StubResponse>): this {
    this.rawPatch = { ...this.rawPatch, ...patch };
    return this;
  }

  /** True when any `is`-block field (status/headers/body) has been set. */
  private hasIsContent(): boolean {
    return (
      this.statusCodeValue !== undefined ||
      (this.headerMap !== undefined && Object.keys(this.headerMap).length > 0) ||
      this.hasBody ||
      this.binaryMode
    );
  }

  build(): StubResponse {
    const out: StubResponse = {};

    // proxy / inject / native-fault are mutually exclusive with an `is` body: emitting the
    // response would silently discard whatever status/headers/body were also set. Fail loudly
    // rather than drop them (the same discipline `withFault` applies to duplicate faults).
    if (
      (this.proxyConfig !== undefined ||
        this.injectFn !== undefined ||
        this.nativeFaultType !== undefined) &&
      this.hasIsContent()
    ) {
      throw new InvalidDefinition(
        'a proxy, inject, or native-fault response cannot also carry an `is` body (status/headers/body)'
      );
    }
    // The engine runs `_rift.stateOps` only after an `is` response is rendered. On every other
    // shape — proxy, inject, a top-level or legacy fault, script, or a bare `_rift` block — it never
    // runs them and says so only as an analysis warning, so refuse here instead. Keyed on whether an
    // `is` block is emitted (the guard above already refused `is` content next to proxy/inject/fault)
    // rather than on a list of shapes, so a future `is`-less shape is covered too.
    if (this.stateOpsList.length > 0 && (this.scriptSpec !== undefined || !this.hasIsContent())) {
      throw new InvalidDefinition(
        'stateOps only run after an `is` response is rendered; a proxy, inject, fault or script response never executes them — write the state from the script instead'
      );
    }
    if (this.legacyTcpFault !== undefined && 'tcp' in this.riftFault) {
      throw new InvalidDefinition(
        'tcp fault set via both fault() and withFault(Fault.tcp(...)) — set it once'
      );
    }

    if (this.proxyConfig !== undefined) {
      out.proxy = this.proxyConfig;
    } else if (this.injectFn !== undefined) {
      out.inject = this.injectFn;
    } else if (this.nativeFaultType !== undefined) {
      out.fault = this.nativeFaultType;
    } else {
      const is: IsResponse = {};
      if (this.statusCodeValue !== undefined) is.statusCode = this.statusCodeValue;
      if (this.headerMap !== undefined && Object.keys(this.headerMap).length > 0) {
        is.headers = this.headerMap;
      }
      if (this.hasBody) is.body = this.bodyValue;
      if (this.binaryMode) is._mode = 'binary';
      if (Object.keys(is).length > 0) out.is = is;
    }

    if (Object.keys(this.behaviors).length > 0) out._behaviors = this.behaviors;

    const rift: RiftResponseExtension = {};
    const faultBlock: Record<string, JsonValue> = { ...this.riftFault };
    if (this.legacyTcpFault !== undefined) faultBlock.tcp = this.legacyTcpFault;
    if (Object.keys(faultBlock).length > 0) rift.fault = faultBlock;
    if (this.scriptSpec !== undefined) rift.script = this.scriptSpec;
    if (this.templatedFlag) rift.templated = true;
    if (this.stateOpsList.length > 0) rift.stateOps = this.stateOpsList.map((op) => ({ ...op }));
    if (Object.keys(rift).length > 0) out._rift = rift;

    return this.rawPatch !== undefined ? { ...out, ...this.rawPatch } : out;
  }
}

/**
 * Reads one state op off an untrusted value the way the engine's parser would (`#[serde(tag = "op")]`,
 * `by: i64`), naming the DSL method in the error, and returns a freshly built op — never the caller's
 * object. Refuses rather than coerces: a numeric `value` would be stringified silently by
 * `JSON.stringify`, and a fractional or unsafe `by` would not survive the engine's `i64` exactly.
 */
function readStateOp(raw: unknown, method: string): StateOp {
  const fields = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : undefined;
  const op = fields?.['op'];
  const key = fields?.['key'];
  const requireKey = (): string => {
    if (typeof key !== 'string' || key.length === 0) {
      throw new InvalidDefinition(`${method}: key must be a non-empty string, got ${JSON.stringify(key)}`);
    }
    return key;
  };
  switch (op) {
    case 'set': {
      const value = fields?.['value'];
      const k = requireKey();
      if (typeof value !== 'string') {
        throw new InvalidDefinition(`${method}: value must be a string (a {{ }} template), got ${JSON.stringify(value)}`);
      }
      return { op: 'set', key: k, value };
    }
    case 'increment': {
      const by = fields?.['by'];
      const k = requireKey();
      if (by === undefined) return { op: 'increment', key: k };
      if (typeof by !== 'number' || !Number.isSafeInteger(by)) {
        throw new InvalidDefinition(`${method}: by must be an integer, got ${JSON.stringify(by) ?? String(by)}`);
      }
      return { op: 'increment', key: k, by };
    }
    case 'delete':
      return { op: 'delete', key: requireKey() };
    case 'clearFlow':
      return { op: 'clearFlow' };
    default:
      throw new InvalidDefinition(`${method}: op must be one of set / increment / delete / clearFlow, got ${JSON.stringify(raw)}`);
  }
}

/** 200 OK, optionally with a body. */
export function ok(body?: JsonValue): ResponseBuilder {
  const builder = new ResponseBuilder().status(200);
  if (body !== undefined) builder.body(body);
  return builder;
}

/** 200 OK with `Content-Type: application/json` and the given (required) body. */
export function okJson(body: JsonValue): ResponseBuilder {
  return new ResponseBuilder().status(200).header('Content-Type', JSON_CONTENT_TYPE).body(body);
}

/** 201 Created, optionally with a body. */
export function created(body?: JsonValue): ResponseBuilder {
  const builder = new ResponseBuilder().status(201);
  if (body !== undefined) builder.body(body);
  return builder;
}

/** Arbitrary status code, optionally with a body. */
export function status(code: number, body?: JsonValue): ResponseBuilder {
  const builder = new ResponseBuilder().status(code);
  if (body !== undefined) builder.body(body);
  return builder;
}

/** Arbitrary status code with `Content-Type: application/json` and the given body. */
export function json(code: number, body: JsonValue): ResponseBuilder {
  return new ResponseBuilder().status(code).header('Content-Type', JSON_CONTENT_TYPE).body(body);
}

/** Arbitrary status code with `Content-Type: text/plain` and the given body. */
export function text(code: number, body: JsonValue): ResponseBuilder {
  return new ResponseBuilder().status(code).header('Content-Type', TEXT_CONTENT_TYPE).body(body);
}

/** 400 Bad Request, optionally with a body. */
export function badRequest(body?: JsonValue): ResponseBuilder {
  const builder = new ResponseBuilder().status(400);
  if (body !== undefined) builder.body(body);
  return builder;
}

/** 404 Not Found, optionally with a body. */
export function notFound(body?: JsonValue): ResponseBuilder {
  const builder = new ResponseBuilder().status(404);
  if (body !== undefined) builder.body(body);
  return builder;
}

/** 204 No Content. */
export function noContent(): ResponseBuilder {
  return new ResponseBuilder().status(204);
}

/**
 * A bare fault response, no `is` block. `kind` values recognized by the engine as native TCP
 * fault kinds (see {@link TcpFaultKind}, e.g. `Fault.CONNECTION_RESET`) emit the wire-native
 * top-level `fault: '<kind>'`. Any other identifier (a caller-chosen string that predates the
 * native field, e.g. a raw Node error code) falls back to the legacy `_rift.fault.tcp` slot.
 */
export function fault(kind: TcpFaultKind | (string & NonNullable<unknown>)): ResponseBuilder {
  if (NATIVE_FAULT_KINDS.has(kind)) {
    return ResponseBuilder.nativeFault(kind);
  }
  // A case-variant of a native kind (e.g. 'connection_reset_by_peer') is a typo, not a legacy
  // identifier — route it to _rift.fault.tcp silently and the caller's intended native fault is
  // lost with no signal. Reject it loudly; genuine legacy strings (ECONNRESET, ...) fall through.
  const upper = kind.toUpperCase();
  if (upper !== kind && NATIVE_FAULT_KINDS.has(upper)) {
    throw new InvalidDefinition(`unknown fault kind '${kind}' — did you mean '${upper}'?`);
  }
  return new ResponseBuilder().fault(kind);
}

/** An `inject` response running the given script body. */
export function inject(fn: string): ResponseBuilder {
  return ResponseBuilder.injected(fn);
}

/** A response wrapping a {@link ScriptSpec} into `_rift.script`, with no `is` block. */
export function script(spec: ScriptSpec): ResponseBuilder {
  return new ResponseBuilder().script(spec);
}
